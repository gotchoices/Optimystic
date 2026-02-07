/**
 * Cryptographic Functions for Quereus
 *
 * Idiomatic ES module exports with base64url as default encoding.
 * All functions accept and return base64url strings by default for SQL compatibility.
 */

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { concatBytes, randomBytes as nobleRandomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, bytesToHex } from '@noble/curves/utils.js';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';

// Type definitions
export type HashAlgorithm = 'sha256' | 'sha512' | 'blake3';
export type CurveType = 'secp256k1' | 'p256' | 'ed25519';
export type Encoding = 'base64url' | 'base64' | 'hex' | 'utf8' | 'bytes';

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

/**
 * Compute hash digest of input data
 *
 * @param data - Data to hash (base64url string or Uint8Array)
 * @param algorithm - Hash algorithm (default: 'sha256')
 * @param inputEncoding - Encoding of input string (default: 'base64url')
 * @param outputEncoding - Encoding of output (default: 'base64url')
 * @returns Hash digest in specified encoding
 *
 * @example
 * ```typescript
 * // Hash UTF-8 text, output as base64url
 * const hash = digest('hello world', 'sha256', 'utf8');
 *
 * // Hash base64url data with SHA-512
 * const hash2 = digest('SGVsbG8', 'sha512');
 *
 * // Get raw bytes
 * const bytes = digest('data', 'blake3', 'utf8', 'bytes');
 * ```
 */
export function digest(
	data: string | Uint8Array,
	algorithm: HashAlgorithm = 'sha256',
	inputEncoding: Encoding = 'base64url',
	outputEncoding: Encoding = 'base64url'
): string | Uint8Array {
	const bytes = toBytes(data, inputEncoding);

	let hashBytes: Uint8Array;
	switch (algorithm) {
		case 'sha256':
			hashBytes = sha256(bytes);
			break;
		case 'sha512':
			hashBytes = sha512(bytes);
			break;
		case 'blake3':
			hashBytes = blake3(bytes);
			break;
		default:
			throw new Error(`Unsupported hash algorithm: ${algorithm}`);
	}

	return fromBytes(hashBytes, outputEncoding);
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

	const hashBytes = toBytes(digest(data, algorithm, inputEncoding, 'base64url') as string, 'base64url');

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

