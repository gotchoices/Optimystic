/**
 * A schema's TAGS, one tag location at a time, and carrying them onto another schema.
 *
 * Quereus applies a tag edit (`alter table … set|add|drop tags`, the column, named-constraint and
 * index forms, and the `set tags` an `apply schema` emits for a tag-only change) by swapping its own
 * in-memory `TableSchema` and announcing the swap as `table_modified`; it never calls the module's
 * `alterTable`. The module recovers the edit from that announcement and applies it to two targets
 * with the same tag-bearing parts:
 *
 * - its own copy of the table's `TableSchema`, which mirrors this machine's engine and so takes
 *   every tag of the new schema ({@link withTagsOf});
 * - the table's catalog record, which other machines write too and can be newer than this machine's
 *   view, so it takes only what the announcement changed ({@link tagChangesBetween},
 *   {@link withTagsAt}), once judged against the record (`tagsToSave` in `./catalog-only-change.ts`).
 *
 * The unit is the *slot*: one place an edit can address tags ({@link tagSlots}). Quereus replaces a
 * slot's tags as a whole set, so a slot is compared and written whole.
 */

import { structuralEquals } from '@optimystic/db-core';
import type { SqlValue } from '@quereus/quereus';

export type Tags = Readonly<Record<string, SqlValue>>;

interface Tagged {
	readonly tags?: Tags;
}

interface NamedTagged extends Tagged {
	readonly name?: string;
}

interface UniqueTagged extends NamedTagged {
	readonly derivedFromIndex?: string;
}

/** The tag-bearing parts Quereus's `TableSchema` and the catalog record have in common. */
export interface TagBearingSchema extends Tagged {
	readonly columns: readonly NamedTagged[];
	readonly checkConstraints?: readonly NamedTagged[];
	readonly foreignKeys?: readonly NamedTagged[];
	readonly uniqueConstraints?: readonly UniqueTagged[];
	readonly indexes?: readonly NamedTagged[];
}

/** Each slot's tags; absent or empty tags are undefined. See {@link tagSlots}. */
export type TagSlots = ReadonlyMap<string, Tags | undefined>;

/** One slot whose tags a schema change replaced. */
export interface TagChange {
	readonly slot: string;
	readonly before: Tags | undefined;
	readonly after: Tags | undefined;
}

const TABLE_SLOT = 'table';

const TAGGED_LISTS = ['columns', 'checkConstraints', 'foreignKeys', 'uniqueConstraints', 'indexes'] as const;

type TaggedList = typeof TAGGED_LISTS[number];

/** A copy of `tags` when it has any, else undefined — so tag-free objects carry no key. */
export function copyTags(tags: Tags | undefined): Record<string, SqlValue> | undefined {
	return tags && Object.keys(tags).length > 0 ? { ...tags } : undefined;
}

/** Whether two tag sets are the same, an empty one being the same as none. */
export function sameTags(a: Tags | undefined, b: Tags | undefined): boolean {
	return structuralEquals(copyTags(a), copyTags(b));
}

/**
 * The slot `item` of `list` is, or undefined when no edit can address it: an unnamed constraint.
 * Names are lowercased, as Quereus compares them case-insensitively.
 *
 * NOTE: a UNIQUE constraint derived from a `CREATE UNIQUE INDEX` (`derivedFromIndex` set) is not a
 * slot: the catalog record has no place for it (hydrate rebuilds it from its index), so a tag edit
 * addressed to one through `alter constraint` cannot be saved — tags on the index itself are. If the
 * record ever stores derived constraints, make them slots here.
 */
function slotOf(list: TaggedList, item: UniqueTagged): string | undefined {
	if (item.name === undefined || (list === 'uniqueConstraints' && item.derivedFromIndex !== undefined)) {
		return undefined;
	}
	return `${list}:${item.name.toLowerCase()}`;
}

/**
 * Every slot of `schema` with its tags: the table's own, each column's, each NAMED CHECK, foreign
 * key and non-derived UNIQUE constraint's, and each index's.
 */
