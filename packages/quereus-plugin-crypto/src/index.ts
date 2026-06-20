/**
 * Quereus Crypto Functions Plugin
 *
 * Provides cryptographic functions for SQL queries and ES modules:
 * - digest: Injective multi-field hash (SHA-256, SHA-512, BLAKE3) with base64url encoding
 * - cid / cidV1 / cidDecode: Self-describing, interoperable CIDv1 content identifiers
 * - setCommit / setDisclose / setVerify: Salted-leaf set commitment for per-attribute selective disclosure
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
	digestFields,
	encodeFields,
	resolveHasher,
	resolveOutputEncoder,
	sign,
	verify,
	hashMod,
	randomBytes,
	generatePrivateKey,
	getPublicKey,
	type HashAlgorithm,
	type CurveType,
	type Encoding,
	type OutputEncoding,
	type DigestField,
	type DigestHasher,
	type OutputEncoder,
} from './crypto.js';

// Self-describing content identifiers (CIDv1) layered on top of digest.
export {
	cid,
	cidV1,
	cidDecode,
	type Multicodec,
	type MultihashCode,
	type Multibase,
	type CidParts,
} from './cid.js';

// Salted-leaf set commitment for per-attribute selective disclosure, layered on digest.
export {
	leafDigest,
	setCommit,
	setDisclose,
	setVerify,
	type SaltedLeaf,
	type SetDisclosure,
} from './sd.js';

