/**
 * Cohort-topic substrate — the **commit-log direct trust anchor** for a reactivity root (db-p2p side of
 * `IMembershipTrustAnchor`, beside `FretTrustAnchor`).
 *
 * **What it closes.** A subscriber verifies a change notification against the root group's
 * `MembershipCertV1`, and the db-core trust gate believes a fetched certificate only when something vouches
 * for it. `FretTrustAnchor` can vouch only for a group this node is itself in, so for a subscriber far from
 * the tail — nearly every subscriber in a network wider than one group — every root certificate was accepted
 * on first use. Since `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort` the root group
 * IS the tail block's storage group, and that group leaves a record of itself that any machine can check: the
 * durable commit proof of the tail block (`BlockCommitProof`, `docs/internals.md` §Durable commit proof),
 * whose `peerIds` is the committing cohort, bound into every vote signature by the membership digest. This
 * anchor fetches the tail's latest certified proof from the tail's storage group and judges the
 * certificate's signers against the cohort that proof names.
 *
 * **The rule (`directAnchor(cert, tier, placement)`).** `"unknown"` unless the placement names a `rootKey`
 * that hashes to the certificate's coordinate — the key names the block, and a key for another coordinate
 * is never judged against this one. The key is decoded as the tail block id (a routing key is the raw UTF-8
 * of the id, `routingKeyForBlock`). The **anchoring set** is the `peerIds` of the highest-revision certified
 * proof the tail's group returns (below); none → `"unknown"`. The certificate's `signers` — the quorum that
 * actually signed, which a forger cannot populate with real members without their keys, the same reasoning
 * as `FretTrustAnchor` — are decoded to peer-id strings and compared (`judgeSigners`, shared with that
 * anchor): every signer in the set, and at least `ceil(|set| × quorumRatio)` of them → `"anchored"`; no
 * signer in the set → `"rejected"`; a partial overlap → `"unknown"`, because membership can churn between
 * the tail's last commit and the certificate, and over-rejecting would silence a legitimate group where the
 * chain or the next commit settles it. Too few signers is `"unknown"` as well: the certificate's own
 * threshold is a ratio of the members IT lists, so without the count against the set one group member could
 * list itself alone and be vouched for. Total: any decode failure on attacker-supplied bytes
 * is `"unknown"`, and nothing here throws or rejects.
 *
 * **The anchoring set.** Every member of the root group at the coordinate (`membersAt`, the node's
 * `rootGroupAt` binding over the key network's storage rule) is asked in parallel for the tail's latest
 * certified claim (`latestClaimFrom`, the node's `clusterLatestCallback`, which already budgets each peer
 * and answers self from local storage). A rejection is silence and that peer is skipped. Each proof is run
 * through `certifyClaim` against the claim `(tail, rev, actionId)` the peer made — the claim binding is what
 * stops a genuine proof for another block or revision being replayed — and an uncertified proof is logged
 * and ignored, never penalized here. The highest certified revision wins, so a lagging peer's older proof
 * loses to a current one; two certified proofs at that revision under different action ids are an
 * **equivocation** (`commit-log-anchor:equivocation`) and yield no set. Two certified proofs at one revision
 * under one action id can legitimately name different cohorts — a torn action is re-sent at the same action
 * id and revision, possibly to a group that rotated between the attempts — so their `peerIds` are united (a united set is larger, so it raises the quorum a certificate must reach: the union can only turn `"anchored"` into `"unknown"`).
 * `peerIds` rather than the proof's verified signers: it is the whole committing cohort, attested by the
 * super-majority that signed over its digest, and a certificate signer who was in the cohort but did not
 * vote in that one commit is still a legitimate member.
 *
 * **Caching and flood bound.** One entry per tail block id — the set, or its absence — reused for `ttlMs`
 * (default {@link DEFAULT_COMMIT_LOG_ANCHOR_TTL_MS}, the subscription renewal cadence), one in-flight fetch
 * per tail shared by concurrent calls, `LruMap`-capped at `maxTails`. The verifier consults the anchor only
 * for a self-consistent certificate naming exactly the coordinate being verified, so spraying fake tail ids
 * buys an attacker no proof queries against honest groups, and the TTL bounds the rest to one group query
 * per tail per interval. The anchor holds no timers.
 *
 * **What it does not prove.** A certified proof says the listed cohort signed, not that it is the tail's
 * legitimate cohort (`feat-cluster-membership-threshold-cert-anchoring`). The proof is fetched from the group
 * this node's own key network names for the tail — the group its reads and writes of that block already go
 * to — so this anchor ties reactivity trust to the trust the node already places in the collection's data,
 * and no further. And a transient `"unknown"` (no member answered in budget, a tail revision with no
 * retained proof) still lets the certificate in on first use; see the `NOTE:` at the composition in
 * `host.ts`.
 */

