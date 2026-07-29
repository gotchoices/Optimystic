import type { ActionRev, BlockId, IBlock } from "@optimystic/db-core";
import type { BlockArchive } from "../storage/struct.js";
import type { ReconcileBlockCallback } from "./cluster-repo.js";
import type { IPeerReputation } from "../reputation/types.js";
import { PenaltyReason } from "../reputation/types.js";
import {
	selectQuorumRev, selectQuorumBlock, canonicalBlockHash,
	type RevClaim, type BlockHashCandidate, type QuorumRev
} from "./quorum-restore.js";
import { createLogger } from '../logger.js';

const log = createLogger('reconcile-block');

/**
 * Wall-clock bound on one whole reconcile pass (all cohort peers, both quorums, the persist).
 * Shared by both callers so a slow or unreachable cohort peer stalls neither the commit path
 * (`ClusterMember.withReconcileTimeout` — a stall there holds up consensus execution) nor the read
 * path (`CoordinatorRepo.restoreCorroborated` — a stall there holds up a caller's `get`).
 */
export const RECONCILE_TIMEOUT_MS = 5000;

/** One cohort peer's answer for a block: its highest revision, and the block bytes if it carried them. */
interface ReconcileCandidate {
	peerId: string;
	rev: number;
	actionId: string;
	/** Present only when the serving archive carried a materialized block for `rev`. */
	block?: IBlock;
}

/** Collaborators {@link createReconcileBlock} needs, injected so the logic stays transport-agnostic. */
export interface ReconcileBlockDeps {
	/** This node's own peer id; excluded from the cohort targets. */
	selfPeerId: string;
	/** Fetch one cohort peer's archive for `blockId` — `undefined` when it is unreachable or holds nothing. */
	fetchArchive: (peerId: string, blockId: BlockId) => Promise<BlockArchive | undefined>;
	/** Persist the agreed content through the churn-replication funnel. */
	saveReplicatedBlock: (blockId: BlockId, block: IBlock, source: ActionRev) => Promise<void>;
	/** Proportional corroboration threshold; the cohort's `simpleMajorityThreshold`. */
	simpleMajorityThreshold: number;
	/** Configured full cluster size — the floor for {@link corroboratorCapacity}. */
	clusterSize: number;
	/** Best-effort misbehavior reporting; a throwing implementation is swallowed. */
	reputation?: Pick<IPeerReputation, 'reportPeer'>;
}

/**
 * How many peers other than this node could answer for the block at all. Mirrors
 * `CoordinatorRepo.corroboratorCapacity` exactly, and for the same reason: the corroboration
 * floor may be relaxed only for a cohort that is *genuinely* small, never for one that merely
 * looks small. `cohortPeerIds` come from the (untrusted) coordinator-declared peer set, so a
 * self-shrunk record could otherwise talk the requirement down to a single voter; taking the MAX
 * against the configured `clusterSize` keeps that shrunken view out of the relaxed branch. The
 * escape hatch for a real two-node deployment is to configure `clusterSize: 2`.
 */
function corroboratorCapacity(targets: string[], clusterSize: number): number {
	return Math.max(targets.length, clusterSize - 1);
}

/**
 * The claim a peer's archive makes: its highest revision, provided that revision is at least the
 * one we committed. `undefined` when the peer served nothing usable (unreachable, empty archive,
 * or only revisions older than the commit we are healing).
 */
function toCandidate(peerId: string, archive: BlockArchive | undefined, committedRev: number): ReconcileCandidate | undefined {
	if (!archive) return undefined;
	const revs = Object.keys(archive.revisions).map(Number);
	if (revs.length === 0) return undefined;
	const maxRev = Math.max(...revs);
	if (maxRev < committedRev) return undefined;
	const data = archive.revisions[maxRev];
	if (!data?.action) return undefined;
	return { peerId, rev: maxRev, actionId: data.action.actionId, block: data.block };
}

/** Hash the block bytes of every candidate that both corroborates `selected` and actually carried content. */
async function hashCarriers(candidates: ReconcileCandidate[], selected: QuorumRev): Promise<BlockHashCandidate[]> {
	const carriers = candidates.filter(c => c.rev === selected.rev && c.actionId === selected.actionId && c.block);
	return await Promise.all(
		carriers.map(async c => ({ peerId: c.peerId, hash: await canonicalBlockHash(c.block!), block: c.block! }))
	);
}

