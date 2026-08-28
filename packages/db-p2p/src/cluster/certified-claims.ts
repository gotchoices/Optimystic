import type { ActionId, BlockId, IBlock } from "@optimystic/db-core";
import {
	verifyBlockCommitProofClaim, verifyBlockCommitProofContent,
	type BlockCommitProof, type ProofClaim, type ProofFailure, type ProofThresholds
} from "./commit-proof.js";
import { createLogger } from "../logger.js";

const log = createLogger('certified-claims');

/**
 * Certification of repair claims by cohort commit proof — the shared layer both block-restoration
 * paths (read-repair in `CoordinatorRepo`, reconcile in `reconcile-block`) run a peer-attached
 * {@link BlockCommitProof} through before marking a `RevClaim` / `BlockHashCandidate` as
 * `certified` for the selection helpers in `quorum-restore.ts`.
 *
 * Mirrors the layered posture of `verifyInvalidationCertificate` (`dispute/invalidation.ts`):
 *
 *  - **Layer 1 (always)**: offline cryptographic verification — thresholds of Ed25519 votes from
 *    the proof's own signer list (`verifyBlockCommitProofClaim` / `...Content`), preceded by the
 *    {@link MAX_PROOF_SIGNERS} cap this module owes the verifier (its caller obligation #2:
 *    verification cost is attacker-chosen, so bound the cohort BEFORE any hashing).
 *  - **Layer 2 (optional, observational)**: {@link ProofAnchoring.recomputeBlockCohort} re-derives
 *    the block's cohort from the caller's own topology view and the overlap with the proof's
 *    signers is LOGGED — never gated on. Historic cohort rotation makes zero overlap legitimate
 *    for old data; gating would re-create the very lone-holder-unreadable defect the certified
 *    path exists to fix. Like invalidation's `recomputeArbitratorSet`, no production caller wires
 *    this yet (see the note at the `clusterMember` construction in `libp2p-node-base.ts`).
 *  - **Degradation**: with no recompute capability, or an infeasible recompute, an accepted proof
 *    is certified anyway but never silently — logged, and surfaced via
 *    {@link ProofAnchoring.onUnanchored} so callers can count/report the residual, exactly as
 *    invalidation's `acceptUnanchored` does.
 */

/**
 * Verdict from a {@link RecomputeBlockCohort}:
 *  - `{ feasible: false }` — the caller could not re-derive the block's current cohort (no routing
 *    view, lookup failed); anchoring degrades to accept-and-surface.
 *  - `{ feasible: true, cohortPeerIds }` — the currently-derived cohort, compared (log-only)
 *    against the proof's signer list.
 */
export type CohortRecomputeVerdict =
	| { readonly feasible: false }
	| { readonly feasible: true; readonly cohortPeerIds: string[] };

/**
 * Injected layer-2 capability: re-derive the block's responsible cohort from the caller's own
 * topology view. A real implementation would come from `IKeyNetwork.findCluster` — the same source
 * `deriveExpectedCluster` uses in `libp2p-node-base.ts`. NOT wired in production yet; the overlap
 * it enables is observational (logged), never a gate.
 */
export type RecomputeBlockCohort = (blockId: BlockId) => Promise<CohortRecomputeVerdict>;

/** Reported when a proof is accepted on layer-1 cryptography alone — see {@link ProofAnchoring.onUnanchored}. */
export type UnanchoredProofAcceptance = {
	readonly blockId: BlockId;
	readonly rev: number;
	readonly actionId: ActionId;
	/** Size of the proof's signer list (`proof.peerIds.length`). */
	readonly signerCount: number;
	/** Why the anchoring layer did not run to a comparison. */
	readonly reason: 'no-recompute-capability' | 'recompute-infeasible';
};

/** Optional anchoring capabilities a caller threads into {@link certifyClaim} / {@link certifyContent}. */
export type ProofAnchoring = {
	/** Layer-2 recompute; omitted → layer-1-only certification with the documented surfacing. */
	readonly recomputeBlockCohort?: RecomputeBlockCohort;
	/**
	 * Invoked when a proof is accepted without a cohort comparison (capability absent or
	 * infeasible). Lets a caller surface "certified a claim it could not anchor to topology"
	 * alongside the internal log. Exceptions thrown from it are swallowed (logged), never allowed
	 * to un-certify an already-verified proof.
	 */
	readonly onUnanchored?: (info: UnanchoredProofAcceptance) => void;
};

