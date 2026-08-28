import type { BlockId, IBlock } from "../index.js";
import type { BlockContentDigests } from "../network/struct.js";
import { canonicalBlockHash } from "../blocks/helpers.js";
import type { Tracker } from "./tracker.js";

/** Digests for the blocks the tracker's staged transforms touch, computed WITHOUT loading anything
 * from the source. An id whose base is not already cached is omitted rather than fetched — an
 * omitted id simply falls back to corroboration downstream, so omission is always safe. Each digest
 * is the {@link canonicalBlockHash} of what {@link Tracker.peekMaterialized} says the block will
 * contain at the committing revision; `baseRev` rides along except for base-independent (inserted)
 * blocks. */
// NOTE: coverage is bounded by the read cache, not by the transaction. A commit whose update-carrying
// blocks outnumber the CacheSource capacity (default 128) silently digests only the ids still
// resident — omission degrades to corroboration rather than failing, so this is safe but quieter than
// it looks. If commits routinely touch more blocks than the cache holds, size the cache to the
// transaction or carry the base revision alongside the staged updates instead of re-reading it here.
export async function computeBlockContentDigests<T extends IBlock>(
	tracker: Tracker<T>,
	blockIds: BlockId[]
): Promise<BlockContentDigests> {
	const digests: BlockContentDigests = {};
	for (const id of blockIds) {
		// Declaring content must never break committing it. Materializing replays the staged ops
		// against the LOCALLY CACHED base, which can legitimately fail — e.g. another action's commit
		// folded into the cache (CacheSource.transformCache) shrank an array a staged splice indexes
		// into. That transaction is doomed, but it must die as a retryable stale failure from the
		// pend/commit round trip, not as a TypeError thrown out of sync() before the pend. Skipping
		// the id degrades to corroboration, exactly like an uncached base.
		let peeked: { block: IBlock; baseRev?: number } | undefined;
		try {
			peeked = tracker.peekMaterialized(id);
		} catch {
			continue;
		}
		if (!peeked) continue;
		digests[id] = {
			digest: await canonicalBlockHash(peeked.block),
			...(peeked.baseRev !== undefined ? { baseRev: peeked.baseRev } : {}),
		};
	}
	return digests;
}
