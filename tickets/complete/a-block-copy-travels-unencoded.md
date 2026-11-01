description: Copying a block to another machine now sends the block as itself rather than as base64 text a third larger, and the answer names which blocks were kept instead of echoing them back, so the largest block the size limit allows can be copied in one message.
prereq: a-log-block-rolls-over-by-size
architecture: docs/internals.md#spreadonchurnmonitor-middle-out
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/protocol-limits.ts, packages/db-core/src/network/struct.ts, packages/db-p2p/test/block-transfer-roundtrip.spec.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/inbound-stream-authorization.spec.ts, packages/db-p2p/test/inbound-message-caps.spec.ts, packages/db-p2p/test/rebalance-push-holders.spec.ts, packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts, docs/internals.md, docs/debugging.md
----
# A block copy travels unencoded

## What changed

**The push wire format** (`packages/db-p2p/src/cluster/block-transfer-service.ts`):

- `BlockTransferRequest` carries `blocks: Record<BlockId, IBlock>`, each block as its JSON value, in place of `blockData` (base64 strings). `type` is gone, since pull is gone (below). `blockIds`, `blockMeta` and `blockProofs` are unchanged.
- `BlockTransferResponse` is `{ accepted: string[]; missing: string[] }`. It carries no block content (it used to echo every accepted block back).
- `BlockTransferClient.pushBlocks(blocks, reason, certification, options)` takes a block map instead of parallel `blockIds` + `Uint8Array[]`. `pushBlockToPeers` passes `{ [blockId]: result.block }` and still reads answers the one true way: a peer holds the block when the answer does not list it missing.
- `handlePush` keeps every receiver rule as it was: the structural check (now the helper `isStructurallyBlock`: an object whose `header` is an object, which rejects `null`, primitives, absent entries and — tightened in review — a `null` header), certification before persisting, per-block decisions, and holder-evidence reporting for the accepted set. A request with no `blocks` answers every id missing.
- The handler's catch arm used to answer `{ blocks: {}, missing: [] }` when `handlePush` threw. A sender reads "not listed missing" as "held", so that answer reported every block as confirmed. It now answers every block missing. In practice this path cannot be reached today: `handlePush` catches its own persist faults, and `certifyContent` does not throw.
- `IBlockReplicaStore` no longer extends `IRepo`: with pull gone, the service only calls `saveReplicatedBlock`.

**Pull was removed.** It had no production caller. Remote reads go through the repo protocol (and `a-remote-read-reply-fits-one-message` packs those replies), and repair fetches go through the sync protocol (`serveBlockArchive`, `fitConsultContent`). Keeping pull would have meant building frame-fitting for dead code. Its tests and doc mentions went with it (`handlePull` in `docs/internals.md`, `docs/debugging.md`, and a comment on `CommitRequest.blockDigests` in `packages/db-core/src/network/struct.ts`).

**The encoder's hidden 4 MiB cap — scope expansion, please weigh it.** The new size test still failed after the base64 change, with `InvalidDataLengthError: Message length too long` from `it-length-prefixed`'s encoder. Its `maxDataLength` defaults to 4 MiB, and no encode site in db-p2p named a cap. So in practice:

