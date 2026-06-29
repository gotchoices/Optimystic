/**
 * Cryptographic Functions for Quereus
 *
 * Idiomatic ES module exports with base64url as default encoding.
 * All functions accept and return base64url strings by default for SQL compatibility.
 */

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { randomBytes as nobleRandomBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, bytesToHex } from '@noble/curves/utils.js';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';

// Type definitions
export type HashAlgorithm = 'sha256' | 'sha512' | 'blake3';
export type CurveType = 'secp256k1' | 'p256' | 'ed25519';
export type Encoding = 'base64url' | 'base64' | 'hex' | 'utf8' | 'bytes';

/** Encodings valid for hash *output* (no 'utf8' — a digest is not UTF-8 text). */
export type OutputEncoding = 'base64url' | 'base64' | 'hex' | 'bytes';

/** A single value in a multi-field digest. Mirrors the SQL value space. */
export type DigestField =
	| string
	| number
	| bigint
	| boolean
	| Uint8Array
	| null
	| undefined
	| { readonly [key: string]: unknown }
	| readonly unknown[];

/** A resolved hash function: raw bytes in, digest bytes out. */
export type DigestHasher = (input: Uint8Array) => Uint8Array;

/** A resolved output encoder: digest bytes in, encoded form out. */
export type OutputEncoder = (bytes: Uint8Array) => string | Uint8Array;

/**
 * Convert input to Uint8Array, handling various encodings
 */
function toBytes(input: string | Uint8Array | null | undefined, encoding: Encoding = 'base64url'): Uint8Array {
	if (input === null || input === undefined) {
		return new Uint8Array(0);
	}

	if (input instanceof Uint8Array) {
		return input;
	}

	if (typeof input === 'string') {
		switch (encoding) {
			case 'base64url':
				return uint8ArrayFromString(input, 'base64url');
			case 'base64':
				return uint8ArrayFromString(input, 'base64');
			case 'hex':
				return hexToBytes(input);
			case 'utf8':
				return utf8ToBytes(input);
			default:
				return uint8ArrayFromString(input, 'base64url');
		}
	}

	throw new Error('Invalid input type');
}

/**
 * Convert Uint8Array to string in specified encoding
 */
function fromBytes(bytes: Uint8Array, encoding: Encoding = 'base64url'): string | Uint8Array {
	switch (encoding) {
		case 'base64url':
			return uint8ArrayToString(bytes, 'base64url');
		case 'base64':
			return uint8ArrayToString(bytes, 'base64');
		case 'hex':
			return bytesToHex(bytes);
		case 'utf8':
			return uint8ArrayToString(bytes, 'utf8');
		case 'bytes':
			return bytes;
		default:
			return uint8ArrayToString(bytes, 'base64url');
	}
}

// --- Algorithm / encoding resolution (done once, no per-call switching) --- //

/** Hash algorithm → noble hasher. Keyed lookup so the digest hot path never branches. */
const HASHERS: Record<HashAlgorithm, DigestHasher> = {
	sha256,
	sha512,
	blake3,
};

/** Output encoding → encoder closure. */
const OUTPUT_ENCODERS: Record<OutputEncoding, OutputEncoder> = {
	base64url: (bytes) => uint8ArrayToString(bytes, 'base64url'),
	base64: (bytes) => uint8ArrayToString(bytes, 'base64'),
	hex: (bytes) => bytesToHex(bytes),
	bytes: (bytes) => bytes,
};

/**
 * Resolve a hash algorithm name to its hasher. Throws on unknown algorithm.
 * Call once (e.g. at plugin registration) and capture the result so the digest
 * hot path performs no per-call algorithm branching.
 */
export function resolveHasher(algorithm: HashAlgorithm): DigestHasher {
	const hasher = HASHERS[algorithm];
	if (!hasher) {
		throw new Error(`Unsupported hash algorithm: ${algorithm}`);
	}
	return hasher;
}

/**
 * Resolve an output encoding name to its encoder. Throws on unknown encoding.
 */
