import type { IBlock } from "@optimystic/db-core";
import type { BlockCommitProof } from "./commit-proof.js";

/**
 * Quorum-corroboration helpers shared by the two block-restoration paths:
 *   - read-repair   (`CoordinatorRepo.queryClusterForLatest`)
 *   - reconcile     (`libp2p-node-base.reconcileBlock`)
 *
 * Both paths previously trusted a single peer's self-reported "latest" (max rev
 * wins), so one lying peer could steer restoration. These helpers replace
 * "max wins" with "highest value corroborated by a quorum of distinct peers".
 *
 * NOTE: the quorum here is corroboration-of-a-claim, NOT Sybil-resistant cohort
 * membership. A peer minting fresh keypairs can still cast a vote. Selection now
 * additionally weighs *certified* claims — those whose cohort commit proof a
 * caller has already verified (`cluster/certified-claims.ts`) and marked via the
 * injected `certified` flag — so a lone honest holder with a valid proof is
 * sufficient where uncertified claims still need distinct-peer corroboration.
 * Certified claims are additionally weighed by the proof's SIGNER COUNT
 * (`certifiedSignerCount`, injected alongside the flag): a single-signer proof —
 * routine since solo cohorts mint their own commit receipts — is one machine's
 * honest word about its own commit, so it wins only where nothing multi-peer
 * contests it, and never outranks several distinct peers agreeing at the same
 * revision. Verification itself never happens here: both selectors stay pure and
 * synchronous; verdicts arrive as booleans and counts.
 */

/** A single peer's self-reported (rev, actionId) for a block. */
export interface RevClaim {
	/** Distinct voter identity (peer-id string). One vote per distinct peerId per group. */
	peerId: string;
	rev: number;
	actionId: string;
	/**
	 * The cohort commit proof the claiming peer attached, when it had one. Selection never reads
	 * this field: presence proves nothing on its own — the peer chose what to attach. A caller
	 * that verifies it (`certifyClaim` / `certifyContent` in `cluster/certified-claims.ts`, built
	 * on `verifyBlockCommitProofClaim`) records the verdict in {@link certified}, which is what
	 * {@link selectQuorumRev} weighs.
	 */
	proof?: BlockCommitProof;
	/**
	 * Injected verdict: the caller verified this claim's cohort commit proof and it certifies this
	 * exact `(rev, actionId)`. A certified claim carries the cohort's signature set as its
	 * corroboration, so {@link selectQuorumRev} can select it without a second peer vouching.
	 * Never set this from the mere presence of {@link proof}.
	 */
	certified?: boolean;
	/**
	 * Distinct signers in the verified proof, injected by the caller from the certification verdict
	 * (`ClaimCertification.signerCount`, `cluster/certified-claims.ts`) — never read off
	 * {@link proof} here. Meaningful only when {@link certified} is set. Selection weighs a certified
	 * claim as SINGLE-SIGNER when this is absent or below two: the conservative direction, since a
	 * single-signer proof (a solo cohort's self-signed commit receipt) must never outrank multi-peer
	 * agreement, and a caller that forgot to plumb the count should degrade toward corroboration,
	 * not toward trusting one signature.
	 */
	certifiedSignerCount?: number;
}

/** The (rev, actionId) pair a quorum agreed on, plus the peers that corroborated it. */
export interface QuorumRev {
	rev: number;
	actionId: string;
	/**
	 * Distinct peer-ids that voted for this exact (rev, actionId). When {@link certified} is set,
	 * these are the certified claimants at that pair instead — possibly a single peer, whose
	 * corroboration is the proof's signature set rather than other voters.
	 */
	supporters: string[];
	/** Set when the certified path selected this pair, so callers can log which rule won. */
	certified?: true;
}

/**
 * Votes a claim needs when the cohort is big enough to supply them: a claim must be
 * seconded by a second, independent peer. See {@link quorumSize} for the cap that
 * applies when the cohort is smaller than this.
 */
export const CORROBORATION_FLOOR = 2;

