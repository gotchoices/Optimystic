/**
 * Digest Function for Quereus
 *
 * Computes the hash of all arguments combined.
 * Uses SHA-256 from @noble/hashes for portable implementation.
 * Compatible with React Native and all JS environments.
 */

import { sha256 } from '@noble/hashes/sha2';
import { sha512 } from '@noble/hashes/sha2';
import { blake3 } from '@noble/hashes/blake3';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Hash algorithm options
 */
export type HashAlgorithm = 'sha256' | 'sha512' | 'blake3';

/**
 * Input type for digest function - can be string, Uint8Array, or number
 */
export type DigestInput = string | Uint8Array | number | boolean | null | undefined;

/**
 * Options for the digest function
 */
export interface DigestOptions {
  /** Hash algorithm to use (default: sha256) */
  algorithm?: HashAlgorithm;
  /** Output format (default: uint8array) */
  output?: 'uint8array' | 'hex';
}

/**
 * Convert various input types to Uint8Array for hashing
 */
function inputToBytes(input: DigestInput): Uint8Array {
  if (input === null || input === undefined) {
    return new Uint8Array(0);
  }

  if (typeof input === 'string') {
    return utf8ToBytes(input);
  }

  if (input instanceof Uint8Array) {
    return input;
  }

  if (typeof input === 'number') {
    // Convert number to 8-byte big-endian representation
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, input, false); // big-endian
    return new Uint8Array(buffer);
  }

  if (typeof input === 'boolean') {
    return new Uint8Array([input ? 1 : 0]);
  }

  // Fallback: convert to string then to bytes
  return utf8ToBytes(String(input));
}

/**
 * Get hash function based on algorithm
 */
function getHashFunction(algorithm: HashAlgorithm): (data: Uint8Array) => Uint8Array {
  switch (algorithm) {
    case 'sha256':
      return sha256;
    case 'sha512':
      return sha512;
    case 'blake3':
      return blake3;
    default:
      throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
}

/**
 * Computes the hash of all arguments
 *
 * @param {...DigestInput} args - Variable number of arguments to hash
 * @returns {Uint8Array} The computed hash as a Uint8Array
 *
 * @example
 * ```typescript
 * // Hash a string
 * const hash1 = Digest('hello world');
 *
 * // Hash multiple arguments
 * const hash2 = Digest('user:', 123, 'session');
 *
 * // Hash with specific algorithm
 * const hash3 = Digest.withOptions({ algorithm: 'sha512' })('data1', 'data2');
 *
 * // Get hex output
 * const hexHash = Digest.withOptions({ output: 'hex' })('hello');
 * ```
 */
export function Digest(...args: DigestInput[]): Uint8Array {
  return DigestWithOptions({ algorithm: 'sha256', output: 'uint8array' }, ...args) as Uint8Array;
}

/**
 * Digest function with custom options
 */
export function DigestWithOptions(options: DigestOptions, ...args: DigestInput[]): Uint8Array | string {
  const algorithm = options.algorithm || 'sha256';
  const output = options.output || 'uint8array';

  // Convert all arguments to bytes and concatenate
  const byteArrays = args.map(inputToBytes);
  const combined = concatBytes(...byteArrays);

  // Hash the combined data
  const hashFunction = getHashFunction(algorithm);
  const hash = hashFunction(combined);

  // Return in requested format
  if (output === 'hex') {
    return Array.from(hash)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return hash;
}

/**
 * Create a digest function with preset options
 */
Digest.withOptions = (options: DigestOptions) => {
  return (...args: DigestInput[]) => DigestWithOptions(options, ...args);
};

/**
 * Convenience functions for specific algorithms
 */
Digest.sha256 = (...args: DigestInput[]): Uint8Array => {
  return DigestWithOptions({ algorithm: 'sha256' }, ...args) as Uint8Array;
};

Digest.sha512 = (...args: DigestInput[]): Uint8Array => {
  return DigestWithOptions({ algorithm: 'sha512' }, ...args) as Uint8Array;
};

Digest.blake3 = (...args: DigestInput[]): Uint8Array => {
  return DigestWithOptions({ algorithm: 'blake3' }, ...args) as Uint8Array;
};

/**
 * Hex output variants
 */
Digest.hex = (...args: DigestInput[]): string => {
  return DigestWithOptions({ algorithm: 'sha256', output: 'hex' }, ...args) as string;
};

Digest.sha256Hex = (...args: DigestInput[]): string => {
  return DigestWithOptions({ algorithm: 'sha256', output: 'hex' }, ...args) as string;
};

Digest.sha512Hex = (...args: DigestInput[]): string => {
  return DigestWithOptions({ algorithm: 'sha512', output: 'hex' }, ...args) as string;
};

Digest.blake3Hex = (...args: DigestInput[]): string => {
  return DigestWithOptions({ algorithm: 'blake3', output: 'hex' }, ...args) as string;
};

export default Digest;
