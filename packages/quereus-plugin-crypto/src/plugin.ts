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