export function tagSlots(schema: TagBearingSchema): Map<string, Tags | undefined> {
	const slots = new Map<string, Tags | undefined>([[TABLE_SLOT, copyTags(schema.tags)]]);
	for (const list of TAGGED_LISTS) {
		for (const item of schema[list] ?? []) {
			const slot = slotOf(list, item);
			if (slot !== undefined) {
				slots.set(slot, copyTags(item.tags));
			}
		}
	}
	return slots;
}

/**
 * The slots whose tags differ between the schema a `table_modified` replaced and the one it installed.
 * Only a slot both schemas have counts. A slot only `newObject` has is an object that appeared, and
 * its tags reached the record through the hook that added the object (`alterCatalogOnly`,
 * `createIndex`). Treating them as a tag change would save, over the record, the tags of a CHECK that
 * Quereus's unwind re-added to this machine's catalog alone.
 *
 * NOTE: so an adopted added CHECK or column keeps the record's tags even when this machine's
 * declaration gives it different ones. That takes two machines applying different schema versions,
 * and the machine's next apply emits a `set tags` once it has hydrated the record; revisit if hosts
 * apply differing versions at once.
 */
export function tagChangesBetween(oldObject: TagBearingSchema, newObject: TagBearingSchema): TagChange[] {
	const held = tagSlots(oldObject);
	const changes: TagChange[] = [];
	for (const [slot, after] of tagSlots(newObject)) {
		if (held.has(slot) && !sameTags(held.get(slot), after)) {
			changes.push({ slot, before: held.get(slot), after });
		}
	}
	return changes;
}

/**
 * `target` with the tags of each slot `slots` names replaced by the tags given for it; every other
 * part keeps its tags. Absent or empty tags are OMITTED, so a tag-free object stays byte-identical
 * with a record written before. Produces new objects throughout and mutates neither argument (Quereus
 * freezes its arrays); every other field of `target` is carried over as it is.
 */
export function withTagsAt<T extends TagBearingSchema>(target: T, slots: TagSlots): T {
	const result: TagBearingSchema = {
		...(slots.has(TABLE_SLOT) ? withTags(target, slots.get(TABLE_SLOT)) : target),
		columns: retagged(target.columns, 'columns', slots),
		...(target.checkConstraints && { checkConstraints: retagged(target.checkConstraints, 'checkConstraints', slots) }),
		...(target.foreignKeys && { foreignKeys: retagged(target.foreignKeys, 'foreignKeys', slots) }),
		...(target.uniqueConstraints && { uniqueConstraints: retagged(target.uniqueConstraints, 'uniqueConstraints', slots) }),
		...(target.indexes && { indexes: retagged(target.indexes, 'indexes', slots) }),
	};
	// Sound: `result` is `target` with only the `tags` of `target` and of its list elements replaced.
	return result as T;
}

/**
 * `target` with every tag `source` can address replaced by `source`'s. Anything `source` has no
 * counterpart for — an unnamed constraint, which no ALTER can address, or a column `source` does not
 * list — keeps its tags.
 */
export function withTagsOf<T extends TagBearingSchema>(target: T, source: TagBearingSchema): T {
	return withTagsAt(target, tagSlots(source));
}

/** `items`, each one `slots` names carrying the tags given for it. */
function retagged<E extends UniqueTagged>(items: readonly E[], list: TaggedList, slots: TagSlots): E[] {
	return items.map(item => {
		const slot = slotOf(list, item);
		return slot !== undefined && slots.has(slot) ? withTags(item, slots.get(slot)) : item;
	});
}

/** `item` carrying `tags` — the key omitted when there are none. */
function withTags<E extends Tagged>(item: E, tags: Tags | undefined): E {
	const { tags: _replaced, ...rest } = item;
	const copied = copyTags(tags);
	return (copied ? { ...rest, tags: copied } : rest) as E;
}
