/**
 * Crypto Functions for Quereus
 *
 * This module provides portable cryptographic functions for the Quereus plugin.
 * All functions are compatible with React Native and browser environments.
 */

import { Digest } from './digest.js';
import { Sign } from './sign.js';
import { SignatureValid } from './signature-valid.js';

export { Digest, type DigestInput, type DigestOptions, type HashAlgorithm } from './digest.js';
export { Sign, type CurveType, type PrivateKeyInput, type SignOptions } from './sign.js';
export { SignatureValid, type BytesInput, type VerifyOptions } from './signature-valid.js';

// Re-export commonly used types
export type CryptoInput = string | Uint8Array;

/**
 * Create algorithm-specific variants for easier SQL usage
 */

// Digest variants
const DigestSHA256 = (...args: any[]) => Digest.sha256(...args);
const DigestSHA512 = (...args: any[]) => Digest.sha512(...args);
const DigestBLAKE3 = (...args: any[]) => Digest.blake3(...args);
const DigestHex = (...args: any[]) => Digest.hex(...args);
const DigestSHA256Hex = (...args: any[]) => Digest.sha256Hex(...args);
const DigestSHA512Hex = (...args: any[]) => Digest.sha512Hex(...args);
const DigestBLAKE3Hex = (...args: any[]) => Digest.blake3Hex(...args);

// Sign variants
const SignSecp256k1 = (digest: any, privateKey: any) => Sign.secp256k1(digest, privateKey);
const SignP256 = (digest: any, privateKey: any) => Sign.p256(digest, privateKey);
const SignEd25519 = (digest: any, privateKey: any) => Sign.ed25519(digest, privateKey);
const SignSecp256k1Hex = (digest: any, privateKey: any) => Sign.secp256k1(digest, privateKey, { format: 'hex' });
const SignP256Hex = (digest: any, privateKey: any) => Sign.p256(digest, privateKey, { format: 'hex' });
const SignEd25519Hex = (digest: any, privateKey: any) => Sign.ed25519(digest, privateKey, { format: 'hex' });

// SignatureValid variants
const SignatureValidSecp256k1 = (digest: any, signature: any, publicKey: any) =>
  SignatureValid.secp256k1(digest, signature, publicKey);
const SignatureValidP256 = (digest: any, signature: any, publicKey: any) =>
  SignatureValid.p256(digest, signature, publicKey);
const SignatureValidEd25519 = (digest: any, signature: any, publicKey: any) =>
  SignatureValid.ed25519(digest, signature, publicKey);

// Key generation functions for SQL
const GeneratePrivateKey = (curve: string = 'secp256k1') => {
  const key = Sign.generatePrivateKey(curve as any);
  return Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
};

const GeneratePrivateKeySecp256k1 = () => GeneratePrivateKey('secp256k1');
const GeneratePrivateKeyP256 = () => GeneratePrivateKey('p256');
const GeneratePrivateKeyEd25519 = () => GeneratePrivateKey('ed25519');

const GetPublicKey = (privateKey: any, curve: string = 'secp256k1') => {
  const key = Sign.getPublicKey(privateKey, curve as any);
  return Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
};

const GetPublicKeySecp256k1 = (privateKey: any) => GetPublicKey(privateKey, 'secp256k1');
const GetPublicKeyP256 = (privateKey: any) => GetPublicKey(privateKey, 'p256');
const GetPublicKeyEd25519 = (privateKey: any) => GetPublicKey(privateKey, 'ed25519');

/**
 * All crypto functions available for registration with Quereus
 */
export const cryptoFunctions = {
  // Main functions
  Digest,
  Sign,
  SignatureValid,

  // Digest variants
  DigestSHA256,
  DigestSHA512,
  DigestBLAKE3,
  DigestHex,
  DigestSHA256Hex,
  DigestSHA512Hex,
  DigestBLAKE3Hex,

  // Sign variants
  SignSecp256k1,
  SignP256,
  SignEd25519,
  SignSecp256k1Hex,
  SignP256Hex,
  SignEd25519Hex,

  // Verify variants
  SignatureValidSecp256k1,
  SignatureValidP256,
  SignatureValidEd25519,

  // Key generation
  GeneratePrivateKey,
  GeneratePrivateKeySecp256k1,
  GeneratePrivateKeyP256,
  GeneratePrivateKeyEd25519,
  GetPublicKey,
  GetPublicKeySecp256k1,
  GetPublicKeyP256,
  GetPublicKeyEd25519,
} as const;

/**
 * Function registration metadata for Quereus
 */
