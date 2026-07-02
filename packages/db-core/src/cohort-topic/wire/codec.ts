/**
 * Cohort-topic substrate — wire codec.
 *
 * Framing: every message is a 4-byte big-endian unsigned length prefix followed by the UTF-8
 * JSON body, so a framed message is self-delimiting on a stream. Frames whose declared body
 * length exceeds {@link DEFAULT_MAX_MESSAGE_BYTES} (or a caller-supplied ceiling) are rejected
 * with {@link CohortWireError} before any allocation against the declared size.
 *
 * Byte fields travel as base64url (no padding); {@link bytesToB64url} / {@link b64urlToBytes}
 * are the shared, cross-platform (browser/node/RN) helpers — no Node `Buffer`.
 */

import { CohortWireError } from "./validate.js";
import {
	validateChildLinkReplyV1,
	validateChildLinkV1,
	validateCohortGossipV1,
	validateDemotionNoticeV1,
	validateMembershipCertV1,
	validatePromotionNoticeV1,
	validateRegisterReplyV1,
	validateRegisterV1,
	validateRenewReplyV1,
	validateRenewV1,
	validateSignRequestV1,
	validateSignReplyV1,
} from "./validate.js";
import type {
	ChildLinkReplyV1,
	ChildLinkV1,
	CohortGossipV1,
	DemotionNoticeV1,
	MembershipCertV1,
	PromotionNoticeV1,
	RegisterReplyV1,
	RegisterV1,
	RenewReplyV1,
	RenewV1,
	SignRequestV1,
	SignReplyV1,
} from "./types.js";

/**
 * Default ceiling on a framed body, in bytes. Sized conservatively at 1 MiB until the
 * simulator-validated cohort-gossip worst case (`topics_max` topic summaries, see
 * `docs/cohort-topic.md` §Configuration) is converted into an exact bound.
 *
 * TODO(cohort-topic): derive the exact ceiling from `topics_max` (2048) × the per-summary JSON
 * size plus the willingness/load header, rather than this flat 1 MiB cap.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

const LENGTH_PREFIX_BYTES = 4;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

// --- base64url helpers (no padding, cross-platform) ---

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const B64URL_LOOKUP: ReadonlyArray<number> = ((): number[] => {
	const table = new Array<number>(128).fill(-1);
	for (let i = 0; i < B64URL_ALPHABET.length; i++) {
		table[B64URL_ALPHABET.charCodeAt(i)] = i;
	}
	return table;
})();

/** Encode bytes as base64url with no padding. */
export function bytesToB64url(b: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 3 <= b.length; i += 3) {
		const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
		out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]! + B64URL_ALPHABET[(n >> 6) & 63]! + B64URL_ALPHABET[n & 63]!;
	}
	const rem = b.length - i;
	if (rem === 1) {
		const n = b[i]! << 16;
		out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]!;
	} else if (rem === 2) {
		const n = (b[i]! << 16) | (b[i + 1]! << 8);
		out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]! + B64URL_ALPHABET[(n >> 6) & 63]!;
	}
	return out;
}

/** Decode a base64url string (no padding) to bytes. Throws {@link CohortWireError} on bad input. */
export function b64urlToBytes(s: string): Uint8Array {
	const len = s.length;
	if (len % 4 === 1) {
		throw new CohortWireError("base64url: invalid length");
	}
	const fullGroups = len >> 2;
	const rem = len & 3;
	const outLen = fullGroups * 3 + (rem === 0 ? 0 : rem - 1);
	const out = new Uint8Array(outLen);
	let si = 0;
	let oi = 0;
	const sext = (ch: number): number => {
		const v = ch < 128 ? B64URL_LOOKUP[ch]! : -1;
		if (v < 0) {
			throw new CohortWireError("base64url: invalid character");
		}
		return v;
	};
	for (let g = 0; g < fullGroups; g++) {
		const n = (sext(s.charCodeAt(si)) << 18) | (sext(s.charCodeAt(si + 1)) << 12) | (sext(s.charCodeAt(si + 2)) << 6) | sext(s.charCodeAt(si + 3));
		out[oi++] = (n >> 16) & 0xff;
		out[oi++] = (n >> 8) & 0xff;
		out[oi++] = n & 0xff;
		si += 4;
	}
	if (rem === 2) {
		const n = (sext(s.charCodeAt(si)) << 18) | (sext(s.charCodeAt(si + 1)) << 12);
		out[oi++] = (n >> 16) & 0xff;
	} else if (rem === 3) {
		const n = (sext(s.charCodeAt(si)) << 18) | (sext(s.charCodeAt(si + 1)) << 12) | (sext(s.charCodeAt(si + 2)) << 6);
		out[oi++] = (n >> 16) & 0xff;
		out[oi++] = (n >> 8) & 0xff;
	}
	return out;
}

