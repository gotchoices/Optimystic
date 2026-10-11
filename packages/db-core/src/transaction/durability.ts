import type { CollectionId } from "../collection/index.js";
import type { WriteDurability } from "../network/struct.js";
import { mergeDurability } from "../network/durability.js";

/** What a multi-collection commit wrote, and who holds it. */
export type TransactionDurability = {
	/** Every collection this commit durably wrote, across all of its attempts, with who holds it.
	 *  A key present with an `undefined` value means the collection IS saved, but the layer that
	 *  recognised it as saved could not say who holds it (a participant the refresh between
	 *  attempts finished without re-sending anything — see `RefreshReport.ownEntryFinished`). Test
	 *  with `has`, never with `get(...) !== undefined`, for "was it written". Never empty. */
	readonly collections: ReadonlyMap<CollectionId, WriteDurability | undefined>;
	/** `mergeDurability` over every value in `collections` — the weakest class, so a caller that
	 *  reads only this is reading the binding constraint. ABSENT when any collection's class is
	 *  unknown: the overall answer is never fabricated, and a caller testing
	 *  `overall !== undefined && isFullyDurable(overall)` then shows the transaction as pending. */
	readonly overall?: WriteDurability;
};

/**
 * Builds a {@link TransactionDurability} from what each collection reported. The map is copied, so
 * later writes to the caller's map do not reach the result.
 *
 * THROWS on an empty map, for the reason `mergeDurability` does: a commit that wrote something wrote
 * at least one collection, and one that wrote nothing has no report at all (`undefined`).
 */
export function transactionDurability(
	collections: ReadonlyMap<CollectionId, WriteDurability | undefined>
): TransactionDurability {
	if (collections.size === 0) {
		throw new Error('transactionDurability: no collections — a commit that wrote nothing reports undefined, not an empty durability');
	}
	const copy = new Map(collections);
	const known: WriteDurability[] = [];
	for (const d of copy.values()) {
		if (d === undefined) {
			return { collections: copy };
		}
		known.push(d);
	}
	return { collections: copy, overall: mergeDurability(known) };
}

/**
 * Merges one more report for a collection into a per-collection map: an absent key is set; when
 * either side is `undefined` the result is `undefined` (an unknown class is never upgraded to a
 * known one by a second report); otherwise the weaker of the two wins (`mergeDurability`).
 */
export function recordCollectionDurability(
	into: Map<CollectionId, WriteDurability | undefined>,
	id: CollectionId,
	d: WriteDurability | undefined
): void {
	if (!into.has(id)) {
		into.set(id, d);
		return;
	}
	const prev = into.get(id);
	into.set(id, prev === undefined || d === undefined ? undefined : mergeDurability([prev, d]));
}