export const functionRegistrations = [
  // Main functions
  {
    name: 'Digest',
    func: Digest,
    description: 'Computes SHA-256 hash of all arguments (default algorithm)',
    examples: [
      "SELECT Digest('hello', 'world') as hash",
      "SELECT Digest('user', 123, 'session') as combined_hash",
    ],
  },
  {
    name: 'Sign',
    func: Sign,
    description: 'Creates ECC signature using secp256k1 (default curve)',
    examples: [
      "SELECT Sign(digest, private_key) as signature",
    ],
  },
  {
    name: 'SignatureValid',
    func: SignatureValid,
    description: 'Verifies ECC signature using secp256k1 (default curve)',
    examples: [
      "SELECT SignatureValid(digest, signature, public_key) as is_valid",
    ],
  },

  // Digest algorithm variants
  {
    name: 'DigestSHA256',
    func: DigestSHA256,
    description: 'Computes SHA-256 hash of all arguments',
    examples: ["SELECT DigestSHA256('hello', 'world') as sha256_hash"],
  },
  {
    name: 'DigestSHA512',
    func: DigestSHA512,
    description: 'Computes SHA-512 hash of all arguments',
    examples: ["SELECT DigestSHA512('hello', 'world') as sha512_hash"],
  },
  {
    name: 'DigestBLAKE3',
    func: DigestBLAKE3,
    description: 'Computes BLAKE3 hash of all arguments',
    examples: ["SELECT DigestBLAKE3('hello', 'world') as blake3_hash"],
  },
  {
    name: 'DigestHex',
    func: DigestHex,
    description: 'Computes SHA-256 hash and returns as hex string',
    examples: ["SELECT DigestHex('hello', 'world') as hex_hash"],
  },
  {
    name: 'DigestSHA256Hex',
    func: DigestSHA256Hex,
    description: 'Computes SHA-256 hash and returns as hex string',
    examples: ["SELECT DigestSHA256Hex('data') as sha256_hex"],
  },
  {
    name: 'DigestSHA512Hex',
    func: DigestSHA512Hex,
    description: 'Computes SHA-512 hash and returns as hex string',
    examples: ["SELECT DigestSHA512Hex('data') as sha512_hex"],
  },
  {
    name: 'DigestBLAKE3Hex',
    func: DigestBLAKE3Hex,
    description: 'Computes BLAKE3 hash and returns as hex string',
    examples: ["SELECT DigestBLAKE3Hex('data') as blake3_hex"],
  },

  // Sign curve variants
  {
    name: 'SignSecp256k1',
    func: SignSecp256k1,
    description: 'Creates signature using secp256k1 curve (Bitcoin/Ethereum)',
    examples: ["SELECT SignSecp256k1(digest, private_key) as secp256k1_sig"],
  },
  {
    name: 'SignP256',
    func: SignP256,
    description: 'Creates signature using P-256 curve (NIST)',
    examples: ["SELECT SignP256(digest, private_key) as p256_sig"],
  },
  {
    name: 'SignEd25519',
    func: SignEd25519,
    description: 'Creates signature using Ed25519 curve',
    examples: ["SELECT SignEd25519(digest, private_key) as ed25519_sig"],
  },
  {
    name: 'SignSecp256k1Hex',
    func: SignSecp256k1Hex,
    description: 'Creates secp256k1 signature and returns as hex string',
    examples: ["SELECT SignSecp256k1Hex(digest, private_key) as hex_sig"],
  },
  {
    name: 'SignP256Hex',
    func: SignP256Hex,
    description: 'Creates P-256 signature and returns as hex string',
    examples: ["SELECT SignP256Hex(digest, private_key) as hex_sig"],
  },
  {
    name: 'SignEd25519Hex',
    func: SignEd25519Hex,
    description: 'Creates Ed25519 signature and returns as hex string',
    examples: ["SELECT SignEd25519Hex(digest, private_key) as hex_sig"],
  },

  // Verify curve variants
  {
    name: 'SignatureValidSecp256k1',
    func: SignatureValidSecp256k1,
    description: 'Verifies signature using secp256k1 curve',
    examples: ["SELECT SignatureValidSecp256k1(digest, sig, pubkey) as valid"],
  },
  {
    name: 'SignatureValidP256',
    func: SignatureValidP256,
    description: 'Verifies signature using P-256 curve',
    examples: ["SELECT SignatureValidP256(digest, sig, pubkey) as valid"],
  },
  {
    name: 'SignatureValidEd25519',
    func: SignatureValidEd25519,
    description: 'Verifies signature using Ed25519 curve',
    examples: ["SELECT SignatureValidEd25519(digest, sig, pubkey) as valid"],
  },

  // Key generation functions
  {
    name: 'GeneratePrivateKey',
    func: GeneratePrivateKey,
    description: 'Generates a random private key (secp256k1 default)',
    examples: ["SELECT GeneratePrivateKey() as private_key"],
  },
  {
    name: 'GeneratePrivateKeySecp256k1',
    func: GeneratePrivateKeySecp256k1,
    description: 'Generates a random secp256k1 private key',
    examples: ["SELECT GeneratePrivateKeySecp256k1() as secp256k1_key"],
  },
  {
    name: 'GeneratePrivateKeyP256',
    func: GeneratePrivateKeyP256,
    description: 'Generates a random P-256 private key',
    examples: ["SELECT GeneratePrivateKeyP256() as p256_key"],
  },
  {
    name: 'GeneratePrivateKeyEd25519',
    func: GeneratePrivateKeyEd25519,
    description: 'Generates a random Ed25519 private key',
    examples: ["SELECT GeneratePrivateKeyEd25519() as ed25519_key"],
  },
  {
    name: 'GetPublicKey',
    func: GetPublicKey,
    description: 'Derives public key from private key (secp256k1 default)',
    examples: ["SELECT GetPublicKey(private_key) as public_key"],
  },
  {
    name: 'GetPublicKeySecp256k1',
    func: GetPublicKeySecp256k1,
    description: 'Derives secp256k1 public key from private key',
    examples: ["SELECT GetPublicKeySecp256k1(private_key) as secp256k1_pubkey"],
  },
  {
    name: 'GetPublicKeyP256',
    func: GetPublicKeyP256,
    description: 'Derives P-256 public key from private key',
    examples: ["SELECT GetPublicKeyP256(private_key) as p256_pubkey"],
  },
  {
    name: 'GetPublicKeyEd25519',
    func: GetPublicKeyEd25519,
    description: 'Derives Ed25519 public key from private key',
    examples: ["SELECT GetPublicKeyEd25519(private_key) as ed25519_pubkey"],
  },
] as const;
