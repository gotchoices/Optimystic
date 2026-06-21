/**
 * Cohort-topic substrate — real signed-parent-reference bootstrap-evidence verifier (db-p2p side).
 *
 * The committed-work proxy for the no-proof-of-work path: a `bootstrap: true` register carries a **signed
 * reference to a parent topic that actually exists**, and the cohort admits it only after confirming the
 * parent topic exists in locally-available committed / membership state. This is the *only* accepted
 * evidence for the committed tiers (T0/T1) and the third option for T2/T3 (`PoW || reputation || parent-ref`).
 *
 * It replaces the interim reputation stand-in for `verifyParentReference` that
 * `cohort-topic-bootstrap-evidence-verifiers` left in `host.ts`.
 *
 * The verifier is **synchronous** (it runs in `member-engine.ts`'s `runGuards` on every register) and
 * **total** (any parse / decode / verify failure on attacker input yields `false`, never a throw). The
 * existence check therefore consults a **synchronous local view** — never a network fetch, which inside an
 * admission gate would itself be a DoS amplifier.
 *
 * Two independent checks, both must pass (`docs/cohort-topic.md` §Anti-DoS bullet 4):
 *
 * 1. **Signed reference (anti-replay).** The participant peer-key-signs the {@link parentRefSigningImage}
 *    — the bound tuple extended with `parentTopicId` — so a reference minted for one
 *    `(topic, tier, peer, time, parent)` cannot be lifted onto another register. Verified against the
 *    participant's own peer key, so it stands alone even in key-less mode (where the outer register
 *    signature is absent).
 * 2. **Existence.** The referenced parent topic must exist in locally-available committed / membership
 *    state, via the injectable synchronous {@link BootstrapParentTopicView}.
 *
 * A node only admits a parent-ref bootstrap for a parent topic it has *locally cached* a cert/commit for
 * (fail-closed when unknown). That is acceptable for an admission gate: a participant whose parent the node
 * does not know retries / uses PoW (T2/T3); a genuinely-new committed (T0/T1) topic is bootstrapped by
 * nodes that already serve the parent's committed work, which hold its cert. A *richer* check — that the
 * parent's commit certificate names *this* child topic — is the follow-on
 * `cohort-topic-parent-ref-tx-log-content`, not this module.
 */

import {
	parseBootstrapEvidenceEnvelope,
	parentRefSigningImage,
	DEFAULT_MAX_NO_POW_TIER,
	b64urlToBytes,
	type RegisterV1,
	type RingCoord,
} from "@optimystic/db-core";
import { verifyPeerSig } from "./peer-sig.js";

/**
 * A synchronous local view answering "does this node locally know parent topic `parentTopicId` exists?".
 * Backed (in the host default) by the committed / FRET membership state the node already holds — never a
 * network lookup (a round-trip inside an admission gate is a DoS amplifier).
 */
export interface BootstrapParentTopicView {
	/**
	 * True iff the node locally knows parent topic `parentTopicId` exists (a committed cohort serves it /
	 * its membership cert is cached) for a cohort at `tier`. `tier` is the registering child's tier and
	 * routes the lookup to the committed (T0/T1) or FRET (T2/T3) backing, mirroring the membership source.
	 */
	exists(parentTopicId: Uint8Array, tier: number): boolean;
}

/** Inputs to {@link createParentReferenceVerifier}. */
export interface ParentReferenceVerifierDeps {
	/** The synchronous local existence view the verifier consults (no network I/O). */
	readonly parentTopicView: BootstrapParentTopicView;
}

/**
 * The real, all-tiers `verifyParentReference(reg) => boolean`. Total and synchronous:
 *
 * ```
 * env = parseBootstrapEvidenceEnvelope(reg); if (!env?.parentRef) return false
 * if (parentRef.parentTopicId === reg.topicId) return false            // a topic cannot vouch for itself
 * if (!verifyPeerSig(participantCoord, parentRefSigningImage(reg, parentTopicId), parentRef.sig)) return false
 * return parentTopicView.exists(parentTopicId, reg.tier)
 * ```
 *
 * - Absent `parentRef`, a malformed envelope, a bad/non-base64url signature, or an unknown parent → `false`
 *   (fails closed → `unwilling_cohort`).
 * - The self-referential guard rejects `parentTopicId === reg.topicId`: a topic cannot reference itself to
 *   prove its own existence (a circular bootstrap).
 */
