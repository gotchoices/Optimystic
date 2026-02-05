/**
 * SignatureValid Function for Quereus
 *
 * Returns true if the ECC signature is valid for the given digest and public key.
 * Uses @noble/curves for portable implementation.
 * Compatible with React Native and all JS environments.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/curves/utils.js';

/**
 * Supported elliptic curve types
 */
export type CurveType = 'secp256k1' | 'p256' | 'ed25519';

/**
 * Input types that can be Uint8Array or hex string
 */
export type BytesInput = Uint8Array | string;

/**
 * Options for signature verification
 */
export interface VerifyOptions {
  /** Elliptic curve to use (default: secp256k1) */
  curve?: CurveType;
  /** Signature format (default: auto-detect) */
  signatureFormat?: 'compact' | 'der' | 'raw';
  /** Allow malleable signatures (default: false for ECDSA, true for EdDSA) */
  allowMalleableSignatures?: boolean;
}

/**
 * Normalize input to Uint8Array
 */
function normalizeBytes(input: BytesInput): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (typeof input === 'string') {
    return hexToBytes(input);
  }

  throw new Error('Invalid input format - expected Uint8Array or hex string');
}

/**
 * Auto-detect signature format based on length and curve
 */
function detectSignatureFormat(signature: Uint8Array, curve: CurveType): 'compact' | 'der' | 'raw' {
  const length = signature.length;

  if (curve === 'ed25519') {
    return 'raw'; // Ed25519 signatures are always 64 bytes
  }

  // For ECDSA curves (secp256k1, p256)
  if (length === 64) {
    return 'compact'; // r + s concatenated (32 + 32 bytes)
  }

  if (length >= 70 && length <= 72 && signature[0] === 0x30) {
    return 'der'; // DER encoding starts with 0x30
  }

  // Default to compact for shorter signatures
  return 'compact';
}

/**
 * Parse signature based on format and curve.
 * In @noble/curves v2.0.1, uses Signature.fromBytes(bytes, format).
 */
function parseSignature(signature: Uint8Array, format: 'compact' | 'der' | 'raw', curve: CurveType): Uint8Array {
  if (curve === 'ed25519') {
    // Ed25519 signatures are always raw 64-byte format
    return signature;
  }

  // For ECDSA curves in v2.0.1, verify() accepts raw bytes directly
  // The format parameter is used to parse signature bytes into the expected format
  const sigFormat = format === 'raw' ? 'compact' : format;

  if (curve === 'secp256k1') {
    return secp256k1.Signature.fromBytes(signature, sigFormat).toBytes();
  } else if (curve === 'p256') {
    return p256.Signature.fromBytes(signature, sigFormat).toBytes();
  }

  throw new Error(`Failed to parse signature for curve ${curve} with format ${format}`);
}

/**
 * Verify if an ECC signature is valid
 *
 * @param {BytesInput} digest - The digest/hash that was signed
 * @param {BytesInput} signature - The signature to verify
 * @param {BytesInput} publicKey - The public key to verify against
 * @param {VerifyOptions} [options] - Optional verification parameters
 * @returns {boolean} True if the signature is valid, false otherwise
 *
 * @example
 * ```typescript
 * // Basic usage with secp256k1
 * const isValid = SignatureValid(digest, signature, publicKey);
 *
 * // With specific curve
 * const isValid = SignatureValid(digest, signature, publicKey, {
 *   curve: 'p256'
 * });
 *
 * // With specific signature format
 * const isValid = SignatureValid(digest, signature, publicKey, {
 *   curve: 'secp256k1',
 *   signatureFormat: 'der'
 * });
 *
 * // Allow malleable signatures
 * const isValid = SignatureValid(digest, signature, publicKey, {
 *   allowMalleableSignatures: true
 * });
 * ```
 */
export function SignatureValid(
  digest: BytesInput,
  signature: BytesInput,
  publicKey: BytesInput,
  options: VerifyOptions = {}
): boolean {
  try {
    const {
      curve = 'secp256k1',
      signatureFormat,
      allowMalleableSignatures,
    } = options;

    const normalizedDigest = normalizeBytes(digest);
    const normalizedSignature = normalizeBytes(signature);
    const normalizedPublicKey = normalizeBytes(publicKey);

    // Auto-detect signature format if not specified
    const detectedFormat = signatureFormat || detectSignatureFormat(normalizedSignature, curve);

    // Parse the signature
    const parsedSignature = parseSignature(normalizedSignature, detectedFormat, curve);

    // Set up verification options
    const verifyOptions: any = {};

    // Handle malleable signatures for ECDSA curves
    if (curve !== 'ed25519' && allowMalleableSignatures !== undefined) {
      verifyOptions.lowS = !allowMalleableSignatures;
    }

    // Verify the signature
    switch (curve) {
      case 'secp256k1':
        return secp256k1.verify(parsedSignature, normalizedDigest, normalizedPublicKey, verifyOptions);

      case 'p256':
        return p256.verify(parsedSignature, normalizedDigest, normalizedPublicKey, verifyOptions);

      case 'ed25519':
        return ed25519.verify(parsedSignature, normalizedDigest, normalizedPublicKey);

      default:
        throw new Error(`Unsupported curve: ${curve}`);
    }
  } catch (error) {
    // If any error occurs during verification, the signature is invalid
    return false;
  }
}

/**
 * Convenience functions for specific curves
 */
SignatureValid.secp256k1 = (
  digest: BytesInput,
  signature: BytesInput,
  publicKey: BytesInput,
  options: Omit<VerifyOptions, 'curve'> = {}
): boolean => {
  return SignatureValid(digest, signature, publicKey, { ...options, curve: 'secp256k1' });
};

SignatureValid.p256 = (
  digest: BytesInput,
  signature: BytesInput,
  publicKey: BytesInput,
  options: Omit<VerifyOptions, 'curve'> = {}
): boolean => {
  return SignatureValid(digest, signature, publicKey, { ...options, curve: 'p256' });
};

SignatureValid.ed25519 = (
  digest: BytesInput,
  signature: BytesInput,
  publicKey: BytesInput,
  options: Omit<VerifyOptions, 'curve'> = {}
): boolean => {
  return SignatureValid(digest, signature, publicKey, { ...options, curve: 'ed25519' });
};

/**
 * Batch verify multiple signatures (more efficient for multiple verifications)
 */
SignatureValid.batch = (
  verifications: Array<{
    digest: BytesInput;
    signature: BytesInput;
    publicKey: BytesInput;
    options?: VerifyOptions;
  }>
): boolean[] => {
  return verifications.map(({ digest, signature, publicKey, options }) =>
    SignatureValid(digest, signature, publicKey, options)
  );
};

/**
 * Verify and return detailed information about the verification
 */
SignatureValid.detailed = (
  digest: BytesInput,
  signature: BytesInput,
  publicKey: BytesInput,
  options: VerifyOptions = {}
): {
  valid: boolean;
  curve: CurveType;
  signatureFormat: string;
  error?: string;
} => {
  const curve = options.curve || 'secp256k1';

  try {
    const normalizedSignature = normalizeBytes(signature);
    const detectedFormat = options.signatureFormat || detectSignatureFormat(normalizedSignature, curve);

    const valid = SignatureValid(digest, signature, publicKey, options);

    return {
      valid,
      curve,
      signatureFormat: detectedFormat,
    };
  } catch (error) {
    return {
      valid: false,
      curve,
      signatureFormat: 'unknown',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

export default SignatureValid;
