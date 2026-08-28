import type { ActionId, ActionRev, BlockId, IBlock } from "@optimystic/db-core";
import { canonicalBlockHash } from "@optimystic/db-core";
import type { BlockArchive } from "../storage/struct.js";
import { maxArchiveRevision } from "../storage/block-archive.js";
import type { ReconcileBlockCallback } from "./cluster-repo.js";
import type { IPeerReputation } from "../reputation/types.js";
import { PenaltyReason } from "../reputation/types.js";
import {
	selectQuorumRev, selectQuorumBlock, corroboratorCapacity, quorumSize,
	certifiedEquivocation, certifiedContentEquivocation,
	type RevClaim, type BlockHashCandidate, type QuorumRev
} from "./quorum-restore.js";
import {
	certifyClaim, certifyContent, isAttributableProofFailure, proofThresholds, type ProofAnchoring
} from "./certified-claims.js";
import type { BlockCommitProof } from "./commit-proof.js";
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
	/**
	 * The cohort commit proof the serving archive attached, when it carried one. The archive keys the
	 * proof INSIDE the same revision entry as the `(rev, actionId)` it certifies
	 * (`storage/struct.ts` `ArchiveRevisions`), so a serving peer cannot pair a genuine proof with a
	 * different revision — mis-pairing is structurally blocked by the wire shape. Presence proves
	 * nothing; the certification pass below is what turns it into a verdict.
	 */
	proof?: BlockCommitProof;
	/** Injected by the certification pass: the proof verified for this `(rev, actionId)`. Never set from mere proof presence. */
	revCertified?: boolean;
	/** Injected by the certification pass: the proof's declared digest matches these exact bytes. */
	contentCertified?: boolean;
	/**
	 * Set on `digest-mismatch` only: the served bytes provably contradict the proof's declared
	 * digest, so this candidate is dropped from the content quorum (its rev claim still counts —
	 * that half genuinely verified).
	 */
	contentRejected?: boolean;
}

/** Collaborators {@link createReconcileBlock} needs, injected so the logic stays transport-agnostic. */
export interface ReconcileBlockDeps {
	/** This node's own peer id; excluded from the cohort targets. */
	selfPeerId: string;
	/** Fetch one cohort peer's archive for `blockId` — `undefined` when it is unreachable or holds nothing. */
	fetchArchive: (peerId: string, blockId: BlockId) => Promise<BlockArchive | undefined>;
	/**
	 * Persist the agreed content through the churn-replication funnel. `verifiedProof` is passed
	 * ONLY when it was verified against these exact bytes (`certifyContent`'s digest check) — the
	 * receiver persists it as evidence, so an unverified proof must never reach this parameter.
	 */
	saveReplicatedBlock: (blockId: BlockId, block: IBlock, source: ActionRev, verifiedProof?: BlockCommitProof) => Promise<void>;
	/** Proportional corroboration threshold; the cohort's `simpleMajorityThreshold`. */
	simpleMajorityThreshold: number;
	/** Promise-round gate for proof verification; the cohort's `superMajorityThreshold`. */
	superMajorityThreshold: number;
	/** Optional layer-2 anchoring for accepted proofs — observational only, see `cluster/certified-claims.ts`. */
	anchoring?: ProofAnchoring;
	/**
	 * Yardstick the corroboration floor is measured against — the floor for
	 * {@link corroboratorCapacity}. Required, not optional: unlike the membership admission gate there
	 * is no "unknown" handling here, so a caller that cannot state an asserted cohort size should pass
	 * its configured `clusterSize` (the strict direction) rather than a small placeholder. The failure
	 * mode of overstating it is a block that stays unrepaired — degraded, not dead; of understating it,
	 * a shrunken cohort view that can relax the floor to a single voter. `resolveClusterPolicy`
	 * (`cluster/cluster-policy.ts`) resolves it for a real node and defaults it to `clusterSize`.
	 */
	repairCorroborationClusterSize: number;
	/** Best-effort misbehavior reporting; a throwing implementation is swallowed. */
	reputation?: Pick<IPeerReputation, 'reportPeer'>;
}

/**
 * What one cohort peer's fetch produced. Kept as separate outcomes rather than collapsed to
 * `ReconcileCandidate | undefined` so a decline can report WHICH populations it was short of: "1 of 3
 * responded" and "1 holder, 2 confirmed non-holders" call for completely different operator actions.
 *
 * NOTE: `no-archive` deliberately conflates "the peer holds nothing" with "the peer is unreachable" —
 * that conflation is in `fetchArchive`'s contract, and the production wiring
 * (`libp2p-node-base.fetchArchiveFromPeer`) swallows every dial failure and timeout into the same
 * `undefined`. The read path does separate the two (`CoordinatorRepo`'s `silent` set). If a
 * reconcile-side decline ever needs that distinction, widen `fetchArchive` to report unreachability
 * rather than trying to infer it here.
 */