export function resolveOutputEncoder(encoding: OutputEncoding): OutputEncoder {
	const encoder = OUTPUT_ENCODERS[encoding];
	if (!encoder) {
		throw new Error(`Unsupported output encoding: ${encoding}`);
	}
	return encoder;
}

// --- Canonical, injective multi-field encoding --- //

/**
 * Format version for {@link encodeFields}. Prepended to every encoding so the
 * framing can evolve, and so a framed digest is domain-separated from a bare
 * hash of the same bytes. Bump only with a deliberate, breaking format change.
 */
const DIGEST_FORMAT_V1 = 0x01;

// Per-field type tags. Distinct tags keep distinct SQL types from colliding
// (e.g. INTEGER 123 vs TEXT '123' vs BOOL true).
//
// Note on INT vs REAL: the tag is derived from the JS value, not from SQL
// affinity (a scalar function does not receive affinity). An integer-VALUED
// number — including a REAL like 2.0, which reaches JS as the number 2 — is
// encoded as INTEGER. So INTEGER 2 and REAL 2.0 produce the same digest. This is
// replicable (every peer sees the same JS value) but not int/real-distinguishing.
const TAG_NULL = 0x00; // bare tag, no length/payload
const TAG_INT = 0x01;  // payload: canonical decimal string (number-integer & bigint unified via BigInt)
const TAG_REAL = 0x02; // payload: ECMAScript Number::toString (non-integer numbers only)
const TAG_TEXT = 0x03; // payload: UTF-8 bytes
const TAG_BOOL = 0x04; // payload: single 0x00/0x01 byte
const TAG_BLOB = 0x05; // payload: raw bytes
const TAG_JSON = 0x06; // payload: UTF-8 of key-sorted canonical JSON

/** Append an unsigned LEB128 varint (safe for lengths up to MAX_SAFE_INTEGER). */
function writeVarint(out: number[], value: number): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`varint expects a non-negative integer, got ${value}`);
	}
	let v = value;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
}

/** tag ‖ varint(len) ‖ payload */
function framed(tag: number, payload: Uint8Array): Uint8Array {
	const header: number[] = [tag];
	writeVarint(header, payload.length);
	return concatBytes(Uint8Array.from(header), payload);
}

/**
 * Strict, deterministic JSON canonicalization for a native object/array field:
 * object keys recursively sorted, no incidental whitespace. Unlike `JSON.stringify`,
 * it THROWS rather than silently collapsing non-JSON inputs (`undefined`, non-finite
 * numbers, `bigint`, non-plain objects like `Date`/`Map`) — silent collapse would
 * break injectivity (`{a:undefined}` vs `{}`, `NaN` vs `null`, `new Date(0)` vs `{}`).
 */
function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	const t = typeof value;
	if (t === 'string') return JSON.stringify(value);
	if (t === 'boolean') return value ? 'true' : 'false';
	if (t === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error('digest: cannot encode a non-finite number inside a JSON field');
		}
		return JSON.stringify(value) as string; // deterministic Number::toString
	}
	if (t === 'bigint') {
		throw new Error('digest: bigint is not representable inside a JSON field');
	}
	if (Array.isArray(value)) {
		return `[${value.map((el) => {
			if (el === undefined) {
				throw new Error('digest: undefined / sparse element inside a JSON field');
			}
			return canonicalJson(el);
		}).join(',')}]`;
	}
	if (t === 'object') {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			throw new Error('digest: only plain objects are allowed inside a JSON field');
		}
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		return `{${keys.map((k) => {
			if (obj[k] === undefined) {
				throw new Error(`digest: undefined value for JSON key '${k}'`);
			}
			return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
		}).join(',')}}`;
	}
	throw new Error(`digest: unsupported value of type '${t}' inside a JSON field`);
}

