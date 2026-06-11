/**
 * Reactivity — Backfill RPC (`docs/reactivity.md` §Backfill RPC, §Wire formats).
 *
 * A subscriber that detects a revision gap (slow-subscriber drop, brief sleep) requests the missing
 * range from its serving cohort; the cohort answers from its {@link ReplayBuffer} ring. The reply
 * carries the **intersection** of the requested range with the buffer plus the `available` window the
 * cohort actually holds, so a subscriber whose lag fell past the ring's low edge learns it must fall
 * back further (to a checkpoint resume or a chain read) rather than silently receiving a short answer.
 *
 * Entries retain the original threshold signature (the buffer stores full {@link NotificationV1}s), so a
 * backfill reply is verifiable **end-to-end** — the subscriber re-runs the same {@link NotificationVerifier}
 * over each backfilled entry it runs over a live notification. Any cohort member can serve, because the
 * replay buffer is gossiped across the cohort (origination ticket).
 *
 * Wire conventions match the rest of reactivity: JSON, byte fields base64url, unix-ms timestamps, `v: 1`,
 * per-message structural validation on decode. `BackfillV1` is signed by the subscriber's peer key
 * (`signature`); replay protection rides the request envelope as elsewhere in the substrate.
 */

import {
	decodeCohortMessage,
	encodeCohortMessage,
	DEFAULT_MAX_MESSAGE_BYTES,
} from "../cohort-topic/wire/codec.js";
import {
	asObject,
	b64urlField,
	failWire,
	reqIntInRange,
	reqString,
	requireV1,
} from "./wire-validate.js";
import type { ReplayBuffer } from "./replay-buffer.js";
import { validateNotificationArray, validateNotificationV1, type NotificationV1 } from "./wire.js";

/** A subscriber's request to replay a contiguous revision range from a cohort's buffer. */
export interface BackfillV1 {
	v: 1;
	/** Collection id, base64url. */
	collectionId: string;
	/** Inclusive low edge of the requested range. */
	fromRevision: number;
	/** Inclusive high edge of the requested range. */
	toRevision: number;
	/** Subscriber peer-key signature over the request. */
	signature: string;
}

/** The cohort's reply: the held intersection of the request, plus the window it actually has. */
export interface BackfillReplyV1 {
	v: 1;
	/** The signed notifications in `[from, to] ∩ buffer`, ascending by revision. */
	entries: NotificationV1[];
	/** The revision window the serving cohort actually holds (so the subscriber can fall back further). */
	available: {
		fromRevision: number;
		toRevision: number;
	};
}

/** Narrow an already-parsed value to {@link BackfillV1}, throwing on any defect. */
export function validateBackfillV1(value: unknown): BackfillV1 {
	const what = "BackfillV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const fromRevision = reqIntInRange(obj, "fromRevision", what, 0);
	const toRevision = reqIntInRange(obj, "toRevision", what, fromRevision);
	return {
		v: 1,
		collectionId: b64urlField(reqString(obj, "collectionId", what), "collectionId", what),
		fromRevision,
		toRevision,
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
}

/** Narrow an already-parsed value to {@link BackfillReplyV1}, throwing on any defect. */
export function validateBackfillReplyV1(value: unknown): BackfillReplyV1 {
	const what = "BackfillReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const available = asObject(obj["available"], `${what}.available`);
	const availFrom = reqIntInRange(available, "fromRevision", `${what}.available`, 0);
	return {
		v: 1,
		entries: validateNotificationArray(obj["entries"], what),
		available: {
			fromRevision: availFrom,
			toRevision: reqIntInRange(available, "toRevision", `${what}.available`, availFrom),
		},
	};
}

/** Encode a {@link BackfillV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeBackfillV1(msg: BackfillV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateBackfillV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link BackfillV1} frame. */
export function decodeBackfillV1(bytes: Uint8Array, maxMessageBytes?: number): BackfillV1 {
	return validateBackfillV1(decodeCohortMessage(bytes, maxMessageBytes));
}

/** Encode a {@link BackfillReplyV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeBackfillReplyV1(msg: BackfillReplyV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateBackfillReplyV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link BackfillReplyV1} frame. */
export function decodeBackfillReplyV1(bytes: Uint8Array, maxMessageBytes?: number): BackfillReplyV1 {
	return validateBackfillReplyV1(decodeCohortMessage(bytes, maxMessageBytes));
}

/**
 * Serve a {@link BackfillV1} from a cohort's replay buffer: return the intersection of the requested
 * range with the buffer and report the buffer's actual `available` window. A request whose `collectionId`
 * does not match `expectedCollectionId` is rejected (a backfill is collection-scoped). When the buffer is
 * empty, `available` collapses to the request's `fromRevision` (an empty window) and no entries are returned.
 */
export function serveBackfill(buffer: ReplayBuffer, req: BackfillV1, expectedCollectionId: string): BackfillReplyV1 {
	if (req.collectionId !== expectedCollectionId) {
		failWire(`serveBackfill: request collectionId does not match this cohort's collection`);
	}
	const entries = buffer.range(req.fromRevision, req.toRevision).map((e) => validateNotificationV1(e.payload));
	const low = buffer.lowRevision;
	const high = buffer.highRevision;
	const available = low === undefined || high === undefined
		? { fromRevision: req.fromRevision, toRevision: req.fromRevision }
		: { fromRevision: low, toRevision: high };
	return { v: 1, entries, available };
}
