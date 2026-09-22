description: An embedding app can now hand the node its own crypto functions for connection encryption, so a React Native app can use fast native crypto instead of the slow pure-JavaScript version it was stuck with (gotchoices/sereus#13).
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.noiseCrypto`, beside `connectionGater`; the `connectionEncrypters` line in the libp2p options)
  - packages/db-p2p/src/noise-crypto.ts (new — the two re-exports)
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts (one `export *` line each)
  - packages/db-p2p/test/noise-crypto-node-wiring.spec.ts (new)
  - packages/db-p2p/readme.md (React Native section, after the "Dormant, not yet reached" paragraph)
----
# An app can supply the crypto Noise uses — review handoff

## What changed

- **`NodeOptions.noiseCrypto?: ICryptoInterface`**: the type comes from `@chainsafe/libp2p-noise`. It is used as `noise(options.noiseCrypto ? { crypto: options.noiseCrypto } : undefined)`. When unset, the call is `noise(undefined)`, which behaves exactly like the old `noise()`. The doc comment says why React Native gets pure JS (Metro honours the package's `browser` field). It says the value must implement every member of the interface: SHA-256, HKDF, X25519 key generation, X25519 shared-key derivation, and ChaCha20-Poly1305 encrypt and decrypt. The ticket's list left out HKDF and generating a key pair from a seed; the real interface includes both, so the comment lists them. It says the usual approach is to spread `noisePureJsCrypto` and override the hot functions. And it says this is deliberately not a general override of the connection encrypters.
- **Re-exports** live in a new module, `src/noise-crypto.ts`: `NoiseCryptoInterface` (a type alias of `ICryptoInterface`) and `noisePureJsCrypto` (`pureJsCrypto`). Both entries pick it up with `export * from './noise-crypto.js'`. It is a separate module because `test/entry-parity.spec.ts` only accepts plain `export *` lines in `index.ts` and `rn.ts`. The ticket's inline `export type { … } from '@chainsafe/libp2p-noise'` would have failed that spec. Both entries keep the same module set, so the rn.ts header comment still holds.
- **Wrappers**: `libp2p-node.ts` and `libp2p-node-rn.ts` already pass the whole `options` object to `createLibp2pNodeBase`, so nothing needed threading.
- **Readme**: one paragraph plus a short example in the React Native section. The native function names in the example (`nativeSha256`, `nativeSeal`, `nativeOpen`) are placeholders. No real React Native crypto library is named.

## Tests

- `test/noise-crypto-node-wiring.spec.ts`, one test. Two real nodes over loopback TCP, set up the same way as `inbound-stream-authorization-node-wiring.spec.ts`. Node A gets `{ ...noisePureJsCrypto }` with counters wrapped around `hashSHA256` and `chaCha20Poly1305Encrypt`. Node B gets no option. B pings A. The test asserts that the ping returns a round-trip time, which shows B (default crypto) interoperates with A, and that both of A's counters are above zero, which shows Noise actually ran the supplied functions. **Checked that it catches the bug:** with the wiring put back to `noise()`, the test fails on the `hashSHA256` counter. With the wiring restored, it passes.
- **No separate type-level test.** The ticket asked for one that checks `noiseCrypto` is optional. `tsc` builds db-p2p's `test/` along with `src/` (the tsconfig includes both), and node B in the spec above is created without the option. So the build already fails if the field ever stops being optional. A `@ts-expect-error` line would only be testing TypeScript itself, which fails the project's "tests must pay for themselves" rule.

## Validation run

- `yarn workspace @optimystic/db-p2p build`: clean.
- db-p2p full suite (`test/**/*.spec.ts`): 3109 passing, 63 pending (the pending ones are env-gated), no failures.
- `eslint` on the touched files, `yarn lint:docs`, `yarn lint:deps`: all clean.
- `yarn check:rn`: passed. Metro bundles the RN entry and legacy Hermes compiles it, with the new re-export included.
- Not run: `yarn test:integration`, the full root `yarn check`, and tests in other packages. The change is confined to db-p2p's libp2p options and one type, and the default path is byte-for-byte unchanged.

## Known gaps / for the reviewer

- Nothing checks that an app-supplied crypto implementation is *correct*. A broken `chaCha20Poly1305Encrypt` shows up as failed handshakes or corrupt frames, not as a clear error. The doc comment points people to spreading `noisePureJsCrypto`, which is the main safeguard. A runtime self-test was considered and not added. It would cost startup time on the same slow phones this option exists for.
- The spec only covers Node, where A's pure-JS-based crypto differs from B's default Node crypto (OpenSSL and WebAssembly). Mixing those two implementations across the connection is the interoperability case that matters. Nothing runs this on an actual React Native device, where the real payoff is.
- Follow-up outside this repo (from the ticket): sereus adds a pass-through in cadre-core (`buildControlNodeOptions` and the strand node options).
