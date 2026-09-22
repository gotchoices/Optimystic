description: An embedding app cannot choose the crypto Noise uses for connection encryption, so React Native always runs the pure-JS implementation (Metro honours @chainsafe/libp2p-noise's `browser` field, which maps its default crypto to `pureJsCrypto`). On an old phone that cost dominates a relayed two-party sync (gotchoices/sereus#13). Add a narrow `noiseCrypto` NodeOption so the app can pass a native implementation; Noise stays the only encrypter.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions` beside `connectionGater`; the `connectionEncrypters: [noise()]` line in the libp2p options object)
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts (re-exports)
  - packages/db-p2p/readme.md (React Native section)
  - packages/db-p2p/test/ (new spec)
----
# An app can supply the crypto Noise uses

## Why

Reported on gotchoices/sereus#13 (kjeib), raised by sereus with the maintainer's approval. `@chainsafe/libp2p-noise` 17 declares `"browser": { "./dist/src/crypto/index.js": "./dist/src/crypto/index.browser.js" }`, and the browser file sets `defaultCrypto = pureJsCrypto`. Metro honours `browser`, so every React Native build runs Noise's handshake and per-frame ChaCha20-Poly1305 in pure JS, while Node gets OpenSSL/WASM. On a Galaxy S7 that cost dominates; charged as a CPU busy-wait in Node, the full S7 cost stops a two-party relay sync from finishing. (Why slow crypto *diverges* rather than just slowing down is a separate sereus ticket, `bug-slow-peer-crypto-cost-diverges-into-retry-amplification`; out of scope here.)

`createLibp2pNodeBase` hardcodes `connectionEncrypters: [noise()]`, so an app has no way in.

## Design

- `NodeOptions.noiseCrypto?: ICryptoInterface` (type from `@chainsafe/libp2p-noise`, which exports it from its root as a type), placed and documented beside `connectionGater`. Used as `noise(options.noiseCrypto ? { crypto: options.noiseCrypto } : undefined)`. Unset → exactly today's behaviour.
- **Not** a general `connectionEncrypters` or libp2p override: Noise stays mandatory so every node can talk to every other, and the option only swaps local primitives — the wire protocol is unchanged, so a node with a native crypto interoperates with one without.
- The doc comment states that the value must be a complete `ICryptoInterface` (SHA-256, ChaCha20-Poly1305 encrypt/decrypt, X25519 key generation and DH), and that the usual pattern is to spread `pureJsCrypto` and override the hot functions with native ones.
- Re-export from both `src/index.ts` and `src/rn.ts`, so an app need not depend on noise directly at a matching major: `export type { ICryptoInterface as NoiseCryptoInterface } from '@chainsafe/libp2p-noise'` and `export { pureJsCrypto as noisePureJsCrypto } from '@chainsafe/libp2p-noise'`. Check the RN entry's comment on its module-set substitution before adding to it, and that `yarn check:rn` still bundles.
- Thread the option through whichever wrapper(s) build `NodeOptions` for the node and RN factories (`libp2p-node.ts`, `libp2p-node-rn.ts`) if they do not pass the whole object through already.

## Tests

- New spec: two real nodes (the smallest existing libp2p-node spec fixture that dials over TCP). Node A gets `noiseCrypto` = `{ ...pureJsCrypto }` with call counters wrapped around `hashSHA256` and `chaCha20Poly1305Encrypt`; node B gets none. Assert they connect and complete one ordinary request (a ping or a repo get is enough), that A's counters were hit, and so B, which has no option, interoperates.
- A type-level check that `noiseCrypto` is optional (an existing options-shape spec, or `@ts-expect-error` on a wrong type).

## Docs

A short paragraph in the React Native section of `packages/db-p2p/readme.md`: RN gets pure-JS Noise through the `browser` field; pass `noiseCrypto` with native primitives (e.g. spread `noisePureJsCrypto` and override hashing and ChaCha20-Poly1305) to avoid that cost.

## Follow-up (not this ticket)

Sereus adds a pass-through in cadre-core (`buildControlNodeOptions` and the strand node options) once this ships.
