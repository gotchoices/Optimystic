description: The code that copies blocks between machines used to encode them with a Node.js-only built-in that does not exist in React Native; it now uses the cross-platform library the rest of the codebase already depends on, and a lint rule stops library code from reintroducing the Node-only built-in.
files:
  - packages/db-p2p/src/cluster/block-transfer-service.ts (the three sites — pull encode, push decode, push encode — now use `uint8arrays` `toString`/`fromString` with `base64pad`, plus `TextEncoder`/`TextDecoder` for the JSON↔bytes steps)
  - eslint.config.js (`NO_BUFFER_GLOBAL` in the existing `no-restricted-globals` rule, scoped to `packages/*/src/**/*.ts` alongside the other library-only rules)
  - packages/db-p2p/test/block-transfer.spec.ts (new `describe('block-transfer wire encoding (uint8arrays base64pad, cross-platform)')`: UTF-8 round trip, Buffer-interop both directions, empty payload, malformed-base64 throw)
  - packages/db-p2p/test/block-transfer-push-persist.spec.ts (new test: malformed-base64 push is reported `missing`, same as unparseable-but-valid-base64)
  - packages/db-p2p/test/block-transfer-roundtrip.spec.ts (new test: a full push+pull through the real handler+stream path with `globalThis.Buffer` deleted for the duration, restored in `finally`)
  - packages/db-p2p/readme.md (§ React Native polyfill table: one sentence — Optimystic's own code does not need a global `Buffer`)
difficulty: easy
----

# What changed

`BlockTransferService` (`packages/db-p2p/src/cluster/block-transfer-service.ts`) encoded/decoded
block payloads with the Node.js global `Buffer` at three sites (serving a pull, receiving a push,
building a push). Hermes — React Native's JS engine — has no global `Buffer` unless a host app
happens to install a polyfill, which the db-p2p readme's own React Native checklist does not tell
hosts to do (it aliases the `buffer` *module*, not the global). Every block push and pull would
throw `ReferenceError: Buffer is not defined` on a phone that followed the checklist, and the error
is caught on a background path — so the failure mode is silent: backup machines never receive data.

The fix: all three sites now go through `uint8arrays` (`toString`/`fromString`, `'base64pad'`
codec — this matches Node's padded `Buffer#toString('base64')` output byte-for-byte, so
old↔new nodes stay wire-compatible), plus `TextEncoder`/`TextDecoder` for the JSON-string↔bytes
step. `uint8arrays` was already a declared dependency of `db-p2p`. A `no-restricted-globals` ESLint
rule now bans `Buffer` across `packages/*/src/**/*.ts` (every library package, not just db-p2p) so
this can't quietly come back; test files are exempt and may still use `Buffer`.

A repo-wide grep of `packages/*/src` for `\bBuffer\b` (excluding `ArrayBuffer`/`SharedArrayBuffer`)
turned up no other hits — the three sites above were the only ones.

# How this was verified

- `yarn lint` (repo-wide) and a scoped `yarn eslint packages/db-p2p/src packages/db-p2p/test
  eslint.config.js` both clean.
- `yarn build` — all workspaces build.
- `yarn workspace @optimystic/db-p2p test` — 2715 passing, 50 pending, **7 failing**. The 7 failures
  are all in `test/coordinator-repo-absence-write-bypass.spec.ts`, unrelated to this change
  (GitHub issue #20 reproduction, already tracked in `tickets/.pre-existing-known.md` and owned by
  `implement/1-drop-the-settled-absence-memo`) — do not re-report.
- Targeted run of every `block-transfer*.spec.ts` file (`mocha "test/block-transfer*.spec.ts"
  --reporter spec`): **69/69 passing**, including:
  - the new UTF-8, Buffer-interop (both directions), empty-payload, and malformed-base64 encoding
    tests in `block-transfer.spec.ts`
  - the new malformed-base64 push-rejection test in `block-transfer-push-persist.spec.ts`
  - the new `globalThis.Buffer`-deleted push+pull round trip in `block-transfer-roundtrip.spec.ts`
    — this is the test that most directly stands in for the React Native condition: it runs a real
    push and a real pull through the actual registered stream handler (not a direct method call)
    with the global gone, restoring it in a `finally` so the deletion can't leak into other specs.

# Gaps / things the reviewer should look at

- **No on-device verification.** The ticket's static classification (`repro: static`) stands —
  this was confirmed by reading code (the sereus reference app's Metro config and source, checked
  2026-09-14) and by reproducing the missing-global condition in Node, not by running on an actual
  phone or Hermes runtime. The `globalThis.Buffer`-deleted round-trip test is the strongest
  available proxy but is still Node, not Hermes.
- **The no-global test only isolates `BlockTransferService`'s own push/pull path** (via the
  existing in-memory linked-duplex-pair harness in `block-transfer-roundtrip.spec.ts`, not a real
  libp2p transport). It does not prove no *other* transitively-reached code path (e.g. inside
  libp2p transport/connection internals, once real networking is involved) reaches for `Buffer`.
  That's a materially larger surface than this ticket's scope (the three sites named above); flagging
  it here rather than silently treating "our three sites" as "the whole node."
  I did grep `it-length-prefixed` and `it-pipe` (both used in the request/response framing this
  path exercises) for `Buffer` and found none, plus a repo-wide `packages/*/src` grep for `Buffer`
  found no other library hits — so the immediate blast radius named in the ticket is covered, but a
  fuller "does anything in the full libp2p stack reach for `Buffer`" sweep was not attempted (it
  would need a real Hermes environment or a much larger fake-global exercise to answer well).
- **Readme**: only the first sentence from the ticket's two-clause option was written (unqualified
  "Optimystic itself does not require a global `Buffer`"). No evidence of a transitive
  libp2p/multiformats dependency itself reaching for the *global* (as opposed to importing the
  `buffer` module, which is already covered by the existing polyfill-table row) was found, so the
  second, conditional clause was deliberately left out per the ticket's own instruction.
- This ticket's implementation was originally interrupted mid-run (see the two salvage commits
  `235d266b` and `21d44376` in history); the resumed work here found the source change,
  lint rule, readme sentence, and three of four planned test additions already correctly in place,
  and completed the missing one (the no-global round-trip test in
  `block-transfer-roundtrip.spec.ts`, which had only gotten as far as its imports).

# Suggested review focus

- Confirm the `base64pad` codec choice is in fact byte-identical to `Buffer#toString('base64')`
  output for the interop tests' cases (the tests assert this both directions; worth eyeballing the
  reasoning isn't circular).
- Confirm `no-restricted-globals` in `eslint.config.js` is scoped correctly (`packages/*/src/**/*.ts`
  only, not `test/**`) and that the message is useful if someone hits it.
- The 7 pre-existing `coordinator-repo-absence-write-bypass.spec.ts` failures are out of scope for
  this ticket and already tracked elsewhere — no action needed here.
