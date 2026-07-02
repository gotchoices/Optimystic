/**
 * Cohort-topic substrate — canonical threshold-signature payloads.
 *
 * A threshold signature is only verifiable if signer and verifier agree on the exact bytes signed.
 * These builders produce that deterministic byte image for each threshold-signed message
 * (`MembershipCertV1`, `PromotionNoticeV1`, `DemotionNoticeV1`, `ChildLinkV1`), covering exactly the
 * semantic fields per `docs/cohort-topic.md` §Wire formats — never the `thresholdSig`/`signers` envelope.
 *
 * Determinism comes from encoding an explicitly-ordered JSON array (array order is stable, unlike
 * object key order) as UTF-8. The publisher signs this image; the verifier recomputes and checks it.
 *
 * The notice images carry `cohortCoord` (the served coord the deciding cohort sits at) so the coord the
 * receiver routes by is bound into the signed bytes — rewriting it to hijack a sibling cohort breaks
 * verification. It is inserted **just before the trailing `cohortEpoch`**, deliberately keeping `cohortEpoch`
 * the LAST element: the `/sign` endorser (`handleSignRequest`) reads a notice's embedded epoch positionally
 * as `image[image.length - 1]`, so `cohortEpoch` must stay last. This is a hard, coordinated change to the
 * canonical signed bytes, acceptable pre-release (no deployed nodes speak this protocol, so there is no
 * version to negotiate).
 */

import type { ChildLinkV1, DemotionNoticeV1, MembershipCertV1, PromotionNoticeV1 } from "../wire/types.js";

const utf8 = new TextEncoder();

/** Fields of a `MembershipCertV1` covered by its threshold signature (doc: cohortCoord, cohortEpoch, members, stabilizedAt). */
export type MembershipCertSignable = Pick<MembershipCertV1, "cohortCoord" | "cohortEpoch" | "members" | "stabilizedAt">;

/** Canonical signed byte image of a membership certificate. */
export function membershipCertSigningPayload(cert: MembershipCertSignable): Uint8Array {
	return utf8.encode(JSON.stringify(["MembershipCertV1", cert.cohortCoord, cert.cohortEpoch, cert.members, cert.stabilizedAt]));
}

/** Fields of a `PromotionNoticeV1` covered by its threshold signature. */
export type PromotionSignable = Pick<PromotionNoticeV1, "topicId" | "fromTier" | "toTier" | "effectiveAt" | "cohortEpoch" | "cohortCoord">;

/** Canonical signed byte image of a promotion notice. `cohortEpoch` stays last (the `/sign` endorser reads it positionally). */
export function promotionNoticeSigningPayload(n: PromotionSignable): Uint8Array {
	return utf8.encode(JSON.stringify(["PromotionNoticeV1", n.topicId, n.fromTier, n.toTier, n.effectiveAt, n.cohortCoord, n.cohortEpoch]));
}

/** Fields of a `DemotionNoticeV1` covered by its threshold signature. */
export type DemotionSignable = Pick<DemotionNoticeV1, "topicId" | "tier" | "parentCohortCoord" | "effectiveAt" | "cohortEpoch" | "cohortCoord">;

/** Canonical signed byte image of a demotion notice. `cohortEpoch` stays last (the `/sign` endorser reads it positionally). */
export function demotionNoticeSigningPayload(n: DemotionSignable): Uint8Array {
	return utf8.encode(JSON.stringify(["DemotionNoticeV1", n.topicId, n.tier, n.parentCohortCoord, n.effectiveAt, n.cohortCoord, n.cohortEpoch]));
}

/** Fields of a `ChildLinkV1` covered by the child cohort's threshold signature. */
export type ChildLinkSignable = Pick<ChildLinkV1, "topicId" | "childCohortCoord" | "childParticipantCoord" | "childTier" | "tier" | "effectiveAt" | "cohortEpoch">;

/**
 * Canonical signed byte image of a child-link frame. `cohortEpoch` stays **last** so the `/sign` endorser
 * (`handleSignRequest`) reads the embedded epoch positionally as `image[image.length - 1]`, exactly as it
 * does for a promotion / demotion notice.
 */
export function childLinkSigningPayload(n: ChildLinkSignable): Uint8Array {
	return utf8.encode(JSON.stringify(["ChildLinkV1", n.topicId, n.childCohortCoord, n.childParticipantCoord, n.childTier, n.tier, n.effectiveAt, n.cohortEpoch]));
}
