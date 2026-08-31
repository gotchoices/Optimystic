import { peerIdFromString } from '@libp2p/peer-id';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import type {
	ActionId, ActionRev, BlockId, IBlock, Log,
	DisputeResolutionProof, ArbitrationVoteProof, RevertedBlock,
} from '@optimystic/db-core';
import { applyTransform, hashString } from '@optimystic/db-core';
import type { IBlockStorage } from '../storage/i-block-storage.js';
import { acquireBlockWriteLatches } from '../storage/block-latch.js';
import type { DisputeResolution, ArbitrationVote } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('invalidation');

/**
 * Accepted arbitration-vote wire-format version. The v3 signed payload binds each vote to BOTH the
 * specific reversed transaction (`targetHash`, #2) and the legitimately-selected arbitrator set
 * (`setHash`, #1); v1/v2 (un-set-bound) votes are rejected, never accepted-by-default.
 */
export const VOTE_VERSION = 'v3' as const;

/**
 * The transaction an invalidation certificate's votes are bound to — the committed action being
 * reversed and the blocks it wrote. Threaded into {@link verifyInvalidationCertificate} so a genuine
 * `challenger-wins` proof for transaction X cannot be replayed to revert an unrelated transaction Y:
 * the arbitrators signed over X's `targetHash`, so verifying against any other target makes every
 * signature fail → 0 decisive votes → reject.
 */
export type CertificateTarget = {
	readonly invalidatedActionId: ActionId;
	readonly blockIds: ReadonlyArray<BlockId>;
};

/**
 * Binds a vote to its reversal target: `hashString(`${messageHash}|${invalidatedActionId}|${sortedBlockIds}`)`.
 * `blockIds` are lexically sorted so the binding is independent of the order a member happens to list
 * them, and {@link hashString} is the same db-core helper the compensating-state computation uses, so
 * every member recomputes an identical `targetHash`.
 */
export async function computeTargetHash(messageHash: string, target: CertificateTarget): Promise<string> {
	const sortedBlockIds = [...target.blockIds].sort();
	return await hashString(`${messageHash}|${target.invalidatedActionId}|${sortedBlockIds.join(',')}`);
}

/**
 * Digest of the legitimately-selected arbitrator set (#1) — `hashString(sortedArbitratorSet.join(','))`.
 * Peer-ids are lexically sorted so the digest is independent of the order any party happens to list the
 * set in, and every member (arbitrators signing votes, the challenger signing the set, the verifier)
 * recomputes an identical `setHash`.
 */
export async function computeArbitratorSetHash(arbitratorSet: ReadonlyArray<string>): Promise<string> {
	return await hashString([...arbitratorSet].sort().join(','));
}

/**
 * The exact bytes an arbitrator signs for a v3 vote — `utf8(`v3:${disputeId}:${vote}:${computedHash}:${targetHash}:${setHash}`)`.
 * Shared by the origination path ({@link makeVote in dispute-service}) and {@link verifyVoteSignature}
 * so the signed and verified preimages can never drift.
 */
export function voteSigningPayload(disputeId: string, vote: string, computedHash: string, targetHash: string, setHash: string): Uint8Array {
	return new TextEncoder().encode(`${VOTE_VERSION}:${disputeId}:${vote}:${computedHash}:${targetHash}:${setHash}`);
}

/**
 * The exact bytes the **challenger** signs to bind `(disputeId, target, arbitratorSet)` —
 * `utf8(`v3set:${disputeId}:${targetHash}:${setHash}`)`. Verified against the challenger's embedded key
 * ({@link DisputeResolutionProof.challengerPeerId}); shared with the origination path so it can never drift.
 * The version marker is derived from {@link VOTE_VERSION} (currently `v3` → `v3set`) so a future format
 * bump moves the vote and set preimages together — a proof is wholly one wire version, never a mix.
 */
export function arbitratorSetSigningPayload(disputeId: string, targetHash: string, setHash: string): Uint8Array {
	return new TextEncoder().encode(`${VOTE_VERSION}set:${disputeId}:${targetHash}:${setHash}`);
}

/**
 * Context handed to an {@link ArbitratorSetRecompute} capability: everything it needs to re-derive the
 * legitimate arbitrator set from the verifying member's own topology and judge the carried set against it.
 */
