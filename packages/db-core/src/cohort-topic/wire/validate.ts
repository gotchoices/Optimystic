/**
 * Cohort-topic substrate — per-message structural validation.
 *
 * Each validator narrows an already-parsed `unknown` (the output of `JSON.parse` on a decoded
 * frame) to a concrete V1 interface, throwing {@link CohortWireError} on any structural defect:
 * missing required field, wrong `v`, out-of-enum discriminant, a byte field that does not decode
 * as base64url, or an out-of-range numeric. Validators never return partial data — they either
 * narrow cleanly or throw.
 */

import { b64urlToBytes } from "./codec.js";
import { DEFAULT_D_MAX_CAP } from "../dmax.js";
import type {
	ChildLinkRefV1,
	ChildLinkReplyV1,
	ChildLinkV1,
	CohortGossipV1,
	CohortTopicSummary,
	DemotionNoticeV1,
	GossipRecordRefV1,
	GossipRecordV1,
	MembershipCertV1,
	PromotionNoticeV1,
	RegisterReplyV1,
	RegisterResult,
	RegisterV1,
	RenewReplyV1,
	RenewV1,
	SignKind,
	SignRequestV1,
	SignReplyV1,
	TopicTrafficV1,
} from "./types.js";

/** Thrown for any malformed, oversized, or structurally invalid cohort-topic frame. */
export class CohortWireError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CohortWireError";
	}
}

function fail(message: string): never {
	throw new CohortWireError(message);
}

/** Set `obj[key]` only when `value` is defined — keeps absent optionals off the decoded object. */
function assignDefined<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) {
		obj[key] = value;
	}
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

function optString(obj: Record<string, unknown>, key: string, what: string): string | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		fail(`${what}: field "${key}" must be a string when present`);
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

function reqStringArray(obj: Record<string, unknown>, key: string, what: string): string[] {
	const value = obj[key];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		fail(`${what}: field "${key}" must be an array of strings`);
	}
	return value as string[];
}

function optStringArray(obj: Record<string, unknown>, key: string, what: string): string[] | undefined {
	if (obj[key] === undefined) {
		return undefined;
	}
	return reqStringArray(obj, key, what);
}

function tier(value: number, what: string): number {
	if (!Number.isInteger(value) || value < 0 || value > 3) {
		fail(`${what}: tier must be an integer in 0..3, got ${value}`);
	}
	return value;
}

/**
 * Validate a `treeTier` (the walk-toward-root start tier `d` a register/redirect targets): an integer in
 * `0..DEFAULT_D_MAX_CAP`. `d_max_cap` (60) is the substrate's own ceiling on useful walk depth, so a
 * `treeTier` above it cannot correspond to a real walk position. Rejecting here keeps an out-of-range value
 * from reaching `addressing.coord()` downstream — whose `coordD` throws a raw `RangeError` for a
 * non-integer / negative / `> 255` tier, an unclassified crash rather than a clean malformed-frame rejection.
 */
function treeTier(value: number, what: string): number {
	if (!Number.isInteger(value) || value < 0 || value > DEFAULT_D_MAX_CAP) {
		fail(`${what}: treeTier must be an integer in 0..${DEFAULT_D_MAX_CAP}, got ${value}`);
	}
	return value;
}

/** Ring-coord / topic-id / epoch byte width (SHA-256 truncated to the ring width). */
const COORD_BYTES = 32;
/** Correlation-id byte width (a 16-byte nonce minted per walk probe / renew). */
const CORRELATION_BYTES = 16;

/**
 * Assert a base64url string decodes cleanly; returns it unchanged. Used for variable-width fields —
 * peer ids (multihash-encoded, not 32 raw bytes), signatures, and opaque application payloads.
 *
 * NOTE: no max-length bound here. A hostile peer can still bloat one of these variable-width fields
 * (e.g. `participantCoord`, a signature) into a large map key in the store / rate limiter / replay
 * guard. Their widths aren't pinned by the spec, so a ceiling would be a chosen policy value rather
 * than a decode of the format. If a bloated one is ever seen as a map key in practice, add a
 * `b64urlMaxLen` ceiling here. (Fixed-width hash-derived fields go through `b64urlFixedLen` instead.)
 */