/**
 * Number of distinct corroborating votes required to accept a claim:
 * `floor(simpleMajorityThreshold × responderCount)`, never below
 * {@link CORROBORATION_FLOOR} — except that demanding more corroborators than the cohort
 * can possibly supply is a deadlock, not a safety property, so the floor is additionally
 * capped at `corroboratorCapacity`.
 *
 * `corroboratorCapacity` is how many peers OTHER than the asking node could answer at
 * all. Omit it when the caller cannot state one; the absolute floor of two then applies,
 * which is the conservative direction (a claim no one seconded is never accepted).
 *
 * Note the capacity caps the FLOOR only, never the proportional term: with many
 * responders the majority requirement still grows past two.
 */
export function quorumSize(
	responderCount: number,
	simpleMajorityThreshold: number,
	corroboratorCapacity: number = Number.POSITIVE_INFINITY
): number {
	const floor = Math.max(1, Math.min(CORROBORATION_FLOOR, corroboratorCapacity));
	return Math.max(floor, Math.floor(simpleMajorityThreshold * responderCount));
}

/**
 * The `corroboratorCapacity` to hand {@link quorumSize}: how many peers other than the asking node
 * could answer for a block at all, given `cohortPeerCount` peers currently visible (self already
 * excluded) and `repairCorroborationClusterSize` — the cohort size this deployment is measured
 * against, resolved by `resolveClusterPolicy` in `cluster/cluster-policy.ts`.
 *
 * Deliberately the MAX of the two: the corroboration floor may be relaxed only for a cohort that is
 * *genuinely* small, never for one that merely looks small. Cohort views are unauthenticated — the
 * read path takes them from `IKeyNetwork.findCluster`, the commit path from a coordinator-declared
 * peer set — so a partition, a self-shrunk record, or an attacker with routing influence could
 * otherwise talk the requirement down to a single voter. Measuring against the resolved size keeps a
 * shrunken view out of the relaxed branch.
 *
 * An unconfigured node resolves this to its `clusterSize` (default 10), so the floor of two binds and
 * a shrunken view gains nothing. The escape hatch for a real two-node deployment is one explicit
 * operator declaration — `clusterPolicy.assumedClusterSize: 2`, which does NOT also drop the
 * replication factor, or an honest `clusterSize: 2`.
 *
 * Shared by both restoration paths so the two can never drift apart on the rule that decides how
 * much trust a lone peer gets.
 */
export function corroboratorCapacity(cohortPeerCount: number, repairCorroborationClusterSize: number): number {
	return Math.max(cohortPeerCount, repairCorroborationClusterSize - 1);
}

/**
 * Select the highest revision corroborated by a quorum of distinct peers.
 *
 * Claims are grouped by the exact `(rev, actionId)` pair; a liar's fabricated
 * pair lands in its own singleton group and is outvoted. The highest rev whose
 * group has `>= quorum` distinct voters wins.
 *
 * **Claims must not include the asking node's own revision.** A node confirming its own
 * answer is not evidence; its revision is the baseline being repaired, and counting it
 * both inflates the responder count and lets a lone reader "corroborate" itself. Callers
 * filter self out before calling (see `CoordinatorRepo.queryClusterForLatest`,
 * `reconcileBlock`).
 *
 * `corroboratorCapacity` — how many peers other than the asking node could corroborate at
 * all — lets a genuinely tiny cohort still converge: a cohort with exactly one other peer
 * cannot produce two corroborators, so requiring two makes divergence permanent rather
 * than making it safe. Pass a capacity that a shrunken view of the network cannot talk
 * down (see {@link corroboratorCapacity}), or omit it to keep the floor at two.
 *
 * Returns `undefined` when nothing is corroborated — an uncorroborated claim
 * must never drive restoration.
 *
 * **Certified claims** (`certified === true`, injected by a caller that verified the claim's
 * cohort commit proof — see `cluster/certified-claims.ts`) short-circuit the distinct-peer rule,
 * because the proof's signature set IS the corroboration — weighed by how many signers that set
 * actually holds ({@link RevClaim.certifiedSignerCount}):
 *
 *  - No certified claims → today's corroboration result, unchanged.
 *  - A corroborated pair at a HIGHER rev than every certified claim wins — corroboration stays a
 *    legitimate weaker path, so a legacy uncertified tail written after the last proven rev
 *    remains readable.
 *  - A MULTI-SIGNER certified claim (two-plus signers) at the top certified rev wins over an
 *    equal-rev corroborated pair and over any uncorroborated claim: the proof outweighs votes.
 *    Single-signer certified claims at that rev neither outrank it nor equivocate against it — a
 *    solo cohort's self-signed receipt is one machine's word, not the cohort's second signature.
 *  - A SINGLE-SIGNER-only certified rev still wins where nothing multi-peer contests it (a lone
 *    holder with a solo proof stays repairable), but it never beats corroboration by
 *    {@link CORROBORATION_FLOOR}-plus distinct peers at the SAME revision — one machine that was
 *    briefly alone must not outrank the cohort that stayed together. A corroborated pair that
 *    AGREES with the sole certified action is convergence, not a contest; the certified verdict
 *    is kept.
 *  - Two distinct `actionId`s still CONTENDING at the top certified rev is equivocation — the
 *    same keys provably signed two different actions into one revision — and the whole selection
 *    declines (`undefined`). Callers distinguish this decline from a plain no-quorum via
 *    {@link certifiedEquivocation}.
 */
