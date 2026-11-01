description: When one machine asked another to cancel a reservation, the cancel worked but the asking machine always read the reply as an error and retried after a multi-second back-off. The shared reply reader now treats an empty reply as "done, nothing to return", so a successful remote cancel resolves as success.
files: packages/db-p2p/src/protocol-client.ts (`ProtocolClient.exchange`, the JSON decode stage), packages/db-p2p/src/repo/service.ts (`handleIncomingStream`, the reply encode), packages/db-p2p/test/repo-protocol-void-reply.spec.ts, packages/db-p2p/test/support/linked-duplex-pair.ts (reused), packages/db-p2p/docs/repo.md (wire paragraph), .release-notes.pending.md
repro: verified
----
# A remote cancel that succeeds is reported as a failure

GitHub [#46](https://github.com/gotchoices/Optimystic/issues/46).

## What was wrong

`IRepo.cancel` resolves `void`. `RepoService` answered every operation with `TextEncoder.encode(JSON.stringify(response))`; `JSON.stringify(undefined)` is `undefined`, which encodes as zero bytes — a length-prefixed frame of length 0. `ProtocolClient.exchange` ran `JSON.parse` on every frame, and `JSON.parse('')` throws `SyntaxError: Unexpected end of JSON input`. So a remote cancel ran, the caller saw a failure, `NetworkTransactor.dischargeCancel` re-sent it to other coordinators after the retry back-off, and a cancel coordinated by another machine could never be confirmed (which also kept `TornActionError.final` from being `true` in that case).

## What changed

- `ProtocolClient.exchange`'s decode stage yields `undefined` for a zero-length frame instead of parsing it. No JSON value serializes to an empty string and length-prefixing makes the zero length explicit, so a truncated reply cannot look like one. Fixing the client side also fixes an upgraded caller talking to an un-upgraded (1.16–1.18) coordinator.
- `RepoService` now builds the empty frame explicitly for an `undefined` response rather than relying on `TextEncoder.encode(undefined)` defaulting to `""` (added in review).
- `packages/db-p2p/docs/repo.md` states the wire rule; `.release-notes.pending.md` carries the user-facing note under "Unreleased — since v1.18.0".
- Test: `packages/db-p2p/test/repo-protocol-void-reply.spec.ts`, a real `RepoClient` against a real `RepoService` over the shared in-memory stream pair — a successful remote cancel resolves (the bug's reproduction: failed with the `SyntaxError` before the fix), and a failed one still rejects.

## Review findings

Read the `ticket(implement): a-remote-cancel-that-succeeds-is-reported-as-a-failure` diff first, then the handoff.

- **Correctness of the decode rule** — checked. `first(...)` returns the first yielded item even when `undefined`, so `'No response received'` still means "no frame at all". `RepoClient.processRepoMessage` reads the reply through `redirectResponse?.redirect?.…`, so `undefined` falls through to `return response` as intended. No finding.
- **Other protocol clients now receiving `undefined`** — checked every `processMessage` caller (`ClusterClient`, `SyncClient`, `BlockTransferClient`, `DisputeClient`). Their services always send an object, so only `cancel` produces an empty frame. A faulty or hostile peer sending an empty frame now yields `undefined` where it used to throw `SyntaxError`; that is the same class as a peer sending `null` (`JSON.parse('null')`), which these clients were always exposed to — none of them validates reply shape, and each fails on the next property read, inside the same per-peer failure path. Not a new class; no ticket. The one behaviour change is that `DisputeClient.sendResolution` accepts an empty ack, which is harmless (the ack's content is never read).
- **Service-side encoding (minor, fixed)** — the service produced the empty frame only implicitly, via `TextEncoder.encode(undefined)` taking its WebIDL default of `""`. A non-conforming encoder (a React Native polyfill that stringifies its argument) would send the bytes `undefined`, which the new client rule would still reject. Made it explicit in `RepoService.handleIncomingStream`, and reworded the `docs/repo.md` paragraph to describe the frame rather than the `JSON.stringify` call.
- **Tests (minor, fixed)** — the "failed cancel still rejects" test asserted only that the call rejected. With a 5 s expiration, a broken failure path that hung would also reject (with `RepoClient timeout`) and pass. It now asserts the rejection is not the client's own deadline, and that the repo saw the cancel. The success test is the bug's reproduction and stays. No tests cut: both pay for themselves (one reproduction, one pinning that the empty-frame rule does not swallow a real failure).
- **Deviation from the implement ticket** (reused `makeLinkedPair` instead of a new helper) — agreed; the shared pair exists so copies do not drift.
- **Docs** — read `packages/db-p2p/docs/repo.md` (updated), `docs/internals.md` (its "JSON in both directions" remark on the log transport is still true; nothing else describes reply framing), and the release notes entry. `yarn lint:docs` passes.
- **Resource cleanup / error handling** — unchanged by the diff: the stream is still closed in `exchange`'s `finally`, and a repo throw still aborts the service stream.
- **Tripwire, not filed** — `test/util/protocol-stream.ts`'s `decodeJson` still throws on an empty frame; only specs decoding `get` replies use it. Left as noted in the implement handoff; a future spec decoding a `cancel` reply through it needs the same rule.
- **Known gap carried forward** — no test drives `NetworkTransactor.cancel` → `RepoClient` → `RepoService` end to end, so nothing asserts at the transactor level that the 3.5 s back-off from the issue is gone; Taleus's latency measurement in the issue is the real confirmation and has not been re-run. The transactor's handling of a resolved cancel is covered by its in-process specs, which is the path the wire now matches. Not filed: the defect's root site is fixed and pinned at the lowest layer that reproduces it.

Validation in this pass: `yarn build`, `yarn typecheck`, `eslint` on the changed files, `yarn test` (3522 passing, 73 pending) and `yarn test:integration` (50 passing, 2 pending) in `packages/db-p2p`; `yarn lint:docs` at the root. Not run: the root-wide `yarn check`.