function b64urlField(value: string, key: string, what: string): string {
	try {
		b64urlToBytes(value);
	} catch {
		fail(`${what}: field "${key}" is not valid base64url`);
	}
	return value;
}

/** Assert a base64url string decodes cleanly to exactly `len` bytes; returns it unchanged. */
function b64urlFixedLen(value: string, key: string, len: number, what: string): string {
	let bytes: Uint8Array;
	try {
		bytes = b64urlToBytes(value);
	} catch {
		return fail(`${what}: field "${key}" is not valid base64url`);
	}
	if (bytes.length !== len) {
		fail(`${what}: field "${key}" must decode to ${len} bytes, got ${bytes.length}`);
	}
	return value;
}

function reqEnum<T extends string>(obj: Record<string, unknown>, key: string, allowed: readonly T[], what: string): T {
	const value = obj[key];
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		fail(`${what}: field "${key}" must be one of ${allowed.join(" | ")}`);
	}
	return value as T;
}

const REGISTER_RESULTS: readonly RegisterResult[] = [
	"accepted",
	"no_state",
	"promoted",
	"unwilling_member",
	"unwilling_cohort",
];

export function validateRegisterV1(value: unknown): RegisterV1 {
	const what = "RegisterV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: RegisterV1 = {
		v: 1,
		topicId: b64urlFixedLen(reqString(obj, "topicId", what), "topicId", COORD_BYTES, what),
		tier: tier(reqFiniteNumber(obj, "tier", what), what),
		treeTier: treeTier(reqFiniteNumber(obj, "treeTier", what), what),
		participantCoord: b64urlField(reqString(obj, "participantCoord", what), "participantCoord", what),
		ttl: reqFiniteNumber(obj, "ttl", what),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		correlationId: b64urlFixedLen(reqString(obj, "correlationId", what), "correlationId", CORRELATION_BYTES, what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
	const bootstrap = optBool(obj, "bootstrap", what);
	if (bootstrap !== undefined) {
		out.bootstrap = bootstrap;
	}
	const probe = optBool(obj, "probe", what);
	if (probe !== undefined) {
		out.probe = probe;
	}
	const followOn = optBool(obj, "followOn", what);
	if (followOn !== undefined) {
		out.followOn = followOn;
	}
	// `bootstrap`, `followOn`, and `probe` are pairwise mutually exclusive — the walk sets at most one
	// (bootstrap only at the tier-0 root re-issue, followOn only at a `treeTier >= 1` redirect target,
	// probe never instantiates). A frame that sets more than one is malformed / adversarial.
	if ([bootstrap, followOn, probe].filter((flag) => flag === true).length > 1) {
		fail(`${what}: at most one of bootstrap, followOn, probe may be set`);
	}
	// A follow-on is by definition a deeper-than-root growth point, so `treeTier >= 1`. A `followOn: true`
	// at the root (treeTier 0) would be a bootstrap, not a follow-on — reject it as malformed.
	if (followOn === true && out.treeTier < 1) {
		fail(`${what}: followOn requires treeTier >= 1, got ${out.treeTier}`);
	}
	const appPayload = optString(obj, "appPayload", what);
	if (appPayload !== undefined) {
		out.appPayload = b64urlField(appPayload, "appPayload", what);
	}
	// Bootstrap-evidence envelope (base64url; present only on a `bootstrap: true` register). A non-string
	// is rejected as malformed; an empty string is treated as absent so it normalizes to the same signed
	// image placeholder as a missing field (see `registerSigningPayload`'s `normalizeEvidence`).
	const bootstrapEvidence = optString(obj, "bootstrapEvidence", what);
	if (bootstrapEvidence !== undefined && bootstrapEvidence !== "") {
		out.bootstrapEvidence = b64urlField(bootstrapEvidence, "bootstrapEvidence", what);
	}
	return out;
}

function validateTopicTrafficV1(value: unknown): TopicTrafficV1 {
	const what = "TopicTrafficV1";
	const obj = asObject(value, what);
	return {
		windowSeconds: reqFiniteNumber(obj, "windowSeconds", what),
		arrivalsPerMin: reqFiniteNumber(obj, "arrivalsPerMin", what),
		queriesPerMin: reqFiniteNumber(obj, "queriesPerMin", what),
		directParticipants: reqFiniteNumber(obj, "directParticipants", what),
		childCohortCount: reqFiniteNumber(obj, "childCohortCount", what),
	};
}

export function validateRegisterReplyV1(value: unknown): RegisterReplyV1 {
	const what = "RegisterReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: RegisterReplyV1 = {
		v: 1,
		result: reqEnum(obj, "result", REGISTER_RESULTS, what),
	};
	assignDefined(out, "primary", optString(obj, "primary", what));
	assignDefined(out, "backups", optStringArray(obj, "backups", what));
	const cohortEpoch = optString(obj, "cohortEpoch", what);
	if (cohortEpoch !== undefined) {
		// NOTE: cohortEpoch is NOT length-pinned though real epochs are a 32-byte SHA-256 — several
		// test fixtures (db-core reactivity + db-p2p) feed 1-byte synthetic epochs. Pinning is tracked
		// by debt-cohort-topic-pin-cohort-epoch. See b64urlField's note.
		out.cohortEpoch = b64urlField(cohortEpoch, "cohortEpoch", what);
	}
	assignDefined(out, "cohortMembers", optStringArray(obj, "cohortMembers", what));
	if (obj["topicTraffic"] !== undefined) {
		out.topicTraffic = validateTopicTrafficV1(obj["topicTraffic"]);
	}
	// NOTE: `targetTier` is range-checked in the walk loop (walk.ts, case "promoted"), not here — an
	// out-of-range redirect must surface as a `retry_later` outcome, not a decode-time throw.
	assignDefined(out, "targetTier", optFiniteNumber(obj, "targetTier", what));
	assignDefined(out, "candidateMembers", optStringArray(obj, "candidateMembers", what));
	assignDefined(out, "retryAfterMs", optFiniteNumber(obj, "retryAfterMs", what));
	assignDefined(out, "reason", optString(obj, "reason", what));
	return out;
}