import type {
	BlockId,
	IMembershipTrustAnchor,
	IRingHash,
	MembershipCertV1,
	RingCoord,
	RootPlacement,
	TrustAnchorVerdict,
} from "@optimystic/db-core";
import { LruMap, b64urlToBytes, bytesEqual } from "@optimystic/db-core";
import { certifyClaim } from "../cluster/certified-claims.js";
import type { ProofThresholds } from "../cluster/commit-proof.js";
import type { CertifiedActionRev } from "../storage/block-archive.js";
import { bytesToPeerIdString } from "./peer-codec.js";
import { judgeSigners, rootGroupQuorum } from "./signer-verdict.js";
import { createLogger } from "../logger.js";

const log = createLogger("cohort-topic");

/** How long one tail's anchoring set (or its absence) is reused: the subscription renewal cadence. */
export const DEFAULT_COMMIT_LOG_ANCHOR_TTL_MS = 30_000;
/** Distinct tails whose anchoring set is retained; the least recently judged is evicted beyond it. */
export const DEFAULT_COMMIT_LOG_ANCHOR_MAX_TAILS = 1024;

/** Construction inputs for a {@link CommitLogTrustAnchor}. */
export interface CommitLogTrustAnchorOptions {
	/**
	 * The root group at a coordinate: the key network's serving cohort there, as peer-id strings. The node
	 * binds its `rootGroupAt`, the same rule the cohort-topic host serves the root under. A rejection is
	 * "no group", so no set.
	 */
	readonly membersAt: (coord: RingCoord) => Promise<readonly string[]>;
	/**
	 * Ask one peer for its latest claim on a block, with the cohort commit proof it retained for that
	 * revision (`ClusterLatestCallback`'s three-way contract: a claim, `undefined` for "holds nothing", a
	 * rejection for silence). The node adapts its `clusterLatestCallback`, which budgets each peer.
	 */
	readonly latestClaimFrom: (peerId: string, blockId: BlockId) => Promise<CertifiedActionRev | undefined>;
	/** The thresholds a proof is certified under: `proofThresholds(consensusConfig.superMajorityThreshold)`. */
	readonly thresholds: ProofThresholds;
	/** The ring hash a root key is placed by — db-core's `createRingHash()`, as the verifier derives the root coordinate. */
	readonly hash: IRingHash;
	/** Reuse window for one tail's anchoring set. Default {@link DEFAULT_COMMIT_LOG_ANCHOR_TTL_MS}. */
	readonly ttlMs?: number;
	/** Cap on retained tails. Default {@link DEFAULT_COMMIT_LOG_ANCHOR_MAX_TAILS}. */
	readonly maxTails?: number;
	/** Wall clock (ms); tests inject one. Default `Date.now`. */
	readonly now?: () => number;
}

/** What one fetch of a tail's group established, kept for the reuse window. */
interface AnchoringSet {
	/** The committing cohort of the highest certified revision, or `undefined` when none was established. */
	readonly peerIds: ReadonlySet<string> | undefined;
	/** That revision, when a set was established. */
	readonly rev: number | undefined;
	readonly fetchedAt: number;
}

/** One peer's certified claim, as the fetch collects them before choosing the top revision. */
interface CertifiedTailClaim {
	readonly rev: number;
	readonly actionId: string;
	readonly peerIds: readonly string[];
}

