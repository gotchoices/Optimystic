/**
 * Matchmaking — V1 wire types, codecs, and per-message validation.
 *
 * Transcribed from `docs/matchmaking.md` §Wire formats. Matchmaking reuses the cohort-topic
 * `RegisterV1` / `RenewV1` envelopes **unchanged**; the matchmaking-specific shape lives in two
 * places:
 *
 *  1. **App payloads** ({@link ProviderAppPayloadV1} / {@link SeekerAppPayloadV1}) carried opaquely
 *     inside `RegisterV1.appPayload`. These are serialized to UTF-8 JSON bytes and handed to the
 *     cohort-topic {@link import("../cohort-topic/service.js").RegisterRequest}`.appPayload` slot,
 *     which base64url-encodes them on the wire. They are therefore **not** length-framed here — the
 *     cohort-topic `RegisterV1` frame wraps them.
 *
 *  2. **Query-protocol messages** ({@link QueryV1} / {@link QueryReplyV1} / {@link AggregateCountV1})
 *     sent as standalone RPCs over the matchmaking application protocol. These ride the same
 *     length-prefixed UTF-8 JSON framing as cohort-topic messages ({@link encodeCohortMessage}).
 *
 * Conventions (matching the cohort-topic wire conventions): all JSON, byte fields base64url (no
 * padding), unix-millisecond timestamps, per-message structural validation on decode. Byte fidelity
 * round-trips (encode→decode→encode is stable). The query-protocol producers (cohort-side reply,
 * root-cohort aggregate sweep) land in later tickets; their decoders live here so the seeker side can
 * be unit-tested against fixtures.
 */

import {
	bytesToB64url,
	b64urlToBytes,
	decodeCohortMessage,
	encodeCohortMessage,
	DEFAULT_MAX_MESSAGE_BYTES,
} from "../cohort-topic/wire/codec.js";
import { CohortWireError } from "../cohort-topic/wire/validate.js";
import type { TopicTrafficV1 } from "../cohort-topic/wire/types.js";
import { QUERY_LIMIT_MAX } from "./config.js";

// --- App-payload variants (carried inside cohort-topic RegisterV1.appPayload) ---

/** A provider's registration payload (`SubscribeAppPayloadV1.appPayload`, `kind == "match-provider"`). */
export interface ProviderAppPayloadV1 {
	kind: "match-provider";
	/** Application-defined attribute tags. */
	capabilities: string[];
	/** Concurrent tasks accepted; `0` == "listed but full". */
	capacityBudget: number;
	/** Unix ms, soft expiry hint to seekers. */
	serviceUntil?: number;
	/** Multiaddr or PeerId-based callback. */
	contactHint: string;
	/** base64url, over `(topicId, capabilities, capacityBudget)` — see {@link providerSigningPayload}. */
	signature: string;
}

/** A seeker's registration payload (`SubscribeAppPayloadV1.appPayload`, `kind == "match-seeker"`). */
export interface SeekerAppPayloadV1 {
	kind: "match-seeker";
	/** Number of providers desired. */
	wantCount: number;
	/** Optional capability filter. */
	filter?: CapabilityFilter;
	/** For collective-assembly use. */
	contactHint: string;
	/** Opt into arrival pushes; default false (poll path). */
	pushOnArrival?: boolean;
	/** base64url. */
	signature: string;
}

/** A capability filter, evaluated locally at the cohort (advisory — the seeker re-validates). */
export interface CapabilityFilter {
	/** Tags that must all be present. */
	must: string[];
	/** Tags that must not be present. */
	mustNot: string[];
	/** Skip providers whose `capacityBudget` is below this. */
	minBudget?: number;
}

// --- Query protocol (evaluation/sweep land in later tickets; codecs land here) ---

/** A seeker's query against a cohort for the providers/seekers it holds. */
export interface QueryV1 {
	v: 1;
	/** Topic id, base64url. */
	topicId: string;
	includeProviders: boolean;
	includeSeekers: boolean;
	filter?: CapabilityFilter;
	/** `<= query_limit_max` (256). */
	limit: number;
	/** Requesting PeerId. */
	requesterId: string;
	/** Unix ms. */
	timestamp: number;
	/** base64url. */
	signature: string;
}