- `ProtocolClient.exchange` refused every request over 4 MiB on every protocol, after `maxRequestBytes` had already allowed it up to 8 MiB. That includes a repo `pend` and a cluster record for a 4–7.5 MiB transaction.
- `RepoService`, `ClusterService` (the member's echo of the record), `SyncService` (archives) and `BlockTransferService` refused every reply over 4 MiB.

Each site is now a one-line change. `ProtocolClient` encodes with `maxDataLength: request.byteLength`, because the request was already sized by name against `maxRequestBytes`. Each service encodes its reply under `MAX_BLOCK_MESSAGE_BYTES`, the cap its client reads replies under. A frame under 4 MiB encodes byte-for-byte as before. `DisputeProtocolService` was left alone: its reply is control-sized, and its client reads it under the 1 MiB cap anyway. The rule is written down in the header of `packages/db-p2p/src/protocol-limits.ts` and in `docs/internals.md` §A transaction's size limit. I also added a note to the open ticket `a-remote-read-reply-fits-one-message`, since its regression test is the first that will exercise the repo reply encode above 4 MiB.

**There is no protocol version gate**, as the ticket asked, and an accepted-tradeoff `NOTE:` on `BlockTransferRequest` records it. I checked the cross-build behaviour by reading the code, not by running it. An old sender's push to a new receiver has no `blocks`, so every block comes back missing. A new sender's push to an old receiver has no `blockData`, so the old receiver answers every block missing. Either way the sender counts a `rejected` refusal and nothing is persisted. `docs/internals.md` §SpreadOnChurnMonitor says so under **The push payload**.

## Tests

Added:

- `block-transfer-roundtrip.spec.ts` "a certified push of a block at MAX_BLOCK_BYTES fits one frame and is persisted". This is the regression for the ticket. A block whose JSON is exactly `MAX_BLOCK_BYTES` gets a real signed proof and is pushed through the real handler on the linked-duplex harness to a receiver running the strict default. The test asserts the block is accepted, persisted at the source revision, and stored whole. Before this change it failed with `MessageTooLargeError` (base64), and after the base64 change alone it failed with the encoder's `InvalidDataLengthError`. So it reproduces both defects.
- `block-transfer-push-persist.spec.ts` "reports missing (and does not poison storage) for a value that is not a structurally valid block". One multi-block push carries `null`, a string and a header-less object beside a certified good block. Only the good block is accepted, and nothing else is persisted. It replaces three tests: the old `null` case and the two base64/parse cases, whose failure modes no longer exist.

Changed for the new shapes (no new coverage):

- `block-transfer-roundtrip.spec.ts`: the pull test was removed; push, timeout and certified tests use the block map and `accepted`; the Buffer-deleted (React Native) test now runs a push only; the shared source setup is a `certifiedSource` helper.
- `block-transfer.spec.ts`: mock answers are `{ accepted, missing }`, and the `pushBlockToPeers` test now asserts the block travels as its JSON value. The type-shape tests and the base64 codec tests were deleted, since there is no codec left to pin.
- `inbound-stream-authorization.spec.ts`: the block-transfer case drives an uncertified push (with `requirePushCertificate: false`, so it reaches `saveReplicatedBlock`), and the client-observable tests push instead of pulling.
- `inbound-message-caps.spec.ts`, `rebalance-push-holders.spec.ts`, `cohort-growth-heals-single-holder.spec.ts`, `spread-on-churn.spec.ts`: shape updates only.

Ran `yarn build`, `yarn lint`, `yarn lint:docs` and db-p2p `yarn test` (3527 passing, 74 pending, 0 failing).

## Known gaps for the reviewer

- The reply encodes in `RepoService`, `ClusterService` and `SyncService` have **no test above 4 MiB of their own**. The repo one will be exercised by `a-remote-read-reply-fits-one-message`'s test. A cluster record echo over 4 MiB, and therefore a 4–7.5 MiB transaction on a cohort of two or more members, should now work end to end, but no test runs it. Consider whether one over the real cluster handler is worth its run time. Likewise for a sync archive over 4 MiB, which a large-block repair needs.
- Nothing stops a future service from adding an `lpEncode(source)` with no cap and bringing the 4 MiB limit back. Only the comment in `protocol-limits.ts` guards against it. A shared encode helper with a required cap would make it unrepresentable, if you think the class warrants it.
- The quereus-plugin-optimystic suite and the integration specs were not run. The encoder changes only alter frames over 4 MiB, and nothing outside db-p2p uses the block-transfer types.
- `BlockTransferResponse` is still read under `MAX_BLOCK_MESSAGE_BYTES` by the client, though it now carries only ids. I left it alone rather than tighten it to the control cap, because a pathological many-block push could make the id list exceed 1 MiB.

## Use cases to validate

- A push of a block up to `MAX_BLOCK_BYTES` with its metadata and proof succeeds over the real handler.
- A push answer lists accepted and missing ids and never block bytes.
- A malformed value (`null`, primitive, header-less, absent) is answered missing and never persisted; a certified block beside it is still accepted.
- Senders (`pushBlockToPeers`: rebalance push/confirm, spread-on-churn, the under-replication drain) still count a peer as holding a block exactly when its answer does not list it missing.

## Review findings

Read the implement diff (`ticket(implement): a-block-copy-travels-unencoded`) before the handoff, then the touched sources, tests and docs.

**Checked, no change needed**

- Wire shape and senders: `pushBlocks` is the only request builder, and every sender (`pushBlockToPeers`, used by rebalance push/confirm, spread-on-churn and the under-replication drain) still reads an answer by "not listed in `missing`". Nothing reads `accepted`; it is diagnostic only, which is what the ticket asked for. No other caller of `pullBlocks`, `blockData`, `handlePull` or the old response shape remains in `packages/*/src`, docs or tests.
- Size: a block embedded as a JSON value encodes to the same bytes as the block alone (no string escaping), so the request is the block plus ids, metadata and proof, inside the 512 KiB envelope reserve. The new `MAX_BLOCK_BYTES` round-trip test exercises the request encode in `ProtocolClient` above 4 MiB, so it pins the encoder fix on that side too.
- Encoder caps: read `it-length-prefixed`'s `encode` (default `MAX_DATA_LENGTH`, 4 MiB, checked as `chunk.byteLength > maxDataLength`). `maxDataLength: request.byteLength` in `ProtocolClient` is therefore exactly "no cap beyond `maxRequestBytes`", and every `processMessage` caller (repo, cluster, sync, dispute, block-transfer) passes `maxRequestBytes`. Each reply encode now matches its client's read cap. The remaining default encode, `DisputeProtocolService`'s reply, is control-sized and read under the 1 MiB cap, so the 4 MiB default never binds there. The cohort-topic streams frame through their own helper and are control-sized.
- The catch arm answering every block missing is the right direction (a sender treats "not listed" as held). `request.blocks[blockId]` on a `__proto__`/`constructor`-shaped id yields a prototype or a function, which the structural check refuses.
- Removal of pull and of `IBlockReplicaStore extends IRepo`: no production caller; the docs (`docs/internals.md`, `docs/debugging.md`, the `CommitRequest.blockDigests` comment) no longer mention it.
- The accepted-tradeoff `NOTE:` on `BlockTransferRequest` (no protocol version gate) states what, why and the revisit condition; left as is.
- Docs: `docs/internals.md` §A transaction's size limit and §SpreadOnChurnMonitor describe the new payload, the encoder rule and the mixed-build behaviour; `protocol-limits.ts`'s header carries the encoder rule.

**Found and fixed**

- The structural-validation test was vacuous. It ran on the strict receiver with no proof on the malformed values, so they were refused by `no-proof` whether or not `isStructurallyBlock` existed (the pre-change `null` test had the same flaw). Moved it under the migration posture (`requirePushCertificate: false`), where the structural check is the only gate. Doing so exposed a real gap:
- `{ header: null }` passed `isStructurallyBlock` (it only tested `header !== undefined`) and was persisted under the migration flag — verified by the moved test failing before the fix. Tightened the helper to require an object header; added the case to the test; updated the wording in `docs/internals.md` and the handler comment.

**Considered, parked**

- An `lpEncode` added later without a cap would silently bring back the 4 MiB limit for that frame. Five sites, one rule; a shared helper with a required cap would not stop a direct `it-length-prefixed` import either, so no ticket. The rule lives in the `protocol-limits.ts` header and `docs/internals.md` §A transaction's size limit, which is where a future encode site's author meets it.
- No test of its own over 4 MiB for the repo, cluster-echo and sync reply encodes (the implementer's first known gap). Each is the same one-line cap as the tested block-transfer and request sides; the repo reply gets its test from `a-remote-read-reply-fits-one-message`. Not worth the run time of a second 7 MiB mesh test.
- `BlockTransferResponse` is still read under `MAX_BLOCK_MESSAGE_BYTES` although it carries only ids — agreed with the implementer's reasoning (a many-block push's id list is the sender's choice); no change.

**Tests and checks run**: `yarn build`, `yarn lint`, `yarn lint:docs` (all clean) and db-p2p `yarn test` (3527 passing, 74 pending, 0 failing). The integration specs and the quereus-plugin suite were not run: the change only alters frames over 4 MiB and the block-transfer types, which nothing outside db-p2p uses.