export function validateRenewV1(value: unknown): RenewV1 {
	const what = "RenewV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: RenewV1 = {
		v: 1,
		topicId: b64urlFixedLen(reqString(obj, "topicId", what), "topicId", COORD_BYTES, what),
		participantId: reqString(obj, "participantId", what),
		correlationId: b64urlFixedLen(reqString(obj, "correlationId", what), "correlationId", CORRELATION_BYTES, what),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
	assignDefined(out, "reattach", optBool(obj, "reattach", what));
	assignDefined(out, "withdraw", optBool(obj, "withdraw", what));
	return out;
}

export function validateRenewReplyV1(value: unknown): RenewReplyV1 {
	const what = "RenewReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: RenewReplyV1 = {
		v: 1,
		result: reqEnum(obj, "result", ["ok", "unknown_registration", "primary_moved", "withdrawn"] as const, what),
	};
	assignDefined(out, "newPrimary", optString(obj, "newPrimary", what));
	assignDefined(out, "newBackups", optStringArray(obj, "newBackups", what));
	const cohortEpoch = optString(obj, "cohortEpoch", what);
	if (cohortEpoch !== undefined) {
		// NOTE: cohortEpoch is NOT length-pinned — see validateRegisterReplyV1's note and
		// debt-cohort-topic-pin-cohort-epoch.
		out.cohortEpoch = b64urlField(cohortEpoch, "cohortEpoch", what);
	}
	return out;
}

