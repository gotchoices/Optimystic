description: When one machine asked another to cancel a reservation, the cancel worked but the asking machine always read the reply as an error and retried after a multi-second back-off. The shared reply reader now treats an empty reply as "done, nothing to return", so a successful remote cancel resolves as success.
files: packages/db-p2p/src/protocol-client.ts (`ProtocolClient.exchange`, the JSON decode stage), packages/db-p2p/test/repo-protocol-void-reply.spec.ts (new), packages/db-p2p/test/support/linked-duplex-pair.ts (reused, unchanged), packages/db-p2p/docs/repo.md (wire paragraph), .release-notes.pending.md (new "Unreleased — since v1.18.0" section), packages/db-p2p/src/repo/service.ts (read only), packages/db-core/src/transactor/network-transactor.ts (`dischargeCancel`, `cancelRound` — consumers, unchanged)
repro: verified
----
# A remote cancel that succeeds is reported as a failure

GitHub [#46](https://github.com/gotchoices/Optimystic/issues/46).

## What was wrong

`IRepo.cancel` resolves `void`. `RepoService` answers every operation with `new TextEncoder().encode(JSON.stringify(response))`, and `JSON.stringify(undefined)` is `undefined`, which encodes as zero bytes — a length-prefixed frame of length 0. `ProtocolClient.exchange` ran `JSON.parse` on every frame, and `JSON.parse('')` throws `SyntaxError: Unexpected end of JSON input`. So the remote cancel ran, and the caller saw a failure. `NetworkTransactor.dischargeCancel` then re-sent it to other coordinators after the retry back-off and finally threw (or left an owed cancel), so a cancel coordinated by another machine could never be confirmed — which also kept `TornActionError.final` from being `true` in that case.

## What changed

- `ProtocolClient.exchange`'s decode stage yields `undefined` for a zero-length frame instead of parsing it, with a comment saying why that is exact (no JSON value serializes to an empty string, and length-prefixing makes the zero length explicit, so a truncated reply cannot look like one). Every protocol client (repo, cluster, sync, block-transfer, dispute) shares this stage. Fixing it on the client side also fixes an upgraded caller talking to an already-deployed 1.16–1.18 coordinator.
- `first(...)` returns the first yielded item even when it is `undefined`, so `'No response received'` still means "the stream ended with no frame at all".
- A real cancel failure still surfaces: `RepoService` lets the repo's throw escape `processStream`, the handler aborts the stream, and the client's read rejects.
- Checked the other services' reply encoders (`cluster/service.ts`, `dispute/service.ts`, `sync/service.ts`, `block-transfer-service.ts`): each always sends an object, so `cancel` is the only operation that produces an empty frame today. No caller that expects a value can now receive `undefined` where it used to receive a `SyntaxError`.
- `packages/db-p2p/docs/repo.md`: one paragraph after "One request per stream" stating the wire rule. `yarn lint:docs` passes.
- `.release-notes.pending.md`: new top section "Unreleased — since v1.18.0" with the user-facing note (the project's changelog equivalent; there is no `CHANGELOG.md` for these packages).

## Deviation from the implement ticket

The ticket asked for a new `makeStreamPair()` in `test/util/protocol-stream.ts`. `test/support/linked-duplex-pair.ts` already exports `makeLinkedPair()`, which is that pair (two `it-pushable` queues; `abort(err)` ends both sides), and its doc says it is shared on purpose so copies do not drift. The spec reuses it; no new helper was added.

## Test added

`packages/db-p2p/test/repo-protocol-void-reply.spec.ts` — a real `RepoClient` against a real `RepoService` (its `handleIncomingStream`, no `keyNetwork`, so it handles the request itself) over `makeLinkedPair`; the repo behind the service is a plain `IRepo` object.

- "a remote cancel that succeeded resolves" — the bug's reproduction. Failed before the source change with exactly `SyntaxError: Unexpected end of JSON input` at the decode stage; passes after. Also asserts the repo saw exactly one cancel (so no retry happened).
- "a remote cancel that failed still rejects" — pins that the empty-frame rule does not swallow a real failure. Over the in-memory pair the client rejects with the repo's own error (the pair's `abort(err)` carries it); over real libp2p it would be a stream reset. The assertion is only that it rejects.

## Validation run

- `yarn build` and `yarn typecheck` in `packages/db-p2p`: clean. `eslint` on the two changed TS files: clean.
- `yarn test` in `packages/db-p2p`: 3522 passing, 73 pending, 0 failing.
- `yarn test:integration` in `packages/db-p2p` (real libp2p wire, includes `real-libp2p.integration.spec.ts`): 50 passing, 2 pending, 0 failing.
- Not run: the root-wide `yarn test` / `yarn check`, and `quereus-plugin-optimystic`'s integration specs. `db-core` is untouched.

## Known gaps / for the reviewer

- No test drives `NetworkTransactor.cancel` → `RepoClient` → `RepoService` end to end over a wire, so nothing yet asserts that the 3.5 s back-off from the issue is gone at the transactor level. The ticket deliberately declined that test (the transactor's handling of a resolved cancel is covered by its in-process specs, which is the path that now matches the wire). Taleus's latency measurement in the issue is the real confirmation and has not been re-run here.
- `test/util/protocol-stream.ts`'s `decodeJson` still throws on an empty frame. It is used only by specs that decode `get` replies, so it was left alone; a future spec that decodes a service's `cancel` reply through it would need the same rule.