type PeerAnswer =
	/** Served an archive covering the committed revision or better. */
	| { kind: 'claim'; candidate: ReconcileCandidate }
	/** Served an archive, but it covers nothing at or above the revision being healed. */
	| { kind: 'behind' }
	/** Served no archive: holds nothing, or is unreachable — see the note above. */
	| { kind: 'no-archive' }
	/** The fetch threw. */
	| { kind: 'error' };

/**
 * The claim a peer's archive makes: its highest revision, provided that revision is at least the
 * one we committed. `undefined` when the archive carries only revisions older than the commit we are
 * healing, or no usable action at its highest.
 */
function toCandidate(peerId: string, archive: BlockArchive, committedRev: number): ReconcileCandidate | undefined {
	const maxRev = maxArchiveRevision(archive.revisions);
	if (maxRev === undefined || maxRev < committedRev) return undefined;
	const data = archive.revisions[maxRev];
	if (!data?.action) return undefined;
	return {
		peerId, rev: maxRev, actionId: data.action.actionId, block: data.block,
		...(data.proof ? { proof: data.proof } : {})
	};
}

/**
 * One peer's answer, isolated. `fetchArchive` is contracted to answer `undefined` for an
 * unreachable peer, but a raw `Promise.all` over the cohort would let a single rejecting fetch
 * discard the answers every other peer already gave — turning a heal the cohort could complete
 * into a decline. One peer's failure costs only that peer's vote.
 */
async function fetchAnswer(
	deps: ReconcileBlockDeps,
	peerId: string,
	blockId: BlockId,
	committedRev: number
): Promise<PeerAnswer> {
	let archive: BlockArchive | undefined;
	try {
		archive = await deps.fetchArchive(peerId, blockId);
	} catch (err) {
		log('reconcile:fetch-error', { blockId, peerId, error: (err as Error).message });
		return { kind: 'error' };
	}
	if (!archive) return { kind: 'no-archive' };
	const candidate = toCandidate(peerId, archive, committedRev);
	return candidate ? { kind: 'claim', candidate } : { kind: 'behind' };
}

/**
 * Run every proof-carrying candidate through the shared certification layer
 * (`cluster/certified-claims.ts`) and inject the verdicts, BEFORE selection reads the claim set.
 * Mirrors the read path's certifyClaim pass (`CoordinatorRepo.queryClusterForLatest`) — same
 * thresholds, same failure logging, same penalty discipline:
 *
 *  - A candidate whose claim half fails stays an ORDINARY uncertified corroborator (its vote is
 *    never dropped — a peer that could fabricate a bad proof could equally have sent none), and
 *    only an attributable failure (`isAttributableProofFailure`) penalizes the serving peer.
 *  - `digest-mismatch` is the one content-side rejection: the served bytes provably contradict
 *    the proof's declared digest, so the candidate is dropped from the content quorum and the
 *    server penalized — while its (genuinely verified) rev claim still counts.
 *  - `no-digest-declared` leaves the content an ordinary uncertified carrier: the cohort declared
 *    nothing to compare against, which is a verdict, never misbehavior.
 *
 * NOTE: cost is one verification pass per proof-carrying answer per reconcile, each bounded by
 * MAX_PROOF_SIGNERS (256, the shared layer's cap) signature checks × cohort width — fine at
 * deployment cohort sizes (~10).
 */
async function certifyCandidates(deps: ReconcileBlockDeps, blockId: BlockId, candidates: ReconcileCandidate[]): Promise<void> {
	// Shared with the read path, so the two cannot drift on what the members actually enforced —
	// see `proofThresholds` for why the simple-majority term is not deps.simpleMajorityThreshold.
	const thresholds = proofThresholds(deps.superMajorityThreshold);
	await Promise.all(candidates.map(async c => {
		if (!c.proof) return;
		const claim = { blockId, rev: c.rev, actionId: c.actionId as ActionId };
		if (c.block) {
			const verdict = await certifyContent(c.proof, claim, c.block, thresholds, deps.anchoring);
			if (verdict.revCertified) {
				c.revCertified = true;
				if (verdict.contentCertified) {
					c.contentCertified = true;
				} else if (verdict.failure === 'digest-mismatch') {
					// The claim half genuinely passed; the bytes provably lie. Drop them from the
					// content quorum and penalize the server — repair continues on the other holders.
					c.contentRejected = true;
					log('reconcile:content-rejected', { blockId, peerId: c.peerId, rev: c.rev });
					penalizeProofService(deps.reputation, c.peerId, blockId);
				}
				// no-digest-declared: content stays an ordinary uncertified carrier, no penalty.
				return;
			}
			logUncertified(blockId, c, verdict.failure);
			if (isAttributableProofFailure(verdict.failure)) {
				penalizeProofService(deps.reputation, c.peerId, blockId);
			}
			return;
		}
		const verdict = await certifyClaim(c.proof, claim, thresholds, deps.anchoring);
		if (verdict.certified) {
			c.revCertified = true;
			return;
		}
		logUncertified(blockId, c, verdict.failure);
		if (isAttributableProofFailure(verdict.failure)) {
			penalizeProofService(deps.reputation, c.peerId, blockId);
		}
	}));
}