// Built on first use: Hermes has no native `TextDecoder`, so constructing it at module load would fail the
// import ahead of the host's polyfill (the same idiom as `peer-codec.ts`).
let utf8DecoderInstance: TextDecoder | undefined;
const utf8Decoder = (): TextDecoder => utf8DecoderInstance ??= new TextDecoder("utf-8", { fatal: true });

/**
 * The commit-log {@link IMembershipTrustAnchor}: judges a reactivity root's certificate against the tail
 * block's latest certified commit proof. See the module header for the full rule.
 */
export class CommitLogTrustAnchor implements IMembershipTrustAnchor {
	private readonly byTail: LruMap<string, AnchoringSet>;
	private readonly inFlight = new Map<string, Promise<AnchoringSet>>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(private readonly options: CommitLogTrustAnchorOptions) {
		this.ttlMs = options.ttlMs ?? DEFAULT_COMMIT_LOG_ANCHOR_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
		this.byTail = new LruMap(options.maxTails ?? DEFAULT_COMMIT_LOG_ANCHOR_MAX_TAILS);
	}

	async directAnchor(cert: MembershipCertV1, _tier: number, placement?: RootPlacement): Promise<TrustAnchorVerdict> {
		try {
			const rootKey = placement?.rootKey;
			if (placement === undefined || rootKey === undefined || rootKey.length === 0) {
				return "unknown"; // not a root-placed cert whose key the caller knew: nothing to locate
			}
			const coord: RingCoord = b64urlToBytes(cert.cohortCoord);
			if (!bytesEqual(this.options.hash.H(rootKey), coord)) {
				return "unknown"; // the key names some other coordinate; never judge one against the other
			}
			// Decode before any network work, so a malformed cert costs no query.
			const signers = cert.signers.map((s) => bytesToPeerIdString(b64urlToBytes(s)));
			if (signers.length === 0) {
				return "unknown"; // a self-consistent cert always has signers; defensive
			}
			const anchoring = await this.anchoringSetFor(utf8Decoder().decode(rootKey) as BlockId, coord);
			return anchoring === undefined ? "unknown" : judgeSigners(signers, anchoring, rootGroupQuorum(anchoring, placement));
		} catch (err) {
			// Any decode failure on attacker-supplied bytes, or an unexpected fault below: this anchor cannot
			// judge the cert. Total, never throws — the verifier falls through to the chain / TOFU.
			log("commit-log-anchor:error coord=%s error=%o", cert.cohortCoord, err);
			return "unknown";
		}
	}

	/**
	 * The anchoring set for `tailId`: the held one inside its reuse window, else one fetch shared by every
	 * concurrent caller. Absence is held too, so a tail with no certified proof is re-asked once per window.
	 *
	 * NOTE: a held set can be one commit behind. A certificate from a group that changed since is judged
	 * against the older cohort until the window ends — `"rejected"` if the group turned over completely,
	 * `"unknown"` if partly — and the watch's renewal-tick tail read covers the notification that failed.
	 * Refetching on a mismatch would let forged notifications drive group queries, which the window exists
	 * to bound. If missed wakes after a membership change show up, refetch once on a mismatch against a set
	 * older than some minimum age.
	 */
	private async anchoringSetFor(tailId: BlockId, coord: RingCoord): Promise<ReadonlySet<string> | undefined> {
		const held = this.byTail.get(tailId);
		if (held !== undefined && this.now() - held.fetchedAt < this.ttlMs) {
			return held.peerIds;
		}
		let pending = this.inFlight.get(tailId);
		if (pending === undefined) {
			pending = this.fetchAnchoringSet(tailId, coord).finally(() => this.inFlight.delete(tailId));
			this.inFlight.set(tailId, pending);
		}
		return (await pending).peerIds;
	}

