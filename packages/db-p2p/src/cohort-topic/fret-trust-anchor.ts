/**
 * Cohort-topic substrate — the **FRET-ring direct trust anchor** (db-p2p side of `IMembershipTrustAnchor`).
 *
 * `cohort-topic-trust-anchor-core` added the db-core trust gate (`membership/verifier.ts`): a (re)fetched
 * `MembershipCertV1` is believed only if it is self-consistent **and** anchored by a trust root, the
 * injected direct anchor, or the attestation chain — else it falls to interim trust-on-first-use. db-core
 * ships only `noAuthorityTrustAnchor` (every coord `"unknown"`), so until db-p2p binds a real anchor the
 * gate stays at TOFU. This module binds the **direct anchor** to the one coord→keyset authority FRET
 * exposes today.
 *
 * **What authority FRET offers.** p2p-fret 0.5.0 has **no transferable stabilization proof** — there is no
 * membership-cert/attestation API and the cert's `fretAttestation` field is never populated. The only
 * coord→keyset authority FRET offers is `assembleCohort(coord, wants)` — the ring's two-sided closest-`k`
 * selection — which is **local**: it answers correctly only for coords the node's routing table actually
 * covers (coords the node is near / serves). That is exactly the amplification-exposed `promote`-handler
 * path (`verifyAndApplyNotice` verifies against `target.servedCoord`, a coord the node serves), so binding
 * the anchor to `assembleCohort` rejects the forged-cert attack precisely where the core ticket calls it out.
 *
 * **The rule (`directAnchor(cert, tier)`):**
 *
 * - **Committed tiers (T0/T1)** route to the tx-log commit certificate, not the FRET ring, so this anchor
 *   returns `"unknown"` for them — it composes with (does not fight) a committed-tier anchor. The host asks
 *   this anchor first and hands every `"unknown"` to the anchor it was given (`composeTrustAnchors` in
 *   `host.ts`): today `CommitLogTrustAnchor` (`commit-log-trust-anchor.ts`), which judges a reactivity root
 *   this node is not in against the tail block's commit proof.
 * - **No local authority** — the node cannot cover the coord (cold/partitioned table, or a distant coord the
 *   node is nowhere near, so `assembleCohort` does not yield a populated neighborhood the node is part of) →
 *   `"unknown"`. The db-core gate then falls through to the chain / interim TOFU, so distant verification is
 *   never broken or falsely rejected.
 * - **Covered coord** — compare the cert's **signing quorum** (`cert.signers`, the `≥ minSigs` that actually
 *   signed) against the ring-expected cohort, widened by a small {@link FretTrustAnchorOptions.churnSlack} to
 *   tolerate stabilization skew (membership stabilizes slightly behind the live ring):
 *   - every signer is in the slack-widened ring view → `"anchored"`;
 *   - the quorum is **disjoint** from the ring view (the ring says a wholly different cohort owns this coord)
 *     → `"rejected"` (a forgery — fatal even though it is internally self-consistent);
 *   - partial overlap beyond the slack (genuinely ambiguous within churn tolerance) → `"unknown"` (do not
 *     over-reject on transient skew; defer to the chain / TOFU).
 *
 * **Why anchoring on `signers` (not exact member-set equality) is sound and sufficient.** A forged cert
 * must sign its threshold multisig with keys the adversary controls; those keys are not in the legitimate
 * ring cohort, so a forged quorum is disjoint from `assembleCohort(coord)` → `"rejected"`. A legitimate
 * cert's signers are real cohort members — present in the ring view (within slack) → `"anchored"`. The
 * adversary cannot list real members as `signers` without their keys (the message multisig would not
 * verify), so the quorum-subset test has teeth without demanding brittle full-set equality across churn.
 *
 * **Root-placed coords** (`docs/cohort-topic.md` §Root placement at a routing key). A verifier that knows a
 * coord is the root of a root-placed topic passes a `RootPlacement`, and the authority for that coord is
 * not the FRET cohort of `wantK` but the **root group** — the key network's serving cohort at the coord,
 * which the host reads into a per-coord snapshot ({@link FretTrustAnchorOptions.rootGroupAt}). The same
 * signer-subset rule is applied against that group, with two differences. The group is a complete list
 * sized by storage placement, with no ring neighbours to widen it into, so the churn slack takes the form
 * of the partial-overlap verdict: a signer that has since rotated out of the group makes the cert
 * `"unknown"` (chain / TOFU), never `"rejected"`. And a snapshot this node has not read, or one naming
 * only this node, yields `"unknown"`: the first is nothing to judge against, and the second is what a
 * cold routing table answers for every key, indistinguishable from a genuine group of one.
 *
 * **db-core never imports FRET.** This adapter lives in db-p2p and depends only on the narrow
 * {@link FretRingView} (satisfied by `FretService`), keeping the db-core trust gate transport-agnostic.
 */