/** Mirror of `cluster-fetch:proof-uncertified` on the read path — same fields, reconcile-side name. */
function logUncertified(blockId: BlockId, c: ReconcileCandidate, failure: string): void {
	log('reconcile:proof-uncertified', { blockId, peerId: c.peerId, rev: c.rev, failure });
}

/**
 * Best-effort penalty for a peer whose served proof (or the bytes served under it) provably lies.
 * Mirrors `CoordinatorRepo.penalizeProofService` — never throws.
 */
function penalizeProofService(
	reputation: Pick<IPeerReputation, 'reportPeer'> | undefined, peerId: string, blockId: BlockId
): void {
	if (!reputation) return;
	try {
		reputation.reportPeer(peerId, PenaltyReason.InvalidRestoration, `reconcile:${blockId}`);
	} catch (err) {
		log('reconcile:penalize-error', { blockId, error: (err as Error).message });
	}
}

/**
 * Hash the block bytes of every candidate that both corroborates `selected` and actually carried
 * content — minus any whose bytes were rejected against their own proof's digest
 * (`contentRejected`). A carrier whose content CERTIFIED carries its `certified` flag into the
 * selector and its proof alongside: that is the only proof safe to persist, because it was
 * verified against these exact bytes.
 *
 * NOTE: this canonical-JSON-serializes and sha256s every carrier's whole block on every reconcile.
 * Negligible at today's cohort widths and block sizes; if blocks grow large or cohorts wide enough
 * for this to show up on a commit-path profile, hash incrementally at receive time instead.
 */