// --- framing ---

/** Encode a V1 message as a length-prefixed UTF-8 JSON frame. */
export function encodeCohortMessage<T extends { v: 1 }>(msg: T, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	const body = utf8Encoder.encode(JSON.stringify(msg));
	if (body.length > maxMessageBytes) {
		throw new CohortWireError(`message body ${body.length} exceeds max_message_bytes ${maxMessageBytes}`);
	}
	const frame = new Uint8Array(LENGTH_PREFIX_BYTES + body.length);
	const view = new DataView(frame.buffer);
	view.setUint32(0, body.length, false);
	frame.set(body, LENGTH_PREFIX_BYTES);
	return frame;
}

/** Strip the length prefix and `JSON.parse` the body. Throws {@link CohortWireError} on a malformed frame. */
export function decodeCohortMessage(bytes: Uint8Array, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): unknown {
	if (bytes.length < LENGTH_PREFIX_BYTES) {
		throw new CohortWireError("frame too short for length prefix");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const declared = view.getUint32(0, false);
	if (declared > maxMessageBytes) {
		throw new CohortWireError(`declared body length ${declared} exceeds max_message_bytes ${maxMessageBytes}`);
	}
	if (LENGTH_PREFIX_BYTES + declared !== bytes.length) {
		throw new CohortWireError(`frame length mismatch: declared ${declared}, have ${bytes.length - LENGTH_PREFIX_BYTES}`);
	}
	const body = bytes.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + declared);
	let text: string;
	try {
		text = utf8Decoder.decode(body);
	} catch {
		throw new CohortWireError("frame body is not valid UTF-8");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new CohortWireError("frame body is not valid JSON");
	}
}

// --- typed decoders (decode frame → validate → narrow) ---

export function decodeRegisterV1(bytes: Uint8Array, maxMessageBytes?: number): RegisterV1 {
	return validateRegisterV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeRegisterReplyV1(bytes: Uint8Array, maxMessageBytes?: number): RegisterReplyV1 {
	return validateRegisterReplyV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeRenewV1(bytes: Uint8Array, maxMessageBytes?: number): RenewV1 {
	return validateRenewV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeRenewReplyV1(bytes: Uint8Array, maxMessageBytes?: number): RenewReplyV1 {
	return validateRenewReplyV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeChildLinkV1(bytes: Uint8Array, maxMessageBytes?: number, minSigs?: number): ChildLinkV1 {
	return validateChildLinkV1(decodeCohortMessage(bytes, maxMessageBytes), minSigs);
}

export function decodeChildLinkReplyV1(bytes: Uint8Array, maxMessageBytes?: number): ChildLinkReplyV1 {
	return validateChildLinkReplyV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodePromotionNoticeV1(bytes: Uint8Array, maxMessageBytes?: number): PromotionNoticeV1 {
	return validatePromotionNoticeV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeDemotionNoticeV1(bytes: Uint8Array, maxMessageBytes?: number): DemotionNoticeV1 {
	return validateDemotionNoticeV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeCohortGossipV1(bytes: Uint8Array, maxMessageBytes?: number): CohortGossipV1 {
	return validateCohortGossipV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeMembershipCertV1(bytes: Uint8Array, maxMessageBytes?: number): MembershipCertV1 {
	return validateMembershipCertV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeSignRequestV1(bytes: Uint8Array, maxMessageBytes?: number): SignRequestV1 {
	return validateSignRequestV1(decodeCohortMessage(bytes, maxMessageBytes));
}

export function decodeSignReplyV1(bytes: Uint8Array, maxMessageBytes?: number): SignReplyV1 {
	return validateSignReplyV1(decodeCohortMessage(bytes, maxMessageBytes));
}