/** Encode one field as tag (‖ length ‖ payload). NULL/undefined is a bare tag. */
function encodeField(field: DigestField): Uint8Array {
	if (field === null || field === undefined) {
		return Uint8Array.of(TAG_NULL);
	}
	switch (typeof field) {
		case 'boolean':
			return Uint8Array.of(TAG_BOOL, field ? 1 : 0);
		case 'bigint':
			return framed(TAG_INT, utf8ToBytes(field.toString()));
		case 'number':
			if (!Number.isFinite(field)) {
				throw new Error('digest: cannot encode a non-finite number');
			}
			// Integer-valued numbers go through BigInt so they encode identically to
			// the equal-valued bigint (e.g. 1e21 → full digits, not "1e+21").
			return Number.isInteger(field)
				? framed(TAG_INT, utf8ToBytes(BigInt(field).toString()))
				: framed(TAG_REAL, utf8ToBytes(field.toString()));
		case 'string':
			return framed(TAG_TEXT, utf8ToBytes(field));
		case 'object':
			if (field instanceof Uint8Array) {
				return framed(TAG_BLOB, field);
			}
			return framed(TAG_JSON, utf8ToBytes(canonicalJson(field)));
		default:
			throw new Error(`digest: unsupported field type '${typeof field}'`);
	}
}

/**
 * Canonically encode an ordered tuple of fields into bytes such that distinct
 * tuples never collide (injective framing).
 *
 * Layout: `version ‖ field*` where each field is `tag ‖ varint(len) ‖ payload`
 * (NULL is a bare tag). Properties:
 * - order-preserving and arity-safe (self-delimiting fields → uniquely decodable),
 * - NULL distinguishable from empty string,
 * - type distinguishable (INTEGER 123 ≠ TEXT '123' ≠ BOOL true ≠ BLOB),
 * - delimiter-safe (a separator inside a string is just payload under its length).
 *
 * Replicability notes:
 * - Integer `number` and `bigint` of equal value encode identically (both via
 *   `BigInt(...).toString()`); a non-integer REAL uses ECMAScript `Number::toString`
 *   (deterministic across JS engines, but not guaranteed across other languages).
 * - INT vs REAL is derived from the JS value, not SQL affinity: an integer-valued
 *   REAL (e.g. 2.0 → number 2) encodes as INTEGER, so INTEGER 2 and REAL 2.0 collide.
 * - A native JSON object/array field must contain only valid JSON (no `undefined`,
 *   non-finite numbers, `bigint`, or non-plain objects) — otherwise it throws.
 */
export function encodeFields(fields: readonly DigestField[]): Uint8Array {
	const chunks: Uint8Array[] = [Uint8Array.of(DIGEST_FORMAT_V1)];
	for (const field of fields) {
		chunks.push(encodeField(field));
	}
	return concatBytes(...chunks);
}

/**
 * Low-level multi-field digest: canonically encode the fields, then hash and
 * encode with the supplied (pre-resolved) hasher/encoder. No per-call branching
 * on algorithm or encoding — resolve once via {@link resolveHasher} /
 * {@link resolveOutputEncoder} and reuse.
 */
export function digestFields(
	fields: readonly DigestField[],
	hasher: DigestHasher,
	encode: OutputEncoder
): string | Uint8Array {
	return encode(hasher(encodeFields(fields)));
}

/**
 * Compute an injective digest over an ordered tuple of fields.
 *
 * @param fields - Ordered tuple of values to hash (any SQL value type)
 * @param algorithm - Hash algorithm (default: 'sha256')
 * @param encoding - Output encoding (default: 'base64url')
 * @returns Hash digest in the specified encoding
 *
 * @example
 * ```typescript
 * // Hash a tuple of fields — distinct tuples never collide
 * const h = digest(['alice', 42, null, true]);
 *
 * // Pick algorithm / output encoding
 * const h512 = digest(['a', 'b'], 'sha512', 'hex');
 * ```
 *
 * Note: this is a *framed* digest, not a bare hash of raw bytes —
 * `digest(['hello'])` is not `sha256("hello")`. Use `hashMod` for sharding a
 * single value.
 */