async function hashCarriers(
	candidates: ReconcileCandidate[], selected: QuorumRev
): Promise<(BlockHashCandidate & { proof?: BlockCommitProof })[]> {
	const carriers = candidates.filter(c =>
		c.rev === selected.rev && c.actionId === selected.actionId && c.block && !c.contentRejected);
	return await Promise.all(
		carriers.map(async c => ({
			peerId: c.peerId, hash: await canonicalBlockHash(c.block!), block: c.block!,
			...(c.contentCertified ? { certified: true } : {}),
			...(c.contentCertified && c.proof ? { proof: c.proof } : {})
		}))
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
 * Peer-attached cohort commit proofs are verified first ({@link certifyCandidates}) and both gates
 * weigh the verdicts: a claim — and, separately, the bytes — that a verified proof certifies is
 * accepted with no second peer at any cohort size, and the proof that certified the bytes is
 * persisted alongside them so the repaired replica serves it onward.
 *
 * Both quorums are capped by {@link corroboratorCapacity} for the claims that still need
 * corroboration: demanding two corroborators from a cohort that contains exactly one other peer is
 * a permanent deadlock, not a safety property — the node can never heal and stays unreadable
 * forever.
 *
 * **Exposure at capacity 1 (documented, not accidental).** Block ids are random 256-bit strings
 * (`db-core` `structs.ts`), NOT content-addressed, so nothing on the receive path can re-derive
 * the id from the bytes: `canonicalBlockHash` is a cross-peer *agreement* hash, never a check
 * against `blockId`. A sole cohort peer's content is therefore believed on its word. That adds no
 * trust the cohort had not already extended — the same peer's `(rev, actionId)` claim is likewise
 * uncorroborable at that size (see `selectQuorumRev`'s capacity note), and a two-member cohort has
 * no honest majority to appeal to in the first place. It is closed for a candidate that carries a
 * verified cohort commit proof — {@link certifyCandidates} binds the proof's declared digest to the
 * served bytes, which is a check against the *cohort's own signatures* rather than against other
 * peers, so a certified carrier wins the content gate outright and this exposure never applies to
 * it. It remains open for a proof-less candidate, and for the residual that layer 1 proves only
 * that the listed signers signed (`feat-cluster-membership-threshold-cert-anchoring`).
 *
 * Declines are cheap and retryable: nothing is persisted, nothing is marked, and the next commit
 * or churn/rebalance pass tries again.
 */
export function createReconcileBlock(deps: ReconcileBlockDeps): ReconcileBlockCallback {
	return async (blockId, committed, cohortPeerIds) => {
		const targets = cohortPeerIds.filter(id => id !== deps.selfPeerId);
		if (targets.length === 0) return;

		const answers = await Promise.all(
			targets.map(peerId => fetchAnswer(deps, peerId, blockId, committed.rev))
		);
		const candidates = answers.flatMap(a => a.kind === 'claim' ? [a.candidate] : []);
		const tally = (kind: PeerAnswer['kind']) => answers.filter(a => a.kind === kind).length;
		const capacity = corroboratorCapacity(targets.length, deps.repairCorroborationClusterSize);

		await certifyCandidates(deps, blockId, candidates);

		const revClaims: RevClaim[] = candidates.map(({ peerId, rev, actionId, revCertified }) => ({
			peerId, rev, actionId, ...(revCertified ? { certified: true } : {})
		}));
		const selected = selectQuorumRev(revClaims, deps.simpleMajorityThreshold, capacity);
		if (!selected) {
			// Asked ONLY on a decline: a certified-vs-certified conflict can coexist with a successful
			// selection (a corroborated pair strictly above the top certified rev wins), so a
			// non-undefined answer here explains THIS decline, nothing more. Two verified proofs for
			// distinct actions at one revision means the cohort (or whoever holds its keys) provably
			// signed both sides — an incident, not a shortage of answers; neither claimant is
			// penalized, because which side is wrong is exactly what this node cannot know.
			const equivocation = certifiedEquivocation(revClaims);
			if (equivocation) {
				log('reconcile:certified-equivocation', {
					blockId, rev: equivocation.rev, actionIds: equivocation.actionIds
				});
			}
			// Leave the block behind; churn/rebalance and the next commit retry.
			log('reconcile:no-rev-quorum', {
				blockId,
				rev: committed.rev,
				cohortPeers: targets.length,
				holders: revClaims.length,
				behind: tally('behind'),
				noArchive: tally('no-archive'),
				fetchErrors: tally('error'),
				required: quorumSize(revClaims.length, deps.simpleMajorityThreshold, capacity),
				repairCorroborationClusterSize: deps.repairCorroborationClusterSize
			});
			return;
		}

		if (selected.certified) {
			// Which rule won matters when reading a repair log: a certified selection may rest on a
			// SINGLE claimant whose corroboration is the cohort's signature set, not other voters.
			log('reconcile:certified-selected', {
				blockId, rev: selected.rev, claimants: selected.supporters.length
			});
		}

		const hashCandidates = await hashCarriers(candidates, selected);
		const agreed = selectQuorumBlock(hashCandidates, deps.simpleMajorityThreshold, capacity);
		if (!agreed) {
			// Two certified hashes at one (rev, actionId) means the cohort's keys signed two digests
			// into one revision — a provable compromise an operator must be able to tell apart from a
			// routine carrier shortfall; without this line the two declines log identically.
			const equivocation = certifiedContentEquivocation(hashCandidates);
			if (equivocation) {
				log('reconcile:certified-content-equivocation', {
					blockId, rev: selected.rev, hashes: equivocation.hashes
				});
			}
			log('reconcile:no-content-quorum', {
				blockId,
				rev: selected.rev,
				carriers: hashCandidates.length,
				required: quorumSize(hashCandidates.length, deps.simpleMajorityThreshold, capacity),
				repairCorroborationClusterSize: deps.repairCorroborationClusterSize
			});
			return;
		}

		// Detection is sound: selectQuorumBlock's certified branch fires iff exactly one distinct
		// certified hash exists, so a defined `agreed` with a certified carrier at `agreed.hash` ⇔
		// the certified rule won.
		const certifiedCarrier = hashCandidates.find(c => c.certified === true && c.hash === agreed.hash);

		// Contradicting-content penalties run ONLY on a corroborated win, mirroring the read path's
		// rule (CoordinatorRepo.penalizeContradictingRevClaims): an unanchored proof must not be able
		// to convict the honest cohort — anyone holding N keys can mint a proof that verifies, and
		// penalizing dissenters against it would hand a forged proof a reputation lever. Revisit when
		// certification is anchored to the block's derived cohort
		// (`feat-cluster-membership-threshold-cert-anchoring`).
		if (!certifiedCarrier) {
			penalizeContradictingContent(deps.reputation, hashCandidates, agreed.hash, blockId);
		}

		// A corroboration-won heal with no certified carrier persists no proof — today's behavior.
		await deps.saveReplicatedBlock(
			blockId, agreed.block, { actionId: selected.actionId, rev: selected.rev }, certifiedCarrier?.proof);
		log('reconcile:restored', { blockId, rev: selected.rev, actionId: selected.actionId });
	};
}
