/**
 * Reactivity — V1 wire types, codecs, and per-message validation.
 *
 * Transcribed from `docs/reactivity.md` §Wire formats. Reactivity reuses the cohort-topic `RegisterV1`
 * / `RenewV1` envelopes **unchanged**; the reactivity-specific shapes live in two places:
 *
 *  1. **Subscribe app payload** ({@link SubscribeAppPayloadV1}) carried opaquely inside
 *     `RegisterV1.appPayload`. Serialized to UTF-8 JSON bytes and handed to the cohort-topic
 *     {@link import("../cohort-topic/service.js").RegisterRequest}`.appPayload` slot, which base64url-encodes
 *     it on the wire. It is therefore **not** length-framed here — the cohort-topic `RegisterV1` frame
 *     wraps it. The subscribe RPC's authentication (peer-key signature over `correlationId` + `timestamp`)
 *     is the cohort-topic `RegisterV1` envelope's job, so the payload itself carries no signature.
 *
 *  2. **Notification** ({@link NotificationV1}) sent as a standalone RPC over the reactivity application
 *     protocol. It rides the same length-prefixed UTF-8 JSON framing as cohort-topic messages
 *     ({@link encodeCohortMessage}). Its `sig` is **bit-for-bit** the commit certificate's threshold
 *     signature — reactivity never re-signs (`docs/reactivity.md` §Notification origination).
 *
 * Conventions (matching the cohort-topic wire conventions): all JSON, byte fields base64url (no
 * padding), unix-millisecond timestamps, per-message structural validation on decode, byte-fidelity
 * round-trips (encode→decode→encode is stable). `collectionId` / `tailId` travel as the collection's
 * base64url block ids verbatim. The `BackfillV1` / `ResumeV1` codecs belong to the sibling tickets.
 */

import {
	decodeCohortMessage,
	encodeCohortMessage,
	DEFAULT_MAX_MESSAGE_BYTES,
} from "../cohort-topic/wire/codec.js";
import {
	asObject,
	b64urlField,
	failWire as fail,
	reqFiniteNumber,
	reqIntInRange,
	reqString,
	reqStringArray,
	requireV1,
} from "./wire-validate.js";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Ceiling for an opaque subscribe app payload, guarding decode allocation. */
export const DEFAULT_MAX_SUBSCRIBE_PAYLOAD_BYTES = 64 * 1024;

// --- Subscribe app payload (carried inside cohort-topic RegisterV1.appPayload) ---

/** A subscriber's registration payload (`RegisterV1.appPayload`, `kind == "reactivity"`). */
export interface SubscribeAppPayloadV1 {
	kind: "reactivity";
	/** Stable collection identity, base64url (the collection's id block id). */
	collectionId: string;
	/** Tail block id at registration time, base64url (the subscriber-side rotation detector). */
	tailIdAtAttach: string;
	/** Last revision the subscriber already holds; `0` for a fresh subscribe. */
	lastKnownRev: number;
	/** Max delta bytes the subscriber accepts; `0` declines delta payloads (Edge). */
	deltaMaxBytes: number;
}

// --- Notification (length-framed RPC) ---

/** The tail cohort's rotation pre-announce, carried inside (and signed by) a {@link NotificationV1}. */
export interface RotationHintV1 {
	/** New tail block id the topic anchor is rotating to, base64url. */
	newTailId: string;
	/** Revision at which the new tail becomes effective. */
	effectiveAtRevision: number;
}

/** A signed change notification fanned out through the reactivity tree (`docs/reactivity.md` §Notification origination). */
export interface NotificationV1 {
	v: 1;
	/** Collection id, base64url. */
	collectionId: string;
	/** Tail block id the reactivity topic is anchored on, base64url. */
	tailId: string;
	/** Per-collection monotonic revision. */
	revision: number;
	/** Commit digest from the transaction layer, base64url. */
	digest: string;
	/** Optional bounded delta, base64url; omitted when `delta_max == 0` or the collection declines it. */
	delta?: string;
	/** Unix ms. */
	timestamp: number;
	/** Threshold signature, base64url — **= the commit cert**, never re-signed. */
	sig: string;
	/** PeerIds contributing to {@link sig}, base64url of the cohort member-id bytes. */
	signers: string[];
	/** Tail-rotation pre-announce, when this notification carries one (rotation ticket fills it). */
	rotationHint?: RotationHintV1;
}

// --- validation helpers ---
// Generic primitives live in ./wire-validate.js (shared across the reactivity codecs); the
// notification-specific narrowing stays here next to the type it produces.