export type ArbitratorSetRecomputeContext = {
	readonly disputeId: string;
	readonly messageHash: string;
	readonly invalidatedActionId: ActionId;
	readonly blockIds: ReadonlyArray<BlockId>;
	/** The carried set being judged (peer-id strings). */
	readonly arbitratorSet: ReadonlyArray<string>;
	/**
	 * Escalation round the carried set was drawn at (0-based). A recompute capability MUST feed this to
	 * `sampleArbitrators` so it re-derives the SAME dispersed draw. Today every dispute is round 0
	 * (single-round arbitration), so the verify path pins it to 0; `design-dispute-synchronous-escalation`
	 * threads the real round through the proof and updates this seam.
	 */
	readonly round: number;
	/**
	 * Agreed membership epoch the carried set was drawn against — the bytes `sampleArbitrators` folds into
	 * every coordinate. A recompute capability MUST feed this so its re-derivation matches the original
	 * draw. Optional until `design-dispute-synchronous-escalation` carries/derives it on the proof; while
	 * absent a recompute cannot reconstruct the draw and should return `{ feasible: false }` (degradation),
	 * which matches today's behavior — no recompute capability is wired in production.
	 */
	readonly epoch?: Uint8Array;
};

/**
 * Verdict from an {@link ArbitratorSetRecompute}:
 *  - `{ feasible: false }` — the member could not reconstruct the historical selection (late-joiner,
 *    churned DHT view); the verifier falls through to the degradation posture (layer-1 accept + log).
 *  - `{ feasible: true, legitimate }` — it recomputed the eligible set and judged whether the carried
 *    `arbitratorSet` matches it (within whatever churn tolerance the capability applies).
 */
export type ArbitratorSetVerdict =
	| { readonly feasible: false }
	| { readonly feasible: true; readonly legitimate: boolean };

/**
 * Injected **layer-2** capability: re-derives the legitimately-selected arbitrator set from the verifying
 * member's topology view (it has `peerNetwork` / FRET routing) and judges the carried set. Supplied by
 * callers that hold a network (e.g. `ClusterMember.applyConsensusInvalidation`); the pure
 * {@link verifyInvalidationCertificate} stays usable without it (layer-1 + degradation). Closing the
 * fully-malicious-challenger vector requires this layer (or the layer-3 trust anchor).
 */
export type ArbitratorSetRecompute = (ctx: ArbitratorSetRecomputeContext) => Promise<ArbitratorSetVerdict>;

/** Reported when a certificate is accepted on layer-1 alone — see {@link VerifyCertificateOptions.onUnanchored}. */
export type UnanchoredAcceptanceInfo = {
	readonly disputeId: string;
	readonly arbitratorSet: ReadonlyArray<string>;
	/** Why the stronger layers did not apply. */
	readonly reason: 'no-recompute-capability' | 'recompute-infeasible';
};

/** Optional capabilities a caller threads into {@link verifyInvalidationCertificate} when it has a network. */
export type VerifyCertificateOptions = {
	/** Layer-2 recompute capability; omitted → pure layer-1 verification with the documented degradation. */
	readonly recomputeArbitratorSet?: ArbitratorSetRecompute;
	/**
	 * Invoked when the certificate is accepted on the challenger-bound set + membership + dedup ALONE —
	 * the interim posture when neither recompute (layer 2) nor a trust anchor (layer 3) resolved the set.
	 * Lets a caller surface "applied an invalidation it could not fully anchor" alongside the internal log.
	 */
	readonly onUnanchored?: (info: UnanchoredAcceptanceInfo) => void;
};

/**
 * Marks a `reverted` block whose as-if-`T_inv`-absent state is a *deletion* (T_inv created the
 * block, so there is no prior content to restore). {@link applyInvalidation} now physically removes
 * such blocks (a forward tombstone via {@link IBlockStorage.saveDeletion}); this sentinel is the
 * `restoredContentHash` it records for the deleted block, telling read-dependents "the observed
 * content no longer exists → invalidate" (a created block can never equal "absent"). Greppable so it
 * is never mistaken for a real content hash.
 */
export const DELETED_BLOCK_RESTORE = 'deleted:block-creation-reverted';

// ─── DisputeResolution → DisputeResolutionProof ───

/**
 * The arbitrator-set binding a proof carries (#1): the legitimately-selected set, the challenger that
 * selected it, and the challenger's signature over `(disputeId, target, arbitratorSet)`. Assembled by
 * the originator ({@link DisputeService.maybeInvalidate}), which holds the selected set from
 * `initiateDispute` and signs it with the challenger's key.
 */
export type ArbitratorSetBinding = {
	readonly arbitratorSet: ReadonlyArray<string>;
	readonly challengerPeerId: string;
	readonly arbitratorSetSignature: string;
};

/**
 * Projects a db-p2p {@link DisputeResolution} onto the db-core {@link DisputeResolutionProof} —
 * the independently-verifiable subset (outcome + signed votes + arbitrator-set binding) that an
 * {@link InvalidationEntry} carries. `messageHash` is the original transaction's hash (from the
 * challenge), the anchor the proof pins the reversal to; `binding` carries the legitimately-selected
 * arbitrator set and the challenger's signature over it (#1).
 */
