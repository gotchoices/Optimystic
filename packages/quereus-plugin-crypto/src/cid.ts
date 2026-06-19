/**
 * Self-describing content identifiers (CIDv1) for Quereus.
 *
 * Where {@link ./crypto.ts | digest} emits a *bare* hash (raw digest bytes in
 * some text encoding), this module emits an interoperable, self-describing
 * CIDv1:
 *
 * ```
 * CIDv1     = multibase( version ‖ multicodec(content-type) ‖ multihash )
 * multihash = hashFnCode ‖ digestLength ‖ digestBytes
 * ```
 *
 * The value carries its own multibase, multicodec (content type), and multihash
 * (hash algorithm + length), so a consumer can decode it without out-of-band
 * knowledge, and an algorithm migration (e.g. sha2-256 → another hash) is
 * unambiguous because the hash code is recorded *in the value*.
 *
 * All framing/parsing comes from the audited `multiformats` library — there is
 * no bespoke byte-pushing here. The actual hashing reuses the same synchronous,
 * cross-platform `@noble/hashes` functions the rest of the plugin uses (via
 * {@link resolveHasher}), so the output is byte-identical to the CID an external
 * content-addressed store (IPFS/IPLD) computes for the same bytes:
 * `cid(utf8('hello world'))` === `bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e`.
 */

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { base32 } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';
import { base64url } from 'multiformats/bases/base64';
import { base16 } from 'multiformats/bases/base16';
import type { MultibaseEncoder, MultibaseDecoder } from 'multiformats/bases/interface';
import { resolveHasher, type HashAlgorithm } from './crypto.js';

/** Content-type multicodec selectable for the CID. Extensible. */
export type Multicodec = 'raw' | 'dag-cbor';
/** Hash-algorithm multihash code selectable for the CID. */
export type MultihashCode = 'sha2-256' | 'sha2-512' | 'blake3';
/** Multibase the CID string is rendered in. */
export type Multibase = 'base32' | 'base58btc' | 'base64url' | 'base16';

/** Parsed parts of a CIDv1 (or CIDv0), as returned by {@link cidDecode}. */
export interface CidParts {
	/** CID version (1 for the values this module produces; 0 for legacy CIDv0). */
	readonly version: number;
	/** Content-type codec name when recognized, else the raw multicodec number. */
	readonly codec: Multicodec | number;
	/** Hash-algorithm code name when recognized, else the raw multihash number. */
	readonly hashCode: MultihashCode | number;
	/** Raw digest bytes (without the multihash code/length prefix). */
	readonly digest: Uint8Array;
}

// --- Multiformats code tables (see multiformats/multicodec table.csv) --- //

/** Content-type name → multicodec code. */
const MULTICODEC_CODES: Record<Multicodec, number> = {
	'raw': 0x55,
	'dag-cbor': 0x71,
};

/** Hash name → multihash code. */
const MULTIHASH_CODES: Record<MultihashCode, number> = {
	'sha2-256': 0x12,
	'sha2-512': 0x13,
	'blake3': 0x1e,
};

/** Multihash code → the synchronous `@noble/hashes` algorithm that produces it. */
const MULTIHASH_TO_ALGORITHM: Record<MultihashCode, HashAlgorithm> = {
	'sha2-256': 'sha256',
	'sha2-512': 'sha512',
	'blake3': 'blake3',
};

/**
 * Multihash code → exact digest length in bytes. A CID is replicable only if its
 * digest length is fixed, so blake3 (which is variable-length in general) is
 * pinned to 32 bytes here, matching the plugin's blake3 output and sha2-256.
 */
const MULTIHASH_DIGEST_LENGTHS: Record<MultihashCode, number> = {
	'sha2-256': 32,
	'sha2-512': 64,
	'blake3': 32,
};

/** Reverse lookups for {@link cidDecode}: code number → friendly name. */
const MULTICODEC_NAMES: ReadonlyMap<number, Multicodec> = new Map(
	(Object.entries(MULTICODEC_CODES) as [Multicodec, number][]).map(([name, code]) => [code, name])
);
const MULTIHASH_NAMES: ReadonlyMap<number, MultihashCode> = new Map(
	(Object.entries(MULTIHASH_CODES) as [MultihashCode, number][]).map(([name, code]) => [code, name])
);

/** Multibase name → its multiformats encoder. */
const MULTIBASE_ENCODERS: Record<Multibase, MultibaseEncoder<string>> = {
	'base32': base32,
	'base58btc': base58btc,
	'base64url': base64url,
	'base16': base16,
};