/** Everything {@link ProofFailure} names, plus the pre-verification cap decline this module adds. */
export type CertifyFailure = ProofFailure | 'oversized-cohort';

/**
 * Hard bound on `proof.peerIds.length`, enforced BEFORE any hashing or signature work. Nothing on
 * the repair wire bounds a proof's cohort count — only byte caps apply (1 MiB control / 8 MiB sync
 * response), which would still admit ~80k signature verifications — so this module enforces the
 * bound `commit-proof.ts` declares as its caller obligation #2. 256 is far above any plausible
 * cohort (deployments run ~10) while keeping the worst-case verification cost trivial.
 */
export const MAX_PROOF_SIGNERS = 256;

/**
 * Failure reasons that must NEVER become a reputation penalty for the serving peer, because the
 * identity behind the artifact was not proven (mirrors `ClusterMember.verifySignature`'s outcome
 * discipline, restated in `commit-proof.ts`): an unparseable or unbound signer, a legacy record,
 * structural garbage — and `oversized-cohort`, since a genuine mega-cohort is conceivable and the
 * cap declines it unexamined.
 *
 * Everything else IS attributable: `membership-mismatch`, `message-hash-mismatch`,
 * `duplicate-signer`, `promise-threshold`, `commit-threshold`, `claim-not-in-message` (the replay
 * case — a genuine proof presented for a claim it does not cover), and `digest-mismatch` (the peer
 * served bytes that provably are not the committed content). `no-digest-declared` is neither: it
 * is a verdict-level "content uncertified, rev certified" outcome, not misbehavior — use
 * {@link isAttributableProofFailure} rather than testing this set directly.
 */
export const NON_ATTRIBUTABLE_PROOF_FAILURES: ReadonlySet<CertifyFailure> = new Set<CertifyFailure>([
	'unknown-signer', 'non-ed25519-signer', 'malformed-signature', 'legacy-record', 'malformed-proof',
	'oversized-cohort'
]);

/**
 * May this failure be held against the peer that served the proof? One predicate so the two repair
 * paths cannot drift on the classification: non-attributable reasons (unproven identity /
 * unexamined artifact) and `no-digest-declared` (a legitimate "cohort declared no digest for this
 * block" outcome) are excluded; everything else is the serving peer's own artifact lying.
 */
export function isAttributableProofFailure(failure: CertifyFailure): boolean {
	return !NON_ATTRIBUTABLE_PROOF_FAILURES.has(failure) && failure !== 'no-digest-declared';
}

export type ClaimCertification = {
	/** The proof certifies `claim` — cap passed, thresholds of valid cohort signatures met. */
	certified: boolean;
	/** Why not, when `certified` is false. Classify via {@link isAttributableProofFailure}. */
	failure?: CertifyFailure;
};

export type ContentCertification = {
	/** The claim half passed: the proof certifies `(blockId, rev, actionId)`. */
	revCertified: boolean;
	/** The content half passed too: the committed digest matches the served bytes. */
	contentCertified: boolean;
	/**
	 * Set whenever either half failed. With `revCertified` true this is `digest-mismatch`
	 * (attributable — drop/penalize the served bytes) or `no-digest-declared` (no penalty; the
	 * cohort declared nothing to compare against).
	 */
	failure?: CertifyFailure;
};

/**
 * Certify a repair claim by its attached cohort commit proof: cap the cohort, verify offline
 * ({@link verifyBlockCommitProofClaim}), then run the anchoring layer on success. Total on hostile
 * input like the verifier it wraps — never throws.
 */
export async function certifyClaim(
	proof: BlockCommitProof, claim: ProofClaim, thresholds: ProofThresholds, anchoring: ProofAnchoring = {}
): Promise<ClaimCertification> {
	if (exceedsSignerCap(proof)) {
		return { certified: false, failure: 'oversized-cohort' };
	}
	const verdict = await verifyBlockCommitProofClaim(proof, claim, thresholds);
	if (!verdict.ok) {
		return { certified: false, failure: verdict.reason };
	}
	await anchorAcceptedProof(proof, claim, anchoring);
	return { certified: true };
}

