/**
 * Judging a catalog-only `ALTER TABLE` against the table's catalog record, when several machines
 * of one network may run the same schema upgrade.
 *
 * A catalog-only arm changes the table's stored description and nothing else (no row is
 * rewritten). On a warm start every machine of a network runs the same `apply schema`, each from
 * the catalog it hydrated, so a machine routinely meets a record another machine has already
 * upgraded. Two rules settle what it does then, both pure and kept here so they can be tested
 * without a database:
 *
 * - {@link classifyCheckChange} compares the change against the record: a change the record
 *   already holds is *adopted* (nothing written), any other is *owned* (written).
 * - {@link AdoptedChanges} remembers, for one `apply schema`, the changes this machine adopted, so
 *   that the engine's undo of one of them (Quereus unwinds an apply whose later step fails) is
 *   recognised and kept off the record: undoing a change this machine did not make would remove
 *   what another machine committed.
 *
 * Objects are compared by their persisted form ignoring their tags and the case of their name.
 * Tags converge through the `set tags` statements the same apply emits, so counting them would
 * make an honest second machine rewrite the record; names compare as Quereus compares them.
 */

import { structuralEquals } from '@optimystic/db-core';
import type { StoredCheckConstraint, StoredTableSchema } from './schema-manager.js';

/** A named, possibly tagged object of a catalog record: a CHECK constraint. */
export interface CatalogObject {
	readonly name?: string;
	readonly tags?: unknown;
}

/** The kinds of record object a catalog-only arm changes. */
export type CatalogObjectKind = 'check';

/**
 * What a catalog-only arm does to the record: write its edit (`owned`), write nothing because the
 * record already holds the change (`adopted`), or refuse the statement with `message`.
 */
export type CatalogOnlyVerdict =
	| { readonly kind: 'owned' }
	| { readonly kind: 'adopted' }
	| { readonly kind: 'refused'; readonly message: string };

const OWNED: CatalogOnlyVerdict = { kind: 'owned' };
const ADOPTED: CatalogOnlyVerdict = { kind: 'adopted' };

/**
 * A CHECK change as this machine's engine makes it. `add` installs `after` (the engine never holds
 * a CHECK of that name beforehand: Quereus refuses a name its catalog holds); `drop` removes the
 * CHECK the engine holds as `before`. Both in the record's form (`checkConstraintToStored`).
 */
export type CheckChange =
	| { readonly op: 'add'; readonly after: StoredCheckConstraint }
	| { readonly op: 'drop'; readonly before: StoredCheckConstraint };

/** The entry of `items` named `name`, compared case-insensitively; undefined when `name` is. */
export function findNamed<T extends CatalogObject>(items: readonly T[] | undefined, name: string | undefined): T | undefined {
	if (name === undefined) {
		return undefined;
	}
	const lower = name.toLowerCase();
	return items?.find(item => item.name?.toLowerCase() === lower);
}

/** `items` without the entry named `name`, under {@link findNamed}'s name rule; all of them when `name` is undefined. */
export function withoutNamed<T extends CatalogObject>(items: readonly T[], name: string | undefined): T[] {
	if (name === undefined) {
		return [...items];
	}
	const lower = name.toLowerCase();
	return items.filter(item => item.name?.toLowerCase() !== lower);
}

/**
 * Whether `a` and `b` are the same object, ignoring tags and the case of the name. Undefined
 * stands for "no such object", and only matches itself.
 */
export function sameCatalogObject(a: CatalogObject | undefined, b: CatalogObject | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	return structuralEquals(comparable(a), comparable(b));
}

function comparable({ tags: _tags, name, ...rest }: CatalogObject): object {
	return { ...rest, name: name?.toLowerCase() };
}

/**
 * A CHECK change judged against `record`:
 *
 * | change | record holds | verdict |
 * | --- | --- | --- |
 * | drop | the CHECK, as this engine holds it | owned: remove it |
 * | drop | no CHECK of that name | adopted |
 * | drop | a different CHECK of that name | adopted: another machine replaced it |
 * | add | no CHECK of that name | owned: add it |
 * | add | the same CHECK | adopted |
 * | add | a different CHECK of that name | owned: replace it (local DDL wins) |
 *
 * NOTE: the third row is judged as the drop half of a changed-body pair. A direct `alter table …
 * drop constraint` over a record whose CHECK another machine re-bodied is adopted too, so the
 * record keeps that CHECK and a restart brings it back; if hosts ever issue imperative drops on
 * shared tables, have that case owned outside `apply schema`.
 */
export function classifyCheckChange(record: StoredTableSchema, change: CheckChange): CatalogOnlyVerdict {
	if (change.op === 'add') {
		return sameCatalogObject(findNamed(record.checkConstraints, change.after.name), change.after) ? ADOPTED : OWNED;
	}
	const held = findNamed(record.checkConstraints, change.before.name);
	return held !== undefined && sameCatalogObject(held, change.before) ? OWNED : ADOPTED;
}

/** The key {@link AdoptedChanges} files one object of one table under. */
export function adoptedChangeKey(tableKey: string, kind: CatalogObjectKind, name: string): string {
	return JSON.stringify([tableKey, kind, name.toLowerCase()]);
}

/**
 * The changes one `apply schema` adopted, per object, newest last — each as what this machine's
 * engine held for the object BEFORE the change (undefined: nothing).
 *
 * A change *undoes* the newest adopted change to its object when it puts the object back to what
 * the engine held before that change. Quereus unwinds a failed apply by running each landed step's
 * undo in reverse order, and each undo restores exactly that pre-step state — the CHECK body it
 * dropped, or the absence of the CHECK it added — so the undo of an adopted step always matches.
 * A forward step never does: the differ only pairs a drop and an add of one CHECK when its body
 * changed, so the add carries a body other than the one the drop removed. That is the case the
 * per-object stack exists for: on a machine that adopted both halves of a changed-body pair, the
 * unwind undoes the add, then the drop, each against its own entry.
 *
 * Changes this machine made itself are not recorded: their undo is judged against the record like
 * any change, and finds the record holding exactly what this machine wrote.
 */
export class AdoptedChanges {
	private readonly adopted = new Map<string, (CatalogObject | undefined)[]>();

	/** Record that a change to `key` found the record already holding it; `before` is the engine's pre-change object. */
	adopt(key: string, before: CatalogObject | undefined): void {
		const stack = this.adopted.get(key) ?? [];
		stack.push(before);
		this.adopted.set(key, stack);
	}

	/** Whether a change leaving `key`'s object as `after` undoes the newest change adopted for it. */
	undoes(key: string, after: CatalogObject | undefined): boolean {
		const stack = this.adopted.get(key);
		return stack !== undefined && stack.length > 0 && sameCatalogObject(stack[stack.length - 1], after);
	}

	/** Forget the newest change adopted for `key`: its undo has run. */
	release(key: string): void {
		const stack = this.adopted.get(key);
		stack?.pop();
		if (stack?.length === 0) {
			this.adopted.delete(key);
		}
	}
}