export function selectQuorumRev(
	claims: RevClaim[],
	simpleMajorityThreshold: number,
	corroboratorCapacity?: number
): QuorumRev | undefined {
	if (claims.length === 0) return undefined;

	const groups = new Map<string, { rev: number; actionId: string; supporters: Set<string> }>();
	const responders = new Set<string>();
	for (const c of claims) {
		responders.add(c.peerId);
		const key = `${c.rev}\0${c.actionId}`;
		let g = groups.get(key);
		if (!g) {
			g = { rev: c.rev, actionId: c.actionId, supporters: new Set() };
			groups.set(key, g);
		}
		g.supporters.add(c.peerId);
	}

	const quorum = quorumSize(responders.size, simpleMajorityThreshold, corroboratorCapacity);

	// Highest rev whose (rev, actionId) group meets quorum. There is deliberately no
	// "too few responders, but they all agree" fallback: that rule fired at ANY cohort
	// size, so a lone responder in a large cohort — where a second corroborator does
	// exist and simply did not answer within the per-peer timeout — was accepted on its
	// own word. `corroboratorCapacity` expresses the same permissiveness where it is
	// actually justified (a cohort that cannot supply a second corroborator) and nowhere
	// else.
	let best: { rev: number; actionId: string; supporters: Set<string> } | undefined;
	for (const g of groups.values()) {
		if (g.supporters.size >= quorum && (!best || g.rev > best.rev)) {
			best = g;
		}
	}
	const corroborated = best
		? { rev: best.rev, actionId: best.actionId, supporters: [...best.supporters] }
		: undefined;

	const certified = certifiedGroups(claims);
	if (!certified) return corroborated;
	// A corroborated pair strictly above every certified rev wins — a legacy uncertified tail
	// must stay readable. A merely UNcorroborated higher rev never reaches here (it is not in
	// `corroborated`), so it cannot outrank a proof.
	if (corroborated && corroborated.rev > certified.rev) return corroborated;
	const contenders = certifiedContenders(certified.byAction);
	// A single-signer-only certified rev loses the equal-rev tie to genuinely multi-peer
	// corroboration — unless the corroborated pair AGREES with the sole certified action, which is
	// convergence rather than a contest and keeps the certified verdict (and its logging/penalty
	// exemptions) intact.
	// NOTE: the weighing reaches EQUAL revisions only. A solo fork that committed twice while its
	// cohort committed once claims the higher rev and still wins above. That is not an oversight of
	// this rule: a claim carries no lineage, so "one peer ahead of two" is identical whether it
	// forked or the two are lagging, and refusing it would break ordinary lagging-cohort repair.
	// Pinned by 'does NOT reach a solo fork one revision AHEAD' in quorum-restore-certified.spec.ts;
	// closing it needs new evidence — debt-repair-cannot-tell-a-fork-from-a-lagging-cohort.
	if (!contenders.multiSigner && corroborated && corroborated.rev === certified.rev
		&& corroborated.supporters.length >= CORROBORATION_FLOOR
		&& !(certified.byAction.size === 1 && certified.byAction.has(corroborated.actionId))) {
		return corroborated;
	}
	// Two actions provably signed into the same top revision by contending proofs: decline the
	// whole selection rather than pick a side. Callers log via certifiedEquivocation.
	if (contenders.entries.length !== 1) return undefined;
	const [actionId, group] = contenders.entries[0]!;
	return { rev: certified.rev, actionId, supporters: [...group.supporters], certified: true };
}

