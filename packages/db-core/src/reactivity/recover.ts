/**
 * Reactivity — recover RPC envelope (`docs/reactivity.md` §Backfill RPC, §Resume, §Wire formats).
 *
 * The db-p2p recover transport runs **one** request-reply protocol
 * (`/optimystic/reactivity/1.0.0/recover`) carrying either a backfill or a resume exchange. Rather than
 * disambiguate two payload shapes structurally off the wire, this module owns an explicit discriminated
 * wrapper so the `kind` discriminant is authoritative: a `kind: "backfill"` frame MUST carry a `backfill`
 * body and no `resume` body (and vice-versa). db-core owns every reactivity wire codec, so the envelope
 * lives here next to the {@link import("./backfill.js").BackfillV1} / {@link import("./resume.js").ResumeV1}
 * payloads it wraps and reuses their per-message validators for the inner branches.
 *
 * **Reply-only `"rotated"` kind.** A subscriber only ever *asks* for a backfill or a resume, so
 * {@link RecoverKind} (the request discriminant) is the narrower `"backfill" | "resume"`. A *reply*,
 * however, may carry a third kind — `"rotated"`, the drain-window {@link RotationRedirectV1} a serving
 * cohort hands a request that arrived at an outgoing tail after it rotated (`docs/reactivity.md` §Tail
 * rotation). The recover reply is the only reactivity surface a subscriber reaches a serving cohort on (a
 * fresh subscribe rides generic cohort-topic `service.register`, whose walk only understands tier-`Promoted`,
 * never a topic redirect), so the redirect rides the recover reply rather than registration.
 *
 * **Forward-compat (fail-closed).** A decoder that predates the `"rotated"` kind rejects it outright — its
 * `kind` narrower only admits `backfill`/`resume` — so an older peer cannot misread a redirect; it simply
 * treats the reply as malformed (no reply / decode failure) and the subscriber falls back to a chain read,
 * which is always safe. A redirect is therefore an *optional optimization* a newer serving cohort offers,
 * never a correctness dependency.
 *
 * Wire conventions match the rest of reactivity: JSON, byte fields base64url, `v: 1`, per-message
 * structural validation on decode (a `kind`/branch mismatch is `failWire`).
 */

import {
	decodeCohortMessage,
	encodeCohortMessage,
	DEFAULT_MAX_MESSAGE_BYTES,
} from "../cohort-topic/wire/codec.js";
import { asObject, failWire, requireV1 } from "./wire-validate.js";
import { validateBackfillV1, validateBackfillReplyV1, type BackfillV1, type BackfillReplyV1 } from "./backfill.js";
import { validateResumeV1, validateResumeReplyV1, type ResumeV1, type ResumeReplyV1 } from "./resume.js";
import { validateRotationRedirectV1, type RotationRedirectV1 } from "./rotation.js";

/** The recover RPC **request** discriminant: which of the two recovery exchanges a subscriber asks for. */
export type RecoverKind = "backfill" | "resume";

/**
 * The recover RPC **reply** discriminant. A superset of {@link RecoverKind}: a reply may additionally be a
 * `"rotated"` {@link RotationRedirectV1} (a subscriber never *asks* for a redirect, so the request kind
 * stays narrower).
 */
export type RecoverReplyKind = RecoverKind | "rotated";

/** A subscriber's recover request — exactly one of {@link backfill} / {@link resume}, per {@link kind}. */
export interface RecoverRequestV1 {
	v: 1;
	kind: RecoverKind;
	/** Present iff `kind === "backfill"`. */
	backfill?: BackfillV1;
	/** Present iff `kind === "resume"`. */
	resume?: ResumeV1;
}

/**
 * The cohort's recover reply — exactly one of {@link backfillReply} / {@link resumeReply} / {@link rotated},
 * per {@link kind}.
 */
