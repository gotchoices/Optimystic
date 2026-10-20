import type { ActionId, BlockId, ClusterRecord, MemberApplyOutcome, RepoMessage, WriteFailure } from "@optimystic/db-core";
import { LruMap, blockIdsForTransforms, isConflictFailure } from "@optimystic/db-core";
import { createLogger } from '../logger.js'

const log = createLogger('cluster')

/** At most this many pend actions' late refusals are held. */
const MaxLatePendRefusalActions = 1024;

/** A member's own report, when it is a conflict-shaped pend refusal — the only pend report that means anything. */
export function conflictPendRefusalOf(outcome: MemberApplyOutcome | undefined): WriteFailure | undefined {
	const pend = outcome?.pend;
	return pend !== undefined && !pend.success && isConflictFailure(pend) ? pend : undefined;
}

/**
 * Each action a message pends, with every block its pend operations name. A batch pends several
 * collections under one action, and a member's report answers for the whole record, so its refusal
 * is held once under all of the batch's blocks — a commit of any of those collections takes it.
 */
function pendsOf(message: RepoMessage): { actionId: ActionId; blockIds: BlockId[] }[] {
	const byAction = new Map<ActionId, BlockId[]>();
	for (const op of message.operations) {
		if (!('pend' in op)) continue;
		byAction.set(op.pend.actionId, [...(byAction.get(op.pend.actionId) ?? []), ...blockIdsForTransforms(op.pend.transforms)]);
	}
	return [...byAction].map(([actionId, blockIds]) => ({ actionId, blockIds }));
}

/** A conflict-shaped pend refusal a member reported after the pend's writer was answered. */
interface LatePendRefusal {
	readonly peerId: string;
	/** The refused pend record's, so a re-delivery of the same record replaces rather than duplicates. */
	readonly messageHash: string;
	readonly refusal: WriteFailure;
	/**
	 * The blocks the refused pend named. Every collection of a multi-collection transaction pends and
	 * commits under the transaction's one action id, concurrently, so only a commit (or a new pend) of
	 * one of these blocks may take the refusal — another collection's commit settling first would
	 * otherwise consume it, and leave this collection's commit throwing.
	 */
	readonly blockIds: ReadonlySet<BlockId>;
	/** The pend record's expiration: past it, the refusal answers nothing. */
	readonly expiresAt: number;
}

/**
 * Conflict-shaped pend refusals that arrived after the pend's writer was answered — reported by a
 * member that applied the pend record only on a carried delivery or a scheduled retry of it — held
 * by the pend's action id, each naming the pend's blocks, until a commit of those blocks takes them
 * or the record expires. `CoordinatorRepo.commit` answers a commit that threw with such a refusal:
 * the retryable conflict the pend would have returned had the member applied it in time.
 */
export class LatePendRefusals {
	private readonly held = new LruMap<ActionId, LatePendRefusal[]>(MaxLatePendRefusalActions);

	/**
	 * Keep each conflict-shaped pend refusal in `outcomes`, a delivery's reports for the pend `record`.
	 * `selfId`'s own report is skipped: its verdict reached the writer with the pend's answer.
	 */
	retain(record: ClusterRecord, outcomes: ClusterRecord['applyOutcomes'], selfId: string | undefined): void {
		const pends = pendsOf(record.message);
		if (outcomes === undefined || pends.length === 0) return;
		const { messageHash } = record;
		const expiresAt = record.message.expiration ?? Number.POSITIVE_INFINITY;
		for (const [peerId, outcome] of Object.entries(outcomes)) {
			const refusal = peerId === selfId ? undefined : conflictPendRefusalOf(outcome);
			if (refusal === undefined) continue;
			for (const { actionId, blockIds } of pends) {
				const held = (this.held.get(actionId) ?? [])
					.filter(late => late.peerId !== peerId || late.messageHash !== messageHash);
				held.push({ peerId, messageHash, refusal, blockIds: new Set(blockIds), expiresAt });
				this.held.set(actionId, held);
				log('cluster-tx:late-pend-refusal', { messageHash, actionId, peerId, reason: refusal.reason });
			}
		}
	}

	/**
	 * Return and forget the refusals held for `actionId` on any of `blockIds`, keyed by peer; empty
	 * when there are none, or when the pend record they belong to had expired by `now`. Refusals of the
	 * action's pends of other blocks — another collection of the same transaction — stay for their own
	 * commit.
	 */
	take(actionId: ActionId, blockIds: readonly BlockId[], now: number): { [peerId: string]: WriteFailure } {
		const held = this.held.get(actionId);
		if (held === undefined) return {};
		const taken: { [peerId: string]: WriteFailure } = {};
		const kept: LatePendRefusal[] = [];
		for (const late of held) {
			if (late.expiresAt < now) continue;
			if (blockIds.some(blockId => late.blockIds.has(blockId))) {
				taken[late.peerId] ??= late.refusal;
			} else {
				kept.push(late);
			}
		}
		if (kept.length === 0) this.held.delete(actionId);
		else this.held.set(actionId, kept);
		return taken;
	}

	/**
	 * Forget what is held for the blocks a new pend `message` names. A writer's retry reuses its action
	 * id, so a refusal of an earlier attempt's pend of these blocks must not be read back by this
	 * attempt's commit.
	 *
	 * NOTE: the earlier attempt's record can still be retrying, and a refusal its timer delivers after
	 * this point is read by this attempt's commit; the cost is a thrown commit answered as a retryable
	 * conflict. If that shows up, keep only refusals of the action's latest pend record.
	 */
	forgetFor(message: RepoMessage, now: number): void {
		for (const { actionId, blockIds } of pendsOf(message)) this.take(actionId, blockIds, now);
	}
}
