description: The code that copies blocks between machines used to encode them with a Node.js-only built-in that does not exist in React Native; it now uses the cross-platform library the rest of the codebase already depends on, and a lint rule stops library code from reintroducing the Node-only built-in.
files:
  - packages/db-p2p/src/cluster/block-transfer-service.ts (pull encode, push decode, push encode now use `uint8arrays` `toString`/`fromString` with `base64pad`)
  - eslint.config.js (`NO_BUFFER_GLOBAL` via `no-restricted-globals`, plus `no-restricted-properties` for `globalThis.Buffer` / `global.Buffer`; scoped to `packages/*/src/**/*.ts`)
  - packages/db-p2p/test/block-transfer.spec.ts (wire-encoding tests: UTF-8 round trip, exact-string Buffer parity at every padding length, Buffer-encoded decode, empty payload, malformed base64 throws)
  - packages/db-p2p/test/block-transfer-push-persist.spec.ts (malformed-base64 push reported `missing`)
  - packages/db-p2p/test/block-transfer-roundtrip.spec.ts (push + pull through the real handler/stream path with `globalThis.Buffer` deleted, restored in `finally`)
  - packages/db-p2p/readme.md (§ React Native: Optimystic's own code needs no global `Buffer`)
difficulty: easy
----

# Summary

`BlockTransferService` used the Node.js global `Buffer` at three sites: serving a pull, receiving a push, and building a push. Hermes, React Native's JavaScript engine, has no such global unless the host app installs one, and the db-p2p React Native checklist never tells hosts to install it. On a phone that followed the checklist, every block push and pull would throw on a background path, so backup machines would silently never get data.

All three sites now use `uint8arrays` (already a db-p2p dependency) with the `base64pad` codec. That codec produces exactly the string Node's `Buffer#toString('base64')` produces, so nodes on the old and new code still understand each other. Lint now bans the `Buffer` global in every library package's `src/`. Test files are exempt.

Verification (implement stage plus review): `yarn lint` is clean and `yarn build` succeeds. Every `block-transfer*.spec.ts` passes (69/69, re-run after the review edits). In the full `@optimystic/db-p2p` suite, run at the implement stage, the only failures were the 7 in `coordinator-repo-absence-write-bypass.spec.ts`. Those are already listed in `tickets/.pre-existing-known.md` and unrelated to this change.

# Review findings

**Checked:** the implement diff (commits `235d266b` and `3984d0ed`) and the original ticket's requirements, each against the delivered code. Also checked: which uint8arrays build Metro resolves, a repo-wide search of `packages/*/src` for `Buffer` and for base64 handling, whether the lint rule actually fires, docs that mention the change, and consistency with import naming elsewhere in the package.

**Correctness: no defects found.**
- uint8arrays 6.1.1 export conditions: `node` resolves to `to-string.node.js`, which imports `Buffer` from `node:buffer` (a module import, not the global). React Native / Metro resolves the `import` condition to `to-string.js` / `from-string.js`, which are pure JS base encoders with no `Buffer` at all. The on-device path is therefore free of `Buffer`.
- The malformed-input path is correct: `fromString` throws inside the existing `try/catch` in `handlePush`, and the push is reported as `missing`. The push-persist spec pins this.
- The only other base64 handling in library source uses uint8arrays `base64url` (signatures, hashes, ids). There are no other `Buffer`, `atob` or `btoa` uses.
- The import aliases `u8ToString` / `u8FromString` match existing db-p2p usage (`sync/service.ts`, `network-manager-service.ts`).

**Minor, fixed in this pass:**
- **Interop test was weaker than its name.** The "new encoder, old decoder" test only decoded the output with `Buffer.from(…, 'base64')`. That decoder is lenient: it accepts unpadded and partly invalid input, so the test would pass even if the padding differed. It now asserts exact string equality with `Buffer#toString('base64')` for payloads covering all three padding cases (`block-transfer.spec.ts`).
- **Readme claimed more than was verified.** The added sentence said the `buffer` module alias is needed "only for libp2p/multiformats' own internal imports … not a `globalThis.Buffer` assignment". That is a claim about third-party libraries nobody checked. It is now reduced to the verified part: Optimystic's own code needs no global `Buffer`, and lint enforces that.
- **The lint rule could be bypassed.** `no-restricted-globals` only flags a bare `Buffer`; `globalThis.Buffer` or `global.Buffer` would pass. Added `no-restricted-properties` for both spellings, reusing the same message. Verified with an eslint `--stdin` probe: all three spellings are flagged under `packages/db-p2p/src/`, nothing is flagged under `test/`, and `ArrayBuffer` is not flagged.
- **Stale config comment.** The SCOPE comment in `eslint.config.js` still said the config enforces "one React Native bundling constraint". Updated to say two (no static blocks, no `Buffer` global).

**Major: none filed.** The two gaps noted in the handoff are already covered by an open ticket:
- No on-device or Hermes run was done, and the no-global test runs in Node, where uint8arrays resolves its Node build rather than the one Metro bundles. The export-condition check above closes that gap for this code by inspection. An actual on-device or Hermes run is the scope of `plan/rn-bundle-and-hermes-compile-check`, so no new ticket.
- Whether some transitive libp2p dependency reaches for the global `Buffer` is outside this ticket's three sites, and the same Hermes check would surface it. No new ticket.

**Tripwires: none recorded.** Nothing here is "fine now but conditional later". The lint rule is the lasting guard.

**Resource cleanup, error handling, types:** the no-global round-trip test restores `globalThis.Buffer` and stops the service in `finally`, so a failure cannot leak into other specs. Decode errors flow through the existing `try/catch`. No new casts in `src`; the `as any` casts are limited to the tests' global-deletion shim.

**Pre-existing failures:** the 7 `coordinator-repo-absence-write-bypass.spec.ts` failures are already listed in `tickets/.pre-existing-known.md`, so no `.pre-existing-error.md` was written.

**Not re-run in review:** the full db-p2p suite. This pass changed no `src` files, only one test (which passed with its spec files), the eslint config (lint is clean) and the readme. The implement stage's full run stands.