/**
 * Combined decoder that dispatches on the multibase prefix character, so
 * {@link cidDecode} accepts a CID in any of the supported bases without the
 * caller having to declare which.
 */
const MULTIBASE_DECODER: MultibaseDecoder<string> = base32.decoder
	.or(base58btc.decoder)
	.or(base64url.decoder)
	.or(base16.decoder);

function resolveCodecCode(codec: Multicodec): number {
	const code = MULTICODEC_CODES[codec];
	if (code === undefined) {
		throw new Error(`cid: unsupported multicodec '${codec}' (expected one of ${Object.keys(MULTICODEC_CODES).join(', ')})`);
	}
	return code;
}

function resolveBaseEncoder(base: Multibase): MultibaseEncoder<string> {
	const encoder = MULTIBASE_ENCODERS[base];
	if (!encoder) {
		throw new Error(`cid: unsupported multibase '${base}' (expected one of ${Object.keys(MULTIBASE_ENCODERS).join(', ')})`);
	}
	return encoder;
}

/**
 * Frame an **already-computed** digest as a CIDv1 string. The caller asserts
 * which `hash` produced the digest; the digest length is validated against that
 * hash so a mismatched assertion is rejected rather than silently mis-framed.
 *
 * Use this to turn an existing field-tuple digest into a CID without re-hashing,
 * e.g. `cidV1(digest(fields, 'sha256', 'bytes'), 'sha2-256')`.
 *
 * @param digest - Raw digest bytes (no multihash prefix).
 * @param hash - The multihash code asserting which algorithm produced `digest`.
 * @param codec - Content-type multicodec (default `'raw'`).
 * @param base - Multibase to render in (default `'base32'`, the IPFS canonical).
 */
export function cidV1(
	digest: Uint8Array,
	hash: MultihashCode,
	codec: Multicodec = 'raw',
	base: Multibase = 'base32'
): string {
	const hashCode = MULTIHASH_CODES[hash];
	if (hashCode === undefined) {
		throw new Error(`cid: unsupported multihash code '${hash}' (expected one of ${Object.keys(MULTIHASH_CODES).join(', ')})`);
	}
	const expectedLength = MULTIHASH_DIGEST_LENGTHS[hash];
	if (digest.length !== expectedLength) {
		throw new Error(`cid: digest length ${digest.length} does not match asserted hash '${hash}' (expected ${expectedLength} bytes)`);
	}
	const codecCode = resolveCodecCode(codec);
	const encoder = resolveBaseEncoder(base);
	const multihash = Digest.create(hashCode, digest);
	return CID.createV1(codecCode, multihash).toString(encoder);
}

/**
 * Hash `data`, wrap the digest as a multihash, frame it as a CIDv1, and encode
 * in `base`. The result is the same interoperable address an IPFS/IPLD store
 * computes for the same bytes (for the matching codec/hash).
 *
 * @param data - The content bytes to address.
 * @param codec - Content-type multicodec (default `'raw'`).
 * @param hash - Hash algorithm (default `'sha2-256'`).
 * @param base - Multibase to render in (default `'base32'`, the IPFS canonical).
 */
export function cid(
	data: Uint8Array,
	codec: Multicodec = 'raw',
	hash: MultihashCode = 'sha2-256',
	base: Multibase = 'base32'
): string {
	const algorithm = MULTIHASH_TO_ALGORITHM[hash];
	if (!algorithm) {
		throw new Error(`cid: unsupported multihash code '${hash}' (expected one of ${Object.keys(MULTIHASH_CODES).join(', ')})`);
	}
	const digest = resolveHasher(algorithm)(data);
	return cidV1(digest, hash, codec, base);
}

/**
 * Parse a CID string back into its parts, for schema validation and migration.
 * Recognized codec/hash codes are returned as friendly names; unrecognized ones
 * as their raw numbers. Throws cleanly on malformed input (delegated to
 * `multiformats`), never silently mis-framing.
 */
export function cidDecode(value: string): CidParts {
	const parsed = CID.parse(value, MULTIBASE_DECODER);
	return {
		version: parsed.version,
		codec: MULTICODEC_NAMES.get(parsed.code) ?? parsed.code,
		hashCode: MULTIHASH_NAMES.get(parsed.multihash.code) ?? parsed.multihash.code,
		digest: parsed.multihash.digest,
	};
}
