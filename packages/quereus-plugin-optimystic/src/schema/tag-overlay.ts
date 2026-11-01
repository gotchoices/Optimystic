/**
 * Carrying one schema's TAGS onto another, and nothing else.
 *
 * Quereus applies a tag edit (`alter table … set|add|drop tags`, the column, named-constraint and
 * index forms, and the `set tags` an `apply schema` emits for a tag-only change) by swapping its own
 * in-memory `TableSchema` and announcing the swap as `table_modified`; it never calls the module's
 * `alterTable`. The module recovers the edit from that announcement and overlays the new schema's
 * tags onto two targets: its own copy of the table's `TableSchema`, and the table's catalog record.
 * Both have the same tag-bearing parts, so one function serves both ({@link withTagsOf}).
 */

import type { SqlValue } from '@quereus/quereus';

type Tags = Readonly<Record<string, SqlValue>>;

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

/** A copy of `tags` when it has any, else undefined — so tag-free objects carry no key. */
export function copyTags(tags: Tags | undefined): Record<string, SqlValue> | undefined {
	return tags && Object.keys(tags).length > 0 ? { ...tags } : undefined;
}

/**
 * `target` with every tag `source` can address replaced by `source`'s: the table's own tags, each
 * column's (matched by name), each NAMED CHECK, foreign key and non-derived UNIQUE constraint's
 * (matched by name within its class), and each index's (matched by name). Names are compared
 * case-insensitively, as Quereus compares them. Anything `source` has no counterpart for — an
 * unnamed constraint, which no ALTER can address, or a column `source` does not list — keeps its
 * tags. Absent or empty tags are OMITTED, so a tag-free object stays byte-identical with a record
 * written before. Produces new objects throughout and mutates neither argument (Quereus freezes
 * its arrays); every other field of `target` is carried over as it is.
 */
export function withTagsOf<T extends TagBearingSchema>(target: T, source: TagBearingSchema): T {
	const result: TagBearingSchema = {
		...withTags(target, source.tags),
		columns: overlayByName(target.columns, source.columns, isNamed),
		...(target.checkConstraints && { checkConstraints: overlayByName(target.checkConstraints, source.checkConstraints, isNamed) }),
		...(target.foreignKeys && { foreignKeys: overlayByName(target.foreignKeys, source.foreignKeys, isNamed) }),
		// NOTE: a UNIQUE constraint derived from a `CREATE UNIQUE INDEX` (`derivedFromIndex` set) is
		// not overlaid: the catalog record has no slot for it (hydrate rebuilds it from its index), so
		// a tag edit addressed to one through `alter constraint` cannot be saved — tags on the index
		// itself are. If the record ever stores derived constraints, overlay them here.
		...(target.uniqueConstraints && {
			uniqueConstraints: overlayByName(target.uniqueConstraints, source.uniqueConstraints, isNamedNonDerived),
		}),
		...(target.indexes && { indexes: overlayByName(target.indexes, source.indexes, isNamed) }),
	};
	// Sound: `result` is `target` with only the `tags` of `target` and of its list elements replaced.
	return result as T;
}

function isNamed(item: NamedTagged): boolean {
	return item.name !== undefined;
}

function isNamedNonDerived(item: UniqueTagged): boolean {
	return item.name !== undefined && item.derivedFromIndex === undefined;
}

/** `items`, each addressable one carrying the tags of the addressable `sources` entry of the same name. */
function overlayByName<E extends NamedTagged>(
	items: readonly E[],
	sources: readonly UniqueTagged[] | undefined,
	addressable: (item: UniqueTagged) => boolean,
): E[] {
	const byName = new Map<string, Tagged>();
	for (const source of sources ?? []) {
		if (addressable(source)) {
			byName.set(source.name!.toLowerCase(), source);
		}
	}
	return items.map(item => {
		const source = addressable(item) ? byName.get(item.name!.toLowerCase()) : undefined;
		return source ? withTags(item, source.tags) : item;
	});
}

/** `item` carrying `tags` — the key omitted when there are none. */
function withTags<E extends Tagged>(item: E, tags: Tags | undefined): E {
	const { tags: _replaced, ...rest } = item;
	const copied = copyTags(tags);
	return (copied ? { ...rest, tags: copied } : rest) as E;
}
