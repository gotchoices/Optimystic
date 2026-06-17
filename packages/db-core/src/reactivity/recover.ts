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

/** The recover RPC discriminant: which of the two recovery exchanges the frame carries. */
export type RecoverKind = "backfill" | "resume";

/** A subscriber's recover request — exactly one of {@link backfill} / {@link resume}, per {@link kind}. */
export interface RecoverRequestV1 {
	v: 1;
	kind: RecoverKind;
	/** Present iff `kind === "backfill"`. */
	backfill?: BackfillV1;
	/** Present iff `kind === "resume"`. */
	resume?: ResumeV1;
}

/** The cohort's recover reply — exactly one of {@link backfillReply} / {@link resumeReply}, per {@link kind}. */
export interface RecoverReplyV1 {
	v: 1;
	kind: RecoverKind;
	/** Present iff `kind === "backfill"`. */
	backfillReply?: BackfillReplyV1;
	/** Present iff `kind === "resume"`. */
	resumeReply?: ResumeReplyV1;
}

/** Narrow `obj.kind` to a {@link RecoverKind}, throwing on any other value. */
function reqKind(obj: Record<string, unknown>, what: string): RecoverKind {
	const kind = obj["kind"];
	if (kind !== "backfill" && kind !== "resume") {
		failWire(`${what}: field "kind" must be "backfill" or "resume"`);
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
	const kind = reqKind(obj, what);
	if (kind === "backfill") {
		rejectStrayBranch(obj, "resumeReply", what);
		return { v: 1, kind, backfillReply: validateBackfillReplyV1(obj["backfillReply"]) };
	}
	rejectStrayBranch(obj, "backfillReply", what);
	return { v: 1, kind, resumeReply: validateResumeReplyV1(obj["resumeReply"]) };
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
