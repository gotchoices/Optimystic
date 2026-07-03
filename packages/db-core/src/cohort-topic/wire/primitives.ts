/**
 * Cohort-topic wire substrate — shared structural-validation primitives.
 *
 * The generic per-field checks every wire codec across the substrate (cohort-topic, matchmaking,
 * reactivity) uses to narrow an already-parsed `unknown` (the output of `JSON.parse` on a decoded
 * frame) into a validated V1 shape. Each helper throws {@link CohortWireError} on a structural defect:
 * missing required field, wrong `v`, out-of-enum discriminant, a byte field that does not decode as
 * base64url, or an out-of-range numeric.
 *
 * These are the *only* generic primitives — domain-specific narrowing (the `validate*V1` functions, the
 * cohort-topic `tier` / `treeTier` semantics, matchmaking utf8 coders, reactivity notification shapes)
 * lives in the modules that own those message shapes. Keeping the primitives in one place means a
 * hardening tweak to a check (e.g. the fixed-length byte-width guard in {@link b64urlFixedLen}) lands
 * once and every consumer inherits it.
 */

import { b64urlToBytes } from "./codec.js";

/** Thrown for any malformed, oversized, or structurally invalid cohort-topic frame. */
export class CohortWireError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CohortWireError";
	}
}

/** Throw a {@link CohortWireError} with `message`. */
export function failWire(message: string): never {
	throw new CohortWireError(message);
}

/** Set `obj[key]` only when `value` is defined — keeps absent optionals off the decoded object. */
export function assignDefined<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) {
		obj[key] = value;
	}
}

/** Narrow `value` to a plain object (not null, not an array), or throw. */
export function asObject(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		failWire(`${what}: expected an object`);
	}
	return value as Record<string, unknown>;
}

/** Require `obj.v === 1`. */
export function requireV1(obj: Record<string, unknown>, what: string): void {
	if (obj["v"] !== 1) {
		failWire(`${what}: expected v === 1, got ${JSON.stringify(obj["v"])}`);
	}
}

/** Require `obj[key]` to be a string; returns it. */
export function reqString(obj: Record<string, unknown>, key: string, what: string): string {
	const value = obj[key];
	if (typeof value !== "string") {
		failWire(`${what}: field "${key}" must be a string`);
	}
	return value;
}

/** Return `obj[key]` when it is a string, `undefined` when absent; throw on any other type. */
export function optString(obj: Record<string, unknown>, key: string, what: string): string | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		failWire(`${what}: field "${key}" must be a string when present`);
	}
	return value;
}

/** Require `obj[key]` to be a finite number; returns it. */
export function reqFiniteNumber(obj: Record<string, unknown>, key: string, what: string): number {
	const value = obj[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		failWire(`${what}: field "${key}" must be a finite number`);
	}
	return value;
}

/** Return `obj[key]` when it is a finite number, `undefined` when absent; throw on any other type. */
export function optFiniteNumber(obj: Record<string, unknown>, key: string, what: string): number | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		failWire(`${what}: field "${key}" must be a finite number when present`);
	}
	return value;
}

/** Require `obj[key]` to be a boolean; returns it. */
export function reqBool(obj: Record<string, unknown>, key: string, what: string): boolean {
	const value = obj[key];
	if (typeof value !== "boolean") {
		failWire(`${what}: field "${key}" must be a boolean`);
	}
	return value;
}

/** Return `obj[key]` when it is a boolean, `undefined` when absent; throw on any other type. */
export function optBool(obj: Record<string, unknown>, key: string, what: string): boolean | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		failWire(`${what}: field "${key}" must be a boolean when present`);
	}
	return value;
}

/**
 * Require `obj[key]` to be an integer `>= min` (and `<= max` when supplied); returns it. Reads and
 * finite-checks the field itself (via {@link reqFiniteNumber}) so callers pass the object + key rather
 * than a pre-extracted value — this composes with the other `req*` helpers.
 */
export function reqIntInRange(obj: Record<string, unknown>, key: string, what: string, min: number, max?: number): number {
	const value = reqFiniteNumber(obj, key, what);
	if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
		const bound = max === undefined ? `>= ${min}` : `in ${min}..${max}`;
		failWire(`${what}: field "${key}" must be an integer ${bound}, got ${value}`);
	}
	return value;
}

/** Require `obj[key]` to be an array of strings; returns it. */
export function reqStringArray(obj: Record<string, unknown>, key: string, what: string): string[] {
	const value = obj[key];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		failWire(`${what}: field "${key}" must be an array of strings`);
	}
	return value as string[];
}

/** Return `obj[key]` when it is an array of strings, `undefined` when absent; throw on any other type. */
export function optStringArray(obj: Record<string, unknown>, key: string, what: string): string[] | undefined {
	if (obj[key] === undefined) {
		return undefined;
	}
	return reqStringArray(obj, key, what);
}

/** Require `obj[key]` to be one of `allowed`; returns it narrowed to the enum type. */
export function reqEnum<T extends string>(obj: Record<string, unknown>, key: string, allowed: readonly T[], what: string): T {
	const value = obj[key];
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		failWire(`${what}: field "${key}" must be one of ${allowed.join(" | ")}`);
	}
	return value as T;
}

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
export function b64urlField(value: string, key: string, what: string): string {
	try {
		b64urlToBytes(value);
	} catch {
		failWire(`${what}: field "${key}" is not valid base64url`);
	}
	return value;
}

/** Assert a base64url string decodes cleanly to exactly `len` bytes; returns it unchanged. */
export function b64urlFixedLen(value: string, key: string, len: number, what: string): string {
	let bytes: Uint8Array;
	try {
		bytes = b64urlToBytes(value);
	} catch {
		return failWire(`${what}: field "${key}" is not valid base64url`);
	}
	if (bytes.length !== len) {
		failWire(`${what}: field "${key}" must decode to ${len} bytes, got ${bytes.length}`);
	}
	return value;
}
