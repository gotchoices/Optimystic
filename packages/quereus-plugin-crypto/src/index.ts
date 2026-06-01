/**
 * Quereus Crypto Functions Plugin
 *
 * Provides cryptographic functions for SQL queries and ES modules:
 * - digest: Hash functions (SHA-256, SHA-512, BLAKE3) with base64url encoding
 * - sign: ECC signature generation (secp256k1, P-256, Ed25519)
 * - verify: ECC signature verification
 * - hashMod: Hash with modulo for fixed-size outputs
 * - randomBytes: Generate cryptographically secure random bytes
 *
 * All functions use base64url encoding by default for SQL compatibility.
 */

// Export idiomatic lowercase functions (primary API)
export {
	digest,
	sign,
	verify,
	hashMod,
	randomBytes,
	generatePrivateKey,
	getPublicKey,
	type HashAlgorithm,
	type CurveType,
	type Encoding,
} from './crypto.js';

