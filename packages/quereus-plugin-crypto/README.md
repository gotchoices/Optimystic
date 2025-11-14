# @optimystic/quereus-plugin-crypto

Quereus plugin providing cryptographic functions for SQL queries with base64url encoding by default.

## Features

- **Hash Functions**: SHA-256, SHA-512, BLAKE3 hashing with base64url output
- **Hash Modulo**: Fixed-size hash values (16-bit, 32-bit, etc.) for sharding and partitioning
- **Random Bytes**: Generate cryptographically secure random bytes (default: 256 bits)
- **Signature Functions**: secp256k1, P-256, Ed25519 signing with base64url encoding
- **Verification Functions**: Signature verification for all supported curves
- **Key Generation**: Generate and derive cryptographic keys
- **Multiple Encodings**: Support for base64url, base64, hex, utf8, and raw bytes

## Installation

```bash
npm install @optimystic/quereus-plugin-crypto
```

## Usage

### As a Quereus Plugin

```typescript
import { Database } from '@quereus/quereus';
import { loadPlugin } from '@quereus/quereus/util/plugin-loader.js';

const db = new Database();
await loadPlugin('npm:@optimystic/quereus-plugin-crypto', db);
```

### Direct Import (for JavaScript/TypeScript code)

All cryptographic functions are also exported directly so you can use the same implementations in your JavaScript code:

```typescript
import {
  digest,
  hashMod,
  randomBytes,
  sign,
  verify,
  generatePrivateKey,
  getPublicKey
} from '@optimystic/quereus-plugin-crypto';

// Hash data (base64url by default)
const hash = digest('hello world', 'sha256', 'utf8', 'base64url');

// Get a 16-bit hash for sharding
const shard = hashMod('user@example.com', 16, 'sha256', 'utf8');

// Generate random bytes (256 bits by default)
const nonce = randomBytes(256, 'base64url');
const salt = randomBytes(128, 'hex');

// Generate keys
const privateKey = generatePrivateKey('secp256k1', 'base64url');
const publicKey = getPublicKey(privateKey, 'secp256k1', 'base64url', 'base64url');

// Sign and verify
const signature = sign(hash, privateKey, 'secp256k1', 'base64url', 'base64url', 'base64url');
const isValid = verify(hash, signature, publicKey, 'secp256k1', 'base64url', 'base64url', 'base64url');
```

## SQL Functions

All SQL functions use **base64url encoding by default** for inputs and outputs. This is URL-safe and SQL-friendly.

### digest(data, algorithm?, inputEncoding?, outputEncoding?)

Hash data using SHA-256 (default), SHA-512, or BLAKE3.

```sql
-- Hash base64url data (default)
SELECT digest('aGVsbG8gd29ybGQ') as hash;

-- Hash UTF-8 text
SELECT digest('hello world', 'sha256', 'utf8', 'base64url') as hash;

-- Hash with SHA-512
SELECT digest('data', 'sha512', 'utf8', 'base64url') as sha512_hash;

-- Hash with BLAKE3, output as hex
SELECT digest('data', 'blake3', 'utf8', 'hex') as blake3_hex;
```

### hash_mod(data, bits, algorithm?, inputEncoding?)

Hash data and return modulo 2^bits for fixed-size hash values.

```sql
-- Get 16-bit hash (0-65535) for sharding
SELECT hash_mod('user@example.com', 16, 'sha256', 'utf8') as shard_id;

-- Get 32-bit hash
SELECT hash_mod('session_token', 32, 'sha256', 'utf8') as hash32;

-- Use with base64url input
SELECT hash_mod('aGVsbG8', 16) as hash16;
```

### random_bytes(bits?, encoding?)

Generate cryptographically secure random bytes.

```sql
-- Generate 256 bits (32 bytes) of random data (default)
SELECT random_bytes() as nonce;

-- Generate 128 bits as hex
SELECT random_bytes(128, 'hex') as salt;

-- Generate 512 bits as base64url
SELECT random_bytes(512, 'base64url') as token;

-- Generate 64 bits for a random ID
SELECT random_bytes(64) as random_id;
```

### sign(data, privateKey, curve?, inputEncoding?, keyEncoding?, outputEncoding?)

Sign data using secp256k1 (default), P-256, or Ed25519.

```sql
-- Sign with secp256k1 (Bitcoin/Ethereum)
SELECT sign('aGVsbG8', 'cHJpdmF0ZUtleQ') as signature;

-- Sign UTF-8 text
SELECT sign('hello', 'cHJpdmF0ZUtleQ', 'secp256k1', 'utf8') as signature;

-- Sign with P-256 (NIST)
SELECT sign('data', 'cHJpdmF0ZUtleQ', 'p256', 'utf8') as p256_sig;

-- Sign with Ed25519
SELECT sign('message', 'cHJpdmF0ZUtleQ', 'ed25519', 'utf8') as ed25519_sig;
```

