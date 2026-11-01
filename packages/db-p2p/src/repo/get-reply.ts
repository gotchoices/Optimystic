import type { BlockGets, BlockId, GetBlockResult, GetBlockResults } from "@optimystic/db-core";
import { jsonEncodedBytes } from "@optimystic/db-core";

/**
 * A remote `get` is answered in ONE repo-protocol frame, and the reader's decoder refuses a frame over
 * `MAX_BLOCK_MESSAGE_BYTES` outright. So a read whose blocks on one coordinator add up to more than a
 * frame used to fail for every one of them, though each fits on its own. `RepoService` therefore packs
 * the reply ({@link fitGetReply}), naming each block it left out for size, and `RepoClient.get` asks
 * the same peer again for those ({@link readGetReply}, {@link narrowBlockGets}) until every block is
 * answered. A left-out entry is a db-p2p wire detail: `RepoClient.get` never returns one, so nothing
 * above it learns that a block arrived in a later round.
 */

/**
 * Why a block's entry was left out of a packed reply. `'size'`: carrying it would have taken the reply
 * past its content budget (`GET_REPLY_CONTENT_BUDGET_BYTES`). A reader treats any reason, including one
 * a newer build sends, as "ask again".
 */
export type GetEntryLeftOut = 'size';

/** What a packed reply carries in place of the entry of a block it left out. */
export type LeftOutGetEntry = { leftOut: GetEntryLeftOut };

/**
 * A `get` as `RepoClient` sends it. `acceptsLeftOut` says the asker reads {@link LeftOutGetEntry}, and
 * only such a request is packed: a reader that predates the field would take a left-out entry, which
 * carries no block, for an authoritative "never created". It is answered whole, as before, and a reply
 * too large for one frame fails for it as it always did.
 */
export type RepoBlockGets = BlockGets & { acceptsLeftOut?: true };

/** The reply `RepoService` sends to a {@link RepoBlockGets} that accepts left-out entries. */
export type RepoGetReply = Record<BlockId, GetBlockResult | LeftOutGetEntry>;

export function isLeftOut(entry: unknown): entry is LeftOutGetEntry {
	return typeof entry === 'object' && entry !== null && 'leftOut' in entry;
}

/**
 * `results` packed into `budgetBytes`, in request order: the first entry is always carried whole, so
 * every reply answers at least one block, and each further entry is carried whole while the running
 * total of the JSON-encoded size of the entries stays within the budget. Every other entry is replaced
 * by a left-out entry, whose own size counts toward the total too. A reply of one entry is returned
 * without measuring, so a one-block read costs nothing extra.
 *
 * The budget sits below the frame by the room the left-out entries and the JSON around the entries
 * need: an entry kept past the budget is only ever the first.
 *
 * NOTE: measuring encodes each entry once more than sending it does; the same accepted cost as
 * `fitConsultContent`'s, paid only by reads of several blocks.
 *
 * NOTE: a left-out entry is a few dozen bytes, so the reserve between `GET_REPLY_CONTENT_BUDGET_BYTES`
 * and the frame holds several thousand of them. A read naming more blocks than that on one coordinator,
 * none of which fit, would still overflow the frame; if reads ever get that wide, stop answering ids
 * past a count and leave them for the next round the same way.
 */
export function fitGetReply(results: GetBlockResults, blockIds: readonly BlockId[], budgetBytes: number): RepoGetReply {
	const order = inRequestOrder(results, blockIds);
	if (order.length <= 1) return results;
	const leftOut: LeftOutGetEntry = { leftOut: 'size' };
	const leftOutBytes = (blockId: BlockId) => jsonEncodedBytes([blockId, leftOut]);
	const reply: RepoGetReply = {};
	let spent = 0;
	for (const [index, blockId] of order.entries()) {
		const entry = results[blockId]!;
		const size = jsonEncodedBytes([blockId, entry]);
		if (index === 0 || spent + size <= budgetBytes) {
			reply[blockId] = entry;
			spent += size;
		} else {
			reply[blockId] = leftOut;
			spent += leftOutBytes(blockId);
		}
	}
	return reply;
}

/** The ids `results` answers, the requested ones first in request order, then any it answers unasked. */
function inRequestOrder(results: GetBlockResults, blockIds: readonly BlockId[]): BlockId[] {
	const requested = [...new Set(blockIds)].filter(blockId => Object.prototype.hasOwnProperty.call(results, blockId));
	const asked = new Set(requested);
	return [...requested, ...Object.keys(results).filter(blockId => !asked.has(blockId))];
}

/**
 * A reply split into the entries it answered and the requested ids it left out. An entry it carries
 * for an id that was not asked is passed through as an answer, as a whole reply always was; a left-out
 * entry for one is dropped, since nobody will ask for it. A reply that is not an object answers nothing.
 */
export function readGetReply(reply: unknown, asked: readonly BlockId[]): { answered: GetBlockResults, leftOut: BlockId[] } {
	const answered: GetBlockResults = {};
	const leftOut: BlockId[] = [];
	if (typeof reply !== 'object' || reply === null) return { answered, leftOut };
	const requested = new Set(asked);
	for (const [blockId, entry] of Object.entries(reply)) {
		if (!isLeftOut(entry)) answered[blockId] = entry as GetBlockResult;
		else if (requested.has(blockId)) leftOut.push(blockId);
	}
	return { answered, leftOut };
}

/**
 * `blockGets` asking for `blockIds` alone: the same context and lineage question, and each per-block
 * field — the asker's floors and its statement of what it holds — cut down to those ids, and left off
 * when none of them has an entry, as the first request would have left it off.
 */
export function narrowBlockGets(blockGets: BlockGets, blockIds: BlockId[]): BlockGets {
	const { floors, askerHolds, ...rest } = blockGets;
	const narrowedFloors = floors === undefined ? undefined : subsetOf(floors, blockIds);
	const narrowedHolds = askerHolds === undefined ? undefined : subsetOf(askerHolds, blockIds);
	return {
		...rest,
		blockIds,
		...(narrowedFloors === undefined ? {} : { floors: narrowedFloors }),
		...(narrowedHolds === undefined ? {} : { askerHolds: narrowedHolds }),
	};
}

function subsetOf<T>(record: Record<BlockId, T>, blockIds: readonly BlockId[]): Record<BlockId, T> | undefined {
	const kept = blockIds.filter(blockId => Object.prototype.hasOwnProperty.call(record, blockId));
	return kept.length === 0 ? undefined : Object.fromEntries(kept.map(blockId => [blockId, record[blockId] as T]));
}