export function createParentReferenceVerifier(deps: ParentReferenceVerifierDeps): (reg: RegisterV1) => boolean {
	const { parentTopicView } = deps;
	return (reg: RegisterV1): boolean => {
		try {
			const env = parseBootstrapEvidenceEnvelope(reg);
			if (env?.parentRef === undefined) {
				return false; // not offered / not a parent-reference envelope
			}
			const { parentTopicId, sig } = env.parentRef;
			// A topic cannot vouch for its own existence (self-referential / circular bootstrap).
			if (parentTopicId === reg.topicId) {
				return false;
			}
			// 1. Signed reference (anti-replay): the participant binds THIS parent to THIS register.
			const image = parentRefSigningImage(reg, parentTopicId);
			if (!verifyPeerSig(b64urlToBytes(reg.participantCoord), image, b64urlToBytes(sig))) {
				return false;
			}
			// 2. Existence: the parent topic must exist in locally-available committed / membership state.
			return parentTopicView.exists(b64urlToBytes(parentTopicId), reg.tier);
		} catch {
			return false; // any decode / verify failure on attacker input → fail closed
		}
	};
}

/** A synchronous local "is a cohort cached for this coord?" read — the {@link FretMembershipSource} cache shape. */
export interface LocalCohortExistence {
	/** True iff a `MembershipCertV1` is locally cached for `coord`. */
	has(coord: RingCoord): boolean;
}

/** Inputs to {@link createDefaultParentTopicView}. */
export interface DefaultParentTopicViewDeps {
	/** The FRET membership cache (T2/T3 backing): a cached cert means a cohort genuinely serves the parent. */
	readonly membershipSource: LocalCohortExistence;
	/** Tier addressing — supplies `coord0(parentTopicId)`, the parent topic's root cohort coordinate. */
	readonly addressing: { coord0(topicId: Uint8Array): RingCoord };
	/**
	 * Optional committed-state backing for the committed tiers (T0/T1). Reads `coord_0(parentTopicId)`. When
	 * **omitted the committed tiers fail closed** (return `false`) — a FRET-cached cert (T2/T3 membership)
	 * must NOT vouch for committed-tier parent existence (committed-tier integrity). A node supplies a real
	 * committed-by-coord reader (e.g. a future tx-log / commit-cert index) here when one is available.
	 */
	readonly committedReader?: (coord: RingCoord) => boolean;
	/** Highest tier exempt from PoW / served by committed work (T0/T1 → 1). Default {@link DEFAULT_MAX_NO_POW_TIER}. */
	readonly maxNoPowTier?: number;
}

/**
 * The host-default {@link BootstrapParentTopicView}, tier-routed exactly like the membership source
 * (`docs/cohort-topic.md` §Membership source):
 *
 * - **T0/T1 (committed tiers):** consult `committedReader` — the committed-state backing. Absent → `false`
 *   (fail closed). A FRET-cached cert never satisfies a committed-tier existence check, so committed-tier
 *   integrity holds: a parent known only as a FRET (T2/T3) cohort cannot back a committed parent reference.
 * - **T2/T3:** `membershipSource.has(coord_0(parentTopicId))` — a cached `MembershipCertV1` means a cohort
 *   is genuinely serving the parent topic.
 *
 * **Known limitation (interim).** No coord-keyed committed-membership index exists yet (the transaction-log
 * commit certificate is keyed by action, not by `coord_0`), so a node typically wires no `committedReader`
 * and T0/T1 parent-ref existence fails closed. T2/T3 parent-ref is fully real today. The dedicated committed
 * backing is the follow-on `cohort-topic-parent-ref-tx-log-content`.
 */
export function createDefaultParentTopicView(deps: DefaultParentTopicViewDeps): BootstrapParentTopicView {
	const { membershipSource, addressing, committedReader } = deps;
	const maxNoPowTier = deps.maxNoPowTier ?? DEFAULT_MAX_NO_POW_TIER;
	return {
		exists(parentTopicId: Uint8Array, tier: number): boolean {
			const coord = addressing.coord0(parentTopicId);
			if (tier <= maxNoPowTier) {
				// Committed tiers (T0/T1): require a committed backing; fail closed without one. The FRET cache
				// must not vouch for committed-tier existence (committed-tier integrity).
				return committedReader !== undefined && committedReader(coord);
			}
			// T2/T3: the FRET membership cache reflects a cohort serving the parent topic.
			return membershipSource.has(coord);
		},
	};
}