export function validatePromotionNoticeV1(value: unknown): PromotionNoticeV1 {
	const what = "PromotionNoticeV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const fromTier = treeTier(reqFiniteNumber(obj, "fromTier", what), what);
	const toTier = treeTier(reqFiniteNumber(obj, "toTier", what), what);
	if (toTier !== fromTier + 1) {
		fail(`${what}: toTier must equal fromTier + 1, got fromTier=${fromTier} toTier=${toTier}`);
	}
	return {
		v: 1,
		topicId: b64urlFixedLen(reqString(obj, "topicId", what), "topicId", COORD_BYTES, what),
		fromTier,
		toTier,
		cohortCoord: b64urlFixedLen(reqString(obj, "cohortCoord", what), "cohortCoord", COORD_BYTES, what),
		effectiveAt: reqFiniteNumber(obj, "effectiveAt", what),
		thresholdSig: b64urlField(reqString(obj, "thresholdSig", what), "thresholdSig", what),
		signers: reqStringArray(obj, "signers", what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
	};
}

export function validateDemotionNoticeV1(value: unknown): DemotionNoticeV1 {
	const what = "DemotionNoticeV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	return {
		v: 1,
		topicId: b64urlFixedLen(reqString(obj, "topicId", what), "topicId", COORD_BYTES, what),
		tier: treeTier(reqFiniteNumber(obj, "tier", what), what),
		parentCohortCoord: b64urlFixedLen(reqString(obj, "parentCohortCoord", what), "parentCohortCoord", COORD_BYTES, what),
		cohortCoord: b64urlFixedLen(reqString(obj, "cohortCoord", what), "cohortCoord", COORD_BYTES, what),
		effectiveAt: reqFiniteNumber(obj, "effectiveAt", what),
		thresholdSig: b64urlField(reqString(obj, "thresholdSig", what), "thresholdSig", what),
		signers: reqStringArray(obj, "signers", what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
	};
}

/**
 * Validate a {@link ChildLinkV1}. Enforces `childTier >= 1` (the root never links), `tier` in 0..3, and
 * well-formed base64url on every byte field. The hash-derived fields (`topicId` / `childCohortCoord` /
 * `cohortEpoch`) are additionally length-checked to exactly 32 bytes (each is a SHA-256 truncation); the
 * `childParticipantCoord` follows the lenient `RegisterV1` convention (base64url only — a participant
 * coord is not always 32 raw bytes, e.g. a multihash-encoded peer id in tests). When `minSigs`
 * is supplied AND the frame carries a threshold signature (`thresholdSig` non-empty), `signers.length` must
 * be `>= minSigs`; a key-less-interim frame carries neither, so that cross-field bound is skipped. `minSigs`
 * is optional so a bare structural decode (no quorum context) still narrows the frame.
 */
export function validateChildLinkV1(value: unknown, minSigs?: number): ChildLinkV1 {
	const what = "ChildLinkV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const childTier = reqFiniteNumber(obj, "childTier", what);
	if (!Number.isInteger(childTier) || childTier < 1) {
		fail(`${what}: childTier must be an integer >= 1, got ${childTier}`);
	}
	const thresholdSig = b64urlField(reqString(obj, "thresholdSig", what), "thresholdSig", what);
	const signers = reqStringArray(obj, "signers", what).map((s) => b64urlField(s, "signers", what));
	if (minSigs !== undefined && thresholdSig.length > 0 && signers.length < minSigs) {
		fail(`${what}: a signed child-link needs signers.length >= ${minSigs}, got ${signers.length}`);
	}
	return {
		v: 1,
		topicId: b64urlFixedLen(reqString(obj, "topicId", what), "topicId", COORD_BYTES, what),
		childCohortCoord: b64urlFixedLen(reqString(obj, "childCohortCoord", what), "childCohortCoord", COORD_BYTES, what),
		childParticipantCoord: b64urlField(reqString(obj, "childParticipantCoord", what), "childParticipantCoord", what),
		childTier,
		tier: tier(reqFiniteNumber(obj, "tier", what), what),
		effectiveAt: reqFiniteNumber(obj, "effectiveAt", what),
		thresholdSig,
		signers,
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
	};
}

/** Validate a {@link ChildLinkReplyV1}: `result` in `linked | rejected`, optional human-readable `reason`. */
export function validateChildLinkReplyV1(value: unknown): ChildLinkReplyV1 {
	const what = "ChildLinkReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: ChildLinkReplyV1 = {
		v: 1,
		result: reqEnum(obj, "result", ["linked", "rejected"] as const, what),
	};
	assignDefined(out, "reason", optString(obj, "reason", what));
	return out;
}

function validateCohortTopicSummary(value: unknown): CohortTopicSummary {
	const what = "CohortTopicSummary";
	const obj = asObject(value, what);
	return {
		topicId: b64urlField(reqString(obj, "topicId", what), "topicId", what),
		tier: tier(reqFiniteNumber(obj, "tier", what), what),
		directParticipants: reqFiniteNumber(obj, "directParticipants", what),
		arrivalsPerMin: reqFiniteNumber(obj, "arrivalsPerMin", what),
		queriesPerMin: reqFiniteNumber(obj, "queriesPerMin", what),
		promoted: reqBool(obj, "promoted", what),
		childCohortCount: reqFiniteNumber(obj, "childCohortCount", what),
	};
}