/** A cohort's advisory reply to a {@link QueryV1} (signed by the cohort primary, not threshold). */
export interface QueryReplyV1 {
	v: 1;
	providers?: ProviderEntryV1[];
	seekers?: SeekerEntryV1[];
	truncated: boolean;
	/** base64url. */
	cohortEpoch: string;
	/** From cohort-topic; consumed by the hang-out engine (next ticket). */
	topicTraffic: TopicTrafficV1;
	/** Cohort PRIMARY single-member signature (NOT threshold), base64url. */
	signature: string;
}

/** A provider entry in a {@link QueryReplyV1}. */
export interface ProviderEntryV1 {
	/** PeerId. */
	participantId: string;
	capabilities: string[];
	capacityBudget: number;
	contactHint: string;
	/** Unix ms. */
	attachedAt: number;
	/** Provider's original signature, forwarded for seeker re-validation, base64url. */
	registrationSig: string;
}

/** A seeker entry in a {@link QueryReplyV1} (collective-assembly discovery). */
export interface SeekerEntryV1 {
	/** PeerId. */
	participantId: string;
	wantCount: number;
	contactHint: string;
	/** Unix ms. */
	attachedAt: number;
	/** base64url. */
	registrationSig: string;
}

/** Root-cohort multi-cohort-sweep summary (producer lands in the sweep ticket). */
export interface AggregateCountV1 {
	v: 1;
	/** Topic id, base64url. */
	topicId: string;
	/** `count` is log-bucketed. */
	bucketCounts: AggregateBucketV1[];
	/** base64url. */
	signature: string;
	/** base64url. */
	cohortEpoch: string;
}

/** One bucketed shard count inside an {@link AggregateCountV1}. */
export interface AggregateBucketV1 {
	targetTier: number;
	prefixSlot: number;
	/** Log-bucketed. */
	count: number;
}

// --- validation helpers (mirror cohort-topic/wire/validate.ts; local to keep matchmaking DRY) ---

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Ceiling for an opaque app payload (provider/seeker), guarding decode allocation. */
export const DEFAULT_MAX_APP_PAYLOAD_BYTES = 64 * 1024;