/** Distinct certified claimants of one action at the top certified rev, and whether any of their
 * proofs carried two-plus signers. */
interface CertifiedActionGroup {
	supporters: Set<string>;
	/** True when at least one certified claim for this action had `certifiedSignerCount >= 2`. */
	multiSigner: boolean;
}

/** Certified claims at the top certified rev, keyed by actionId → the claimants behind each. */
function certifiedGroups(claims: RevClaim[]): { rev: number; byAction: Map<string, CertifiedActionGroup> } | undefined {
	let top: number | undefined;
	for (const c of claims) {
		if (c.certified === true && (top === undefined || c.rev > top)) top = c.rev;
	}
	if (top === undefined) return undefined;
	const byAction = new Map<string, CertifiedActionGroup>();
	for (const c of claims) {
		if (c.certified !== true || c.rev !== top) continue;
		let g = byAction.get(c.actionId);
		if (!g) {
			g = { supporters: new Set(), multiSigner: false };
			byAction.set(c.actionId, g);
		}
		g.supporters.add(c.peerId);
		// Absent or sub-two count weighs as single-signer — see RevClaim.certifiedSignerCount.
		if ((c.certifiedSignerCount ?? 1) >= 2) g.multiSigner = true;
	}
	return { rev: top, byAction };
}

/**
 * Which certified actions at the top rev actually CONTEND for selection. A multi-signer proof is
 * the cohort's own signature set; a single-signer proof is one machine's word about its own solo
 * commit — so when any action is multi-signer-backed, only the multi-signer-backed ones contend
 * (a solo receipt can neither outrank nor equivocate against a cohort proof), and only with no
 * multi-signer action anywhere do the single-signer ones contend among themselves. One helper so
 * {@link selectQuorumRev} and {@link certifiedEquivocation} cannot drift on the rule.
 */
function certifiedContenders(
	byAction: Map<string, CertifiedActionGroup>
): { entries: [string, CertifiedActionGroup][]; multiSigner: boolean } {
	const multi = [...byAction].filter(([, g]) => g.multiSigner);
	return multi.length > 0
		? { entries: multi, multiSigner: true }
		: { entries: [...byAction], multiSigner: false };
}

/**
 * The conflicting certified set at the top certified rev, when there is one: two-plus distinct
 * `actionId`s that CONTEND there ({@link certifiedContenders}) — each carrying a verified cohort
 * commit proof for the SAME revision, at comparable weight. It deserves a distinct log line from a
 * plain no-quorum — whoever holds the signing keys provably signed both sides. Selection stays
 * pure, so callers do the logging with what this reports.
 *
 * `undefined` when no certified claim exists or a single action contends at the top certified rev —
 * conflicts at LOWER certified revs are history already superseded, and a single-signer proof
 * disagreeing with a multi-signer one at the same rev is a solo machine's fork losing to the
 * cohort, not equivocation worth declining over.
 *
 * **Ask this only on a decline.** A non-`undefined` result does NOT imply {@link selectQuorumRev}
 * returned `undefined`: a corroborated pair STRICTLY above the top certified rev still wins, and
 * the equivocation below it is reported here while selection succeeded. Call it when selection
 * declined, to say WHY it declined.
 */
export function certifiedEquivocation(claims: RevClaim[]): { rev: number; actionIds: string[] } | undefined {
	const groups = certifiedGroups(claims);
	if (!groups) return undefined;
	const contenders = certifiedContenders(groups.byAction);
	if (contenders.entries.length < 2) return undefined;
	return { rev: groups.rev, actionIds: contenders.entries.map(([actionId]) => actionId) };
}

/** One block candidate paired with its serving peer and canonical hash
 * (`canonicalBlockHash` from `@optimystic/db-core`). */
