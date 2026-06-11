/**
 * Reactivity — shared wire-validation primitives.
 *
 * The reactivity message codecs ({@link import("./wire.js")}, {@link import("./push-state.js")},
 * {@link import("./backfill.js")}, {@link import("./resume.js")}) all decode untrusted JSON into
 * validated V1 shapes with the same structural checks. Those primitives live here so each codec module
 * narrows fields the same way (DRY) — every helper throws {@link CohortWireError} on a defect, matching
 * the cohort-topic wire conventions (base64url byte fields, finite/integer numbers, `v: 1`).
 */

import { b64urlToBytes } from "../cohort-topic/wire/codec.js";
import { CohortWireError } from "../cohort-topic/wire/validate.js";

/** Throw a {@link CohortWireError} with `message`. */
export function failWire(message: string): never {
	throw new CohortWireError(message);
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

/** Require `obj[key]` to be a finite number; returns it. */
export function reqFiniteNumber(obj: Record<string, unknown>, key: string, what: string): number {
	const value = obj[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		failWire(`${what}: field "${key}" must be a finite number`);
	}
	return value;
}

/** Require `obj[key]` to be an integer `>= min` (and `<= max` when supplied); returns it. */
export function reqIntInRange(obj: Record<string, unknown>, key: string, what: string, min: number, max?: number): number {
	const value = reqFiniteNumber(obj, key, what);
	if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
		const bound = max === undefined ? `>= ${min}` : `in ${min}..${max}`;
		failWire(`${what}: field "${key}" must be an integer ${bound}, got ${value}`);
	}
	return value;
}

/** Assert a base64url string decodes cleanly; returns it unchanged. */
export function b64urlField(value: string, key: string, what: string): string {
	try {
		b64urlToBytes(value);
	} catch {
		failWire(`${what}: field "${key}" is not valid base64url`);
	}
	return value;
}

/** Require `value` to be an array of strings; returns it (callers map each element through {@link b64urlField}). */
export function reqStringArray(value: unknown, key: string, what: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		failWire(`${what}: field "${key}" must be an array of strings`);
	}
	return value as string[];
}