import type { IMembershipTrustAnchor, MembershipCertV1, RingCoord, RootPlacement, TrustAnchorVerdict } from "@optimystic/db-core";
import { b64urlToBytes, DEFAULT_MAX_NO_POW_TIER } from "@optimystic/db-core";
import { bytesToPeerIdString } from "./peer-codec.js";

/**
 * The minimal slice of `FretService` the trust anchor needs: the ring's local two-sided cohort assembly
 * around a coord, plus an optional partition signal. `FretService` satisfies it directly; a test (and the
 * mock-mesh harness facade) can supply a stub with just `assembleCohort`.
 */
export interface FretRingView {
	/** Two-sided closest-`wants` selection around `coord` from the node's routing table (peer-id strings). */
	assembleCohort(coord: Uint8Array, wants: number, exclude?: Set<string>): string[];
	/** Optional: `true` when the node believes it is partitioned (table unreliable → never reject). */
	detectPartition?(): boolean;
}

/** Configuration for a {@link FretTrustAnchor}. */
export interface FretTrustAnchorOptions {
	/**
	 * Requested cohort size — must match the host's `wantK`, so the ring view the anchor computes lines up
	 * with the cohort the cohort-side `cohortAround` published the cert over.
	 */
	readonly k: number;
	/** This node's own peer-id string — used for the coverage check (the node must be in the coord's cohort). */
	readonly selfPeerId: string;
	/**
	 * Stabilization-skew slack: the ring-expected cohort is widened to `k + churnSlack` members before the
	 * quorum-subset test, so a legit cert whose signing quorum lags the live ring by a rotation or two is
	 * still `"anchored"`. Kept small so a disjoint forged keyset cannot hide in the slack. Default
	 * {@link DEFAULT_CHURN_SLACK}.
	 */
	readonly churnSlack?: number;
	/**
	 * Highest tier whose membership is anchored in the tx-log commit certificate (T0/T1), for which this
	 * FRET-ring anchor has no authority and returns `"unknown"`. Mirrors the membership-source dispatch
	 * (`createMembershipSourceRouter` treats tier 0/1 as committed). Default {@link DEFAULT_MAX_NO_POW_TIER}.
	 */
	readonly maxCommittedTier?: number;
	/**
	 * The root group this node last read for a root-placed coord (peer-id strings, the host's snapshot), or
	 * `undefined` when it holds none. Consulted only for a cert verified under a `RootPlacement`. Synchronous
	 * on purpose: this anchor is local authority — it reads the snapshot the host filled before the
	 * verification that needs it and never asks the network — so its verdict is immediate even though the
	 * verifier's trust gate awaits the port; a group this node holds no snapshot for is `"unknown"`, which
	 * the host hands to the commit-log anchor. Absent → every root-placed cert is `"unknown"` (a host that
	 * serves no root placement cannot judge one).
	 */
	readonly rootGroupAt?: (coord: RingCoord) => readonly string[] | undefined;
}

/**
 * Default stabilization-skew slack (`churn_slack ≈ 2`): a legit cert may lag the live ring by ~1–2 members
 * (one rotates in, one rotates out) between stabilization and the verifier's table view; widening to
 * `k + 2` admits that skew while still rejecting a wholly-disjoint forged keyset.
 */
export const DEFAULT_CHURN_SLACK = 2;

/**
 * The FRET-ring {@link IMembershipTrustAnchor}: judges a cert's `coord → keyset` binding against the
 * node's local FRET cohort assembly. See the module header for the full rule.
 */