function validateGossipRecordV1(value: unknown): GossipRecordV1 {
	const what = "GossipRecordV1";
	const obj = asObject(value, what);
	const out: GossipRecordV1 = {
		topicId: b64urlFixedLen(reqString(obj, "topicId", what), "topicId", COORD_BYTES, what),
		participantId: b64urlField(reqString(obj, "participantId", what), "participantId", what),
		tier: tier(reqFiniteNumber(obj, "tier", what), what),
		primary: b64urlField(reqString(obj, "primary", what), "primary", what),
		backups: reqStringArray(obj, "backups", what).map((b) => b64urlField(b, "backups", what)),
		attachedAt: reqFiniteNumber(obj, "attachedAt", what),
		lastPing: reqFiniteNumber(obj, "lastPing", what),
		ttl: reqFiniteNumber(obj, "ttl", what),
	};
	const appState = optString(obj, "appState", what);
	if (appState !== undefined) {
		out.appState = b64urlField(appState, "appState", what);
	}
	return out;
}

function validateGossipRecordRefV1(value: unknown): GossipRecordRefV1 {
	const what = "GossipRecordRefV1";
	const obj = asObject(value, what);
	return {
		topicId: b64urlFixedLen(reqString(obj, "topicId", what), "topicId", COORD_BYTES, what),
		participantId: b64urlField(reqString(obj, "participantId", what), "participantId", what),
		lastPing: reqFiniteNumber(obj, "lastPing", what),
	};
}

function validateChildLinkRefV1(value: unknown): ChildLinkRefV1 {
	const what = "ChildLinkRefV1";
	const obj = asObject(value, what);
	return {
		topicId: b64urlFixedLen(reqString(obj, "topicId", what), "topicId", COORD_BYTES, what),
		childCohortCoord: b64urlField(reqString(obj, "childCohortCoord", what), "childCohortCoord", what),
		effectiveAt: reqFiniteNumber(obj, "effectiveAt", what),
	};
}

/** `willingnessBits` carries exactly 4 bits (T0..T3) as a single hex nibble. */
const WILLINGNESS_RE = /^[0-9a-fA-F]$/;

