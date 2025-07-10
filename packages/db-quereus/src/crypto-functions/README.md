# Crypto Functions for Quereus

This module provides portable cryptographic functions for the @optimystic/db-quereus plugin. All functions are built using @noble/curves and @noble/hashes for maximum compatibility across JavaScript environments including React Native.

## Functions

### Digest(...args)

Computes the hash of all arguments combined using SHA-256 (default) or other algorithms.

**Examples:**
```sql
-- Hash a string
SELECT Digest('hello world') as hash;

-- Hash multiple arguments
SELECT Digest('user:', 123, 'session') as combined_hash;

-- Different algorithms (if plugin supports options)
SELECT Digest('data', 'sha512') as sha512_hash;
```

**JavaScript Usage:**
```typescript
import { Digest } from '@optimystic/db-quereus';

// Basic usage
const hash1 = Digest('hello', 'world');

// With options
const hash2 = Digest.sha512('data1', 'data2');
const hexHash = Digest.hex('hello');
```

### Sign(digest, privateKey, [options])

Returns the ECC signature for a digest using a private key. Supports secp256k1, P-256, and Ed25519 curves.

**Examples:**
```sql
-- Basic signing with secp256k1
SELECT Sign(digest, private_key) as signature;

-- With specific curve (if plugin supports)
SELECT Sign(digest, private_key, 'p256') as p256_signature;
```

**JavaScript Usage:**
```typescript
import { Sign } from '@optimystic/db-quereus';

const digest = new Uint8Array(32).fill(1);
const privateKey = 'a'.repeat(64); // hex string

// Basic usage
const signature = Sign(digest, privateKey);

// With options
const hedgedSig = Sign(digest, privateKey, { 
  extraEntropy: true,
  curve: 'p256',
  format: 'hex'
});

// Generate keys
const privKey = Sign.generatePrivateKey('secp256k1');
const pubKey = Sign.getPublicKey(privKey);
```

### SignatureValid(digest, signature, publicKey, [options])

Returns true if the ECC signature is valid for the given digest and public key.

**Examples:**
```sql
-- Basic verification
SELECT SignatureValid(digest, signature, public_key) as is_valid;

-- With specific curve
SELECT SignatureValid(digest, signature, public_key, 'ed25519') as ed25519_valid;
```

**JavaScript Usage:**
```typescript
import { SignatureValid } from '@optimystic/db-quereus';

const isValid = SignatureValid(digest, signature, publicKey);

// With options
const isValid2 = SignatureValid(digest, signature, publicKey, {
  curve: 'p256',
  allowMalleableSignatures: false
});

// Batch verification
const results = SignatureValid.batch([
  { digest: d1, signature: s1, publicKey: pk1 },
  { digest: d2, signature: s2, publicKey: pk2 }
]);
```

## Supported Curves

- **secp256k1**: Bitcoin/Ethereum curve (default)
- **P-256 (secp256r1)**: NIST curve
- **Ed25519**: Edwards curve for EdDSA

## Input Formats

All functions accept inputs as:
- `Uint8Array` - Binary data
- `string` - Hex-encoded strings
- For Digest: also `number`, `boolean`, `null`, `undefined`

## Output Formats

- **Digest**: Returns `Uint8Array` by default, hex string with `.hex` variants
- **Sign**: Returns `Uint8Array` by default, configurable via options
- **SignatureValid**: Returns `boolean`

## React Native Compatibility

These functions are fully compatible with React Native and don't require any native modules. They use:

- `@noble/curves` for elliptic curve operations
- `@noble/hashes` for hashing
- `crypto.getRandomValues()` for secure randomness

## Security Notes

- All cryptographic operations use audited libraries (@noble/*)
- Private keys should be handled securely
- Random number generation uses platform CSPRNG
- Signatures use deterministic k-generation (RFC 6979) by default
- Support for hedged signatures for additional fault attack protection

## Performance

The functions are optimized for JavaScript environments:

- Digest: ~100K ops/sec for small inputs
- Sign: ~1-10K ops/sec depending on curve
- SignatureValid: ~1-5K ops/sec depending on curve

Performance may vary significantly across platforms and input sizes. 