export class FretTrustAnchor implements IMembershipTrustAnchor {
	private readonly k: number;
	private readonly selfPeerId: string;
	private readonly churnSlack: number;
	private readonly maxCommittedTier: number;
	private readonly rootGroupAt: ((coord: RingCoord) => readonly string[] | undefined) | undefined;

	constructor(private readonly fret: FretRingView, options: FretTrustAnchorOptions) {
		this.k = options.k;
		this.selfPeerId = options.selfPeerId;
		this.churnSlack = options.churnSlack ?? DEFAULT_CHURN_SLACK;
		this.maxCommittedTier = options.maxCommittedTier ?? DEFAULT_MAX_NO_POW_TIER;
		this.rootGroupAt = options.rootGroupAt;
	}

	directAnchor(cert: MembershipCertV1, tier: number, placement?: RootPlacement): TrustAnchorVerdict {
		try {
			// A partitioned table is unreliable: never reject a legit cert during a partition — defer to TOFU.
			if (this.fret.detectPartition?.() === true) {
				return "unknown";
			}
			const coord: RingCoord = b64urlToBytes(cert.cohortCoord);
			// A root-placed coord's authority is the root group, whatever the tier: the placement rule is the
			// key network's, which this node applies at every tier, so the committed-tier deferral inside
			// `fretView` (the FRET ring has no say over T0/T1) does not apply to it.
			const expected = placement === undefined ? this.fretView(tier, coord) : this.rootGroupView(coord);
			if (expected === undefined) {
				return "unknown";
			}
			// Decode the cert's signing quorum into FRET peer-id strings (the same form `assembleCohort` yields).
			const signers = cert.signers.map((s) => bytesToPeerIdString(b64urlToBytes(s)));
			if (signers.length === 0) {
				return "unknown"; // nothing to judge (a self-consistent cert always has signers; defensive)
			}
			let inRing = 0;
			for (const signer of signers) {
				if (expected.has(signer)) {
					inRing++;
				}
			}
			if (inRing === signers.length) {
				return "anchored"; // the whole signing quorum is a subset of a reasonable ring view
			}
			if (inRing === 0) {
				return "rejected"; // a wholly-disjoint quorum — the ring knows a different cohort owns this coord
			}
			return "unknown"; // partial overlap beyond the slack — ambiguous churn; defer rather than over-reject
		} catch {
			// Any decode failure on attacker-supplied bytes → the ring cannot judge it. Total, never throws.
			return "unknown";
		}
	}

	/**
	 * The slack-widened ring view a default-rule cert's signers are judged against, or `undefined` when this
	 * node has no authority over `coord`: a committed tier (T0/T1, the tx-log anchor's job), a cold or
	 * partitioned table (`< k` members), or a distant coord whose neighbourhood omits self. Either way the
	 * node cannot judge → `"unknown"` (no regression on coords nothing can anchor).
	 */
	private fretView(tier: number, coord: RingCoord): ReadonlySet<string> | undefined {
		if (tier <= this.maxCommittedTier) {
			return undefined;
		}
		const expected = this.fret.assembleCohort(coord, this.k);
		if (expected.length < this.k || !expected.includes(this.selfPeerId)) {
			return undefined;
		}
		return new Set(this.fret.assembleCohort(coord, this.k + this.churnSlack));
	}

	/**
	 * The root group a root-placed cert's signers are judged against, or `undefined` when this node cannot
	 * judge: no reader, no snapshot read for the coord, a group that omits self (the same local-authority
	 * rule as the ring view — the group is assembled from this node's own table, accurate only near it), or
	 * a group of this node alone, which a cold table answers for every key.
	 *
	 * NOTE: the group-of-one guard trades away rejection for a genuine `clusterSize: 1` deployment, where
	 * nothing root-signed by another node ever needs verifying; if a solo group ever has to reject a forged
	 * root cert, tell the anchor the configured group size so it can separate "full" from "cold".
	 */
	private rootGroupView(coord: RingCoord): ReadonlySet<string> | undefined {
		const group = this.rootGroupAt?.(coord);
		if (group === undefined || group.length < 2 || !group.includes(this.selfPeerId)) {
			return undefined;
		}
		return new Set(group);
	}
}
