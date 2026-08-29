import type { BlockId, IBlock } from "../index.js";
import type { BlockContentDigests } from "../network/struct.js";
import { canonicalBlockHash } from "../blocks/helpers.js";
import { createLogger } from "../logger.js";
import { isRecordEmpty } from "../utility/is-record-empty.js";
import type { Tracker } from "./tracker.js";

const log = createLogger('digest');

/** Digests for the blocks the tracker's staged transforms touch, computed WITHOUT loading anything
 * from the source. An id whose base is not already cached is omitted rather than fetched — an
 * omitted id never fails the commit, it only forfeits what a declaration buys (see the NOTE below).
 * Each digest is the {@link canonicalBlockHash} of what {@link Tracker.peekMaterialized} says the
 * block will contain at the committing revision; `baseRev` rides along except for base-independent
 * (inserted) blocks. */
// NOTE: coverage is bounded by the read cache, not by the transaction. A commit whose update-carrying
// blocks outnumber the CacheSource capacity (default 128) silently digests only the ids still
// resident, and the declared count does not merely thin out — it CAPS. Measured through the
// production path (`Collection.act`/`sync`) in `test/digest-cache-coverage.spec.ts`: with N
// update-carrying blocks the declared count is 32/32 at N=32, then 126 at N=128, 200, 256 AND 512
// (126 = the 128 slots less the collection header and log tail), i.e. 100%, 98.4%, 63.0%, 49.2%,
// 24.6%. Coverage therefore decays as 1/N and an arbitrarily large commit declares an arbitrarily
// small fraction of itself. The survivors are the newest contiguous run, exactly as LRU eviction
// predicts.
// Omission also costs MORE than it used to: it still degrades gracefully on the read path, but an
// undeclared block retains no durable `BlockCommitProof` and so can never GAIN a holder by push.
// That consequence is stated once, canonically, at {@link CommitRequest.blockDigests} in
// `network/struct.ts`; do not restate it here.
// Still accepted here rather than fixed in place: both remedies are larger than this function —
// size the cache to the transaction, or carry the base revision alongside the staged updates instead
// of re-reading it here. Tracked as `debt-digest-coverage-capped-by-read-cache`. Revisit when a
// workload legitimately commits more update-carrying blocks than the cache holds.
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
