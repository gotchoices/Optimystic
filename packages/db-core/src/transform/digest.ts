import type { BlockId, IBlock } from "../index.js";
import type { BlockContentDigests } from "../network/struct.js";
import { canonicalBlockHash } from "../blocks/helpers.js";
import { createLogger } from "../logger.js";
import { isRecordEmpty } from "../utility/is-record-empty.js";
import type { Tracker } from "./tracker.js";

const log = createLogger('digest');

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
