import { peerIdFromString } from '@libp2p/peer-id';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import type {
	ActionId, BlockId, IBlock, Log,
	DisputeResolutionProof, ArbitrationVoteProof, RevertedBlock,
} from '@optimystic/db-core';
import { applyTransform, hashString } from '@optimystic/db-core';
import type { IBlockStorage } from '../storage/i-block-storage.js';
import type { DisputeResolution, ArbitrationVote } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('invalidation');

/**
 * Marks a `reverted` block whose as-if-`T_inv`-absent state is a *deletion* (T_inv created the
 * block, so there is no prior content to restore). The single-collection core does not yet
 * physically remove such blocks — it records and logs them; the cascade ticket completes the
 * delete-restore path. Greppable sentinel so the deferral is never mistaken for a real hash.
 */
export const DEFERRED_DELETE_RESTORE = 'deferred:block-creation-reversal';

// ─── DisputeResolution → DisputeResolutionProof ───

/**
 * Projects a db-p2p {@link DisputeResolution} onto the db-core {@link DisputeResolutionProof} —
 * the independently-verifiable subset (outcome + signed votes) that an {@link InvalidationEntry}
 * carries. `messageHash` is the original transaction's hash (from the challenge), the anchor the
 * proof pins the reversal to.
 */
export function buildDisputeResolutionProof(resolution: DisputeResolution, messageHash: string): DisputeResolutionProof {
	return {
		disputeId: resolution.disputeId,
		messageHash,
		outcome: resolution.outcome,
		votes: resolution.votes.map(toVoteProof),
	};
}

function toVoteProof(vote: ArbitrationVote): ArbitrationVoteProof {
	return {
		arbitratorPeerId: vote.arbitratorPeerId,
		vote: vote.vote,
		computedHash: vote.evidence.computedHash,
		signature: vote.signature,
	};
}

// ─── Invalidation certificate verification ───

/**
 * Verifies that a {@link DisputeResolutionProof} is a valid invalidation certificate — the reversal
 * analogue of the commit certificate. A member accepts an invalidation **only** if this returns true:
 *
 *  - the claimed `outcome` is `challenger-wins`, AND
 *  - recomputing from the *cryptographically valid* votes alone, the `agree-with-challenger` votes
 *    meet the 2/3 super-majority of decisive votes (mirrors `DisputeService.resolveDispute`).
 *
 * Each vote's signature is verified against the Ed25519 public key embedded in its arbitrator's
 * peer id, over the exact payload the arbitrator signed (`${disputeId}:${vote}:${computedHash}`).
 * Votes with bad/forged/unparseable signatures are dropped before counting, so a single peer cannot
 * forge an invalidation by fabricating votes.
 */
export async function verifyInvalidationCertificate(proof: DisputeResolutionProof): Promise<boolean> {
	if (proof.outcome !== 'challenger-wins') {
		return false;
	}

	let challengerVotes = 0;
	let majorityVotes = 0;
	for (const vote of proof.votes) {
		if (!(await verifyVoteSignature(proof.disputeId, vote))) {
			continue;
		}
		if (vote.vote === 'agree-with-challenger') {
			challengerVotes++;
		} else if (vote.vote === 'agree-with-majority') {
			majorityVotes++;
		}
		// 'inconclusive' votes are valid but not decisive.
	}

	const totalDecisive = challengerVotes + majorityVotes;
	if (totalDecisive === 0) {
		return false;
	}
	const superMajorityThreshold = Math.ceil(totalDecisive * 2 / 3);
	return challengerVotes >= superMajorityThreshold;
}

/** Verify one arbitration vote's Ed25519 signature against its arbitrator peer id's embedded key. */
async function verifyVoteSignature(disputeId: string, vote: ArbitrationVoteProof): Promise<boolean> {
	try {
		const publicKey = peerIdFromString(vote.arbitratorPeerId).publicKey;
		if (!publicKey) {
			return false;
		}
		const payload = new TextEncoder().encode(`${disputeId}:${vote.vote}:${vote.computedHash}`);
		const sigBytes = uint8ArrayFromString(vote.signature, 'base64url');
		return await publicKey.verify(payload, sigBytes);
	} catch (err) {
		log('vote-signature-verify-error arbitrator=%s error=%o', vote.arbitratorPeerId, err);
		return false;
	}
}