	/** Ask the tail's group, certify what it serves, pick the top revision, and record the outcome. Never rejects. */
	private async fetchAnchoringSet(tailId: BlockId, coord: RingCoord): Promise<AnchoringSet> {
		let set: AnchoringSet;
		try {
			set = await this.establishAnchoringSet(tailId, coord);
			// The only trace of a fetch that found no set: without it a root that fell back to first use
			// looks the same as an anchored one.
			log("commit-log-anchor:set tail=%s rev=%s peers=%d", tailId, set.rev ?? "none", set.peerIds?.size ?? 0);
		} catch (err) {
			// `membersAt` or an unexpected fault: hold the absence for the window, as for "no proof served",
			// so a failing group read is asked again once per window rather than on every verify.
			log("commit-log-anchor:fetch-failed tail=%s error=%o", tailId, err);
			set = { peerIds: undefined, rev: undefined, fetchedAt: this.now() };
		}
		this.byTail.set(tailId, set);
		return set;
	}

	private async establishAnchoringSet(tailId: BlockId, coord: RingCoord): Promise<AnchoringSet> {
		const members = [...new Set(await this.options.membersAt(coord))];
		const claims = await this.certifiedClaimsFrom(members, tailId);
		return { ...chooseAnchoringSet(tailId, claims), fetchedAt: this.now() };
	}

	/** Every member's answer, settled together; the certified ones, with the cohort each proof names. */
	private async certifiedClaimsFrom(members: readonly string[], tailId: BlockId): Promise<CertifiedTailClaim[]> {
		// `async`, so a callback that throws before it returns a promise (an unparseable peer id) is that
		// peer's silence rather than a failed fetch for the whole group.
		const answers = await Promise.allSettled(members.map(async (peer) => this.options.latestClaimFrom(peer, tailId)));
		const certified: CertifiedTailClaim[] = [];
		for (const [i, answer] of answers.entries()) {
			if (answer.status !== "fulfilled") {
				continue; // silence: skip the peer
			}
			const claim = await this.certifyAnswer(tailId, members[i]!, answer.value);
			if (claim !== undefined) {
				certified.push(claim);
			}
		}
		return certified;
	}

	/**
	 * One peer's answer run through `certifyClaim` against the claim the peer itself made; `undefined` for an
	 * answer carrying no proof or no usable claim, and for an uncertified proof, which is logged and never
	 * penalized here — a lagging or pre-proof peer is not misbehaving.
	 */
	private async certifyAnswer(tailId: BlockId, peer: string, answer: CertifiedActionRev | undefined): Promise<CertifiedTailClaim | undefined> {
		if (answer === null || typeof answer !== "object" || answer.proof === undefined
			|| typeof answer.rev !== "number" || typeof answer.actionId !== "string") {
			return undefined;
		}
		const { proof, rev, actionId } = answer;
		const verdict = await certifyClaim(proof, { blockId: tailId, rev, actionId }, this.options.thresholds);
		if (!verdict.certified) {
			log("commit-log-anchor:proof-uncertified tail=%s peer=%s rev=%d failure=%s", tailId, peer, rev, verdict.failure);
			return undefined;
		}
		return { rev, actionId, peerIds: proof.peerIds };
	}
}

/**
 * The top-revision rule over certified claims: the highest revision wins; two action ids at that revision
 * are an equivocation and yield no set; one action id unites the cohorts its proofs name.
 */
function chooseAnchoringSet(tailId: BlockId, claims: readonly CertifiedTailClaim[]): Pick<AnchoringSet, "peerIds" | "rev"> {
	if (claims.length === 0) {
		return { peerIds: undefined, rev: undefined };
	}
	const top = Math.max(...claims.map((c) => c.rev));
	const atTop = claims.filter((c) => c.rev === top);
	const actionIds = new Set(atTop.map((c) => c.actionId));
	if (actionIds.size > 1) {
		// Whoever holds the group's keys signed two actions into one revision: a key compromise or a fork,
		// never a shortage. Decline rather than pick a side; the next commit's proof is what settles it.
		log("commit-log-anchor:equivocation tail=%s rev=%d actions=%s", tailId, top, [...actionIds].join(","));
		return { peerIds: undefined, rev: undefined };
	}
	return { peerIds: new Set(atTop.flatMap((c) => c.peerIds)), rev: top };
}
