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
 * - {@link classifyCheckChange} and {@link classifyColumnChange} compare the change against the
 *   record: a change the record already holds is *adopted* (nothing written), any other is
 *   *owned* (written) — or, for a column, *refused* when the record contradicts it.
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
import { StatusCode } from '@quereus/quereus';
import type { StoredCheckConstraint, StoredColumnSchema, StoredTableSchema } from './schema-manager.js';

/** A named, possibly tagged object of a catalog record: a CHECK constraint or a column. */
export interface CatalogObject {
	readonly name?: string;
	readonly tags?: unknown;
}

/** The kinds of record object a catalog-only arm changes. */
export type CatalogObjectKind = 'check' | 'column';

/**
 * What a catalog-only arm does to the record: write its edit (`owned`), write nothing because the
 * record already holds the change (`adopted`), or refuse the statement with `message` under `code`.
 */
export type CatalogOnlyVerdict =
	| { readonly kind: 'owned' }
	| { readonly kind: 'adopted' }
	| { readonly kind: 'refused'; readonly message: string; readonly code: StatusCode };

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

/**
 * A column change as this machine's engine makes it: `add` appends `after`, `drop` removes the
 * column the engine holds as `before`. Both in the record's form (`columnSchemaToStored`).
 */
export type ColumnChange =
	| { readonly op: 'add'; readonly after: StoredColumnSchema }
	| { readonly op: 'drop'; readonly before: StoredColumnSchema };

/**
 * A column change judged against `record`:
 *
 * | change | record holds | verdict |
 * | --- | --- | --- |
 * | add | no column of that name | owned: append it |
 * | add | the same column | adopted |
 * | add | a different column of that name | refused (`ERROR`): another machine's upgrade disagrees |
 * | drop | the column, and nothing in the record keys on it | owned: remove it, whatever its definition |
 * | drop | the column, with something in the record keying on it ({@link columnDropBlockers}) | refused (`UNSUPPORTED`) |
 * | drop | no column of that name | adopted |
 *
 * A dropped column is removed whatever the record says it is: no host reuses a dropped name, so a
 * column the record defines differently is still the column being dropped. What in the record
 * keys on it is judged here because the record can hold what this engine has not seen — an index
 * another machine added since this one hydrated, say.
 */
export function classifyColumnChange(record: StoredTableSchema, change: ColumnChange): CatalogOnlyVerdict {
	if (change.op === 'add') {
		const held = findNamed(record.columns, change.after.name);
		if (held === undefined) {
			return OWNED;
		}
		return sameCatalogObject(held, change.after)
			? ADOPTED
			: {
				kind: 'refused',
				code: StatusCode.ERROR,
				message: `Cannot add column '${change.after.name}' to Optimystic table '${record.name}': the table's stored ` +
					`description already has a different column of that name, saved by another machine whose schema ` +
					`upgrade disagrees with this one. Retrying will not help.`,
			};
	}
	const position = positionOfNamed(record.columns, change.before.name);
	if (position === undefined) {
		return ADOPTED;
	}
	const blockers = columnDropBlockers(record, position);
	return blockers.length === 0
		? OWNED
		: { kind: 'refused', code: StatusCode.UNSUPPORTED, message: dropColumnRefusal(record.name, change.before.name, blockers, 'stored') };
}

/** The position of the entry of `items` named `name`, under {@link findNamed}'s name rule. */
export function positionOfNamed(items: readonly CatalogObject[], name: string): number | undefined {
	const lower = name.toLowerCase();
	const position = items.findIndex(item => item.name?.toLowerCase() === lower);
	return position < 0 ? undefined : position;
}

/**
 * The positional parts of a table's description, in the shape a Quereus `TableSchema` and a
 * catalog record (`StoredTableSchema`) share, so one rule judges both.
 */
export interface ColumnKeyedParts {
	readonly columns: readonly { readonly name: string; readonly generated: boolean }[];
	readonly primaryKeyDefinition: readonly { readonly index: number }[];
	readonly indexes?: readonly { readonly name: string; readonly columns: readonly { readonly index: number }[] }[];
	readonly uniqueConstraints?: readonly { readonly name?: string; readonly columns: readonly number[] }[];
	readonly foreignKeys?: readonly { readonly name?: string; readonly columns: readonly number[] }[];
	readonly generatedColumnDependencies?: Iterable<readonly [number, readonly number[]]>;
}

/**
 * Why the column at `position` cannot be dropped by changing the table's description alone, one
 * phrase each; empty when nothing stands in the way. A key, an index (declared, or a
 * unique-enforcement tree), a UNIQUE constraint and a FOREIGN KEY all key stored data on the
 * column's values, and a generated column's value is computed into its row — dropping any of them
 * would need rows or trees rewritten.
 *
 * NOTE: expressions are not judged — a CHECK, a DEFAULT or a generated expression naming the
 * column. Quereus refuses those against the engine's own catalog before the module is called; a
 * record holding one this engine has not seen (another machine added it) would keep naming a
 * column the record no longer has, and every machine that hydrates it would fail to plan writes to
 * the table. Reaching that takes two different upgrades of one table racing; if hosts ever apply
 * differing schema versions at once, judge the record's expressions here too.
 */
export function columnDropBlockers(parts: ColumnKeyedParts, position: number): string[] {
	const blockers: string[] = [];
	const named = (kind: string, name: string | undefined) => (name ? `${kind} '${name}'` : `a ${kind}`);
	if (parts.columns[position]?.generated) {
		blockers.push('it is a generated column');
	}
	if (parts.primaryKeyDefinition.some(pk => pk.index === position)) {
		blockers.push('it is in the primary key');
	}
	for (const idx of parts.indexes ?? []) {
		if (idx.columns.some(col => col.index === position)) blockers.push(`index '${idx.name}' covers it`);
	}
	for (const uc of parts.uniqueConstraints ?? []) {
		if (uc.columns.includes(position)) blockers.push(`${named('UNIQUE constraint', uc.name)} covers it`);
	}
	for (const fk of parts.foreignKeys ?? []) {
		if (fk.columns.includes(position)) blockers.push(`${named('foreign key', fk.name)} uses it`);
	}
	for (const [generated, dependencies] of parts.generatedColumnDependencies ?? []) {
		if (generated !== position && dependencies.includes(position)) {
			blockers.push(`generated column '${parts.columns[generated]?.name ?? `#${generated}`}' reads it`);
		}
	}
	return blockers;
}

/**
 * The refusal of a DROP COLUMN that {@link columnDropBlockers} stood in the way of. It starts with
 * the text the engine gave before the module had an `alterTable` hook, so a caller matching that
 * still matches. `stored` says the blockers are in the table's catalog record and not in this
 * machine's own catalog: another machine's change this one has not seen.
 */
export function dropColumnRefusal(table: string, column: string, blockers: readonly string[], where: 'engine' | 'stored'): string {
	const scope = where === 'stored' ? ` (in the table's stored description, saved by another machine)` : '';
	return `Module for table '${table}' does not support ALTER TABLE DROP COLUMN of '${column}'${scope}: ${blockers.join('; ')}`;
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
 * Columns take the same rule: the undo of an adopted ADD COLUMN is the DROP COLUMN that leaves the
 * column absent, which is what the engine held before the add. A DROP COLUMN has no undo (Quereus
 * marks it irreversible), so an adopted one is recorded and never matched.
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
