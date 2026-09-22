description: An embedding app can now hand the node its own crypto functions for connection encryption, so a React Native app can use fast native crypto instead of the slow pure-JavaScript version it was stuck with (gotchoices/sereus#13).
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/noise-crypto.ts
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts
  - packages/db-p2p/test/noise-crypto-node-wiring.spec.ts
  - packages/db-p2p/readme.md
----
# An app can supply the crypto Noise uses

## What shipped

- `NodeOptions.noiseCrypto?: ICryptoInterface` (from `@chainsafe/libp2p-noise`), passed as `noise({ crypto: options.noiseCrypto })`. Unset → Noise's own default. The doc comment explains why React Native gets pure JS (Metro honours the package's `browser` field), lists the full interface an implementation must provide, and recommends spreading `noisePureJsCrypto` and overriding the hot functions.
- `src/noise-crypto.ts` re-exports `NoiseCryptoInterface` (type) and `noisePureJsCrypto`, picked up by both `index.ts` and `rn.ts` via `export *` (as `test/entry-parity.spec.ts` requires).
- Readme React Native section: a paragraph and a short example with placeholder native function names.
- One two-node loopback test: node A uses counted pure-JS crypto, node B the default; a ping succeeds and A's `hashSHA256` / `chaCha20Poly1305Encrypt` counters moved. The implementer confirmed the test fails with the wiring reverted to `noise()`.

Out-of-repo follow-up: sereus adds a pass-through in cadre-core (`buildControlNodeOptions` and strand node options).

## Review findings

- **Correctness / wiring**: checked that `libp2p-node.ts` and `libp2p-node-rn.ts` forward the whole `options` object to `createLibp2pNodeBase`, so the option reaches both entries. Checked Noise v17's constructor: it does `crypto ?? defaultCrypto`, so the implementer's `options.noiseCrypto ? { crypto } : undefined` conditional was redundant. **Fixed inline**: simplified to `noise({ crypto: options.noiseCrypto })` (no `exactOptionalPropertyTypes` in the tsconfigs, so this type-checks). Re-ran build and the wiring spec: it passes.
- **Type safety / API surface**: the readme example's signatures match `ICryptoInterface` (including `dst?` on decrypt, and `.subarray()` works on both `Uint8Array` and `Uint8ArrayList`). `NodeOptions` now exposes a third-party type, so a major bump of `@chainsafe/libp2p-noise` would change this package's public API. The comment in `noise-crypto.ts` already says it re-exports "at the major this package is built against", which records the constraint. No further action.
- **Tests**: the one spec pins the named contract (supplied primitives are actually used, and it interoperates with a default node) on a real connection. It is not testing a mock. Kept. Agreed that a separate type-level "optional" test would add nothing: node B in the spec is built without the option, and `tsc` compiles `test/`.
- **Error handling**: a broken app-supplied implementation shows up as failed handshakes or corrupted frames, not as a clear error. The implementer deliberately declined a runtime self-test because of its startup cost on slow phones. That tradeoff is recorded in the handoff and not re-filed.
- **Docs**: the readme is updated. `docs/internals.md` has no general `NodeOptions` catalogue (it mentions `connectionGater` only in the context of stream authorization), so nothing there needed changing.
- **Resource cleanup**: the spec stops both nodes in `afterEach` via `Promise.allSettled`. Fine.
- **Source hygiene / DRY**: the new module is 4 lines, and the comments state why rather than narrating the code. Nothing to change.
- **Tripwires / new tickets**: none. Nothing conditional or major was found.
- **Validation**: `yarn build` in db-p2p is clean. `noise-crypto-node-wiring.spec.ts` and `entry-parity.spec.ts` pass (10 tests). `eslint` on `libp2p-node-base.ts` is clean. The full db-p2p suite, `check:rn` and the lint:docs/deps checks were run by the implementer (all green) and not re-run after the one-line change: it only changes how the argument is written, not what Noise receives.
