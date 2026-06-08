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
import type {
	CohortGossipV1,
	CohortTopicSummary,
	DemotionNoticeV1,
	MembershipCertV1,
	PromotionNoticeV1,
	RegisterReplyV1,
	RegisterResult,
	RegisterV1,
	RenewReplyV1,
	RenewV1,
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

/** Assert a base64url string decodes cleanly; returns it unchanged. */
function b64urlField(value: string, key: string, what: string): string {
	try {
		b64urlToBytes(value);
	} catch {
		fail(`${what}: field "${key}" is not valid base64url`);
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
		topicId: b64urlField(reqString(obj, "topicId", what), "topicId", what),
		tier: tier(reqFiniteNumber(obj, "tier", what), what),
		treeTier: reqFiniteNumber(obj, "treeTier", what),
		participantCoord: b64urlField(reqString(obj, "participantCoord", what), "participantCoord", what),
		ttl: reqFiniteNumber(obj, "ttl", what),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		correlationId: b64urlField(reqString(obj, "correlationId", what), "correlationId", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
	const bootstrap = optBool(obj, "bootstrap", what);
	if (bootstrap !== undefined) {
		out.bootstrap = bootstrap;
	}
	const appPayload = optString(obj, "appPayload", what);
	if (appPayload !== undefined) {
		out.appPayload = b64urlField(appPayload, "appPayload", what);
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
		out.cohortEpoch = b64urlField(cohortEpoch, "cohortEpoch", what);
	}
	assignDefined(out, "cohortMembers", optStringArray(obj, "cohortMembers", what));
	if (obj["topicTraffic"] !== undefined) {
		out.topicTraffic = validateTopicTrafficV1(obj["topicTraffic"]);
	}
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
	return {
		v: 1,
		topicId: b64urlField(reqString(obj, "topicId", what), "topicId", what),
		participantId: reqString(obj, "participantId", what),
		correlationId: b64urlField(reqString(obj, "correlationId", what), "correlationId", what),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
}

export function validateRenewReplyV1(value: unknown): RenewReplyV1 {
	const what = "RenewReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: RenewReplyV1 = {
		v: 1,
		result: reqEnum(obj, "result", ["ok", "unknown_registration", "primary_moved"] as const, what),
	};
	assignDefined(out, "newPrimary", optString(obj, "newPrimary", what));
	assignDefined(out, "newBackups", optStringArray(obj, "newBackups", what));
	const cohortEpoch = optString(obj, "cohortEpoch", what);
	if (cohortEpoch !== undefined) {
		out.cohortEpoch = b64urlField(cohortEpoch, "cohortEpoch", what);
	}
	return out;
}

export function validatePromotionNoticeV1(value: unknown): PromotionNoticeV1 {
	const what = "PromotionNoticeV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	return {
		v: 1,
		topicId: b64urlField(reqString(obj, "topicId", what), "topicId", what),
		fromTier: tier(reqFiniteNumber(obj, "fromTier", what), what),
		toTier: tier(reqFiniteNumber(obj, "toTier", what), what),
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
		topicId: b64urlField(reqString(obj, "topicId", what), "topicId", what),
		tier: tier(reqFiniteNumber(obj, "tier", what), what),
		parentCohortCoord: b64urlField(reqString(obj, "parentCohortCoord", what), "parentCohortCoord", what),
		effectiveAt: reqFiniteNumber(obj, "effectiveAt", what),
		thresholdSig: b64urlField(reqString(obj, "thresholdSig", what), "thresholdSig", what),
		signers: reqStringArray(obj, "signers", what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
	};
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

const HEX_RE = /^[0-9a-fA-F]+$/;

export function validateCohortGossipV1(value: unknown): CohortGossipV1 {
	const what = "CohortGossipV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const willingnessBits = reqString(obj, "willingnessBits", what);
	if (!HEX_RE.test(willingnessBits)) {
		fail(`${what}: field "willingnessBits" must be hex`);
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
	return {
		v: 1,
		fromMember: reqString(obj, "fromMember", what),
		cohortEpoch: b64urlField(reqString(obj, "cohortEpoch", what), "cohortEpoch", what),
		willingnessBits,
		loadBuckets: loadBuckets as number[],
		windowSeconds: reqFiniteNumber(obj, "windowSeconds", what),
		topicSummaries: summaries.map(validateCohortTopicSummary),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
}

export function validateMembershipCertV1(value: unknown): MembershipCertV1 {
	const what = "MembershipCertV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const out: MembershipCertV1 = {
		v: 1,
		cohortCoord: b64urlField(reqString(obj, "cohortCoord", what), "cohortCoord", what),
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
	return out;
}