// ─── Compensating-state computation ───

/**
 * The recomputed "as-if-`T_inv`-never-committed" state for a single block.
 *  - `restore`: the block existed before `T_inv`; `block` is its recomputed content (the revision
 *    immediately before `T_inv`, with any surviving later actions replayed on top).
 *  - `delete`: `T_inv` created the block, so the as-if-absent state is a deletion (deferred — see
 *    {@link DEFERRED_DELETE_RESTORE}).
 */
export type RevertedComputation =
	| { kind: 'restore'; block: IBlock; restoredContentHash: string; fromRev: number; laterActions: number }
	| { kind: 'delete'; fromRev: number };

/**
 * Reconstructs the compensating content for one block from stored revisions only (never by re-running
 * the engine — so it does not depend on engine availability and stays deterministic across members).
 *
 * Base = the block's content at `invalidatedRev - 1`. In the single-collection/no-cascade core,
 * "surviving later actions" = every committed action after `T_inv` on this block, replayed verbatim
 * on the rolled-back base (the cascade ticket replaces this blind replay with re-evaluation of true
 * read-dependents). Genuinely read-dependent successors are left as-is and logged.
 */
export async function computeRevertedBlock(blockStorage: IBlockStorage, invalidatedRev: number): Promise<RevertedComputation> {
	const latest = await blockStorage.getLatest();
	const fromRev = latest?.rev ?? invalidatedRev;

	// T_inv created this block (no prior revision) → as-if-absent is a deletion.
	if (invalidatedRev <= 1) {
		return { kind: 'delete', fromRev };
	}
	const base = await blockStorage.getBlock(invalidatedRev - 1);
	if (!base) {
		return { kind: 'delete', fromRev };
	}

	// Replay surviving later actions (committed strictly after T_inv) onto the rolled-back base.
	// Guard on `fromRev > invalidatedRev`: listRevisions treats start > end as a *descending*
	// range, so an unguarded listRevisions(invalidatedRev + 1, fromRev) when no later action
	// exists would wrongly re-include T_inv's own revision.
	let block: IBlock | undefined = base.block;
	let laterActions = 0;
	if (fromRev > invalidatedRev) {
		for await (const actionRev of blockStorage.listRevisions(invalidatedRev + 1, fromRev)) {
			const transform = await blockStorage.getTransaction(actionRev.actionId);
			if (!transform) {
				continue;
			}
			block = applyTransform(block, transform);
			laterActions++;
		}
	}
	if (!block) {
		return { kind: 'delete', fromRev };
	}
	const restoredContentHash = await hashString(stableStringify(block));
	return { kind: 'restore', block, restoredContentHash, fromRev, laterActions };
}

// ─── Deterministic apply ───

/** Everything the apply primitive needs from the host: the collection log and per-block storage. */
export type InvalidationContext = {
	/** The collection log of the collection `T_inv` wrote (where the compensating entry is appended). */
	readonly log: Log<unknown>;
	/** Resolves a block's storage so the compensating revision can be written. */
	readonly createBlockStorage: (blockId: BlockId) => IBlockStorage;
};

export type ApplyInvalidationParams = {
	readonly invalidatedActionId: ActionId;
	readonly invalidatedRev: number;
	/** Blocks `T_inv` wrote (its commit's blockIds). */
	readonly blockIds: ReadonlyArray<BlockId>;
	/** The invalidation certificate. */
	readonly proof: DisputeResolutionProof;
	/**
	 * Consensus-assigned revision slot for the compensating revision (collection-global). When
	 * omitted, computed as one past the highest current tip across the reverted blocks — the value a
	 * local/single-node apply uses; the consensus path passes the agreed slot.
	 */
	readonly rev?: number;
	readonly timestamp?: number;
};

export type ApplyInvalidationResult = {
	readonly applied: boolean;
	readonly reason?: 'already-applied' | 'invalid-certificate';
	readonly rev?: number;
	readonly reverted: ReadonlyArray<RevertedBlock>;
};

