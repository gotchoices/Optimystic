import type { ActionRev, BlockGets, BlockId, IRepo } from "@optimystic/db-core";
import type { IHeldRevisionReader } from "../storage/storage-repo.js";

/**
 * The two halves of one exchange: a reader tells the coordinator it asks what the reader already holds
 * of each block ({@link BlockGets.askerHolds}), and the coordinator uses that statement as the reader's
 * answer to its cohort consult instead of asking the reader over the network.
 *
 * Why it matters: a coordinator's consult asks every other cohort member what it holds, and the reader
 * is often one of them. In a two-machine group the reader is the whole rest of the cohort, so without
 * the statement a read routed to the other machine costs two network exchanges where one would do: the
 * reader's request, and the coordinator asking the reader something the reader knew when it asked.
 */

/**
 * Wrap the repo a reader uses to reach ANOTHER machine so every read it sends states what this node
 * holds of the blocks it names. Only `get` changes; the write operations pass through untouched.
 *
 * Never wrap the reader's own coordinated repo: a read this node coordinates itself has no consult of
 * this node to replace (its own copy is the baseline, not a cohort answer).
 *
 * `local` is read afresh on every call, never cached: the statement must describe this node's store as
 * it is when the request goes out.
 *
 * NOTE: every read sent to another machine pays one local metadata read per block before it leaves,
 * including reads whose coordinator will ignore the statement (this node is not in that block's cohort,
 * or the coordinator predates the field). Negligible beside a network round trip on every backend
 * measured so far; if it ever shows in a profile, skip the statement for blocks this node is known not
 * to be a cohort member of rather than dropping it altogether.
 */
export function stateHoldingsOnReads(remote: IRepo, local: IHeldRevisionReader): IRepo {
	return {
		async get(blockGets, options) {
			const held = await local.heldRevisions(blockGets.blockIds);
			// Left off entirely when no block could be read, so such a request goes out exactly as before.
			const stated: BlockGets = Object.keys(held).length === 0 ? blockGets : { ...blockGets, askerHolds: held };
			return await remote.get(stated, options);
		},
		async pend(request, options) {
			return await remote.pend(request, options);
		},
		async cancel(actionRef, options) {
			return await remote.cancel(actionRef, options);
		},
		async commit(request, options) {
			return await remote.commit(request, options);
		}
	};
}

/**
 * What the asker of a read said it holds for one block, bound to the peer the request's connection
 * authenticated, and whether the statement may answer the consult in place of asking that peer.
 */
export interface AskerStatement {
	/** The asker, as the connection it asked on authenticated it (`MessageOptions.asker`). */
	peerId: string;
	/** Its stated committed latest, or `undefined` for "holds no committed revision". Never carries a
	 *  commit proof: a statement is the asker's bare word. (Where it names exactly the coordinator's own
	 *  revision, the coordinator weighs it with its OWN proof — `CoordinatorRepo.lendLocalProofToStandIn`.) */
	held: ActionRev | undefined;
	/** Whether the statement stands in for consulting the asker — see {@link askerStatementFor}. */
	standsIn: boolean;
}

/**
 * The asker's statement for `blockId`, or `undefined` when there is none to weigh: no authenticated
 * asker (a local call), no statement for this block, or a statement that is not a well-formed revision.
 * The request arrived as JSON from another machine, so every field is checked rather than trusted.
 *
 * `standsIn` is true exactly when using the statement in place of the consult loses nothing:
 *  - the asker holds nothing — its consult answer would be the same "nothing"; or
 *  - it holds a revision at or below `localLatest`, this coordinator's own copy — at an equal revision
 *    only under the same action. Nothing the asker holds is then ahead of the coordinator, so neither
 *    acquisition nor a doubt memo could come of asking it.
 *
 * Anything else is consulted as before: a revision ahead of the coordinator (it will need the asker's
 * archive and commit proof to acquire or judge it, and a stated revision carries neither), a different
 * action at the same revision (a divergence the consult's proof may settle), or any revision when the
 * coordinator holds none.
 */
export function askerStatementFor(
	blockGets: BlockGets,
	blockId: BlockId,
	asker: string | undefined,
	localLatest: ActionRev | undefined
): AskerStatement | undefined {
	if (asker === undefined) return undefined;
	const holds: unknown = blockGets.askerHolds;
	if (typeof holds !== 'object' || holds === null || !Object.prototype.hasOwnProperty.call(holds, blockId)) return undefined;
	const stated = (holds as Record<string, unknown>)[blockId];
	if (stated === null) return { peerId: asker, held: undefined, standsIn: true };
	if (!isActionRev(stated)) return undefined;
	// Copied field by field, so nothing else the sender attached (a `proof`, say) rides into the claim set.
	const held: ActionRev = { rev: stated.rev, actionId: stated.actionId };
	return { peerId: asker, held, standsIn: localLatest !== undefined && isAtOrBelow(held, localLatest) };
}

function isActionRev(value: unknown): value is ActionRev {
	if (typeof value !== 'object' || value === null) return false;
	const { rev, actionId } = value as Partial<ActionRev>;
	return Number.isSafeInteger(rev) && (rev as number) >= 0 && typeof actionId === 'string';
}

function isAtOrBelow(held: ActionRev, local: ActionRev): boolean {
	return held.rev < local.rev || (held.rev === local.rev && held.actionId === local.actionId);
}