export function buildDisputeResolutionProof(resolution: DisputeResolution, messageHash: string, binding: ArbitratorSetBinding): DisputeResolutionProof {
	return {
		disputeId: resolution.disputeId,
		messageHash,
		outcome: resolution.outcome,
		challengerPeerId: binding.challengerPeerId,
		arbitratorSet: binding.arbitratorSet,
		arbitratorSetSignature: binding.arbitratorSetSignature,
		votes: resolution.votes.map(toVoteProof),
	};
}

function toVoteProof(vote: ArbitrationVote): ArbitrationVoteProof {
	return {
		version: vote.version,
		arbitratorPeerId: vote.arbitratorPeerId,
		vote: vote.vote,
		computedHash: vote.evidence.computedHash,
		signature: vote.signature,
	};
}

// ─── Invalidation certificate verification ───

/**
 * Verifies that a {@link DisputeResolutionProof} is a valid invalidation certificate — the reversal
 * analogue of the commit certificate. A member accepts an invalidation **only** if this returns true.
 * Defense-in-depth, strongest-available-layer-wins:
 *
 * **Target binding (#2).** `target` is the transaction actually being reverted; the verifier recomputes
 * `targetHash` from `proof.messageHash` + `target` and checks each vote's signature over the v3 payload
 * `v3:${disputeId}:${vote}:${computedHash}:${targetHash}:${setHash}`. Because the arbitrators signed the
 * *real* transaction's `targetHash`, feeding any other target (a replay against an innocent transaction)
 * makes every signature fail. A vote whose version is absent/unrecognized (legacy/v1/v2) is rejected
 * before counting — never accepted-by-default.
 *
 * **Arbitrator-set binding (#1) — layer 1 (always).** The proof carries `arbitratorSet` (the K peer-ids
 * the challenger selected) and `arbitratorSetSignature` (the challenger's signature over
 * `(disputeId, target, arbitratorSet)`, verified against `challengerPeerId`'s embedded key). The verifier:
 *  - rejects a proof missing the set / challenger fields;
 *  - rejects a proof whose challenger signature does not validate over the recomputed `(targetHash, setHash)`
 *    — so tampering with the set (adding sybils) breaks the certificate;
 *  - counts only votes whose `arbitratorPeerId` ∈ `arbitratorSet` (a signature-valid vote from a peer
 *    outside the set is dropped), and whose vote payload also commits to the same `setHash`.
 * This closes the third-party-relay / originator sybil vector and binds the originator. It does NOT by
 * itself stop a *fully-malicious* challenger (who legitimately holds its own key and signs a sybil set it
 * minted) — that needs layer 2 or 3.
 *
 * **Per-arbitrator dedup (#3).** Among the in-set votes, decisive verdicts are tallied at most once per
 * `arbitratorPeerId`: a repeated identical decisive vote counts once; an arbitrator with conflicting
 * decisive votes (equivocation) is dropped from both sides. `inconclusive` votes are non-decisive.
 *
 * **Recompute — layer 2 (best effort).** When `options.recomputeArbitratorSet` is supplied (the caller
 * holds a topology view), the carried set is re-derived and judged. A `{feasible:true, legitimate:false}`
 * verdict rejects the certificate even though layer 1 passed — closing the malicious-challenger vector.
 * `{feasible:false}` (member can't reconstruct the historical topology) falls through to degradation.
 *
 * **Degradation (layer 3 / none-available).** With no recompute capability (or an infeasible recompute)
 * and no trust anchor yet, a layer-1-valid certificate is **accepted and logged** as not-fully-anchored
 * (and `options.onUnanchored` is invoked) — never a silent accept-by-default, and never a false reject
 * that would break liveness for late-joiners. This is the interim posture until the cohort-topic
 * membership-cert trust-anchor chain lands (`tickets/plan/cohort-topic-membership-cert-trust-anchoring.md`),
 * at which point it is upgraded to a hard gate.
 */