/** Report cohort members that served content contradicting the agreed hash. Best-effort; never throws. */
function penalizeContradictingContent(
	reputation: Pick<IPeerReputation, 'reportPeer'> | undefined,
	candidates: BlockHashCandidate[],
	agreedHash: string,
	blockId: BlockId
): void {
	if (!reputation) return;
	try {
		for (const c of candidates) {
			if (c.hash !== agreedHash) {
				reputation.reportPeer(c.peerId, PenaltyReason.InvalidRestoration, `reconcile:${blockId}`);
			}
		}
	} catch (err) {
		log('reconcile:penalize-error', { blockId, error: (err as Error).message });
	}
}

/**
 * Active reconciliation for a block this member committed without a materializable base
 * (cohort drift between the independent pend and commit cluster-transactions, or a refused
 * `missing-base-revision` commit). Queries the commit cohort — self already excluded by
 * `ClusterMember.reconcileDivergentCommit` — for the block, picks the target revision by quorum
 * corroboration rather than raw `Math.max` (a lone peer inflating its rev cannot steer
 * reconciliation), verifies the cohort agrees on the *content* at that revision, and persists it.
 *
 * Both quorums are capped by {@link corroboratorCapacity}: demanding two corroborators from a
 * cohort that contains exactly one other peer is a permanent deadlock, not a safety property —
 * the node can never heal and stays unreadable forever.
 *
 * **Exposure at capacity 1 (documented, not accidental).** Block ids are random 256-bit strings
 * (`db-core` `structs.ts`), NOT content-addressed, so nothing on the receive path can re-derive
 * the id from the bytes: `canonicalBlockHash` is a cross-peer *agreement* hash, never a check
 * against `blockId`. A sole cohort peer's content is therefore believed on its word. That adds no
 * trust the cohort had not already extended — the same peer's `(rev, actionId)` claim is likewise
 * uncorroborable at that size (see `selectQuorumRev`'s capacity note), and a two-member cohort has
 * no honest majority to appeal to in the first place. Closing it needs commit-cert verification,
 * tracked by backlog `debt-read-repair-commit-cert-verification`.
 *
 * Declines are cheap and retryable: nothing is persisted, nothing is marked, and the next commit
 * or churn/rebalance pass tries again.
 */
export function createReconcileBlock(deps: ReconcileBlockDeps): ReconcileBlockCallback {
	return async (blockId, committed, cohortPeerIds) => {
		const targets = cohortPeerIds.filter(id => id !== deps.selfPeerId);
		if (targets.length === 0) return;

		const fetched = await Promise.all(
			targets.map(async peerId => toCandidate(peerId, await deps.fetchArchive(peerId, blockId), committed.rev))
		);
		const candidates = fetched.filter((c): c is ReconcileCandidate => c !== undefined);
		const capacity = corroboratorCapacity(targets, deps.clusterSize);

		const revClaims: RevClaim[] = candidates.map(({ peerId, rev, actionId }) => ({ peerId, rev, actionId }));
		const selected = selectQuorumRev(revClaims, deps.simpleMajorityThreshold, capacity);
		if (!selected) {
			// Leave the block behind; churn/rebalance and the next commit retry.
			log('reconcile:no-rev-quorum', { blockId, rev: committed.rev, responders: revClaims.length, capacity });
			return;
		}

		const hashCandidates = await hashCarriers(candidates, selected);
		const agreed = selectQuorumBlock(hashCandidates, deps.simpleMajorityThreshold, capacity);
		if (!agreed) {
			log('reconcile:no-content-quorum', { blockId, rev: selected.rev, carriers: hashCandidates.length, capacity });
			return;
		}

		penalizeContradictingContent(deps.reputation, hashCandidates, agreed.hash, blockId);

		await deps.saveReplicatedBlock(blockId, agreed.block, { actionId: selected.actionId, rev: selected.rev });
		log('reconcile:restored', { blockId, rev: selected.rev, actionId: selected.actionId });
	};
}