function fail(message: string): never {
	throw new CohortWireError(message);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${what}: expected an object`);
	}
	return value as Record<string, unknown>;
}

function requireV1(obj: Record<string, unknown>, what: string): void {
	if (obj["v"] !== 1) {
		fail(`${what}: expected v === 1, got ${JSON.stringify(obj["v"])}`);
	}
}

function reqString(obj: Record<string, unknown>, key: string, what: string): string {
	const value = obj[key];
	if (typeof value !== "string") {
		fail(`${what}: field "${key}" must be a string`);
	}
	return value;
}

function reqBool(obj: Record<string, unknown>, key: string, what: string): boolean {
	const value = obj[key];
	if (typeof value !== "boolean") {
		fail(`${what}: field "${key}" must be a boolean`);
	}
	return value;
}

function optBool(obj: Record<string, unknown>, key: string, what: string): boolean | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		fail(`${what}: field "${key}" must be a boolean when present`);
	}
	return value;
}

function reqFiniteNumber(obj: Record<string, unknown>, key: string, what: string): number {
	const value = obj[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail(`${what}: field "${key}" must be a finite number`);
	}
	return value;
}

function optFiniteNumber(obj: Record<string, unknown>, key: string, what: string): number | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail(`${what}: field "${key}" must be a finite number when present`);
	}
	return value;
}

function reqStringArray(obj: Record<string, unknown>, key: string, what: string): string[] {
	const value = obj[key];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		fail(`${what}: field "${key}" must be an array of strings`);
	}
	return value as string[];
}

/** Assert a base64url string decodes cleanly; returns it unchanged. */
function b64urlField(value: string, key: string, what: string): string {
	try {
		b64urlToBytes(value);
	} catch {
		fail(`${what}: field "${key}" is not valid base64url`);
	}
	return value;
}

/** Require an integer `>= min` (and `<= max` when supplied). */
function reqIntInRange(value: number, key: string, what: string, min: number, max?: number): number {
	if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
		const bound = max === undefined ? `>= ${min}` : `in ${min}..${max}`;
		fail(`${what}: field "${key}" must be an integer ${bound}, got ${value}`);
	}
	return value;
}

function validateCapabilityFilter(value: unknown, what: string): CapabilityFilter {
	const obj = asObject(value, what);
	const out: CapabilityFilter = {
		must: reqStringArray(obj, "must", what),
		mustNot: reqStringArray(obj, "mustNot", what),
	};
	const minBudget = optFiniteNumber(obj, "minBudget", what);
	if (minBudget !== undefined) {
		out.minBudget = reqIntInRange(minBudget, "minBudget", what, 0);
	}
	return out;
}

// --- Provider / Seeker app payloads (opaque RegisterV1.appPayload bytes) ---

/** Narrow an already-parsed value to {@link ProviderAppPayloadV1}, throwing on any defect. */
export function validateProviderAppPayloadV1(value: unknown): ProviderAppPayloadV1 {
	const what = "ProviderAppPayloadV1";
	const obj = asObject(value, what);
	if (obj["kind"] !== "match-provider") {
		fail(`${what}: field "kind" must be exactly "match-provider"`);
	}
	const out: ProviderAppPayloadV1 = {
		kind: "match-provider",
		capabilities: reqStringArray(obj, "capabilities", what),
		capacityBudget: reqIntInRange(reqFiniteNumber(obj, "capacityBudget", what), "capacityBudget", what, 0),
		contactHint: reqString(obj, "contactHint", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
	const serviceUntil = optFiniteNumber(obj, "serviceUntil", what);
	if (serviceUntil !== undefined) {
		out.serviceUntil = serviceUntil;
	}
	return out;
}

/** Narrow an already-parsed value to {@link SeekerAppPayloadV1}, throwing on any defect. */
export function validateSeekerAppPayloadV1(value: unknown): SeekerAppPayloadV1 {
	const what = "SeekerAppPayloadV1";
	const obj = asObject(value, what);
	if (obj["kind"] !== "match-seeker") {
		fail(`${what}: field "kind" must be exactly "match-seeker"`);
	}
	const out: SeekerAppPayloadV1 = {
		kind: "match-seeker",
		wantCount: reqIntInRange(reqFiniteNumber(obj, "wantCount", what), "wantCount", what, 1),
		contactHint: reqString(obj, "contactHint", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
	if (obj["filter"] !== undefined) {
		out.filter = validateCapabilityFilter(obj["filter"], `${what}.filter`);
	}
	const pushOnArrival = optBool(obj, "pushOnArrival", what);
	if (pushOnArrival !== undefined) {
		out.pushOnArrival = pushOnArrival;
	}
	return out;
}

/** Serialize a {@link ProviderAppPayloadV1} to the opaque UTF-8 JSON bytes for `RegisterV1.appPayload`. */
export function encodeProviderAppPayload(payload: ProviderAppPayloadV1): Uint8Array {
	return utf8Encoder.encode(JSON.stringify(validateProviderAppPayloadV1(payload)));
}

/** Decode opaque `RegisterV1.appPayload` bytes back to a validated {@link ProviderAppPayloadV1}. */
export function decodeProviderAppPayload(bytes: Uint8Array, maxBytes: number = DEFAULT_MAX_APP_PAYLOAD_BYTES): ProviderAppPayloadV1 {
	return validateProviderAppPayloadV1(parseJsonBytes(bytes, maxBytes, "ProviderAppPayloadV1"));
}

/** Serialize a {@link SeekerAppPayloadV1} to the opaque UTF-8 JSON bytes for `RegisterV1.appPayload`. */
export function encodeSeekerAppPayload(payload: SeekerAppPayloadV1): Uint8Array {
	return utf8Encoder.encode(JSON.stringify(validateSeekerAppPayloadV1(payload)));
}

/** Decode opaque `RegisterV1.appPayload` bytes back to a validated {@link SeekerAppPayloadV1}. */
export function decodeSeekerAppPayload(bytes: Uint8Array, maxBytes: number = DEFAULT_MAX_APP_PAYLOAD_BYTES): SeekerAppPayloadV1 {
	return validateSeekerAppPayloadV1(parseJsonBytes(bytes, maxBytes, "SeekerAppPayloadV1"));
}

/** Either matchmaking registration payload, discriminated by `kind`. */
export type MatchAppPayloadV1 = ProviderAppPayloadV1 | SeekerAppPayloadV1;

/**
 * Decode an opaque `RegisterV1.appPayload` to whichever matchmaking payload it carries, dispatched on
 * `kind` (parsed once — no exception-as-control-flow). The cohort query handler uses this to classify a
 * registration record into a provider vs. seeker entry. Throws {@link CohortWireError} on an unknown
 * `kind` or a malformed payload.
 */
export function decodeMatchAppPayload(bytes: Uint8Array, maxBytes: number = DEFAULT_MAX_APP_PAYLOAD_BYTES): MatchAppPayloadV1 {
	const value = parseJsonBytes(bytes, maxBytes, "MatchAppPayloadV1");
	const obj = asObject(value, "MatchAppPayloadV1");
	if (obj["kind"] === "match-provider") {
		return validateProviderAppPayloadV1(value);
	}
	if (obj["kind"] === "match-seeker") {
		return validateSeekerAppPayloadV1(value);
	}
	fail(`MatchAppPayloadV1: field "kind" must be "match-provider" or "match-seeker", got ${JSON.stringify(obj["kind"])}`);
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

// --- Query-protocol messages (length-framed RPCs) ---

/** Narrow an already-parsed value to {@link QueryV1}, throwing on any defect. */
export function validateQueryV1(value: unknown): QueryV1 {
	const what = "QueryV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: QueryV1 = {
		v: 1,
		topicId: b64urlField(reqString(obj, "topicId", what), "topicId", what),
		includeProviders: reqBool(obj, "includeProviders", what),
		includeSeekers: reqBool(obj, "includeSeekers", what),
		limit: reqIntInRange(reqFiniteNumber(obj, "limit", what), "limit", what, 1, QUERY_LIMIT_MAX),
		requesterId: reqString(obj, "requesterId", what),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
	if (obj["filter"] !== undefined) {
		out.filter = validateCapabilityFilter(obj["filter"], `${what}.filter`);
	}
	return out;
}

function validateTopicTrafficV1(value: unknown, what: string): TopicTrafficV1 {
	const obj = asObject(value, what);
	return {
		windowSeconds: reqFiniteNumber(obj, "windowSeconds", what),
		arrivalsPerMin: reqFiniteNumber(obj, "arrivalsPerMin", what),
		queriesPerMin: reqFiniteNumber(obj, "queriesPerMin", what),
		directParticipants: reqFiniteNumber(obj, "directParticipants", what),
		childCohortCount: reqFiniteNumber(obj, "childCohortCount", what),
	};
}

function validateProviderEntryV1(value: unknown): ProviderEntryV1 {
	const what = "ProviderEntryV1";
	const obj = asObject(value, what);
	return {
		participantId: reqString(obj, "participantId", what),
		capabilities: reqStringArray(obj, "capabilities", what),
		capacityBudget: reqIntInRange(reqFiniteNumber(obj, "capacityBudget", what), "capacityBudget", what, 0),
		contactHint: reqString(obj, "contactHint", what),
		attachedAt: reqFiniteNumber(obj, "attachedAt", what),
		registrationSig: b64urlField(reqString(obj, "registrationSig", what), "registrationSig", what),
	};
}

function validateSeekerEntryV1(value: unknown): SeekerEntryV1 {
	const what = "SeekerEntryV1";
	const obj = asObject(value, what);
	return {
		participantId: reqString(obj, "participantId", what),
		wantCount: reqIntInRange(reqFiniteNumber(obj, "wantCount", what), "wantCount", what, 1),
		contactHint: reqString(obj, "contactHint", what),
		attachedAt: reqFiniteNumber(obj, "attachedAt", what),
		registrationSig: b64urlField(reqString(obj, "registrationSig", what), "registrationSig", what),
	};
}

/** Narrow an already-parsed value to {@link QueryReplyV1}, throwing on any defect. */
export function validateQueryReplyV1(value: unknown): QueryReplyV1 {
	const what = "QueryReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: QueryReplyV1 = {
		v: 1,
		truncated: reqBool(obj, "truncated", what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
		topicTraffic: validateTopicTrafficV1(obj["topicTraffic"], `${what}.topicTraffic`),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
	if (obj["providers"] !== undefined) {
		if (!Array.isArray(obj["providers"])) {
			fail(`${what}: field "providers" must be an array when present`);
		}
		out.providers = obj["providers"].map(validateProviderEntryV1);
	}
	if (obj["seekers"] !== undefined) {
		if (!Array.isArray(obj["seekers"])) {
			fail(`${what}: field "seekers" must be an array when present`);
		}
		out.seekers = obj["seekers"].map(validateSeekerEntryV1);
	}
	return out;
}

function validateAggregateBucketV1(value: unknown): AggregateBucketV1 {
	const what = "AggregateBucketV1";
	const obj = asObject(value, what);
	return {
		targetTier: reqIntInRange(reqFiniteNumber(obj, "targetTier", what), "targetTier", what, 0),
		prefixSlot: reqIntInRange(reqFiniteNumber(obj, "prefixSlot", what), "prefixSlot", what, 0),
		count: reqIntInRange(reqFiniteNumber(obj, "count", what), "count", what, 0),
	};
}

/** Narrow an already-parsed value to {@link AggregateCountV1}, throwing on any defect. */
export function validateAggregateCountV1(value: unknown): AggregateCountV1 {
	const what = "AggregateCountV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const buckets = obj["bucketCounts"];
	if (!Array.isArray(buckets)) {
		fail(`${what}: field "bucketCounts" must be an array`);
	}
	return {
		v: 1,
		topicId: b64urlField(reqString(obj, "topicId", what), "topicId", what),
		bucketCounts: buckets.map(validateAggregateBucketV1),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
	};
}

/** Encode a {@link QueryV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeQueryV1(msg: QueryV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateQueryV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link QueryV1} frame. */
export function decodeQueryV1(bytes: Uint8Array, maxMessageBytes?: number): QueryV1 {
	return validateQueryV1(decodeCohortMessage(bytes, maxMessageBytes));
}

/** Encode a {@link QueryReplyV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeQueryReplyV1(msg: QueryReplyV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateQueryReplyV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link QueryReplyV1} frame. */
export function decodeQueryReplyV1(bytes: Uint8Array, maxMessageBytes?: number): QueryReplyV1 {
	return validateQueryReplyV1(decodeCohortMessage(bytes, maxMessageBytes));
}

/** Encode an {@link AggregateCountV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeAggregateCountV1(msg: AggregateCountV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateAggregateCountV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link AggregateCountV1} frame. */
export function decodeAggregateCountV1(bytes: Uint8Array, maxMessageBytes?: number): AggregateCountV1 {
	return validateAggregateCountV1(decodeCohortMessage(bytes, maxMessageBytes));
}

// --- canonical participant-signature payloads (provider/seeker registration sigs) ---

/**
 * Canonical signed byte image of a provider registration — `(topicId, capabilities, capacityBudget)`
 * per `docs/matchmaking.md` §Wire formats.
 *
 * **Signing scope (resolved):** the signed image deliberately excludes the matchmaking
 * `correlationId`. The advisory trust model (matchmaking.md §Wire formats) requires a seeker to
 * re-validate each forwarded {@link ProviderEntryV1}'s `registrationSig`, and a {@link ProviderEntryV1}
 * carries **no** `correlationId` field — so binding the signature over `correlationId` would leave the
 * seeker unable to reconstruct the exact signed image. Dropping it (option (b) of the implement ticket)
 * keeps the signed image fully self-contained in the forwarded entry: `topicId` (the topic the seeker
 * queried) + `capabilities` + `capacityBudget`. Replay-binding of the *registration* is handled
 * independently by the cohort-topic `RegisterV1` envelope (its own `correlationId` + replay guard +
 * peer-key signature); the matchmaking signature only attests provider authorship of the advertised
 * capabilities, which the participant peer key (the entry's `participantId`) anchors.
 *
 * Determinism comes from an explicitly-ordered array (stable, unlike object key order), exactly like
 * the cohort-topic `registerSigningPayload`. `topicId` is passed as raw bytes and emitted as base64url
 * so signer and verifier agree byte-for-byte.
 */
export function providerSigningPayload(topicId: Uint8Array, capabilities: readonly string[], capacityBudget: number): Uint8Array {
	return utf8Encoder.encode(JSON.stringify([
		"ProviderAppPayloadV1",
		bytesToB64url(topicId),
		[...capabilities],
		capacityBudget,
	]));
}

/**
 * Canonical signed byte image of a seeker registration — `(topicId, wantCount)`. Mirrors the provider
 * scope (option (b), see {@link providerSigningPayload}): the image excludes `correlationId` so it is
 * fully reconstructable from a forwarded {@link SeekerEntryV1} (`participantId` + `wantCount`) for
 * collective-assembly re-validation.
 */
export function seekerSigningPayload(topicId: Uint8Array, wantCount: number): Uint8Array {
	return utf8Encoder.encode(JSON.stringify([
		"SeekerAppPayloadV1",
		bytesToB64url(topicId),
		wantCount,
	]));
}

// --- seeker-side entry re-validation (advisory trust model) ---

/**
 * Verifies a forwarded entry's `registrationSig`. db-core is crypto-free, so the actual peer-key check
 * is injected (db-p2p binds it to {@link import("@optimystic/db-p2p").verifyPeerSig} over the
 * participant's Ed25519 peer key). `signerId` is the entry's `participantId` (a peer-id string); the
 * verifier resolves the public key from it. Returns `false` (never throws) on a malformed signature.
 */
export type EntrySigVerifier = (signerId: string, payload: Uint8Array, signature: Uint8Array) => boolean;

/**
 * Re-validate a forwarded {@link ProviderEntryV1} against the topic it was returned for: reconstruct the
 * provider signing image from the entry's own fields and verify `registrationSig` against the entry's
 * `participantId`. This is the seeker-side check the advisory trust model hinges on — the cohort vouches
 * only for "these were the registrations I held", never for provider authenticity.
 */
export function verifyProviderEntry(topicId: Uint8Array, entry: ProviderEntryV1, verify: EntrySigVerifier): boolean {
	let sig: Uint8Array;
	try {
		sig = b64urlToBytes(entry.registrationSig);
	} catch {
		return false;
	}
	return verify(entry.participantId, providerSigningPayload(topicId, entry.capabilities, entry.capacityBudget), sig);
}

/** Re-validate a forwarded {@link SeekerEntryV1} (collective-assembly discovery), mirroring {@link verifyProviderEntry}. */
export function verifySeekerEntry(topicId: Uint8Array, entry: SeekerEntryV1, verify: EntrySigVerifier): boolean {
	let sig: Uint8Array;
	try {
		sig = b64urlToBytes(entry.registrationSig);
	} catch {
		return false;
	}
	return verify(entry.participantId, seekerSigningPayload(topicId, entry.wantCount), sig);
}

/**
 * Canonical signed byte image of a {@link QueryReplyV1} — the cohort **primary's** single-member
 * signature (not threshold), per `docs/matchmaking.md` §Wire formats. The primary vouches only for the
 * *set it held*; provider authenticity is re-validated per entry via {@link verifyProviderEntry}. The
 * image binds the epoch, truncation flag, traffic snapshot, and the participant ids of each returned
 * entry (order-sensitive) so a tampered reply is detectable, while staying independent of the
 * advisory per-entry signatures.
 */
export function queryReplySigningPayload(reply: Omit<QueryReplyV1, "signature">): Uint8Array {
	return utf8Encoder.encode(JSON.stringify([
		"QueryReplyV1",
		reply.v,
		reply.cohortEpoch,
		reply.truncated,
		[
			reply.topicTraffic.windowSeconds,
			reply.topicTraffic.arrivalsPerMin,
			reply.topicTraffic.queriesPerMin,
			reply.topicTraffic.directParticipants,
			reply.topicTraffic.childCohortCount,
		],
		(reply.providers ?? []).map((p) => p.participantId),
		(reply.seekers ?? []).map((s) => s.participantId),
	]));
}
