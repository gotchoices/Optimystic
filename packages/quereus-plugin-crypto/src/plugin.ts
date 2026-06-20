/**
 * Quereus Plugin Entry Point for Crypto Functions
 *
 * This module provides the plugin registration following Quereus 0.4.5 format.
 * All metadata is in package.json - no manifest export needed.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { FunctionFlags, TEXT_TYPE, INTEGER_TYPE, BOOLEAN_TYPE } from '@quereus/quereus';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import {
	sign, verify, hashMod, randomBytes,
	digestFields, resolveHasher, resolveOutputEncoder,
	type HashAlgorithm, type OutputEncoding, type DigestField,
} from './crypto.js';
import {
	cid, cidV1, cidDecode,
	type Multicodec, type MultihashCode, type Multibase,
} from './cid.js';
import {
	setCommit, setVerify,
	type SaltedLeaf,
} from './sd.js';

const DIGEST_ALGORITHMS: readonly HashAlgorithm[] = ['sha256', 'sha512', 'blake3'];
// SQL digest returns TEXT, so only text-producing encodings are valid here ('bytes' is JS-only).
const DIGEST_TEXT_ENCODINGS: readonly OutputEncoding[] = ['base64url', 'base64', 'hex'];

function configAlgorithm(config: Record<string, SqlValue>): HashAlgorithm {
	const value = config.algorithm == null ? 'sha256' : String(config.algorithm);
	if (!DIGEST_ALGORITHMS.includes(value as HashAlgorithm)) {
		throw new Error(`crypto plugin: unsupported digest algorithm '${value}' (expected one of ${DIGEST_ALGORITHMS.join(', ')})`);
	}
	return value as HashAlgorithm;
}

function configEncoding(config: Record<string, SqlValue>): OutputEncoding {
	const value = config.encoding == null ? 'base64url' : String(config.encoding);
	if (!DIGEST_TEXT_ENCODINGS.includes(value as OutputEncoding)) {
		throw new Error(`crypto plugin: unsupported digest encoding '${value}' (expected one of ${DIGEST_TEXT_ENCODINGS.join(', ')})`);
	}
	return value as OutputEncoding;
}

/**
 * Coerce a SQL `data`/`digest` argument to raw bytes. A BLOB arrives as a
 * Uint8Array and is used directly; TEXT is interpreted as base64url — the
 * plugin's canonical text encoding — so `cid_v1(digest(...))` composes with the
 * base64url string `digest` returns, with no extra round-trip.
 */
function toContentBytes(value: SqlValue | undefined, fnName: string): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (typeof value === 'string') {
		return uint8ArrayFromString(value, 'base64url');
	}
	throw new Error(`${fnName}: expected a BLOB or base64url TEXT argument, got ${value == null ? 'NULL' : typeof value}`);
}

/**
 * Parse one JSON leaf — either `[name, value, salt]` or `{ name, value, salt }` —
 * into a {@link SaltedLeaf}. The JSON value maps directly to the `encodeFields` value
 * space (INTEGER vs REAL by JS value, TEXT, BOOL, null, nested object/array → JSON).
 *
 * Note: a BLOB-valued attribute is passed as its base64url TEXT and committed AS TEXT
 * (JSON has no blob type); callers needing a true BLOB value must use the JS API with a
 * `Uint8Array`. The salt is likewise base64url TEXT (decoded to bytes by `set_commit`).
 */
function leafFromJson(entry: unknown, fnName: string): SaltedLeaf {
	if (Array.isArray(entry)) {
		if (entry.length < 3) {
			throw new Error(`${fnName}: a leaf array must be [name, value, salt]`);
		}
		const [name, value, salt] = entry;
		if (typeof name !== 'string') {
			throw new Error(`${fnName}: leaf name must be a string`);
		}
		return { name, value: value as DigestField, salt: salt as string };
	}
	if (entry !== null && typeof entry === 'object') {
		const o = entry as Record<string, unknown>;
		if (typeof o.name !== 'string') {
			throw new Error(`${fnName}: leaf name must be a string`);
		}
		// Require an explicit `value` key (symmetric with the array form, which demands all
		// three positions): a silently-absent value would commit NULL and mask a malformed
		// leaf. To commit a null-valued attribute, pass `value: null` explicitly.
		if (!('value' in o)) {
			throw new Error(`${fnName}: leaf '${o.name}' is missing a value (pass value: null for a null-valued attribute)`);
		}
		return { name: o.name, value: o.value as DigestField, salt: o.salt as string };
	}
	throw new Error(`${fnName}: each leaf must be a [name, value, salt] array or { name, value, salt } object`);
}

