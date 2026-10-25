description: A write that would leave any block too large to copy to another machine in one message is now refused by the writer, by name and before anything is sent, on both write paths.
prereq: a-log-block-rolls-over-by-size, a-tree-node-splits-by-size
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/network/block-size.ts (`BlockTooLargeError`, `oversizedBlock`), packages/db-core/src/transform/digest.ts (`describeTouchedBlocks`, `TouchedBlocks`), packages/db-core/src/blocks/helpers.ts (`canonicalBlockHashAndBytes`), packages/db-core/src/collection/collection.ts (`Collection.syncAttempts`), packages/db-core/src/transaction/coordinator.ts (`declareTouchedBlocks`, `coordinateTransaction`, `commitPhase`, `commitRequestFor`), packages/db-core/test/writer-refuses-oversized-block.spec.ts, packages/db-core/test/coordinator.spec.ts, docs/internals.md
----
# A writer refuses a block too large to copy

## What was built

Before a write is sent, every block it touches that the writer can materialize locally is measured as it will be after the write, and a block over `MAX_BLOCK_BYTES` (7.5 MiB of JSON) throws `BlockTooLargeError` (`blockId`, `bytes`, `limit`). It has the same terms as `TransactionTooLargeError`: nothing sent, nothing to cancel, not a `StaleFailure`, never retried.

- The measure comes from the pass that already declares each block's content digest: `describeTouchedBlocks` returns `{ digests, bytes }`, the byte count being the length of the canonical JSON it hashes (`canonicalBlockHashAndBytes`). `oversizedBlock` judges it as a separate, non-throwing step, so declaring content still never breaks committing it.
- `Collection.syncAttempts` measures on every attempt, after the log append, and throws; `actAndSync` unstages.
- `TransactionCoordinator.coordinateTransaction` now takes the declaration once, before the gather and the pend (`declareTouchedBlocks`), and threads it to `commitRequestFor` (now synchronous) instead of materializing again after the pend. The refusal is a pend-phase failure with `tooLarge`, so `commit()` throws it by name and `execute()` returns it as a failed result.
- Documented in docs/internals.md §A transaction's size limit ("The writer refuses a block over the limit"), including what it cannot see and when it fires.

## Review findings

Read the `ticket(implement): a-writer-refuses-a-block-too-large-to-copy` diff first, then the handoff.

**Correctness — checked, no defect found.**
- The coordinator's declaration now covers `blockIdsForTransforms(transforms)` instead of the pend's returned `blockIds`. Confirmed they are the same set: `NetworkTransactor.pend` answers with `blockIdsForTransforms` of the request's transforms, and `TestTransactor` likewise. The transforms map holds each collection's live `tracker.transforms` after the log append (`applyActionsToCollection`), so the log tail and header are measured and declared, as before.
- Moving the declaration ahead of the pend: the tracker is latched for the commit span and reset only on success, so the content is the same; the one observable difference is a pin judged "moved" by an unlatched read between pend and commit, which used to make the block undeclared and is now declared from the pin the pend's `baseRevs` named. That is consistent with the pend, not a regression. All digest/base tests pass unchanged.
- `canonicalBlockHashAndBytes`'s claim that the length equals `jsonEncodedBytes`: `canonicalJson` is `JSON.stringify` with a replacer that only reorders object keys (`toJSON` runs before the replacer, `undefined` properties are dropped the same way, a `Uint8Array` serializes to the same index-keyed object), so the length is identical.
- Error flow: the coordinator's empty-committed failure branch restores every snapshot and throws `coordResult.tooLarge`; when a refresh between attempts has already saved a participant, `commit()`'s one catch turns it into `CoordinatorPartialCommitError`, which is right. The Collection path throws out of `syncAttempts` before `transact`, and no catch converts it (pinned by the test).
- The pre-pend failure also runs the `retainInFlightAttempt` loop for an attempt that sent nothing. Harmless (no own entry can be found for it, and the in-flight mark clears with the cycle), and identical to how `TransactionTooLargeError` already behaved.

**Consequence for data written before the size rules — parked as an accepted-tradeoff `NOTE:`.** A block a build without the split rules grew past the limit refuses every write that leaves it over, including ones that do not grow it: an oversized log tail wedges its collection (the roll-over rewrites the old tail's `nextId`), and a delete from an oversized leaf is refused. Under AGENTS.md's "don't worry about backwards compatibility yet", and with every upgrade-check fixture far under the limit (largest about 440 KB), this is not filed. Recorded at `oversizedBlock` in `packages/db-core/src/network/block-size.ts` with its revisit condition (a deployment that must keep writing over such data) and remedy (refuse only a block that grows past its base's size). docs/internals.md already states the consequence under "When it fires".

**Unmeasured blocks (deletes, blind updates, evicted or moved bases)** — already recorded by the implementer as a `NOTE:` tripwire at `describeTouchedBlocks` and in internals.md; agreed it is conditional, left as is.

**Tests.** Both new tests kept. The `Collection.sync` test is the one the ticket asked for. The coordinator test is not wiring: it pins the `pendFailure` classification branch this ticket added (`instanceof BlockTooLargeError`), without which `commit()` would throw a generic `Error`. The `coordinator.spec.ts` changes only follow the new `commitPhase` signature, and the two digest tests still draw their declaration from each collection's own tracker. No test added; no defect needed a reproduction.

**Performance / resource cleanup.** One serialization per touched block per attempt, the same as before (the bytes come from the hash's own encoding). `declareTouchedBlocks` hashes collections one after another where `commitTogether` used to build requests with `Promise.all`; the work is CPU-bound and per-transaction collection counts are small, so this is not a measurable change. Nothing allocated needs releasing.

**Type safety / hygiene.** `TooLargeError` union is used consistently; no `any` added. `computeBlockContentDigests` stays as a thin wrapper because tests in db-core and db-p2p call it. File size: `wc -l` gives 2534 lines for `collection.ts` and 2149 for `coordinator.ts` (this ticket added 47 to the latter). That is already tracked by backlog `debt-collection-write-retry-logic-outgrew-its-file`; I appended the new measurement there rather than filing a new ticket.

**Docs.** Read docs/internals.md (the new paragraph and the edited block-limit paragraph), docs/repository.md §Declared block content, docs/correctness.md, packages/db-core/docs/btree.md, packages/db-core/docs/chains.md, docs/reactivity.md and the db-core README. All are accurate: none states when the coordinator computes its digests or that nothing refuses an oversized block. No change needed beyond the implementer's.

**Validation.** `yarn lint` clean, `yarn lint:docs` clean, db-core rebuilt, db-core suite 1919 passing. My only source change was a comment, so I did not re-run the other packages; the implementer's runs (quereus-plugin-optimystic 1064, db-p2p 3528) stand. `yarn test:integration` was not run.