export async function verifyInvalidationCertificate(proof: DisputeResolutionProof, target: CertificateTarget, options: VerifyCertificateOptions = {}): Promise<boolean> {
	if (proof.outcome !== 'challenger-wins') {
		return false;
	}

	// Structural: a v3 certificate must carry the arbitrator-set binding. Absent → reject (never accept a
	// pre-set-binding proof by default).
	if (!proof.arbitratorSet?.length || !proof.challengerPeerId || !proof.arbitratorSetSignature) {
		return false;
	}

	const targetHash = await computeTargetHash(proof.messageHash, target);
	const setHash = await computeArbitratorSetHash(proof.arbitratorSet);

	// Layer 1a: challenger binds (disputeId, target, arbitratorSet). A tampered set breaks this signature.
	if (!(await verifyChallengerSetSignature(proof, targetHash, setHash))) {
		log('verify-reject-challenger-set-signature disputeId=%s challenger=%s', proof.disputeId, proof.challengerPeerId);
		return false;
	}

	// Layer 1b: count only signature-valid, target+set-bound, in-set votes — deduped/equivocation-dropped.
	const arbitratorSet = new Set(proof.arbitratorSet);
	type Decisive = 'agree-with-challenger' | 'agree-with-majority';
	const decisiveByArbitrator = new Map<string, Decisive | 'equivocated'>();
	for (const vote of proof.votes) {
		if (!arbitratorSet.has(vote.arbitratorPeerId)) {
			continue; // not a legitimately-selected arbitrator → never counted (#1)
		}
		if (!(await verifyVoteSignature(proof.disputeId, vote, targetHash, setHash))) {
			continue;
		}
		if (vote.vote !== 'agree-with-challenger' && vote.vote !== 'agree-with-majority') {
			continue; // 'inconclusive' — valid but not decisive
		}
		const prior = decisiveByArbitrator.get(vote.arbitratorPeerId);
		if (prior === undefined) {
			decisiveByArbitrator.set(vote.arbitratorPeerId, vote.vote);
		} else if (prior !== 'equivocated' && prior !== vote.vote) {
			// Same arbitrator, conflicting decisive votes → drop entirely (do not let one peer be on both sides).
			decisiveByArbitrator.set(vote.arbitratorPeerId, 'equivocated');
		}
		// prior === vote.vote (duplicate) or already 'equivocated': counted at most once, no change.
	}

	let challengerVotes = 0;
	let majorityVotes = 0;
	for (const decision of decisiveByArbitrator.values()) {
		if (decision === 'agree-with-challenger') {
			challengerVotes++;
		} else if (decision === 'agree-with-majority') {
			majorityVotes++;
		}
	}

	const totalDecisive = challengerVotes + majorityVotes;
	if (totalDecisive === 0) {
		return false;
	}
	const superMajorityThreshold = Math.ceil(totalDecisive * 2 / 3);
	if (challengerVotes < superMajorityThreshold) {
		return false;
	}

	// Layer 2: re-derive the eligible set from the member's own topology when it can — closes a
	// fully-malicious challenger that self-signed a sybil set that passed layer 1.
	if (options.recomputeArbitratorSet) {
		const verdict = await options.recomputeArbitratorSet({
			disputeId: proof.disputeId,
			messageHash: proof.messageHash,
			invalidatedActionId: target.invalidatedActionId,
			blockIds: target.blockIds,
			arbitratorSet: proof.arbitratorSet,
			// NOTE: `round` pinned to 0 (single-round arbitration today) and `epoch` omitted until
			// `design-dispute-synchronous-escalation` threads the real (round, epoch) through the proof, so a
			// `sampleArbitrators`-based recompute re-derives the identical dispersed set. Until then no recompute
			// capability is wired in production; the test recomputes ignore these fields.
			round: 0,
		});
		if (verdict.feasible) {
			if (!verdict.legitimate) {
				log('verify-reject-recompute-mismatch disputeId=%s', proof.disputeId);
				return false;
			}
			return true; // fully anchored to the recomputed topology
		}
		// infeasible → fall through to the documented degradation posture
		return acceptUnanchored(proof, 'recompute-infeasible', options);
	}

	// Layer 3 / none-available: accept on layer 1 alone, but never silently — log + surface the residual.
	return acceptUnanchored(proof, 'no-recompute-capability', options);
}

/**
 * Accept-and-log a layer-1-valid certificate that could not be fully anchored (no recompute capability
 * or an infeasible recompute, and no trust anchor yet). Documented interim posture — never a silent
 * accept. Returns true.
 */
function acceptUnanchored(proof: DisputeResolutionProof, reason: UnanchoredAcceptanceInfo['reason'], options: VerifyCertificateOptions): boolean {
	log('verify-accept-unanchored disputeId=%s reason=%s setSize=%d', proof.disputeId, reason, proof.arbitratorSet.length);
	try {
		options.onUnanchored?.({ disputeId: proof.disputeId, arbitratorSet: proof.arbitratorSet, reason });
	} catch (err) {
		log('verify-onUnanchored-error disputeId=%s error=%o', proof.disputeId, err);
	}
	return true;
}

/**
 * Verify the challenger's signature binding `(disputeId, target, arbitratorSet)` against the embedded
 * Ed25519 key in `proof.challengerPeerId`. Closes the third-party-relay sybil vector: a relay cannot
 * swap the carried set without the challenger's key.
 */
