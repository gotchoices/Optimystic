# @optimystic/quereus-plugin-crypto

Quereus plugin providing cryptographic functions for SQL queries with base64url encoding by default.

## Features

- **Hash Functions**: SHA-256, SHA-512, BLAKE3 hashing with base64url output
- **Content Identifiers (CIDv1)**: Self-describing, interoperable IPFS/IPLD content addresses
- **Selective Disclosure**: Salted-leaf set commitment — commit to a whole attribute set with one value, later reveal only a chosen subset with proof of authenticity
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

// Or configure the digest algorithm / output encoding once, at load time
// (see "Digest configuration" below):
await loadPlugin('npm:@optimystic/quereus-plugin-crypto', db, {
  algorithm: 'sha256',     // 'sha256' (default) | 'sha512' | 'blake3'
  encoding: 'base64url',   // 'base64url' (default) | 'base64' | 'hex'
});
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

// Hash an ordered tuple of fields (injective — distinct tuples never collide)
const hash = digest(['hello world', 42, null], 'sha256', 'base64url');

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

### digest(field1, field2, ..., fieldN)

Hash an **ordered tuple of fields** into a single digest. `digest` is variadic over
*data* — every argument is a field, not a configuration option. The algorithm and
output encoding are chosen once, at load time (see [Digest configuration](#digest-configuration)),
so they never have to be passed per call.

```sql
-- Hash a single value
SELECT digest(Id) as hash;

-- Hash a tuple of columns — distinct tuples never collide,
-- NULL is distinguished from '', and 123 from '123'
SELECT digest(Tid, Name, ImageRef, NumberRequiredTSAs) as commitment;
```

**Why variadic + injective?** Hashing several fields by joining them
(`a || '|' || b`) or by `String()`-concatenation is not injective: `('a|b','c')`
collides with `('a','b|c')`, `NULL` collides with `''`, and `123` collides with
`'123'`. `digest` instead applies a canonical, length-prefixed, type-tagged framing
to each field, so distinct tuples always produce distinct digests. This matters when
the digest is signed or persisted as a commitment.

The framing is also why `digest(x)` is **not** a bare `sha256(x)` — it is a framed
digest of a one-element tuple. For sharding a single value, use `hash_mod`.

### cid(data, codec?, hash?, base?) / cid_v1(digest, hash, codec?, base?) / cid_decode(cid)

`digest` returns a **bare** hash — raw digest bytes in some text encoding, with no
record of which base, content type, or hash algorithm produced it. `cid` instead
produces a **self-describing CIDv1**, the same interoperable content address an
IPFS/IPLD store computes for the same bytes:

```
CIDv1     = multibase( version ‖ multicodec(content-type) ‖ multihash )
multihash = hashFnCode ‖ digestLength ‖ digestBytes
```

Because the multibase, content codec, and hash code all travel *inside* the value,
a consumer can validate it without out-of-band knowledge, and an algorithm
migration (e.g. sha2-256 → another hash) is unambiguous rather than a silent
reinterpretation. The framing comes entirely from the audited
[`multiformats`](https://github.com/multiformats/js-multiformats) library.

```sql
-- Hash a blob and frame it as the canonical raw/sha2-256/base32 CID
-- (== the CID IPFS shows for the same bytes)
SELECT cid(SomeBlob) AS Cid;

-- Pick content codec / hash / base
SELECT cid(SomeBlob, 'dag-cbor', 'sha2-512', 'base58btc') AS Cid;

-- A self-describing content address over a field tuple: digest() canonically
-- frames + hashes the fields; cid_v1() wraps that exact digest as a CIDv1
-- (no double-hash). The asserted hash must match digest()'s configured algorithm.
SELECT cid_v1(digest(ColA, ColB, ColC), 'sha2-256') AS Cid;

-- Validate / inspect a stored CID (returns JSON: { version, codec, hashCode, digest })
SELECT cid_decode(Cid) ->> 'codec' AS codec FROM T;
```

- **`cid(data, codec?, hash?, base?)`** — hash `data` then frame. `data` is a BLOB,
  or a base64url-encoded TEXT digest/blob (the plugin's canonical text encoding).
  Defaults: `codec='raw'`, `hash='sha2-256'`, `base='base32'`.
- **`cid_v1(digest, hash, codec?, base?)`** — wrap an **already-computed** digest
  without re-hashing. `hash` is required and asserts which algorithm produced the
  digest; the digest length is checked against it (sha2-256/blake3 = 32 bytes,
  sha2-512 = 64) and a mismatch is rejected.
- **`cid_decode(cid) → JSON`** — parse a CID back to `{ version, codec, hashCode,
  digest }` (digest as base64url). Throws cleanly on malformed input.

Selectable values: `codec` ∈ `raw`, `dag-cbor`; `hash` ∈ `sha2-256`, `sha2-512`,
`blake3`; `base` ∈ `base32` (default), `base58btc`, `base64url`, `base16`.

**Why `base32` by default?** A CID's whole purpose is to match what an external
content-addressed store computes, and IPFS renders CIDv1 canonically in base32 (the
`b…` prefix). This is deliberately different from the plugin's `digest`/`random_bytes`
default of base64url: base64url is compact for *internal* values that live in memory,
on the wire, or in JSON, whereas base32 is case-insensitive and DNS/URL/filename-safe
where interoperable addresses are copied and read. Two audiences, two defaults — pass
`'base64url'` explicitly if you want the compact form.

### set_commit(leaves_json) / set_verify(root, disclosed_json, hidden_json)

**Per-attribute selective disclosure.** An authority commits to a registrant's whole
attribute set as a single root (which it signs / persists), then later reveals only a
chosen *subset* to a recipient — with a proof the revealed values are genuinely the
committed ones — **without** leaking the withheld attribute values. A flat
`digest(whole set)` can't do this (verifying one field needs the whole pre-image, so
it's all-or-nothing); `set_commit` supports *partial opening*.

Each attribute becomes a salted leaf, and the root is the digest of all leaf digests in
canonical (sort-by-leaf-digest-bytes) order:

```
leafDigest = digest([SD_LEAF_DOMAIN_V1, name, value, salt])   -- raw digest bytes
root       = digest([SD_SET_DOMAIN_V1, sortedLeaf_0, sortedLeaf_1, ...])
```

This is the same flat salted-hash shape the IETF SD-JWT standard
(`draft-ietf-oauth-selective-disclosure-jwt`) settled on rather than a Merkle tree —
cited as conceptual precedent only; the framing here is Optimystic's own `digest`
`encodeFields` (not SD-JWT wire-compatible). The `name` is hashed into the leaf so a
`(value, salt)` proof can't be replayed under another attribute; the `salt` is per-leaf
and **mandatory** (low-entropy values like a DOB or a boolean are brute-forceable from a
bare hash, and independent salts defeat cross-registrant correlation).

```sql
-- Commit to a JSON array of [name, value, salt] leaves -> single root.
-- Pair with cid() for the self-describing persisted/signed column representation:
SELECT cid(set_commit(SelectiveDetails)) AS SelectiveCid;

-- A schema CHECK makes a forged root impossible to store: the root is recomputed from
-- the stored attribute triples, so SelectiveCid must equal the genuine commitment.
CREATE TABLE Registrant (
  ...,
  SelectiveDetails TEXT,   -- JSON array of [name, value, salt] triples
  SelectiveCid     TEXT,
  CHECK (SelectiveCid = cid(set_commit(SelectiveDetails)))
);

-- A recipient verifies a disclosure: the disclosed [name, value, salt] triples plus
-- the opaque leaf digests of the withheld leaves reconstruct the entire root.
SELECT set_verify(root, disclosed_json, hidden_json) AS ok;
```

- **`set_commit(leaves_json) → TEXT`** — `leaves_json` is a JSON array; each element is a
  leaf `[name, value, salt]` *or* `{ "name", "value", "salt" }`. Values follow `digest`'s
  rules as parsed from JSON (INTEGER vs REAL by JS value, TEXT, BOOL, null, nested
  object/array). Each leaf must carry all three fields — a missing `value` (object form) or
  a `[name, value]` array (under three elements) throws; pass `value: null` for a null-valued
  attribute. The salt is base64url TEXT (e.g. from `random_bytes`). **THROWS** on a duplicate
  name, a missing value, a missing/empty salt, or unparseable/non-array JSON (invalid states
  made impossible). `replicable` — the root is signed and persisted, same bar as `digest`.
- **`set_verify(root, disclosed_json, hidden_json) → BOOLEAN`** — `disclosed_json` is the
  opened triples (same leaf shape), `hidden_json` a JSON array of the withheld leaves'
  opaque base64url digests. Reconstructs the **entire** root and compares — so the holder
  cannot add, drop, or swap a leaf. Returns `false` on any mismatch or malformed input
  (forgiving, like `verify`).

> **Disclosure generation is JS-only** (`setDisclose`, below) — there's no SQL
> `set_disclose`, because building a disclosure requires the full attribute set including
> the secret salts, which lives engine-side, not in a query.

**BLOB-valued attributes via SQL:** JSON has no blob type, so a blob attribute passed
through `set_commit` is committed as its base64url TEXT. Callers needing a *true* BLOB
value (committed as a BLOB field, `TAG_BLOB`) must use the JS `setCommit` with a
`Uint8Array` value.

**Privacy note:** a fixed commitment disclosed to two audiences exposes the same hidden
digests and field count to both, so they can correlate that it's the same record.
Re-randomizing per disclosure would require fresh salts → a new root → a new signature
(out of scope here).

**Framing coupling:** leaf and root reuse `digest`'s `encodeFields`, so a future digest
framing-version bump changes `set_commit` output too — intentional (one canonical
framing), but it means the pinned set-commitment vectors move with the digest vectors.

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

## Digest configuration

Because `digest` is variadic over data, its **algorithm** and **output encoding** are
not call arguments — they are bound once when the plugin is loaded, via the plugin
config object:

```ts
import { registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';

await registerPlugin(db, cryptoPlugin, {
  algorithm: 'sha256',   // 'sha256' (default) | 'sha512' | 'blake3'
  encoding: 'base64url', // 'base64url' (default) | 'base64' | 'hex'
});
```

An unknown `algorithm` or a non-text `encoding` throws at registration (fail fast),
and the algorithm/encoding are resolved once so the per-call path does no branching.

**Why load-time and not per-connection?** The SQL `digest` is registered as
`replicable` — its output must be bit-identical across peers, platforms, and app
versions, because these digests are signed and persisted as commitments. That holds
only if the configuration is fixed for every peer. *Mutable* per-connection
configuration (e.g. a runtime `SET`/PRAGMA) would let two peers disagree and silently
break signature validation, so it is intentionally not offered for this function. If a
single database genuinely needs two digest configurations, register the plugin twice
(or expose named variants) rather than flipping mutable session state.

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
const hash = digest([message], 'sha256', 'base64url') as string;
const signature = sign(hash, privateKey);
const isValid = verify(hash, signature, publicKey);

console.log('Valid signature:', isValid); // true

// Generate random nonce
const nonce = randomBytes(256, 'base64url');
console.log('Random nonce:', nonce);
```

## JavaScript API Reference

### digest(fields, algorithm?, encoding?)
Injective digest over an ordered tuple of fields. `fields` is an array of values
(any SQL value type). `algorithm` defaults to `'sha256'`, `encoding` to `'base64url'`.
- **Returns**: Hash as string (or Uint8Array if encoding is `'bytes'`)
- **Related**: `encodeFields(fields)` returns the canonical pre-hash byte framing;
  `digestFields(fields, hasher, encode)` / `resolveHasher` / `resolveOutputEncoder`
  are the building blocks the SQL function composes (resolve once, no per-call branching).

### cid(data, codec?, hash?, base?)
Hash `data` (a `Uint8Array`) and frame it as a self-describing CIDv1 string. Defaults:
`codec='raw'`, `hash='sha2-256'`, `base='base32'`. Byte-identical to the CID an IPFS/IPLD
store computes for the same bytes.
- **Returns**: CIDv1 string

### cidV1(digest, hash, codec?, base?)
Frame an **already-computed** `digest` (a `Uint8Array`) as a CIDv1 without re-hashing.
`hash` asserts which algorithm produced the digest; the digest length is validated
against it. Use to turn a `digest(...)` result into a CID: `cidV1(digest(fields, 'sha256', 'bytes'), 'sha2-256')`.
- **Returns**: CIDv1 string

### cidDecode(cid)
Parse a CID string into `{ version, codec, hashCode, digest }` for validation/migration.
Recognized codec/hash codes are returned as names, otherwise as numbers; `digest` is a
`Uint8Array`. Throws on malformed input.
- **Returns**: `{ version: number, codec: Multicodec | number, hashCode: MultihashCode | number, digest: Uint8Array }`

### setCommit(leaves, hasher?, encode?) / setDisclose(leaves, revealNames, hasher?) / setVerify(root, disclosure, hasher?, encode?)
Salted-leaf set commitment for selective disclosure. `leaves` is an array of
`{ name, value, salt }` (`salt` a base64url string or `Uint8Array`).
- **`setCommit`** → the root (`string`, or `Uint8Array` with a bytes encoder). Throws on a
  duplicate name or a missing/empty salt; the empty set is well-defined, not an error.
- **`setDisclose`** → `{ disclosed, hidden }`: the revealed `{ name, value, salt }` triples
  plus the opaque base64url leaf digests of the withheld leaves (withheld values/salts never
  appear). This is the engine-side generator with no SQL equivalent.
- **`setVerify`** → `boolean`: reconstructs the entire root from `disclosure` and compares to
  `root`. `false` on mismatch or malformed input. `encode` is how the signed root is rendered
  (default base64url); a `Uint8Array` root is compared by raw bytes.
- **`leafDigest(leaf, hasher)`** → raw leaf digest bytes (the low-level building block).

```typescript
import { setCommit, setDisclose, setVerify, randomBytes } from '@optimystic/quereus-plugin-crypto';

const leaves = [
  { name: 'name',    value: 'Alice',     salt: randomBytes(256) as string },
  { name: 'over18',  value: true,        salt: randomBytes(256) as string },
  { name: 'zip',     value: '90210',     salt: randomBytes(256) as string },
];
const root = setCommit(leaves);                 // sign / persist this (often as cid(root))

// Recipient gets only `over18`, with proof it belongs to the committed set:
const disclosure = setDisclose(leaves, ['over18']);
const ok = setVerify(root, disclosure);          // true — withheld values never left the engine
```

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

