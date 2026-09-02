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
 *
 * NOTE: this cap bounds the SIGNATURE count (at most `MAX_PROOF_SIGNERS` Ed25519 verifies per
 * round, since `countApprovals` skips signers outside `peerIds` before any crypto). It does NOT
 * bound the proof's serialized SIZE: `computeClusterMessageHash` / `...PromiseHash` /
 * `...CommitHash` canonically serialize `message`, `promises` and `commits`, whose entry counts a
 * peer chooses freely inside the transport byte cap. That cost is linear and today bounded by the
 * 1 MiB control-message cap; if repair verification ever shows up in a profile, or a deployment
 * raises those transport caps, add a serialized-size bound here alongside the signer count.
 */
export const MAX_PROOF_SIGNERS = 256;

/**
 * Every {@link CertifyFailure}, classified: may it be held against the peer that SERVED the proof?
 *
 * Exhaustive by type — `Record<CertifyFailure, boolean>` means adding a {@link ProofFailure}
 * variant in `commit-proof.ts` fails the build here until it is classified, rather than silently
 * defaulting to `true` (penalize), which is the wrong direction for an unknown reason.
 *
 * `false` — never a penalty, because the identity behind the artifact was not proven (mirrors
 * `ClusterMember.verifySignature`'s outcome discipline, restated in `commit-proof.ts`) or because
 * the outcome is not misbehavior at all.
 *
 * `true` — the peer's own artifact provably lies, or provably does not cover what it was served
 * for.
 */
const ATTRIBUTABLE_PROOF_FAILURES: Readonly<Record<CertifyFailure, boolean>> = {
	// Identity not proven — an unparseable or unbound signer, or structural garbage that could have
	// been authored by anyone in the chain.
	'unknown-signer': false,
	'non-ed25519-signer': false,
	'malformed-signature': false,
	'malformed-proof': false,
	// A v1 / unversioned record is history, not misbehavior: it binds no peer set and never could.
	'legacy-record': false,
	// A genuine mega-cohort is conceivable and the cap declines it unexamined — no evidence either way.
	'oversized-cohort': false,
	// Not a failure of the proof at all: the cohort declared no digest for this block, so there was
	// nothing to compare the served bytes against. A verdict ("content uncertified, rev certified"),
	// never misbehavior.
	'no-digest-declared': false,
	// The artifact contradicts itself or the claim it was served for. `buildBlockCommitProof` derives
	// `peerIds` from `Object.keys(record.peers)`, so honest construction cannot produce a duplicate —
	// serving one implies authorship, as does a digest or hash that does not recompute.
	'membership-mismatch': true,
	'message-hash-mismatch': true,
	'duplicate-signer': true,
	'promise-threshold': true,
	'commit-threshold': true,
	// The replay case: a genuine proof presented for a claim it does not cover.
	'claim-not-in-message': true,
	// The peer served bytes that provably are not the committed content.
	'digest-mismatch': true
};

/**
 * Failure reasons that must NEVER become a reputation penalty for the serving peer — the `false`
 * half of {@link ATTRIBUTABLE_PROOF_FAILURES}, derived so the set and
 * {@link isAttributableProofFailure} cannot drift apart. Prefer the predicate; this set is exported
 * for callers that want to name the whole population (logs, tests).
 */
export const NON_ATTRIBUTABLE_PROOF_FAILURES: ReadonlySet<CertifyFailure> = new Set(
	(Object.keys(ATTRIBUTABLE_PROOF_FAILURES) as CertifyFailure[])
		.filter(failure => !ATTRIBUTABLE_PROOF_FAILURES[failure])
);

/**
 * May this failure be held against the peer that served the proof? One predicate so the two repair
 * paths cannot drift on the classification — see {@link ATTRIBUTABLE_PROOF_FAILURES} for the
 * per-reason rationale.
 */
export function isAttributableProofFailure(failure: CertifyFailure): boolean {
	return ATTRIBUTABLE_PROOF_FAILURES[failure] === true;
}

/**
 * The {@link ProofThresholds} both repair paths verify against, from the cohort's configured
 * `superMajorityThreshold`.
 *
 * `simpleMajorityThreshold` is hardcoded 0.5 — NOT the deployment's configured value (0.51 by
 * default): cohort members enforce `count > total / 2` (`ClusterMember.hasMajority`), and
 * `ProofThresholds` requires a verifier to mirror what the members actually enforced. Verifying
 * against the configured value would reject proofs real cohorts produce.
 *
 * One function so the read path (`CoordinatorRepo.queryClusterForLatest`) and the commit-path
 * reconcile (`cluster/reconcile-block.ts`) cannot drift on the one number that has to match
 * `hasMajority`.
 */
