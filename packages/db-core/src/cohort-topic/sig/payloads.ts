/**
 * Cohort-topic substrate — canonical threshold-signature payloads.
 *
 * A threshold signature is only verifiable if signer and verifier agree on the exact bytes signed.
 * These builders produce that deterministic byte image for each threshold-signed message
 * (`MembershipCertV1`, `PromotionNoticeV1`, `DemotionNoticeV1`), covering exactly the semantic
 * fields per `docs/cohort-topic.md` §Wire formats — never the `thresholdSig`/`signers` envelope.
 *
 * Determinism comes from encoding an explicitly-ordered JSON array (array order is stable, unlike
 * object key order) as UTF-8. The publisher signs this image; the verifier recomputes and checks it.
 */

import type { DemotionNoticeV1, MembershipCertV1, PromotionNoticeV1 } from "../wire/types.js";

const utf8 = new TextEncoder();

/** Fields of a `MembershipCertV1` covered by its threshold signature (doc: cohortCoord, cohortEpoch, members, stabilizedAt). */
export type MembershipCertSignable = Pick<MembershipCertV1, "cohortCoord" | "cohortEpoch" | "members" | "stabilizedAt">;

/** Canonical signed byte image of a membership certificate. */
export function membershipCertSigningPayload(cert: MembershipCertSignable): Uint8Array {
	return utf8.encode(JSON.stringify(["MembershipCertV1", cert.cohortCoord, cert.cohortEpoch, cert.members, cert.stabilizedAt]));
}

/** Fields of a `PromotionNoticeV1` covered by its threshold signature. */
export type PromotionSignable = Pick<PromotionNoticeV1, "topicId" | "fromTier" | "toTier" | "effectiveAt" | "cohortEpoch">;

/** Canonical signed byte image of a promotion notice. */
export function promotionNoticeSigningPayload(n: PromotionSignable): Uint8Array {
	return utf8.encode(JSON.stringify(["PromotionNoticeV1", n.topicId, n.fromTier, n.toTier, n.effectiveAt, n.cohortEpoch]));
}

/** Fields of a `DemotionNoticeV1` covered by its threshold signature. */
export type DemotionSignable = Pick<DemotionNoticeV1, "topicId" | "tier" | "parentCohortCoord" | "effectiveAt" | "cohortEpoch">;

/** Canonical signed byte image of a demotion notice. */
export function demotionNoticeSigningPayload(n: DemotionSignable): Uint8Array {
	return utf8.encode(JSON.stringify(["DemotionNoticeV1", n.topicId, n.tier, n.parentCohortCoord, n.effectiveAt, n.cohortEpoch]));
}
