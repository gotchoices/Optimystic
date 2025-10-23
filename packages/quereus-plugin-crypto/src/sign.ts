/**
 * Sign Function for Quereus
 *
 * Returns the signature for the given payload using an ECC private key.
 * Uses secp256k1 from @noble/curves for portable implementation.
 * Compatible with React Native and all JS environments.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/nist';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';

/**
 * Supported elliptic curve types
 */
export type CurveType = 'secp256k1' | 'p256' | 'ed25519';

/**
 * Private key input - can be Uint8Array, hex string, or bigint
 */
export type PrivateKeyInput = Uint8Array | string | bigint;

/**
 * Digest input - can be Uint8Array or hex string
 */
export type DigestInput = Uint8Array | string;

/**
 * Signature output format options
 */
export type SignatureFormat = 'uint8array' | 'hex' | 'compact' | 'der';

/**
 * Options for the Sign function
 */
export interface SignOptions {
  /** Elliptic curve to use (default: secp256k1) */
  curve?: CurveType;
  /** Output format for signature (default: uint8array) */
  format?: SignatureFormat;
  /** Additional entropy for signatures (hedged signatures) */
  extraEntropy?: boolean | Uint8Array;
  /** Use low-S canonical signatures (default: true) */
  lowS?: boolean;
}

/**
 * Normalize private key input to Uint8Array
 */
function normalizePrivateKey(privateKey: PrivateKeyInput): Uint8Array {
  if (privateKey instanceof Uint8Array) {
    return privateKey;
  }

  if (typeof privateKey === 'string') {
    // Assume hex string
    return hexToBytes(privateKey);
  }

  if (typeof privateKey === 'bigint') {
    // Convert bigint to 32-byte array (for secp256k1/p256)
    const hex = privateKey.toString(16).padStart(64, '0');
    return hexToBytes(hex);
  }

  throw new Error('Invalid private key format');
}

/**
 * Normalize digest input to Uint8Array
 */
function normalizeDigest(digest: DigestInput): Uint8Array {
  if (digest instanceof Uint8Array) {
    return digest;
  }

  if (typeof digest === 'string') {
    return hexToBytes(digest);
  }

  throw new Error('Invalid digest format');
}

/**
 * Format signature based on requested format
 */
function formatSignature(signature: any, format: SignatureFormat, curve: CurveType): Uint8Array | string {
  switch (format) {
    case 'uint8array':
      if (curve === 'ed25519') {
        return signature;
      }
      return signature.toCompactRawBytes();

    case 'hex':
      if (curve === 'ed25519') {
        return bytesToHex(signature);
      }
      return signature.toCompactHex();

    case 'compact':
      if (curve === 'ed25519') {
        return signature;
      }
      return signature.toCompactRawBytes();

    case 'der':
      if (curve === 'ed25519') {
        throw new Error('DER format not supported for ed25519');
      }
      // Note: DER encoding would require additional implementation
      // For now, fall back to compact
      return signature.toCompactRawBytes();

    default:
      throw new Error(`Unsupported signature format: ${format}`);
  }
}

/**
 * Sign a digest using the specified private key and curve
 *
 * @param {DigestInput} digest - The digest/hash to sign
 * @param {PrivateKeyInput} privateKey - The private key to use for signing
 * @param {SignOptions} [options] - Optional signing parameters
 * @returns {Uint8Array | string} The signature in the requested format
 *
 * @example
 * ```typescript
 * // Basic usage with secp256k1
 * const digest = new Uint8Array(32).fill(1); // Your hash here
 * const privateKey = 'a'.repeat(64); // Your private key hex
 * const signature = Sign(digest, privateKey);
 *
 * // With specific curve and format
 * const sig = Sign(digest, privateKey, {
 *   curve: 'p256',
 *   format: 'hex'
 * });
 *
 * // With hedged signatures for extra security
 * const hedgedSig = Sign(digest, privateKey, {
 *   extraEntropy: true
 * });
 * ```
 */
export function Sign(
  digest: DigestInput,
  privateKey: PrivateKeyInput,
  options: SignOptions = {}
): Uint8Array | string {
  const {
    curve = 'secp256k1',
    format = 'uint8array',
    extraEntropy = false,
    lowS = true,
  } = options;

  const normalizedDigest = normalizeDigest(digest);
  const normalizedPrivateKey = normalizePrivateKey(privateKey);

  let signature: any;

  switch (curve) {
    case 'secp256k1': {
      const signOptions: any = { lowS };
      if (extraEntropy) {
        signOptions.extraEntropy = extraEntropy;
      }
      signature = secp256k1.sign(normalizedDigest, normalizedPrivateKey, signOptions);
      break;
    }

    case 'p256': {
      const signOptions: any = { lowS };
      if (extraEntropy) {
        signOptions.extraEntropy = extraEntropy;
      }
      signature = p256.sign(normalizedDigest, normalizedPrivateKey, signOptions);
      break;
    }

    case 'ed25519': {
      signature = ed25519.sign(normalizedDigest, normalizedPrivateKey);
      break;
    }

    default:
      throw new Error(`Unsupported curve: ${curve}`);
  }

  return formatSignature(signature, format, curve);
}

/**
 * Convenience functions for specific curves
 */
Sign.secp256k1 = (digest: DigestInput, privateKey: PrivateKeyInput, options: Omit<SignOptions, 'curve'> = {}) => {
  return Sign(digest, privateKey, { ...options, curve: 'secp256k1' });
};

Sign.p256 = (digest: DigestInput, privateKey: PrivateKeyInput, options: Omit<SignOptions, 'curve'> = {}) => {
  return Sign(digest, privateKey, { ...options, curve: 'p256' });
};

Sign.ed25519 = (digest: DigestInput, privateKey: PrivateKeyInput, options: Omit<SignOptions, 'curve'> = {}) => {
  return Sign(digest, privateKey, { ...options, curve: 'ed25519' });
};

/**
 * Generate a random private key for the specified curve
 */
Sign.generatePrivateKey = (curve: CurveType = 'secp256k1'): Uint8Array => {
  switch (curve) {
    case 'secp256k1':
      return secp256k1.utils.randomPrivateKey();
    case 'p256':
      return p256.utils.randomPrivateKey();
    case 'ed25519':
      return ed25519.utils.randomPrivateKey();
    default:
      throw new Error(`Unsupported curve: ${curve}`);
  }
};

/**
 * Get the public key for a given private key and curve
 */
Sign.getPublicKey = (privateKey: PrivateKeyInput, curve: CurveType = 'secp256k1'): Uint8Array => {
  const normalizedPrivateKey = normalizePrivateKey(privateKey);

  switch (curve) {
    case 'secp256k1':
      return secp256k1.getPublicKey(normalizedPrivateKey);
    case 'p256':
      return p256.getPublicKey(normalizedPrivateKey);
    case 'ed25519':
      return ed25519.getPublicKey(normalizedPrivateKey);
    default:
      throw new Error(`Unsupported curve: ${curve}`);
  }
};

export default Sign;