export function proofThresholds(superMajorityThreshold: number): ProofThresholds {
	return { superMajorityThreshold, simpleMajorityThreshold: 0.5 };
}

/**
 * Certification verdict for a claim — a discriminated union, mirroring `ProofVerdict`
 * (`commit-proof.ts`) so "certified" and "why not" cannot disagree: a failure reason is REQUIRED
 * when uncertified and unrepresentable when certified.
 */
export type ClaimCertification =
	/**
	 * The proof certifies `claim` — cap passed, thresholds of valid cohort signatures met.
	 * `signerCount` is the proof's distinct signer list size (`proof.peerIds.length`, the same
	 * number {@link UnanchoredProofAcceptance} reports): the selection helpers weigh a
	 * single-signer certification — routine since solo cohorts self-sign their commits — below
	 * multi-peer corroboration, and carrying the count in the verdict keeps the two repair paths
	 * from each measuring it off the proof themselves.
	 */
	| { certified: true; signerCount: number }
	/** Classify the reason via {@link isAttributableProofFailure} before penalizing anyone. */
	| { certified: false; failure: CertifyFailure };

/**
 * Certification verdict for a claim AND the block bytes served for it. Three reachable outcomes,
 * spelled as three arms so an impossible mix (content certified while the rev is not, a failure
 * alongside full success) cannot be constructed:
 */
export type ContentCertification =
	/**
	 * Both halves passed: the proof certifies `(blockId, rev, actionId)` AND these exact bytes.
	 * `signerCount` as in {@link ClaimCertification} — the selectors weigh it.
	 */
	| { revCertified: true; contentCertified: true; signerCount: number }
	/**
	 * The claim half passed, the content half did not: `digest-mismatch` (attributable — drop AND
	 * penalize the served bytes) or `no-digest-declared` (drop only; the cohort declared nothing to
	 * compare against). The `(rev, actionId)` is certified either way, with `signerCount` weighing
	 * that certified half exactly as on full success.
	 */
	| { revCertified: true; contentCertified: false; failure: 'digest-mismatch' | 'no-digest-declared'; signerCount: number }
	/** The claim half failed, so nothing is certified. Classify via {@link isAttributableProofFailure}. */
	| { revCertified: false; contentCertified: false; failure: CertifyFailure };

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
	// Safe unguarded: the verifier only passes a proof whose peerIds it validated (the same read
	// anchorAcceptedProof just performed).
	return { certified: true, signerCount: proof.peerIds.length };
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
		return { revCertified: true, contentCertified: true, signerCount: proof.peerIds.length };
	}
	if (verdict.reason === 'digest-mismatch' || verdict.reason === 'no-digest-declared') {
		await anchorAcceptedProof(proof, claim, anchoring);
		return { revCertified: true, contentCertified: false, failure: verdict.reason, signerCount: proof.peerIds.length };
	}
	return { revCertified: false, contentCertified: false, failure: verdict.reason };
}

/**
 * The cap check, structurally safe on hostile shapes: a `peerIds` that is not an array — or a
 * property access that throws, which is why the whole read is guarded — falls through to the
 * verifier, which reports `malformed-proof` without doing signature work either. This runs before
 * {@link certifyClaim}'s and {@link certifyContent}'s only other call, so it is the one place their
 * "never throws" contract could be broken.
 */
function exceedsSignerCap(proof: BlockCommitProof): boolean {
	try {
		return proof !== null && typeof proof === 'object'
			&& Array.isArray(proof.peerIds) && proof.peerIds.length > MAX_PROOF_SIGNERS;
	} catch {
		return false;
	}
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
	// A verdict that is null or otherwise off-contract reads as infeasible rather than throwing —
	// `recomputeBlockCohort` is caller-supplied, so its return shape is as untrusted as its behavior.
	if (!verdict?.feasible) {
		acceptUnanchored(claim, signerCount, 'recompute-infeasible', anchoring);
		return;
	}
	try {
		const cohort = new Set(verdict.cohortPeerIds);
		const overlap = proof.peerIds.filter(id => cohort.has(id)).length;
		log('anchor-overlap block=%s rev=%d action=%s overlap=%d signers=%d cohort=%d',
			claim.blockId, claim.rev, claim.actionId, overlap, signerCount, cohort.size);
	} catch (err) {
		// A non-iterable `cohortPeerIds`. The comparison is observational, so losing it costs a log
		// line, never the certification.
		log('anchor-overlap-error block=%s error=%o', claim.blockId, err);
	}
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