/**
 * Certify a claim AND the served block bytes ({@link verifyBlockCommitProofContent}). The two
 * halves are reported separately because the content checks (`digest-mismatch` /
 * `no-digest-declared`) only run after the claim half has already PASSED — a proof that certifies
 * the revision while the bytes disagree still certifies the revision; the caller drops (and, for
 * `digest-mismatch`, penalizes) the bytes. Anchoring runs whenever the claim half passed: that is
 * the moment a proof was accepted as evidence.
 */
export async function certifyContent(
	proof: BlockCommitProof, claim: ProofClaim, block: IBlock, thresholds: ProofThresholds,
	anchoring: ProofAnchoring = {}
): Promise<ContentCertification> {
	if (exceedsSignerCap(proof)) {
		return { revCertified: false, contentCertified: false, failure: 'oversized-cohort' };
	}
	const verdict = await verifyBlockCommitProofContent(proof, claim, block, thresholds);
	if (verdict.ok) {
		await anchorAcceptedProof(proof, claim, anchoring);
		return { revCertified: true, contentCertified: true };
	}
	if (verdict.reason === 'digest-mismatch' || verdict.reason === 'no-digest-declared') {
		await anchorAcceptedProof(proof, claim, anchoring);
		return { revCertified: true, contentCertified: false, failure: verdict.reason };
	}
	return { revCertified: false, contentCertified: false, failure: verdict.reason };
}

/**
 * The cap check, structurally safe on hostile shapes: a `peerIds` that is not an array falls
 * through to the verifier, which reports `malformed-proof` without doing signature work either.
 */
function exceedsSignerCap(proof: BlockCommitProof): boolean {
	return proof !== null && typeof proof === 'object'
		&& Array.isArray(proof.peerIds) && proof.peerIds.length > MAX_PROOF_SIGNERS;
}

/**
 * Layer 2 + degradation for a proof the offline layer accepted. Purely observational — nothing
 * here can revoke the certification: overlap is logged (never gated — historic cohort rotation
 * makes zero overlap legitimate for old data, and gating would re-create the lone-holder-unreadable
 * defect), infeasibility degrades to accept-and-surface, and a throwing capability is logged and
 * treated as infeasible.
 */
async function anchorAcceptedProof(proof: BlockCommitProof, claim: ProofClaim, anchoring: ProofAnchoring): Promise<void> {
	const signerCount = proof.peerIds.length;
	if (!anchoring.recomputeBlockCohort) {
		acceptUnanchored(claim, signerCount, 'no-recompute-capability', anchoring);
		return;
	}
	let verdict: CohortRecomputeVerdict;
	try {
		verdict = await anchoring.recomputeBlockCohort(claim.blockId);
	} catch (err) {
		log('anchor-recompute-error block=%s error=%o', claim.blockId, err);
		acceptUnanchored(claim, signerCount, 'recompute-infeasible', anchoring);
		return;
	}
	if (!verdict.feasible) {
		acceptUnanchored(claim, signerCount, 'recompute-infeasible', anchoring);
		return;
	}
	const cohort = new Set(verdict.cohortPeerIds);
	const overlap = proof.peerIds.filter(id => cohort.has(id)).length;
	log('anchor-overlap block=%s rev=%d action=%s overlap=%d signers=%d cohort=%d',
		claim.blockId, claim.rev, claim.actionId, overlap, signerCount, cohort.size);
}

/** Accept-and-surface a proof certified on layer 1 alone — never silent, never throwing. */
function acceptUnanchored(
	claim: ProofClaim, signerCount: number, reason: UnanchoredProofAcceptance['reason'], anchoring: ProofAnchoring
): void {
	log('accept-unanchored block=%s rev=%d action=%s signers=%d reason=%s',
		claim.blockId, claim.rev, claim.actionId, signerCount, reason);
	try {
		anchoring.onUnanchored?.({
			blockId: claim.blockId, rev: claim.rev, actionId: claim.actionId, signerCount, reason
		});
	} catch (err) {
		log('accept-unanchored-callback-error block=%s error=%o', claim.blockId, err);
	}
}