export function validateCohortGossipV1(value: unknown): CohortGossipV1 {
	const what = "CohortGossipV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const willingnessBits = reqString(obj, "willingnessBits", what);
	if (!WILLINGNESS_RE.test(willingnessBits)) {
		fail(`${what}: field "willingnessBits" must be a single hex nibble (4 bits)`);
	}
	const loadBuckets = obj["loadBuckets"];
	if (!Array.isArray(loadBuckets) || loadBuckets.length !== 4) {
		fail(`${what}: field "loadBuckets" must be an array of length 4`);
	}
	for (const bucket of loadBuckets) {
		if (typeof bucket !== "number" || !Number.isInteger(bucket) || bucket < 0 || bucket > 7) {
			fail(`${what}: each loadBuckets entry must be an integer in 0..7`);
		}
	}
	const summaries = obj["topicSummaries"];
	if (!Array.isArray(summaries)) {
		fail(`${what}: field "topicSummaries" must be an array`);
	}
	const treeTier = reqFiniteNumber(obj, "treeTier", what);
	if (!Number.isInteger(treeTier) || treeTier < 0) {
		fail(`${what}: field "treeTier" must be a non-negative integer, got ${treeTier}`);
	}
	const out: CohortGossipV1 = {
		v: 1,
		fromMember: reqString(obj, "fromMember", what),
		coord: b64urlFixedLen(reqString(obj, "coord", what), "coord", COORD_BYTES, what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
		treeTier,
		willingnessBits,
		loadBuckets: loadBuckets as number[],
		windowSeconds: reqFiniteNumber(obj, "windowSeconds", what),
		topicSummaries: summaries.map(validateCohortTopicSummary),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
	const records = obj["records"];
	if (records !== undefined) {
		if (!Array.isArray(records)) {
			fail(`${what}: field "records" must be an array when present`);
		}
		out.records = records.map(validateGossipRecordV1);
	}
	const evicted = obj["evicted"];
	if (evicted !== undefined) {
		if (!Array.isArray(evicted)) {
			fail(`${what}: field "evicted" must be an array when present`);
		}
		out.evicted = evicted.map(validateGossipRecordRefV1);
	}
	const childLinks = obj["childLinks"];
	if (childLinks !== undefined) {
		if (!Array.isArray(childLinks)) {
			fail(`${what}: field "childLinks" must be an array when present`);
		}
		out.childLinks = childLinks.map(validateChildLinkRefV1);
	}
	const childUnlinks = obj["childUnlinks"];
	if (childUnlinks !== undefined) {
		if (!Array.isArray(childUnlinks)) {
			fail(`${what}: field "childUnlinks" must be an array when present`);
		}
		out.childUnlinks = childUnlinks.map(validateChildLinkRefV1);
	}
	return out;
}

const SIGN_KINDS: readonly SignKind[] = ["membership", "promotion", "demotion", "rotation", "childlink"];

export function validateSignRequestV1(value: unknown): SignRequestV1 {
	const what = "SignRequestV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	return {
		v: 1,
		kind: reqEnum(obj, "kind", SIGN_KINDS, what),
		coord: b64urlFixedLen(reqString(obj, "coord", what), "coord", COORD_BYTES, what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
		payload: b64urlField(reqString(obj, "payload", what), "payload", what),
	};
}

export function validateSignReplyV1(value: unknown): SignReplyV1 {
	const what = "SignReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	// Discriminated by `refused`: a refusal carries a reason; an endorsement carries signer + signature.
	if (obj["refused"] !== undefined) {
		if (obj["refused"] !== true) {
			fail(`${what}: field "refused" must be true when present`);
		}
		return { v: 1, refused: true, reason: reqString(obj, "reason", what) };
	}
	return {
		v: 1,
		signer: b64urlField(reqString(obj, "signer", what), "signer", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
}

export function validateMembershipCertV1(value: unknown): MembershipCertV1 {
	const what = "MembershipCertV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: MembershipCertV1 = {
		v: 1,
		cohortCoord: b64urlFixedLen(reqString(obj, "cohortCoord", what), "cohortCoord", COORD_BYTES, what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
		members: reqStringArray(obj, "members", what),
		stabilizedAt: reqFiniteNumber(obj, "stabilizedAt", what),
		thresholdSig: b64urlField(reqString(obj, "thresholdSig", what), "thresholdSig", what),
		signers: reqStringArray(obj, "signers", what),
	};
	const attestation = optString(obj, "fretAttestation", what);
	if (attestation !== undefined) {
		out.fretAttestation = b64urlField(attestation, "fretAttestation", what);
	}
	validateRotationAttestation(obj, out, what);
	return out;
}

/**
 * Validate the optional rotation attestation as an all-or-nothing group: either all three of
 * `prevEpoch`/`rotationSig`/`rotationSigners` are present (and well-formed) or all are absent. A
 * partial set is a {@link CohortWireError}. `rotationSigners` is validated only as a string array (its
 * elements are decoded per-element later, mirroring `signers`).
 */
function validateRotationAttestation(obj: Record<string, unknown>, out: MembershipCertV1, what: string): void {
	const prevEpoch = optString(obj, "prevEpoch", what);
	const rotationSig = optString(obj, "rotationSig", what);
	const rotationSigners = optStringArray(obj, "rotationSigners", what);
	const presentCount = [prevEpoch, rotationSig, rotationSigners].filter((v) => v !== undefined).length;
	if (presentCount === 0) {
		return;
	}
	if (presentCount !== 3) {
		fail(`${what}: rotation attestation requires all of prevEpoch, rotationSig, rotationSigners — or none`);
	}
	// prevEpoch is a prior cohortEpoch, so it inherits cohortEpoch's leniency (see the b64urlField note
	// and debt-cohort-topic-pin-cohort-epoch).
	out.prevEpoch = b64urlField(prevEpoch!, "prevEpoch", what);
	out.rotationSig = b64urlField(rotationSig!, "rotationSig", what);
	out.rotationSigners = rotationSigners!;
}
