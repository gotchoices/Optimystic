import type { BlockId, IBlock } from "../index.js";
import type { BlockContentDigests } from "../network/struct.js";
import { canonicalBlockHash } from "../blocks/helpers.js";
import { createLogger } from "../logger.js";
import { isRecordEmpty } from "../utility/is-record-empty.js";
import type { Tracker } from "./tracker.js";

const log = createLogger('digest');

/** Digests for the blocks the tracker's staged transforms touch, computed WITHOUT loading anything
 * from the source. An id whose base is neither pinned nor cached is omitted rather than fetched —
 * an omitted id never fails the commit, it only forfeits what a declaration buys (an undeclared
 * block retains no durable `BlockCommitProof` and so can never GAIN a holder by push; stated once,
 * canonically, at {@link CommitRequest.blockDigests} in `network/struct.ts`).
 * Each digest is the {@link canonicalBlockHash} of what {@link Tracker.peekMaterialized} says the
 * block will contain at the committing revision; `baseRev` rides along except for base-independent
 * (inserted) blocks. */
// NOTE: declarability follows what the transaction read and staged, not read-cache residency. Each
// updated block's committed base is pinned at the moment its update is staged (Tracker.update ->
// BasePins) and held until the transaction boundary, so a commit of any size declares 100% of the
// blocks whose bases it read — verified through the production path (`Collection.act`/`sync`) in
// `test/digest-cache-coverage.spec.ts` at 2x and 4x the cache capacity. The two remaining
// legitimate omissions: a delete (materializes to nothing) and a blind update to a block this node
// never read whose base is not cached (nothing to declare, and a commit must never pay a network
// read to describe itself). Residual gap: read-far-then-update — a block read, then evicted by
// 128+ other reads, and only then updated, finds nothing to pin; see the NOTE at the pin site in
// `tracker.ts`.
export async function computeBlockContentDigests<T extends IBlock>(
	tracker: Tracker<T>,
	blockIds: BlockId[]
): Promise<BlockContentDigests> {
	const digests: BlockContentDigests = {};
	for (const id of blockIds) {
		const peeked = peekOrSkip(tracker, id);
		if (!peeked) continue;
		digests[id] = {
			digest: await canonicalBlockHash(peeked.block),
			...(peeked.baseRev !== undefined ? { baseRev: peeked.baseRev } : {}),
		};
	}
	return digests;
}

/** Wraps `blockDigests` so it spreads onto a request only when there is something to declare. The
 * empty map omits the key entirely rather than sending `{}`: the request is hashed verbatim into
 * every cohort signature preimage, so a commit that declares nothing must serialize exactly as it
 * did before this field existed. Every producer of the field goes through here. */
export function blockDigestsField(digests: BlockContentDigests | undefined): { blockDigests?: BlockContentDigests } {
	return digests && !isRecordEmpty(digests) ? { blockDigests: digests } : {};
}

/** {@link Tracker.peekMaterialized}, degraded to "undeclared" when materializing throws.
 *
 * Declaring content must never break committing it. Materializing replays the staged ops against the
 * LOCALLY CACHED base, which can legitimately fail — e.g. another action's commit folded into the
 * cache (`CacheSource.transformCache`) shrank an array a staged splice indexes into. That transaction
 * is doomed, but it must die as a retryable stale failure from the pend/commit round trip, not as a
 * TypeError thrown out of `sync()` before the pend. The failure is logged rather than silently eaten,
 * because the same swallow would also hide a genuine `applyTransform` bug. */
function peekOrSkip<T extends IBlock>(tracker: Tracker<T>, id: BlockId): { block: IBlock; baseRev?: number } | undefined {
	try {
		return tracker.peekMaterialized(id);
	} catch (e) {
		log('block %s left undeclared: materializing against the cached base failed: %o', id, e);
		return undefined;
	}
}
