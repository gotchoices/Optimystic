import type { BlockId, IBlock } from "../index.js";
import type { BlockBaseRevs, BlockContentDigests } from "../network/struct.js";
import { canonicalBlockHashAndBytes } from "../blocks/helpers.js";
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
// updated block's committed base is pinned at the moment its FIRST update is staged (Tracker.update
// -> BasePins), fixed there, and held until the transaction boundary, so a commit of any size
// declares 100% of the blocks whose bases it read — verified through the production path
// (`Collection.act`/`sync`) in `test/digest-cache-coverage.spec.ts` at 2x and 4x the cache capacity.
// `baseRev` is always the pin's revision: the one the operations were computed against, never the
// live cache's. The legitimate omissions: a delete (materializes to nothing); a blind update to a
// block this node never read (nothing to declare, and a commit must never pay a network read to
// describe itself); read-far-then-update — a block read, then evicted by 128+ other reads, and only
// then updated — which pins the revision but not the content, so the base is still named on the
// pend (`Tracker.stagedBaseRevs`) and only its digest is undeclared; and a base that MOVED under its
// staged operations, which is never declared at any revision (`Tracker.revalidatePin`) and is
// re-staged before it is pended (`Collection.restageIfBasesMoved`).
export async function computeBlockContentDigests<T extends IBlock>(
	tracker: Tracker<T>,
	blockIds: BlockId[]
): Promise<BlockContentDigests> {
	return (await describeTouchedBlocks(tracker, blockIds)).digests;
}

/** What a writer can say about the blocks a write touches, from one local materialization of each. */
export type TouchedBlocks = {
	/** The commit's declaration of what each block will contain ({@link computeBlockContentDigests}). */
	digests: BlockContentDigests;
	/** What each of the same blocks' post-write content encodes to, by `jsonEncodedBytes` — the measure
	 * `oversizedBlock` judges against `MAX_BLOCK_BYTES`. */
	bytes: Record<BlockId, number>;
};

/** {@link computeBlockContentDigests}, plus the size of every block it declares, taken from the
 * serialization the digest already hashes — the one pass both write paths make over their touched
 * blocks before anything is sent. Judging the sizes is the caller's separate step (`oversizedBlock`),
 * so declaring content still never breaks committing it.
 *
 * A block this pass cannot materialize is in neither map: neither declared nor measured. Those are the
 * omissions listed at {@link computeBlockContentDigests} — a deleted block, a blind update to a block
 * this node never read, an update whose base was evicted before it was staged, a base that moved under
 * its staged operations — and a base the staged operations would not apply to (`peekOrSkip`). So the
 * per-block size bound has the same gaps as the declaration: a block that outgrows `MAX_BLOCK_BYTES`
 * through an update this node cannot materialize is not refused by the writer. */
// NOTE: if a block is ever seen past MAX_BLOCK_BYTES after growing through one of those gaps, measure an
// unmeasured update-only block here by reading its base — the one exception that would make to a commit
// never paying a network read to describe itself. Its digest can stay undeclared.
export async function describeTouchedBlocks<T extends IBlock>(
	tracker: Tracker<T>,
	blockIds: BlockId[]
): Promise<TouchedBlocks> {
	const digests: BlockContentDigests = {};
	const bytes: Record<BlockId, number> = {};
	for (const id of blockIds) {
		const peeked = peekOrSkip(tracker, id);
		if (!peeked) continue;
		const described = await canonicalBlockHashAndBytes(peeked.block);
		digests[id] = {
			digest: described.hash,
			...(peeked.baseRev !== undefined ? { baseRev: peeked.baseRev } : {}),
		};
		bytes[id] = described.bytes;
	}
	return { digests, bytes };
}

/** Wraps `blockDigests` so it spreads onto a request only when there is something to declare. The
 * empty map omits the key entirely rather than sending `{}`: the request is hashed verbatim into
 * every cohort signature preimage, so a commit that declares nothing must serialize exactly as it
 * did before this field existed. Every producer of the field goes through here. */
export function blockDigestsField(digests: BlockContentDigests | undefined): { blockDigests?: BlockContentDigests } {
	return digests && !isRecordEmpty(digests) ? { blockDigests: digests } : {};
}

/** The pend-side sibling of {@link blockDigestsField}: wraps `PendRequest.baseRevs` so it spreads
 * onto a request only when some block names a base. Same reason — the pend is hashed verbatim into
 * every cohort signature preimage, so a pend that names no base must serialize exactly as it did
 * before the field existed. Every producer of the field goes through here. */
export function baseRevsField(baseRevs: BlockBaseRevs | undefined): { baseRevs?: BlockBaseRevs } {
	return baseRevs && !isRecordEmpty(baseRevs) ? { baseRevs } : {};
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