async function verifyChallengerSetSignature(proof: DisputeResolutionProof, targetHash: string, setHash: string): Promise<boolean> {
	try {
		const publicKey = peerIdFromString(proof.challengerPeerId).publicKey;
		if (!publicKey) {
			return false;
		}
		const payload = arbitratorSetSigningPayload(proof.disputeId, targetHash, setHash);
		const sigBytes = uint8ArrayFromString(proof.arbitratorSetSignature, 'base64url');
		return await publicKey.verify(payload, sigBytes);
	} catch (err) {
		log('challenger-set-signature-verify-error challenger=%s error=%o', proof.challengerPeerId, err);
		return false;
	}
}

/**
 * Verify one arbitration vote's Ed25519 signature against its arbitrator peer id's embedded key, over
 * the **target- and set-bound v3 payload**. Rejects any vote that is not the v3 format before trusting
 * it, so a legacy/unversioned (v1/v2) vote can never slip through.
 */
async function verifyVoteSignature(disputeId: string, vote: ArbitrationVoteProof, targetHash: string, setHash: string): Promise<boolean> {
	// Runtime gate: `vote` arrives off the wire, so its `version` may not match the declared type.
	if (vote.version !== VOTE_VERSION) {
		return false;
	}
	try {
		const publicKey = peerIdFromString(vote.arbitratorPeerId).publicKey;
		if (!publicKey) {
			return false;
		}
		const payload = voteSigningPayload(disputeId, vote.vote, vote.computedHash, targetHash, setHash);
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
 *  - `delete`: `T_inv` created the block, so the as-if-absent state is a deletion (physically removed
 *    by {@link applyInvalidation} via a tombstone — see {@link DELETED_BLOCK_RESTORE}).
 */
export type RevertedComputation =
	| { kind: 'restore'; block: IBlock; restoredContentHash: string; fromRev: number; laterActions: number }
	| { kind: 'delete'; fromRev: number };

/**
 * Reconstructs the compensating content for one block from stored revisions only (never by re-running
 * the engine — so it does not depend on engine availability and stays deterministic across members).
 *
 * Base = the block's content at the highest stored revision strictly before `T_inv` (no such revision
 * ⇒ `T_inv` created the block ⇒ a deletion). In the single-collection/no-cascade core, "surviving later
 * actions" = every committed action after `T_inv` on this block, replayed verbatim on the rolled-back
 * base. The cascade (see `cascade.ts`) layers true read-dependent re-evaluation on top of this blind
 * replay — it reverts the genuine successors this primitive leaves as-is and logs.
 */
export async function computeRevertedBlock(blockStorage: IBlockStorage, invalidatedRev: number): Promise<RevertedComputation> {
	const latest = await blockStorage.getLatest();
	const fromRev = latest?.rev ?? invalidatedRev;

	// Find the highest stored revision strictly before T_inv — the base to roll back to. A descending
	// listRevisions(invalidatedRev - 1, 1) yields it first (same descending-scan pattern materializeBlock
	// uses, so no new cost class). No such revision ⇒ T_inv CREATED this block ⇒ the as-if-absent state is
	// a deletion — at ANY rev, without throwing (the previous `invalidatedRev <= 1` special-case folds into
	// this: at rev <= 1 the probe is skipped and priorRev stays undefined). We intentionally do NOT replay
	// surviving later actions onto an absent base: replaying an update on `undefined` stays `undefined`, and
	// any later writer of a created-then-reverted block is itself a read-dependent the cascade (`cascade.ts`)
	// re-evaluates and reverts.
	let priorRev: number | undefined;
	if (invalidatedRev > 1) {
		for await (const ar of blockStorage.listRevisions(invalidatedRev - 1, 1)) {
			priorRev = ar.rev;
			break;
		}
	}
	if (priorRev === undefined) {
		return { kind: 'delete', fromRev };
	}
	const base = await blockStorage.getBlock(priorRev);
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
	const restoredContentHash = await hashBlockContent(block);
	return { kind: 'restore', block, restoredContentHash, fromRev, laterActions };
}

/**
 * Deterministic content hash for a materialized block — the single hashing convention shared by
 * the compensating-state computation ({@link computeRevertedBlock}) and the cascade re-evaluator
 * (`db-p2p/src/dispute/cascade.ts`). Both must agree byte-for-byte: the cascade decides whether a
 * read-dependent still holds by comparing the hash of the content it *observed* against the
 * `restoredContentHash` an invalidation recorded — so the two hashes have to be produced the same way.
 */
export async function hashBlockContent(block: IBlock): Promise<string> {
	return await hashString(stableStringify(block));
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
	 * omitted, computed as one past the highest current tip across the reverted blocks — read under
	 * the blocks' write latches, so an omitted slot is strictly past every tip and its compensating
	 * writes can never be refused by the monotonic guard.
	 *
	 * An explicit slot at or below any affected block's tip is refused wholesale (`applied: false`,
	 * reason `stale-revision`) rather than partially written.
	 *
	 * NOTE: nothing on the wire supplies this today. `InvalidateRequest`
	 * (`db-core/src/network/struct.ts`) carries `invalidatedActionId` / `invalidatedRev` / `blockIds` /
	 * `collectionId` / `resolution` and NO compensating-revision field, so the network-facing apply
	 * path leaves this undefined and every member computes its own slot locally. The `stale-revision`
	 * path is therefore reachable only from tests and from a future caller that does pass an agreed
	 * slot; adding that wire field is out of scope here.
	 */
	readonly rev?: number;
	/**
	 * When this invalidation is a cascade step (a read-dependent of an already-invalidated root being
	 * reverted), the `actionId` of the root invalidation that triggered the cascade. Recorded on the
	 * resulting {@link InvalidationEntry} (`cascadeRoot`) so the reversal is auditable as part of one
	 * logical cascade event. Absent for a root invalidation.
	 */
	readonly cascadeRoot?: ActionId;
	/**
	 * The target the proof's votes are bound to — the transaction the dispute actually resolved. For a
	 * **root** invalidation this equals this call's own `(invalidatedActionId, blockIds)` and may be
	 * omitted (defaulted below). A **cascade child** reuses the *root's* proof to authorize reverting a
	 * read-dependent whose own target differs, so it MUST pass the root's target here: the votes were
	 * signed over the root's `targetHash`, not the child's. The child-specific justification is the
	 * deterministic cascade derivation every member replays — not the certificate, which only attests
	 * the root is invalid. (The network-facing apply path `applyConsensusInvalidation` never sets this:
	 * it verifies against the request's *own* target, which is the replay boundary this ticket closes.)
	 */
	readonly certificateTarget?: CertificateTarget;
	readonly timestamp?: number;
};

export type ApplyInvalidationResult = {
	readonly applied: boolean;
	/**
	 *  - `already-applied` — a re-receipt; the log already holds this `(invalidatedActionId, disputeId)`.
	 *    `reverted` carries the EXISTING entry's blocks, so a caller can reuse them.
	 *  - `invalid-certificate` — the proof is not a valid challenger-wins certificate for the target.
	 *  - `stale-revision` — at least one affected block already sits at or past the compensating
	 *    revision slot, so the compensating write would be refused by the monotonic guard. Nothing was
	 *    written and nothing was appended (all-or-nothing); the invalidation is safely re-deliverable
	 *    once the caller supplies a slot past every affected block's tip. Reachable only when the
	 *    caller supplies an explicit {@link ApplyInvalidationParams.rev} — a slot this function
	 *    computes itself is strictly past every tip by construction.
	 */
	readonly reason?: 'already-applied' | 'invalid-certificate' | 'stale-revision';
	readonly rev?: number;
	readonly reverted: ReadonlyArray<RevertedBlock>;
};

/**
 * Boundary invariant for the compensating write: the effective `ActionRev` a forward write returns
 * must be the one we intended. The precheck above already establishes that, so a mismatch means a
 * write path refused for a reason the precheck does not model — an internal contradiction (a write
 * refused while its latch was held and its tip was checked), not a condition to degrade around. It
 * throws rather than returning `applied: false`: `ClusterRepo.applyConsensusInvalidation` tolerates a
 * sink throw, logs it, and rolls back its dedup marker so a re-broadcast retries.
 */
function assertWriteLanded(blockId: BlockId, intended: ActionRev, effective: ActionRev): void {
	if (effective.rev !== intended.rev || effective.actionId !== intended.actionId) {
		throw new Error(
			`Invalidation compensating write did not land for block ${blockId}: intended ` +
			`{ rev: ${intended.rev}, actionId: ${intended.actionId} }, effective ` +
			`{ rev: ${effective.rev}, actionId: ${effective.actionId} }`
		);
	}
}

/**
 * Deterministically applies a single-collection invalidation: the durable reversal primitive every
 * cluster member runs identically (it carries the `reverted` targets and proof, exactly as the
 * consensus-apply path runs committed operations on every peer).
 *
 * Steps, in order:
 *  1. **Dedup** — if the log already holds an invalidation for `(invalidatedActionId, disputeId)`,
 *     this is a re-receipt (rebroadcast / sync / retry): no-op, append nothing.
 *  2. **Certificate** — reject (append nothing) unless `proof` is a valid challenger-wins certificate.
 *  3. **Reverted revisions** — holding EVERY affected block's write latch, recompute each block's
 *     as-if-`T_inv`-absent content and write a new monotonic revision (a forward compensating
 *     transform; prior revisions are retained). All-or-nothing: if any block already sits at or past
 *     the compensating slot, nothing is written and nothing is appended.
 *  4. **Log entry** — append the {@link InvalidationEntry} carrying the proof and `reverted` targets,
 *     making `committed-invalidated` durable and recoverable on sync.
 *
 * The `reverted` entries an applied result carries therefore describe writes that ACTUALLY landed,
 * at the revision and with the content hash they name — the property `cascade.ts` relies on when it
 * decides a read-dependent's fate by comparing observed content against `restoredContentHash`.
 */
export async function applyInvalidation(ctx: InvalidationContext, params: ApplyInvalidationParams): Promise<ApplyInvalidationResult> {
	const { invalidatedActionId, invalidatedRev, blockIds, proof } = params;

	// 1. Idempotent re-receipt — keyed on (invalidatedActionId, disputeId).
	// NOTE: this read is outside the block latches taken in step 3, so two OVERLAPPING applies of the
	// same invalidation would both pass here and both write a compensating revision (the second at a
	// slot one past the first), appending two entries for one invalidation. Not reachable today: the
	// network path serializes through consensus and dedups in memory first
	// (`ClusterRepo.applyConsensusInvalidation`), and the cascade applies its children sequentially.
	// If a caller ever applies the same invalidation concurrently, this dedup has to move inside the
	// critical section — which means keying it on something the block latches actually cover, since
	// `ctx.log` is not latched by them.
	const existing = await ctx.log.findInvalidation(invalidatedActionId);
	if (existing && existing.resolution.disputeId === proof.disputeId) {
		log('apply-skip-duplicate actionId=%s disputeId=%s', invalidatedActionId, proof.disputeId);
		return { applied: false, reason: 'already-applied', reverted: [...existing.reverted] };
	}

	// 2. Certificate verification — never trust a single peer's say-so. The proof's votes are bound to
	//    a specific target; verify against the target they were signed over. For a root invalidation
	//    that is this call's own target; a cascade child passes the root's target via `certificateTarget`
	//    (the child-target justification is the deterministic cascade, not the certificate). A mismatched
	//    target (a genuine proof replayed against an innocent transaction) fails every signature here, so
	//    no compensating revision or log entry is ever written for it.
	const certificateTarget = params.certificateTarget ?? { invalidatedActionId, blockIds };
	if (!(await verifyInvalidationCertificate(proof, certificateTarget))) {
		log('apply-reject-certificate actionId=%s disputeId=%s outcome=%s', invalidatedActionId, proof.disputeId, proof.outcome);
		return { applied: false, reason: 'invalid-certificate', reverted: [] };
	}

	// 3. Compensating revisions — ONE critical section spanning every affected block.
	//
	// Latch discipline: hold ALL affected blocks' write latches across compute → revision slot →
	// precheck → writes. `acquireBlockWriteLatches` is the package's single multi-latch entry point
	// (it dedups and acquires in the one global sorted order), so this cannot deadlock against the
	// other multi-latch holder, `StorageRepo.commit`. (The previous code took each block's latch
	// around only its own write, which left the tips it computed from — and the revision slot derived
	// from them — read outside any latch: a concurrent commit could land a newer revision in the gap,
	// the monotonic guard in saveReplica/saveDeletion would correctly refuse the compensating write,
	// and the log entry appended in step 4 would then assert a restore that never happened.)
	//
	// Collapsing duplicate ids is why `uniqueBlockIds` drives the writes and `reverted` too: one
	// latched block yields one compensating write and one entry. The certificate target above
	// deliberately still uses the caller's `blockIds` verbatim — the arbitrators signed over that list.
	const uniqueBlockIds = Array.from(new Set(blockIds));
	const { latches, release } = await acquireBlockWriteLatches(uniqueBlockIds);
	let reverted: RevertedBlock[];
	let rev: number;
	try {
		// --- Start of critical section ---

		// Compute compensating content from tips read UNDER the latches. `computeRevertedBlock` reads
		// only through getLatest/listRevisions/getBlock/getTransaction — none of which acquire a latch
		// or touch the network (`BlockStorage.getBlock` throws `RevisionNotCoveredError` rather than
		// restoring; the healing re-read lives one layer up in `StorageRepo.get`), so it is safe to
		// call while holding them. Keep it that way: routing it through the healing path, which
		// restores under the block latch, would self-deadlock here.
		//
		// NOTE: this compute now runs inside the critical section, so every commit and pend on these
		// blocks queues behind it, and its cost grows with the number of revisions between T_inv and
		// the tip (`listRevisions` + a transform apply each). Fine at invalidation's rate — a reversal
		// is rare and its blocks are few. If invalidations ever become frequent, or reversals of very
		// old transactions show up delaying commits, compute optimistically outside the latches and
		// re-verify the tips inside (recomputing only the blocks that moved).
		const computations = await Promise.all(
			uniqueBlockIds.map(async (blockId) => {
				const storage = ctx.createBlockStorage(blockId);
				return {
					blockId,
					storage,
					latch: latches.get(blockId)!,
					latest: await storage.getLatest(),
					computation: await computeRevertedBlock(storage, invalidatedRev),
				};
			})
		);
		const maxFromRev = computations.reduce((max, c) => Math.max(max, c.computation.fromRev), invalidatedRev);
		rev = params.rev ?? maxFromRev + 1;

		// All-or-nothing precheck, mirroring the monotonic guard in `BlockStorage.saveForwardRevision`
		// (`meta.latest.rev >= rev` ⇒ refuse). With the tips read under these same latches, a computed
		// slot is strictly greater than every tip by construction, so this can only trip when the CALLER
		// supplied an explicit `rev` at or below a current tip. Writing nothing is the right outcome:
		// skipping the block or retrying at a higher slot would make one member's durable entry differ
		// from another's for the same invalidation, and step 1 dedups on (invalidatedActionId, disputeId)
		// so an invalidation that appended nothing is simply re-deliverable.
		const stale = computations.find(c => c.latest !== undefined && c.latest.rev >= rev);
		if (stale) {
			log('apply-reject-stale-revision actionId=%s disputeId=%s rev=%d blockId=%s held=%d',
				invalidatedActionId, proof.disputeId, rev, stale.blockId, stale.latest!.rev);
			return { applied: false, reason: 'stale-revision', reverted: [] };
		}

		reverted = [];
		for (const { blockId, storage, latch, computation } of computations) {
			// Deterministic compensating-revision actionId — identical on every member, so all converge on
			// the same (rev, actionId) for both the restore and the tombstone path.
			const revertActionId = await hashString(`inv:${invalidatedActionId}:${proof.disputeId}:${blockId}:${rev}`);
			const intended: ActionRev = { rev, actionId: revertActionId };
			let effective: ActionRev;
			if (computation.kind === 'delete') {
				// Block-creation reversal: physically remove the created block by writing a forward tombstone
				// revision. The `restoredContentHash` is the DELETED_BLOCK_RESTORE sentinel — a deleted block
				// has no content hash, and the sentinel tells dependents "observed content is gone → invalidate".
				effective = await storage.saveDeletion(intended, latch);
				assertWriteLanded(blockId, intended, effective);
				log('apply-delete-restore blockId=%s invalidatedRev=%d rev=%d', blockId, invalidatedRev, rev);
				reverted.push({ blockId, fromRev: computation.fromRev, restoredContentHash: DELETED_BLOCK_RESTORE });
				continue;
			}
			if (computation.laterActions > 0) {
				// Surviving later actions were replayed verbatim; true read-dependents are out of scope here.
				log('apply-replayed-later-actions blockId=%s count=%d', blockId, computation.laterActions);
			}
			effective = await storage.saveReplica(computation.block, intended, undefined, latch);
			assertWriteLanded(blockId, intended, effective);
			reverted.push({ blockId, fromRev: computation.fromRev, restoredContentHash: computation.restoredContentHash });
		}

		// --- End of critical section ---
	} finally {
		// Every acquired latch is released even if a compute or a write threw.
		release();
	}

	// 4. Durable, append-only invalidation entry (the source of truth for committed-invalidated).
	//    Appended OUTSIDE the block latches on purpose: `ctx.log` writes through a `BlockStore` that may
	//    itself be repo-backed, and `Latches` has no re-entrancy — appending under a block latch could
	//    self-deadlock.
	//    `cascadeRoot` is set when this is a cascade step (a reverted read-dependent), undefined for a root.
	//
	// NOTE: the gap between the writes landing and this append is a crash window — a crash inside it
	// leaves compensating revisions with no entry naming them. Deliberate, and the recoverable
	// direction of the invariant this function establishes: an entry never over-claims, it can only
	// under-claim, and re-delivery re-applies (step 1 dedups on the entry, which is not there). The
	// asymmetry only stops being acceptable if a consumer starts treating "revision present, entry
	// absent" as authoritative rather than as a state to re-sync.
	await ctx.log.addInvalidation(invalidatedActionId, invalidatedRev, proof, reverted, rev, params.cascadeRoot, params.timestamp);
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
