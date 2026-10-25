description: After logs and tables stop building oversized blocks, nothing checks that a write cannot produce one some other way; have the writer refuse, by name and before anything is sent, a write that would leave any block larger than the most one message can carry, the way it already refuses a transaction that is too large.
prereq: a-log-block-rolls-over-by-size, a-tree-node-splits-by-size
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/transform/digest.ts (`computeBlockContentDigests`, `peekOrSkip`), packages/db-core/src/transform/tracker.ts (`Tracker.peekMaterialized`), packages/db-core/src/collection/collection.ts (`Collection.syncInternal`, `Collection.actAndSync`), packages/db-core/src/transaction/coordinator.ts (where it computes `blockDigests`), packages/db-core/src/network/transaction-size.ts (`TransactionTooLargeError`, the precedent), docs/internals.md
repro: none
----
# A writer refuses a block too large to copy

## Why

`a-log-block-rolls-over-by-size` and `a-tree-node-splits-by-size` stop the two known ways a block outgrows `MAX_BLOCK_BYTES`. Nothing enforces the bound itself: a new block type, a branch node of very large keys, or a later change to either split rule can build an oversized block again, and nothing fails until a copy or remote read is needed — possibly long after, on another machine. The per-transaction limit is checked on the writer before sending (`assertTransactionFits`); the per-block limit should be too.

## Expected

- Before a write is pended, every block it touches that the writer can materialize is measured (`jsonEncodedBytes` of its post-write content). Over `MAX_BLOCK_BYTES` throws `BlockTooLargeError` (block id, bytes, limit, a message naming `MAX_BLOCK_BYTES`), shaped like `TransactionTooLargeError`: not a `StaleFailure`, never retried, nothing sent and nothing to cancel; `Tree.replace` and `Diary.append` unstage what they staged through `Collection.actAndSync`, as for any failure.
- Both write paths check: `Collection.syncInternal` and `TransactionCoordinator`'s pend phase, at the point each already materializes touched blocks to compute `blockDigests`. Reuse that materialization (`Tracker.peekMaterialized`) rather than materializing twice; consider having the digest pass hand back each block's canonical serialization length, since it already serializes each block. Keep `computeBlockContentDigests`'s rule that declaring content never breaks committing — the size check is a separate step with its own error, not a failure inside the digest pass.
- A block the writer cannot materialize (a blind update to a block never read, a base that would not materialize) is not measured; record that gap in the doc comment.
- With the two prerequisites landed the check should never fire for logs or trees; it is the boundary that catches the next way.

## TODO

- Add `BlockTooLargeError` beside `MAX_BLOCK_BYTES` and the measuring step on both write paths.
- One test: a collection whose action handler grows one block past `MAX_BLOCK_BYTES` (a test-only handler is fine) gets `BlockTooLargeError` from `sync`, nothing reaches the transactor, and the staged action is unstaged.
- Add the writer check to §A transaction's size limit in `docs/internals.md` (what the writer gets, as for the transaction limit).
- Run `yarn build` and the db-core and quereus-plugin-optimystic suites.
