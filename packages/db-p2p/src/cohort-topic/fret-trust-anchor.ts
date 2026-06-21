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
 *   returns `"unknown"` for them — it composes with (does not fight) the future tx-log anchor.
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
 * **db-core never imports FRET.** This adapter lives in db-p2p and depends only on the narrow
 * {@link FretRingView} (satisfied by `FretService`), keeping the db-core trust gate transport-agnostic.
 */

import type { IMembershipTrustAnchor, MembershipCertV1, RingCoord, TrustAnchorVerdict } from "@optimystic/db-core";
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

	constructor(private readonly fret: FretRingView, options: FretTrustAnchorOptions) {
		this.k = options.k;
		this.selfPeerId = options.selfPeerId;
		this.churnSlack = options.churnSlack ?? DEFAULT_CHURN_SLACK;
		this.maxCommittedTier = options.maxCommittedTier ?? DEFAULT_MAX_NO_POW_TIER;
	}

	directAnchor(cert: MembershipCertV1, tier: number): TrustAnchorVerdict {
		// Committed tiers (T0/T1) are the tx-log anchor's job, not the FRET ring's — defer.
		if (tier <= this.maxCommittedTier) {
			return "unknown";
		}
		try {
			// A partitioned table is unreliable: never reject a legit cert during a partition — defer to TOFU.
			if (this.fret.detectPartition?.() === true) {
				return "unknown";
			}
			const coord: RingCoord = b64urlToBytes(cert.cohortCoord);
			const expected = this.fret.assembleCohort(coord, this.k);
			// Coverage / local authority: a populated neighborhood the node is itself part of. A cold or
			// partitioned table yields `< k`; a distant coord the node is nowhere near omits self. Either way
			// the node cannot judge → `"unknown"` (no regression on coords nothing can anchor).
			if (expected.length < this.k || !expected.includes(this.selfPeerId)) {
				return "unknown";
			}
			const widened = new Set(this.fret.assembleCohort(coord, this.k + this.churnSlack));
			// Decode the cert's signing quorum into FRET peer-id strings (the same form `assembleCohort` yields).
			const signers = cert.signers.map((s) => bytesToPeerIdString(b64urlToBytes(s)));
			if (signers.length === 0) {
				return "unknown"; // nothing to judge (a self-consistent cert always has signers; defensive)
			}
			let inRing = 0;
			for (const signer of signers) {
				if (widened.has(signer)) {
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
}