export interface BlockHashCandidate {
	peerId: string;
	hash: string;
	block: IBlock;
	/**
	 * Injected verdict: the caller verified a cohort commit proof binding this candidate's CONTENT
	 * (`certifyContent` in `cluster/certified-claims.ts` — the declared digest matched these
	 * bytes), so the cohort's signatures stand in for other peers serving the same hash.
	 */
	certified?: boolean;
	/**
	 * Distinct signers in the verified proof, from the certification verdict
	 * (`ContentCertification.signerCount`) — the content-side sibling of
	 * {@link RevClaim.certifiedSignerCount}, with the same weighing: meaningful only when
	 * {@link certified} is set, and absent or sub-two counts as single-signer.
	 */
	certifiedSignerCount?: number;
}

/**
 * Among candidates already known to corroborate the target `(rev, actionId)`,
 * pick the block content agreed by a quorum. Requires a UNIQUE hash group meeting
 * `quorum` — a cohort split on content declines rather than picking a side.
 * Returns the agreed block, or `undefined`.
 *
 * `corroboratorCapacity` caps the floor exactly as it does in {@link selectQuorumRev}, and for
 * the same reason: a cohort holding one other peer cannot produce two block-carriers, so
 * demanding two makes the block permanently unrestorable on this node rather than making it safe.
 * Omit it to keep the floor at two.
 *
 * **What relaxing this does and does not cost.** Block ids are random 256-bit strings, not
 * content-addressed, so `canonicalBlockHash` (db-core) is a cross-peer *agreement* hash and never a
 * check against the requested id — nothing here re-derives an id from received bytes. At capacity
 * one the sole peer's content is therefore taken on its word. That extends no trust the cohort had
 * not already extended: the same peer's `(rev, actionId)` claim is equally uncorroborable at that
 * size, and a two-member cohort has no honest majority to appeal to. Pass a capacity a shrunken
 * view of the network cannot talk down (see {@link corroboratorCapacity}), so only a cohort that is
 * *genuinely* that small reaches this branch.
 *
 * **Certified candidates** (`certified === true` — a caller verified a cohort commit proof whose
 * declared digest matches these exact bytes) are weighed by the proof's signer count, mirroring
 * {@link selectQuorumRev}:
 *
 *  - Exactly one distinct MULTI-SIGNER certified hash → that block wins outright, however many
 *    peers served anything else: the cohort's own signatures over the digest outweigh other
 *    carriers' bytes. Two-plus distinct multi-signer certified hashes is certified content
 *    equivocation → decline (`undefined`); a single-signer certified hash alongside a
 *    multi-signer one neither wins nor forces that decline (a solo receipt cannot equivocate
 *    against the cohort's proof).
 *  - SINGLE-SIGNER-only certified hashes no longer short-circuit: a hash group carried by
 *    {@link CORROBORATION_FLOOR}-plus distinct peers that meets the ordinary quorum displaces
 *    them (two-plus such groups is a genuine content disagreement → decline, as ever). With no
 *    multi-peer group to defer to, a sole single-signer certified hash still wins on its proof —
 *    a lone certified holder stays repairable — and two-plus distinct ones decline.
 *  - No certified candidate → the hash quorum below, unchanged.
 *
 * Callers name the certified declines via {@link certifiedContentEquivocation}.
 */