export function digest(
	fields: readonly DigestField[],
	algorithm: HashAlgorithm = 'sha256',
	encoding: OutputEncoding = 'base64url'
): string | Uint8Array {
	if (!Array.isArray(fields)) {
		throw new Error(
			`digest(fields, algorithm?, encoding?): 'fields' must be an array of values. ` +
			`The digest API changed in v0.14: it is now variadic/injective over fields, ` +
			`the per-call inputEncoding was removed, and algorithm + output encoding are bound at plugin load time. ` +
			`Migrate digest(value, algo, inputEncoding, outputEncoding) → digest([value], algo, outputEncoding) — ` +
			`note the result is now a *framed* digest, not a bare hash of the bytes.`
		);
	}
	return digestFields(fields, resolveHasher(algorithm), resolveOutputEncoder(encoding));
}

/**
 * Hash data and return modulo of specified bit length
 * Useful for generating fixed-size hash values (e.g., 16-bit, 32-bit)
 *
 * @param data - Data to hash
 * @param bits - Number of bits for the result (e.g., 16 for 16-bit hash)
 * @param algorithm - Hash algorithm (default: 'sha256')
 * @param inputEncoding - Encoding of input string (default: 'base64url')
 * @returns Integer hash value modulo 2^bits
 *
 * @example
 * ```typescript
 * // Get 16-bit hash (0-65535)
 * const hash16 = hashMod('hello', 16, 'sha256', 'utf8');
 *
 * // Get 32-bit hash
 * const hash32 = hashMod('world', 32, 'sha256', 'utf8');
 * ```
 */
export function hashMod(
	data: string | Uint8Array,
	bits: number,
	algorithm: HashAlgorithm = 'sha256',
	inputEncoding: Encoding = 'base64url'
): number {
	if (bits <= 0 || bits > 53) {
		throw new Error('Bits must be between 1 and 53 (JavaScript safe integer limit)');
	}

	// Single-blob hash for sharding (not the field-framed digest).
	const hashBytes = resolveHasher(algorithm)(toBytes(data, inputEncoding));

	// Take first 8 bytes and convert to number
	const view = new DataView(hashBytes.buffer, hashBytes.byteOffset, Math.min(8, hashBytes.length));
	const fullHash = view.getBigUint64(0, false); // big-endian

	// Modulo by 2^bits
	const modulus = BigInt(2) ** BigInt(bits);
	const result = fullHash % modulus;

	return Number(result);
}

/**
 * Sign data with a private key
 *
 * @param data - Data to sign (typically a hash)
 * @param privateKey - Private key (base64url string or Uint8Array)
 * @param curve - Elliptic curve (default: 'secp256k1')
 * @param inputEncoding - Encoding of data input (default: 'base64url')
 * @param keyEncoding - Encoding of private key (default: 'base64url')
 * @param outputEncoding - Encoding of signature output (default: 'base64url')
 * @returns Signature in specified encoding
 *
 * @example
 * ```typescript
 * // Sign a hash with secp256k1
 * const sig = sign(hashData, privateKey);
 *
 * // Sign with Ed25519
 * const sig2 = sign(hashData, privateKey, 'ed25519');
 * ```
 */
export function sign(
	data: string | Uint8Array,
	privateKey: string | Uint8Array,
	curve: CurveType = 'secp256k1',
	inputEncoding: Encoding = 'base64url',
	keyEncoding: Encoding = 'base64url',
	outputEncoding: Encoding = 'base64url'
): string | Uint8Array {
	const dataBytes = toBytes(data, inputEncoding);
	const keyBytes = toBytes(privateKey, keyEncoding);

	let sigBytes: Uint8Array;

	switch (curve) {
		case 'secp256k1':
			sigBytes = secp256k1.sign(dataBytes, keyBytes, { lowS: true });
			break;
		case 'p256':
			sigBytes = p256.sign(dataBytes, keyBytes, { lowS: true });
			break;
		case 'ed25519':
			sigBytes = ed25519.sign(dataBytes, keyBytes);
			break;
		default:
			throw new Error(`Unsupported curve: ${curve}`);
	}

	return fromBytes(sigBytes, outputEncoding);
}