function validateRotationHint(value: unknown, what: string): RotationHintV1 {
	const obj = asObject(value, what);
	return {
		newTailId: b64urlField(reqString(obj, "newTailId", what), "newTailId", what),
		effectiveAtRevision: reqIntInRange(obj, "effectiveAtRevision", what, 0),
	};
}

// --- Subscribe app payload (opaque RegisterV1.appPayload bytes) ---

/** Narrow an already-parsed value to {@link SubscribeAppPayloadV1}, throwing on any defect. */
export function validateSubscribeAppPayloadV1(value: unknown): SubscribeAppPayloadV1 {
	const what = "SubscribeAppPayloadV1";
	const obj = asObject(value, what);
	if (obj["kind"] !== "reactivity") {
		fail(`${what}: field "kind" must be exactly "reactivity"`);
	}
	return {
		kind: "reactivity",
		collectionId: b64urlField(reqString(obj, "collectionId", what), "collectionId", what),
		tailIdAtAttach: b64urlField(reqString(obj, "tailIdAtAttach", what), "tailIdAtAttach", what),
		lastKnownRev: reqIntInRange(obj, "lastKnownRev", what, 0),
		deltaMaxBytes: reqIntInRange(obj, "deltaMaxBytes", what, 0),
	};
}

/** Serialize a {@link SubscribeAppPayloadV1} to the opaque UTF-8 JSON bytes for `RegisterV1.appPayload`. */
export function encodeSubscribeAppPayload(payload: SubscribeAppPayloadV1): Uint8Array {
	return utf8Encoder.encode(JSON.stringify(validateSubscribeAppPayloadV1(payload)));
}

/** Decode opaque `RegisterV1.appPayload` bytes back to a validated {@link SubscribeAppPayloadV1}. */
export function decodeSubscribeAppPayload(bytes: Uint8Array, maxBytes: number = DEFAULT_MAX_SUBSCRIBE_PAYLOAD_BYTES): SubscribeAppPayloadV1 {
	return validateSubscribeAppPayloadV1(parseJsonBytes(bytes, maxBytes, "SubscribeAppPayloadV1"));
}

/** Parse opaque (non-framed) UTF-8 JSON payload bytes, rejecting oversized/invalid input. */
function parseJsonBytes(bytes: Uint8Array, maxBytes: number, what: string): unknown {
	if (bytes.length > maxBytes) {
		fail(`${what}: payload ${bytes.length} exceeds max ${maxBytes} bytes`);
	}
	let text: string;
	try {
		text = utf8Decoder.decode(bytes);
	} catch {
		fail(`${what}: payload is not valid UTF-8`);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		fail(`${what}: payload is not valid JSON`);
	}
}

// --- Notification (length-framed) ---

/** Narrow an already-parsed value to {@link NotificationV1}, throwing on any defect. */
export function validateNotificationV1(value: unknown): NotificationV1 {
	const what = "NotificationV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const signers = reqStringArray(obj["signers"], "signers", what);
	const out: NotificationV1 = {
		v: 1,
		collectionId: b64urlField(reqString(obj, "collectionId", what), "collectionId", what),
		tailId: b64urlField(reqString(obj, "tailId", what), "tailId", what),
		revision: reqIntInRange(obj, "revision", what, 0),
		digest: b64urlField(reqString(obj, "digest", what), "digest", what),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		sig: b64urlField(reqString(obj, "sig", what), "sig", what),
		signers: signers.map((s, i) => b64urlField(s, `signers[${i}]`, what)),
	};
	if (obj["delta"] !== undefined) {
		out.delta = b64urlField(reqString(obj, "delta", what), "delta", what);
	}
	if (obj["rotationHint"] !== undefined) {
		out.rotationHint = validateRotationHint(obj["rotationHint"], `${what}.rotationHint`);
	}
	return out;
}

/** Validate an array of {@link NotificationV1} (the `entries`/`recentEntries` carried in backfill/resume replies). */
export function validateNotificationArray(value: unknown, what: string): NotificationV1[] {
	if (!Array.isArray(value)) {
		fail(`${what}: field "entries" must be an array`);
	}
	return value.map((entry) => validateNotificationV1(entry));
}

/** Encode a {@link NotificationV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeNotificationV1(msg: NotificationV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateNotificationV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link NotificationV1} frame. */
export function decodeNotificationV1(bytes: Uint8Array, maxMessageBytes?: number): NotificationV1 {
	return validateNotificationV1(decodeCohortMessage(bytes, maxMessageBytes));
}