export interface RecoverReplyV1 {
	v: 1;
	kind: RecoverReplyKind;
	/** Present iff `kind === "backfill"`. */
	backfillReply?: BackfillReplyV1;
	/** Present iff `kind === "resume"`. */
	resumeReply?: ResumeReplyV1;
	/** Present iff `kind === "rotated"` — the drain-window redirect to the rotated tree. */
	rotated?: RotationRedirectV1;
}

/** Narrow `obj.kind` to a {@link RecoverKind} (request side), throwing on any other value. */
function reqKind(obj: Record<string, unknown>, what: string): RecoverKind {
	const kind = obj["kind"];
	if (kind !== "backfill" && kind !== "resume") {
		failWire(`${what}: field "kind" must be "backfill" or "resume"`);
	}
	return kind;
}

/** Narrow `obj.kind` to a {@link RecoverReplyKind} (reply side — also admits `"rotated"`). */
function reqReplyKind(obj: Record<string, unknown>, what: string): RecoverReplyKind {
	const kind = obj["kind"];
	if (kind !== "backfill" && kind !== "resume" && kind !== "rotated") {
		failWire(`${what}: field "kind" must be "backfill", "resume", or "rotated"`);
	}
	return kind;
}

/** Reject a frame carrying `branch`, the body that does not belong to the declared `kind`. */
function rejectStrayBranch(obj: Record<string, unknown>, branch: string, what: string): void {
	if (obj[branch] !== undefined) {
		failWire(`${what}: a "${branch}" body is present but does not match the declared kind`);
	}
}

/** Narrow an already-parsed value to {@link RecoverRequestV1}, throwing on any defect or kind/branch mismatch. */
export function validateRecoverRequestV1(value: unknown): RecoverRequestV1 {
	const what = "RecoverRequestV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const kind = reqKind(obj, what);
	if (kind === "backfill") {
		rejectStrayBranch(obj, "resume", what);
		return { v: 1, kind, backfill: validateBackfillV1(obj["backfill"]) };
	}
	rejectStrayBranch(obj, "backfill", what);
	return { v: 1, kind, resume: validateResumeV1(obj["resume"]) };
}

/** Narrow an already-parsed value to {@link RecoverReplyV1}, throwing on any defect or kind/branch mismatch. */
export function validateRecoverReplyV1(value: unknown): RecoverReplyV1 {
	const what = "RecoverReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const kind = reqReplyKind(obj, what);
	if (kind === "backfill") {
		rejectStrayBranch(obj, "resumeReply", what);
		rejectStrayBranch(obj, "rotated", what);
		return { v: 1, kind, backfillReply: validateBackfillReplyV1(obj["backfillReply"]) };
	}
	if (kind === "resume") {
		rejectStrayBranch(obj, "backfillReply", what);
		rejectStrayBranch(obj, "rotated", what);
		return { v: 1, kind, resumeReply: validateResumeReplyV1(obj["resumeReply"]) };
	}
	rejectStrayBranch(obj, "backfillReply", what);
	rejectStrayBranch(obj, "resumeReply", what);
	return { v: 1, kind, rotated: validateRotationRedirectV1(obj["rotated"]) };
}

/** Encode a {@link RecoverRequestV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeRecoverRequestV1(msg: RecoverRequestV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateRecoverRequestV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link RecoverRequestV1} frame. */
export function decodeRecoverRequestV1(bytes: Uint8Array, maxMessageBytes?: number): RecoverRequestV1 {
	return validateRecoverRequestV1(decodeCohortMessage(bytes, maxMessageBytes));
}

/** Encode a {@link RecoverReplyV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeRecoverReplyV1(msg: RecoverReplyV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateRecoverReplyV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link RecoverReplyV1} frame. */
export function decodeRecoverReplyV1(bytes: Uint8Array, maxMessageBytes?: number): RecoverReplyV1 {
	return validateRecoverReplyV1(decodeCohortMessage(bytes, maxMessageBytes));
}