/**
 * Verify a signature
 *
 * @param data - Data that was signed
 * @param signature - Signature to verify
 * @param publicKey - Public key
 * @param curve - Elliptic curve (default: 'secp256k1')
 * @param inputEncoding - Encoding of data input (default: 'base64url')
 * @param sigEncoding - Encoding of signature (default: 'base64url')
 * @param keyEncoding - Encoding of public key (default: 'base64url')
 * @returns true if signature is valid, false otherwise
 *
 * @example
 * ```typescript
 * // Verify a signature
 * const isValid = verify(hashData, signature, publicKey);
 *
 * // Verify with Ed25519
 * const isValid2 = verify(hashData, signature, publicKey, 'ed25519');
 * ```
 */
export function verify(
	data: string | Uint8Array,
	signature: string | Uint8Array,
	publicKey: string | Uint8Array,
	curve: CurveType = 'secp256k1',
	inputEncoding: Encoding = 'base64url',
	sigEncoding: Encoding = 'base64url',
	keyEncoding: Encoding = 'base64url'
): boolean {
	try {
		const dataBytes = toBytes(data, inputEncoding);
		const sigBytes = toBytes(signature, sigEncoding);
		const keyBytes = toBytes(publicKey, keyEncoding);

		switch (curve) {
			case 'secp256k1': {
				return secp256k1.verify(sigBytes, dataBytes, keyBytes);
			}
			case 'p256': {
				return p256.verify(sigBytes, dataBytes, keyBytes);
			}
			case 'ed25519': {
				return ed25519.verify(sigBytes, dataBytes, keyBytes);
			}
			default:
				throw new Error(`Unsupported curve: ${curve}`);
		}
	} catch {
		return false;
	}
}

/**
 * Generate cryptographically secure random bytes
 *
 * @param bits - Number of bits to generate (default: 256)
 * @param encoding - Output encoding (default: 'base64url')
 * @returns Random bytes in the specified encoding
 */
export function randomBytes(bits: number = 256, encoding: Encoding = 'base64url'): string | Uint8Array {
	const bytes = Math.ceil(bits / 8);
	const randomBytesArray = nobleRandomBytes(bytes);
	return fromBytes(randomBytesArray, encoding);
}

/**
 * Generate a random private key
 */
export function generatePrivateKey(curve: CurveType = 'secp256k1', encoding: Encoding = 'base64url'): string | Uint8Array {
	let keyBytes: Uint8Array;

	switch (curve) {
		case 'secp256k1':
			keyBytes = secp256k1.utils.randomSecretKey();
			break;
		case 'p256':
			keyBytes = p256.utils.randomSecretKey();
			break;
		case 'ed25519':
			keyBytes = ed25519.utils.randomSecretKey();
			break;
		default:
			throw new Error(`Unsupported curve: ${curve}`);
	}

	return fromBytes(keyBytes, encoding);
}

/**
 * Get public key from private key
 */
export function getPublicKey(
	privateKey: string | Uint8Array,
	curve: CurveType = 'secp256k1',
	keyEncoding: Encoding = 'base64url',
	outputEncoding: Encoding = 'base64url'
): string | Uint8Array {
	const keyBytes = toBytes(privateKey, keyEncoding);

	let pubBytes: Uint8Array;

	switch (curve) {
		case 'secp256k1':
			pubBytes = secp256k1.getPublicKey(keyBytes);
			break;
		case 'p256':
			pubBytes = p256.getPublicKey(keyBytes);
			break;
		case 'ed25519':
			pubBytes = ed25519.getPublicKey(keyBytes);
			break;
		default:
			throw new Error(`Unsupported curve: ${curve}`);
	}

	return fromBytes(pubBytes, outputEncoding);
}