### verify(data, signature, publicKey, curve?, inputEncoding?, sigEncoding?, keyEncoding?)

Verify signatures. Returns true for valid, false for invalid.

```sql
-- Verify secp256k1 signature
SELECT verify('aGVsbG8', 'c2lnbmF0dXJl', 'cHVibGljS2V5') as is_valid;

-- Verify UTF-8 text signature
SELECT verify('hello', 'c2lnbmF0dXJl', 'cHVibGljS2V5', 'secp256k1', 'utf8') as is_valid;

-- Verify P-256 signature
SELECT verify('data', 'c2lnbmF0dXJl', 'cHVibGljS2V5', 'p256', 'utf8') as is_valid;
```

## Supported Algorithms

### Hash Algorithms
- `sha256` - SHA-256 (default) - 256-bit secure hash
- `sha512` - SHA-512 - 512-bit secure hash
- `blake3` - BLAKE3 - Fast, secure, parallel hash

### Elliptic Curves
- `secp256k1` - Bitcoin/Ethereum curve (default)
- `p256` - NIST P-256 curve (secp256r1)
- `ed25519` - Edwards curve for EdDSA

### Encoding Formats
- `base64url` - URL-safe base64 without padding (default)
- `base64` - Standard base64 encoding
- `hex` - Hexadecimal encoding
- `utf8` - UTF-8 text encoding
- `bytes` - Raw Uint8Array (JavaScript only)

## Why base64url?

Base64url is the default encoding because it's:
- **URL-safe**: No `+`, `/`, or `=` characters
- **SQL-friendly**: No special characters that need escaping
- **Compact**: More efficient than hex (33% smaller)
- **Standard**: Defined in RFC 4648

## Complete Example

```typescript
import { Database } from '@quereus/quereus';
import { loadPlugin } from '@quereus/quereus/util/plugin-loader.js';
import {
  digest,
  randomBytes,
  sign,
  verify,
  generatePrivateKey,
  getPublicKey
} from '@optimystic/quereus-plugin-crypto';

// Load plugin
const db = new Database();
await loadPlugin('npm:@optimystic/quereus-plugin-crypto', db);

// Use in SQL
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT,
    shard_id INTEGER AS (hash_mod(email, 16, 'sha256', 'utf8')),
    nonce TEXT DEFAULT (random_bytes(256))
  );

  INSERT INTO users (id, email) VALUES (1, 'alice@example.com');

  SELECT id, email, shard_id, nonce FROM users;
`);

// Use in JavaScript
const privateKey = generatePrivateKey('secp256k1', 'base64url');
const publicKey = getPublicKey(privateKey);

const message = 'Hello, World!';
const hash = digest(message, 'sha256', 'utf8', 'base64url');
const signature = sign(hash, privateKey);
const isValid = verify(hash, signature, publicKey);

console.log('Valid signature:', isValid); // true

// Generate random nonce
const nonce = randomBytes(256, 'base64url');
console.log('Random nonce:', nonce);
```

## JavaScript API Reference

### digest(data, algorithm?, inputEncoding?, outputEncoding?)
Hash data using SHA-256, SHA-512, or BLAKE3.
- **Returns**: Hash as string (or Uint8Array if encoding is 'bytes')

### hashMod(data, bits, algorithm?, inputEncoding?)
Hash data and return modulo 2^bits for fixed-size hash values.
- **Returns**: Number between 0 and 2^bits - 1

### randomBytes(bits?, encoding?)
Generate cryptographically secure random bytes.
- **Default**: 256 bits, base64url encoding
- **Returns**: Random bytes as string (or Uint8Array if encoding is 'bytes')

### sign(data, privateKey, curve?, inputEncoding?, keyEncoding?, outputEncoding?)
Sign data using ECC (secp256k1, P-256, or Ed25519).
- **Returns**: Signature as string (or Uint8Array if encoding is 'bytes')

### verify(data, signature, publicKey, curve?, inputEncoding?, sigEncoding?, keyEncoding?)
Verify an ECC signature.
- **Returns**: Boolean (true if valid, false if invalid)

### generatePrivateKey(curve?, encoding?)
Generate a random private key for the specified curve.
- **Returns**: Private key as string (or Uint8Array if encoding is 'bytes')

### getPublicKey(privateKey, curve?, keyEncoding?, outputEncoding?)
Derive the public key from a private key.
- **Returns**: Public key as string (or Uint8Array if encoding is 'bytes')

## Security Notes

- All cryptographic operations use audited libraries (@noble/*)
- Private keys should be handled securely and never exposed
- Random number generation uses platform CSPRNG (crypto.getRandomValues)
- Signatures use deterministic k-generation (RFC 6979)
- All algorithms provide industry-standard security levels

## React Native Compatibility

These functions are fully compatible with React Native and don't require any native modules. They use:
- `@noble/curves` for elliptic curve operations
- `@noble/hashes` for hashing
- `crypto.getRandomValues()` for secure randomness (polyfill required for React Native)

## License

MIT