export function selectQuorumBlock(
	candidates: BlockHashCandidate[],
	simpleMajorityThreshold: number,
	corroboratorCapacity?: number
): { block: IBlock; hash: string } | undefined {
	if (candidates.length === 0) return undefined;

	const certifiedByHash = certifiedHashes(candidates);
	const multiSignerHashes = [...certifiedByHash].filter(([, v]) => v.multiSigner);
	if (multiSignerHashes.length === 1) {
		const [hash, { block }] = multiSignerHashes[0]!;
		return { block, hash };
	}
	if (multiSignerHashes.length > 1) return undefined; // certified content equivocation — decline

	// One vote per distinct peer per hash group, matching selectQuorumRev — a peer appearing twice
	// must not be able to second itself into a content quorum.
	const groups = new Map<string, { block: IBlock; supporters: Set<string> }>();
	const voters = new Set<string>();
	for (const c of candidates) {
		voters.add(c.peerId);
		let g = groups.get(c.hash);
		if (!g) {
			g = { block: c.block, supporters: new Set() };
			groups.set(c.hash, g);
		}
		g.supporters.add(c.peerId);
	}

	const quorum = quorumSize(voters.size, simpleMajorityThreshold, corroboratorCapacity);
	const meeting = [...groups.entries()].filter(([, g]) => g.supporters.size >= quorum);

	if (certifiedByHash.size === 0) {
		// Exactly one hash may meet quorum; a tie is a genuine content disagreement → decline.
		if (meeting.length !== 1) return undefined;
		const [hash, group] = meeting[0]!;
		return { block: group.block, hash };
	}

	// Only single-signer certified hashes remain. Genuinely multi-peer agreement — a quorum-meeting
	// group of CORROBORATION_FLOOR-plus distinct carriers — outranks a solo proof, with the usual
	// uniqueness rule among such groups. (A quorum-meeting group of ONE carrier, possible only on a
	// capacity-one cohort, is a bare assertion and does not displace a verified proof.)
	const multiPeer = meeting.filter(([, g]) => g.supporters.size >= CORROBORATION_FLOOR);
	if (multiPeer.length > 1) return undefined;
	if (multiPeer.length === 1) {
		const [hash, group] = multiPeer[0]!;
		return { block: group.block, hash };
	}
	// No multi-peer agreement to defer to: a sole single-signer certified hash wins on its proof;
	// two-plus distinct ones are solo-vs-solo equivocation → decline.
	if (certifiedByHash.size > 1) return undefined;
	const [entry] = certifiedByHash;
	const [hash, { block }] = entry!;
	return { block, hash };
}

/** Distinct hashes carried by certified candidates → the first block instance serving each, and
 * whether any certified candidate at that hash carried a two-plus-signer proof. */
function certifiedHashes(candidates: BlockHashCandidate[]): Map<string, { block: IBlock; multiSigner: boolean }> {
	const byHash = new Map<string, { block: IBlock; multiSigner: boolean }>();
	for (const c of candidates) {
		if (c.certified !== true) continue;
		let entry = byHash.get(c.hash);
		if (!entry) {
			entry = { block: c.block, multiSigner: false };
			byHash.set(c.hash, entry);
		}
		// Absent or sub-two count weighs as single-signer — see BlockHashCandidate.certifiedSignerCount.
		if ((c.certifiedSignerCount ?? 1) >= 2) entry.multiSigner = true;
	}
	return byHash;
}

/**
 * The conflicting certified hashes when there are two or more CONTENDING — the content-side
 * sibling of {@link certifiedEquivocation}, and the reason {@link selectQuorumBlock} declines
 * outright. Candidates reaching that selector all carry the SAME `(rev, actionId)`, so two
 * contending certified hashes mean the same keys signed two different digests into one revision: a
 * provable compromise an operator must be able to tell apart from the routine "not enough carriers
 * agreed" decline. Both declines return `undefined`, so without this they log identically.
 * Contention mirrors the selector: multi-signer certified hashes when any exist, else the
 * single-signer ones among themselves — a solo receipt disagreeing with a cohort proof is a fork
 * losing, not equivocation.
 *
 * `undefined` when fewer than two certified hashes contend — including the ordinary
 * no-certified-candidate case, where a decline really is a plain content-quorum shortfall.
 *
 * **Ask this only on a decline**, exactly as with {@link certifiedEquivocation}: a non-`undefined`
 * result does NOT imply {@link selectQuorumBlock} returned `undefined`. Two contending
 * single-signer certified hashes yield to a {@link CORROBORATION_FLOOR}-plus-carrier quorum group,
 * so selection can succeed while the solo-versus-solo conflict is still reported here. Call it when
 * selection declined, to say WHY.
 */
export function certifiedContentEquivocation(candidates: BlockHashCandidate[]): { hashes: string[] } | undefined {
	const byHash = certifiedHashes(candidates);
	const multi = [...byHash].filter(([, v]) => v.multiSigner);
	const contenders = multi.length > 0 ? multi : [...byHash];
	return contenders.length < 2 ? undefined : { hashes: contenders.map(([hash]) => hash) };
}