/** Parse a JSON array of leaves. Throws on unparseable / non-array input. */
function parseLeaves(json: string, fnName: string): SaltedLeaf[] {
	const parsed = JSON.parse(json);
	if (!Array.isArray(parsed)) {
		throw new Error(`${fnName}: expected a JSON array of leaves`);
	}
	return parsed.map((entry) => leafFromJson(entry, fnName));
}

// Flags for deterministic functions (UTF8 + DETERMINISTIC)
const DETERMINISTIC_FLAGS = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;
// Flags for non-deterministic functions (UTF8 only)
const NON_DETERMINISTIC_FLAGS = FunctionFlags.UTF8;

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(_db: Database, config: Record<string, SqlValue> = {}) {
	// Resolve the digest algorithm + output encoding ONCE, at registration, from
	// load-time config — so the per-call path never branches on them, and so the
	// digest is stable for the lifetime of the database (a precondition for
	// `replicable`: every peer that loads the plugin with the same config agrees).
	const digestHasher = resolveHasher(configAlgorithm(config));
	const digestEncoder = resolveOutputEncoder(configEncoding(config));

	// Register crypto functions with Quereus
	const functions = [
		{
			schema: {
				name: 'digest',
				numArgs: -1, // Variadic over data fields: digest(f1, f2, ..., fN)
				flags: DETERMINISTIC_FLAGS, // digest is deterministic
				// Bit-identical across peers/platforms — these digests are signed and persisted.
				replicable: true,
				returnType: { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false },
				implementation: (...fields: SqlValue[]) =>
					digestFields(fields as DigestField[], digestHasher, digestEncoder) as string,
			},
		},
		{
			schema: {
				name: 'cid',
				numArgs: -1, // cid(data, codec?, hash?, base?) — trailing args optional
				flags: DETERMINISTIC_FLAGS,
				// Self-describing content address; signed/persisted, so byte-identical across peers.
				replicable: true,
				returnType: { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false },
				implementation: (...args: SqlValue[]) => {
					const [data, codec = 'raw', hash = 'sha2-256', base = 'base32'] = args;
					return cid(toContentBytes(data, 'cid'), codec as Multicodec, hash as MultihashCode, base as Multibase);
				},
			},
		},
		{
			schema: {
				name: 'cid_v1',
				numArgs: -1, // cid_v1(digest, hash, codec?, base?) — hash required, trailing args optional
				flags: DETERMINISTIC_FLAGS,
				replicable: true,
				returnType: { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false },
				implementation: (...args: SqlValue[]) => {
					const [digest, hash, codec = 'raw', base = 'base32'] = args;
					if (hash == null) {
						throw new Error("cid_v1: 'hash' argument is required (the multihash code asserting which algorithm produced the digest)");
					}
					return cidV1(toContentBytes(digest, 'cid_v1'), hash as MultihashCode, codec as Multicodec, base as Multibase);
				},
			},
		},
		{
			schema: {
				name: 'cid_decode',
				numArgs: 1, // cid_decode(cid) -> JSON text { version, codec, hashCode, digest }
				flags: DETERMINISTIC_FLAGS,
				replicable: true,
				returnType: { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false },
				implementation: (value: SqlValue) => {
					const parts = cidDecode(value as string);
					// JSON object (Quereus has native JSON); digest is base64url, the plugin's canonical text encoding.
					return JSON.stringify({
						version: parts.version,
						codec: parts.codec,
						hashCode: parts.hashCode,
						digest: uint8ArrayToString(parts.digest, 'base64url'),
					});
				},
			},
		},
		{
			schema: {
				name: 'set_commit',
				numArgs: 1, // set_commit(leaves_json) -> root over a JSON array of [name, value, salt] leaves
				flags: DETERMINISTIC_FLAGS,
				// The root is signed and persisted as a commitment, same bar as `digest`.
				replicable: true,
				returnType: { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false },
				implementation: (leavesJson: SqlValue) => {
					if (typeof leavesJson !== 'string') {
						throw new Error('set_commit: expected a JSON TEXT array of [name, value, salt] leaves');
					}
					const leaves = parseLeaves(leavesJson, 'set_commit');
					return setCommit(leaves, digestHasher, digestEncoder) as string;
				},
			},
		},
		{
			schema: {
				name: 'set_verify',
				numArgs: 3, // set_verify(root, disclosed_json, hidden_json) -> BOOLEAN
				flags: DETERMINISTIC_FLAGS, // pure, not persisted — matches `verify` (no `replicable`)
				returnType: { typeClass: 'scalar' as const, logicalType: BOOLEAN_TYPE, nullable: false },
				implementation: (root: SqlValue, disclosedJson: SqlValue, hiddenJson: SqlValue) => {
					// Forgiving contract (mirrors `verify`): any malformed input → false, never throw.
					try {
						if (typeof root !== 'string' && !(root instanceof Uint8Array)) return false;
						if (typeof disclosedJson !== 'string' || typeof hiddenJson !== 'string') return false;
						const disclosed = parseLeaves(disclosedJson, 'set_verify');
						const hidden = JSON.parse(hiddenJson);
						if (!Array.isArray(hidden) || !hidden.every((h) => typeof h === 'string')) return false;
						return setVerify(root, { disclosed, hidden: hidden as string[] }, digestHasher, digestEncoder);
					} catch {
						return false;
					}
				},
			},
		},
		{
			schema: {
				name: 'sign',
				numArgs: -1, // Variable arguments: data, privateKey, curve?, inputEncoding?, keyEncoding?, outputEncoding?
				flags: DETERMINISTIC_FLAGS, // sign is deterministic (same key + data = same signature)
				returnType: { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false },
				implementation: (...args: SqlValue[]) => {
					const [data, privateKey, curve = 'secp256k1', inputEncoding = 'base64url', keyEncoding = 'base64url', outputEncoding = 'base64url'] = args;
					return sign(data as string, privateKey as string, curve as any, inputEncoding as any, keyEncoding as any, outputEncoding as any);
				},
			},
		},
		{
			schema: {
				name: 'verify',
				numArgs: -1, // Variable arguments: data, signature, publicKey, curve?, inputEncoding?, sigEncoding?, keyEncoding?
				flags: DETERMINISTIC_FLAGS, // verify is deterministic
				returnType: { typeClass: 'scalar' as const, logicalType: BOOLEAN_TYPE, nullable: false },
				implementation: (...args: SqlValue[]) => {
					const [data, signature, publicKey, curve = 'secp256k1', inputEncoding = 'base64url', sigEncoding = 'base64url', keyEncoding = 'base64url'] = args;
					const result = verify(data as string, signature as string, publicKey as string, curve as any, inputEncoding as any, sigEncoding as any, keyEncoding as any);
					return result;
				},
			},
		},
		{
			schema: {
				name: 'hash_mod',
				numArgs: -1, // Variable arguments: data, bits, algorithm?, inputEncoding?
				flags: DETERMINISTIC_FLAGS, // hash_mod is deterministic
				returnType: { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: false },
				implementation: (...args: SqlValue[]) => {
					const [data, bits, algorithm = 'sha256', inputEncoding = 'base64url'] = args;
					return hashMod(data as string, bits as number, algorithm as any, inputEncoding as any);
				},
			},
		},
		{
			schema: {
				name: 'random_bytes',
				numArgs: -1, // Variable arguments: bits?, encoding?
				flags: NON_DETERMINISTIC_FLAGS, // random_bytes is NOT deterministic
				returnType: { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false },
				implementation: (...args: SqlValue[]) => {
					const [bits = 256, encoding = 'base64url'] = args;
					return randomBytes(bits as number, encoding as any);
				},
			},
		},
	];

	return {
		functions,
		vtables: [],
		collations: [],
	};
}

