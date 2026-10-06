description: The SQL crypto functions (digest, sign, verify) always use pure-JavaScript hashing and signatures, so a phone that already has fast native crypto cannot use it for them. Add a small synchronous hook an app can set to route these to a native implementation, defaulting to the current one.
files: packages/quereus-plugin-crypto/src/crypto.ts, packages/quereus-plugin-crypto/src/cid.ts, packages/quereus-plugin-crypto/README.md
----

# quereus-plugin-crypto: allow a native crypto backend

GitHub: [#30](https://github.com/gotchoices/Optimystic/issues/30). The reporter offers a PR once the shape is agreed.

## Verified in code

`packages/quereus-plugin-crypto/src/crypto.ts` imports `@noble/hashes` (sha256, sha512, blake3) and `@noble/curves` (ed25519, secp256k1, p256) directly. The `HASHERS` table maps algorithm to noble hasher, and `sign`/`verify` call noble's curves. `cid.ts` uses the noble hashers too. There is no seam.

## Measurement (taleus on a Galaxy S7, Sereus 1.12 / Optimystic 1.10.1, Hermes CPU profile)

One tally invitation took 29 s end to end. SQL `verify` was 408 ms inclusive, noble `ed25519.verify` 366 ms of it; every noble Ed25519 frame came through this plugin (libp2p's Ed25519 was already native through quick-crypto's WebCrypto). Digests use noble SHA-256 even after the kit routes `crypto.subtle.digest` to native, because the plugin never touches `crypto.subtle`. The cost scales with signed rows read.

## Proposed shape (reporter's)

```ts
export interface CryptoBackend {
	sha256?(data: Uint8Array): Uint8Array;
	sha512?(data: Uint8Array): Uint8Array;
	ed25519Verify?(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean;
	ed25519Sign?(msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
}
export function setCryptoBackend(backend: CryptoBackend): void;
```

It must be synchronous, since the SQL functions are. `HASHERS` and the ed25519 branches consult it first.

Open for planning: a process-global setter versus a per-registration plugin option (the `feat-an-app-can-supply-noise-crypto` precedent injects per node); whether `cid.ts` uses it; a test that a supplied backend gives byte-identical results to noble. The reporter has not yet confirmed that quick-crypto's synchronous Ed25519 accepts raw 32-byte keys.