/**
 * Deterministically applies a single-collection invalidation: the durable reversal primitive every
 * cluster member runs identically (it carries the `reverted` targets and proof, exactly as the
 * consensus-apply path runs committed operations on every peer).
 *
 * Steps, in order:
 *  1. **Dedup** — if the log already holds an invalidation for `(invalidatedActionId, disputeId)`,
 *     this is a re-receipt (rebroadcast / sync / retry): no-op, append nothing.
 *  2. **Certificate** — reject (append nothing) unless `proof` is a valid challenger-wins certificate.
 *  3. **Reverted revisions** — for each block, recompute the as-if-`T_inv`-absent content and write a
 *     new monotonic revision (a forward compensating transform; prior revisions are retained).
 *  4. **Log entry** — append the {@link InvalidationEntry} carrying the proof and `reverted` targets,
 *     making `committed-invalidated` durable and recoverable on sync.
 */
export async function applyInvalidation(ctx: InvalidationContext, params: ApplyInvalidationParams): Promise<ApplyInvalidationResult> {
	const { invalidatedActionId, invalidatedRev, blockIds, proof } = params;

	// 1. Idempotent re-receipt — keyed on (invalidatedActionId, disputeId).
	const existing = await ctx.log.findInvalidation(invalidatedActionId);
	if (existing && existing.resolution.disputeId === proof.disputeId) {
		log('apply-skip-duplicate actionId=%s disputeId=%s', invalidatedActionId, proof.disputeId);
		return { applied: false, reason: 'already-applied', reverted: [...existing.reverted] };
	}

	// 2. Certificate verification — never trust a single peer's say-so.
	if (!(await verifyInvalidationCertificate(proof))) {
		log('apply-reject-certificate actionId=%s disputeId=%s outcome=%s', invalidatedActionId, proof.disputeId, proof.outcome);
		return { applied: false, reason: 'invalid-certificate', reverted: [] };
	}

	// 3. Compute compensating content + the collection-global revision slot.
	const computations = await Promise.all(
		blockIds.map(async (blockId) => {
			const storage = ctx.createBlockStorage(blockId);
			return { blockId, storage, computation: await computeRevertedBlock(storage, invalidatedRev) };
		})
	);
	const maxFromRev = computations.reduce((max, c) => Math.max(max, c.computation.fromRev), invalidatedRev);
	const rev = params.rev ?? maxFromRev + 1;

	const reverted: RevertedBlock[] = [];
	for (const { blockId, storage, computation } of computations) {
		if (computation.kind === 'delete') {
			// Block-creation reversal (delete-restore) is deferred to the cascade ticket — record + log,
			// do not physically remove. Never silently drop: surface it so the deferral is auditable.
			log('apply-defer-delete-restore blockId=%s invalidatedRev=%d', blockId, invalidatedRev);
			reverted.push({ blockId, fromRev: computation.fromRev, restoredContentHash: DEFERRED_DELETE_RESTORE });
			continue;
		}
		if (computation.laterActions > 0) {
			// Surviving later actions were replayed verbatim; true read-dependents are out of scope here.
			log('apply-replayed-later-actions blockId=%s count=%d', blockId, computation.laterActions);
		}
		// Deterministic compensating-revision actionId — identical on every member.
		const revertActionId = await hashString(`inv:${invalidatedActionId}:${proof.disputeId}:${blockId}:${rev}`);
		await storage.saveReplica(computation.block, { rev, actionId: revertActionId });
		reverted.push({ blockId, fromRev: computation.fromRev, restoredContentHash: computation.restoredContentHash });
	}

	// 4. Durable, append-only invalidation entry (the source of truth for committed-invalidated).
	await ctx.log.addInvalidation(invalidatedActionId, invalidatedRev, proof, reverted, rev, undefined, params.timestamp);
	log('apply-complete actionId=%s disputeId=%s rev=%d blocks=%d', invalidatedActionId, proof.disputeId, rev, reverted.length);

	return { applied: true, rev, reverted };
}

/** Deterministic, key-sorted JSON for content hashing — stable across members regardless of key order. */
function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = (v as Record<string, unknown>)[k]; return o; }, {})
			: v
	);
}
