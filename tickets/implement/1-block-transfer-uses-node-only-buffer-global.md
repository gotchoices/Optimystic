<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-09-15T05:52:51.829Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\1-block-transfer-uses-node-only-buffer-global.implement.2026-09-15T05-52-51-827Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: The code that copies blocks between machines uses a Node.js-only built-in to encode them, and that built-in does not exist in React Native unless the app happens to install it. A phone app that follows our setup guide exactly would therefore fail whenever it tries to hand a copy of its data to a backup machine or receive one. Encode with the cross-platform library we already depend on, and add a lint rule so library code cannot use that built-in again.
files:
  - packages/db-p2p/src/cluster/block-transfer-service.ts (the three `Buffer.from` sites: encoding a pulled block to base64, decoding a pushed block, encoding pushed block bytes)
  - eslint.config.js (add `no-restricted-globals` for `Buffer` on `packages/*/src/**/*.ts`, in the style of the existing logging rules)
  - packages/db-p2p/test/entry-parity.spec.ts (the existing React Native entry guard; it checks imports, not globals, so it could not see this)
  - packages/db-p2p/readme.md (§ React Native polyfill table lists `buffer` / `node:buffer` as a module alias only; no global `Buffer`)
difficulty: easy
repro: static
----

# The defect

`BlockTransferService` (`packages/db-p2p/src/cluster/block-transfer-service.ts`) is reachable from the React Native entry (`@optimystic/db-p2p/rn`). It encodes and decodes block payloads with the Node.js global `Buffer`:

- serving a pull: `Buffer.from(JSON.stringify(block)).toString('base64')`
- receiving a push: `JSON.parse(Buffer.from(data, 'base64').toString('utf8'))`
- building a push: `Buffer.from(bytes).toString('base64')`

Hermes has no global `Buffer`. The db-p2p readme's React Native checklist tells hosts to alias the `buffer` *module* in Metro, which makes `import { Buffer } from 'buffer'` work but does not create the global. The sereus React Native reference app (`../sereus/packages/reference-app-rn`) follows that checklist: `buffer` is aliased in `metro.config.js`, and no file in the app's own source assigns `globalThis.Buffer` (checked 2026-09-14; a dependency could still install it, which is why this is `repro: static`).

Where the global is missing, every block push and pull throws `ReferenceError: Buffer is not defined`. Those are the paths that give a newly added backup machine a copy of data written while the phone was alone (the rebalance monitor's cohort-growth reaction), re-replicate on churn, and serve restoration requests. On a phone this would present as "the backup never gets the data", not as a crash, since the error is likely caught and logged on a background path.

Confirming on-device is quick: evaluate `typeof globalThis.Buffer` in the running reference app. It is not needed to justify the fix: library code must not depend on a Node-only global under this repo's cross-platform rule (AGENTS.md § General).

# The fix

- Replace the three sites with `uint8arrays`, already a declared, version-guarded dependency of db-p2p: `toString(bytes, 'base64pad')` / `fromString(str, 'base64pad')`, with `new TextEncoder()` / `new TextDecoder()` for the JSON string ↔ bytes steps. Use `base64pad`, not `base64`: Node's `Buffer#toString('base64')` emits padded standard base64, so `base64pad` keeps the wire bytes identical and nodes on the previous release keep interoperating in both directions.
- Add `no-restricted-globals` for `Buffer` to `eslint.config.js`, scoped to `packages/*/src/**/*.ts` like the existing `no-console` rule, with a message pointing at `uint8arrays`. If the rule turns up other library sites, fix them in this ticket. Test files are out of scope and may keep using `Buffer`.
- Readme § React Native: add one sentence saying Optimystic itself does not require a global `Buffer`, but some transitive libp2p dependencies may, so hosts should still install one if they observe `Buffer is not defined`. Only write that second clause if you find evidence of such a dependency; otherwise say only the first.

# Edge cases & interactions

- **Wire compatibility.** Add a unit test that encodes a block with the new helper and decodes it with `Buffer.from(…, 'base64')`, and the reverse, so old↔new interop is pinned, not assumed. Include a block whose JSON contains non-ASCII text (a multi-byte UTF-8 character) so the TextEncoder path is exercised.
- **Prove the global is no longer needed.** A spec that deletes `globalThis.Buffer` for the duration of one push/pull round-trip through `BlockTransferService`, restoring it in `finally`, must pass. That is the React Native condition reproduced in Node. Make sure the deletion cannot leak into other specs on failure.
- **Malformed input.** `Buffer.from(str, 'base64')` silently ignores invalid characters; `fromString(str, 'base64pad')` throws. The receive path must turn a throw into the same rejection it gives any other undecodable push (check what it does today for bad JSON), not an unhandled error.
- **Empty payload.** Zero-length block data round-trips.
- **Lint rule scope.** `packages/*/src` includes tsup-built plugin packages; confirm they have no `Buffer` uses, or fix them.

# TODO

- Replace the three `Buffer` sites with `uint8arrays` `base64pad` plus TextEncoder/TextDecoder.
- Add the interop, no-global round-trip, malformed-input and empty-payload tests.
- Add the `no-restricted-globals` rule; fix any further library hits it reports.
- Readme § React Native sentence.
- `yarn lint`, `yarn build`, `yarn workspace @optimystic/db-p2p test`.
