# Cryptographic Functions Reference

Technical reference for the `@optimystic/quereus-plugin-crypto` package. For usage examples and quick start, see the [README](../README.md).

## Architecture

The crypto plugin exposes cryptographic primitives in two ways:

1. **SQL functions** — registered via `plugin.ts` for use in Quereus queries
2. **JavaScript API** — exported from `index.ts` for direct use in application code

All implementations delegate to audited libraries ([`@noble/curves`](https://github.com/paulmillr/noble-curves), [`@noble/hashes`](https://github.com/paulmillr/noble-hashes)) with no custom cryptographic code.

### Legacy API

The original class-based API (`Digest`, `Sign`, `SignatureValid`) remains exported for backwards compatibility. New code should use the idiomatic lowercase function exports (`digest`, `sign`, `verify`, etc.).

---

## Hash Algorithms

| Algorithm | Output Size | Library | Notes |
|-----------|------------|---------|-------|
| `sha256` | 256 bits (32 bytes) | `@noble/hashes/sha2` | Default. NIST FIPS 180-4. |
| `sha512` | 512 bits (64 bytes) | `@noble/hashes/sha2` | NIST FIPS 180-4. |
| `blake3` | 256 bits (32 bytes) | `@noble/hashes/blake3` | Parallelizable, faster than SHA-2 on large inputs. |

All hash functions are deterministic and collision-resistant. They accept arbitrary-length input and produce fixed-length output.

### `hashMod` Bit Limits

`hashMod(data, bits)` returns an integer in `[0, 2^bits - 1]`. The `bits` parameter must be between 1 and 53 (JavaScript safe integer limit). The modulo is computed as `hash % 2^bits`, which is unbiased because `2^bits` divides evenly into the hash space.

---

## Elliptic Curves

| Curve | Algorithm | Key Size | Signature Size | Library |
|-------|-----------|----------|----------------|---------|
| `secp256k1` | ECDSA | 32 bytes private, 33/65 bytes public | 64 bytes (compact r\|\|s) | `@noble/curves/secp256k1` |
| `p256` | ECDSA | 32 bytes private, 33/65 bytes public | 64 bytes (compact r\|\|s) | `@noble/curves/p256` |
| `ed25519` | EdDSA | 32 bytes private, 32 bytes public | 64 bytes | `@noble/curves/ed25519` |

### Curve Selection Guide

- **secp256k1** (default): Bitcoin/Ethereum ecosystem. Use when interoperating with blockchain protocols.
- **p256** (NIST P-256): Web/TLS ecosystem. Use when NIST compliance is required.
- **ed25519**: Modern EdDSA. Fastest signing/verification, smallest keys, no malleability issues. Use when no specific ecosystem compatibility is needed.

### Signature Properties

- **ECDSA (secp256k1, p256)**: Deterministic k-generation per RFC 6979. Low-S canonical signatures by default to prevent malleability. Optional extra entropy for hedged signatures.
- **EdDSA (ed25519)**: Inherently deterministic. Does not support DER encoding (64-byte fixed format only).

### Signature Formats

| Format | Description | Supported Curves |
|--------|-------------|-----------------|
| `compact` | Raw r\|\|s concatenation (64 bytes) | All |
| `der` | ASN.1 DER encoding (70-72 bytes) | secp256k1, p256 |
| `uint8array` | Raw bytes | All |
| `hex` | Hex-encoded compact signature | All |

The `verify` function auto-detects signature format based on byte length and curve.

---

## Encoding Formats

| Encoding | Description | SQL Support | Expansion vs Raw |
|----------|-------------|-------------|-----------------|
| `base64url` | RFC 4648 URL-safe base64, no padding | Yes (default) | ~33% |
| `base64` | Standard base64 with `+`, `/`, `=` | Yes | ~33% |
| `hex` | Hexadecimal (0-9, a-f) | Yes | 100% |
| `utf8` | UTF-8 text interpretation | Yes (input only) | Variable |
| `bytes` | Raw `Uint8Array` | No (JS only) | 0% |

### Encoding Parameters by Function

| Function | Input Encoding | Output Encoding | Key Encoding | Sig Encoding |
|----------|---------------|-----------------|--------------|-------------- |
| `digest` | `inputEncoding` | `outputEncoding` | — | — |
| `hashMod` | `inputEncoding` | — (returns number) | — | — |
| `sign` | `inputEncoding` | `outputEncoding` | `keyEncoding` | — |
| `verify` | `inputEncoding` | — (returns boolean) | `keyEncoding` | `sigEncoding` |
| `randomBytes` | — | `encoding` | — | — |
| `generatePrivateKey` | — | `encoding` | — | — |
| `getPublicKey` | — | `outputEncoding` | `keyEncoding` | — |

All encoding parameters default to `base64url` unless otherwise specified.

---

## SQL Function Signatures

### `digest(data, algorithm?, inputEncoding?, outputEncoding?) → TEXT`

- **Deterministic**: Yes
- **Default algorithm**: `sha256`
- **Default encodings**: `base64url` in, `base64url` out

### `sign(data, privateKey, curve?, inputEncoding?, keyEncoding?, outputEncoding?) → TEXT`

- **Deterministic**: Yes (RFC 6979 deterministic k)
- **Default curve**: `secp256k1`
- **Default encodings**: all `base64url`

### `verify(data, signature, publicKey, curve?, inputEncoding?, sigEncoding?, keyEncoding?) → BOOLEAN`

- **Deterministic**: Yes
- **Returns**: `true` if valid, `false` for any error (prevents info leakage)
- **Default curve**: `secp256k1`

### `hash_mod(data, bits, algorithm?, inputEncoding?) → INTEGER`

- **Deterministic**: Yes
- **Returns**: Integer in `[0, 2^bits - 1]`
- **Bits range**: 1-53 (JavaScript safe integer)

### `random_bytes(bits?, encoding?) → TEXT`

- **Deterministic**: No (uses CSPRNG)
- **Default bits**: 256
- **Default encoding**: `base64url`

---

## Security Properties

| Property | Implementation |
|----------|---------------|
| Constant-time operations | Delegated to `@noble/curves` internals |
| Side-channel resistance | `@noble/curves` designed for side-channel safety |
| CSPRNG | `crypto.getRandomValues()` (platform) |
| Signature malleability | Low-S enforcement for ECDSA by default |
| Error information leakage | `verify()` returns `false` for all errors |
| Deterministic signatures | RFC 6979 for ECDSA, inherent for EdDSA |

### Usage in Optimystic

- **Transaction hashing**: SHA-256 via `multiformats/hashes/sha2` (not this plugin)
- **Schema hashing**: SHA-256 (first 16 bytes, base64url) in `quereus-engine.ts`
- **Cluster consensus**: `SignatureValid` from this plugin (see [signature-verification-implementation.md](../../../tasks/refactoring/signature-verification-implementation.md) for integration status)

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@noble/curves` | ^2.0.1 | ECC: secp256k1, P-256, Ed25519 |
| `@noble/hashes` | ^2.0.1 | SHA-256, SHA-512, BLAKE3 |
| `uint8arrays` | ^5.1.0 | Encoding conversion utilities |

No native modules required. Compatible with Node.js, browsers, and React Native (with `crypto.getRandomValues` polyfill).
