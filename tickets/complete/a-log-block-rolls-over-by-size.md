description: A log block used to hold 32 entries however large they were, so a diary or table written with large entries built log blocks too big to copy between machines. The log now starts a new block once the current one is full by size as well as by count, and two new constants set the size limit every block must stay under.
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/network/block-size.ts, packages/db-core/src/network/index.ts, packages/db-core/src/chain/chain.ts, packages/db-core/src/log/log.ts, packages/db-core/src/reactivity/config.ts, packages/db-core/src/reactivity/rotation.ts, packages/substrate-simulator/src/reactivity.ts, packages/db-core/test/diary.spec.ts, packages/db-core/test/chain.spec.ts, docs/internals.md, docs/architecture.md, docs/reactivity.md, packages/db-core/docs/chains.md, packages/db-core/README.md
----
# A log block rolls over by size

## What landed

Landed in `ticket(implement): a-log-block-rolls-over-by-size`.

- `MAX_BLOCK_BYTES` (7.5 MiB, equal to `MAX_TRANSACTION_BYTES`) and `BLOCK_TARGET_BYTES` (1 MiB) in `packages/db-core/src/network/block-size.ts`, exported from `@optimystic/db-core`. Both are measured with `jsonEncodedBytes`, the UTF-8 length of the block's JSON. Nothing enforces `MAX_BLOCK_BYTES` yet; that is `a-writer-refuses-a-block-too-large-to-copy`, now in `implement/`.
- `ChainInitOptions.blockTargetBytes` is an opt-in setting. `Chain.add` asks `Chain.takenBy` how many entries a block takes: up to `EntriesPerBlock` (32), and no further entry once the block holds one and the next would take its JSON past the target. A block holding no entry always takes the next one. The same rule decides for the existing tail and for every new block in the loop. `Log.getChainOptions` sets the target, so every log uses it. A plain `Chain` without the setting behaves exactly as before.
- The reactivity comments and docs now say `block_fill_size` is an upper bound. The stale "56 of 64" in `docs/reactivity.md` §Anticipatory warm-up is now "24 of 32".
- Docs updated: `docs/internals.md` §A transaction's size limit, `docs/architecture.md`, `docs/reactivity.md`, `packages/db-core/docs/chains.md` and `packages/db-core/README.md`.

## Review findings

**Checked, with no defect found:**

- **Correctness of `takenBy`.** I read it against the edge cases. An empty block always takes at least one entry. A tail already past the target takes nothing, so the next append rolls over. A tail holding more than 32 entries is caught by the `Math.max(0, …)` clamp. A target smaller than an empty block's own JSON still gives one entry per block. The comma arithmetic is right: the first entry in a block adds no comma, and each later entry adds its own JSON plus one byte. `nextId: undefined` is dropped by `JSON.stringify`, both when measured and on the wire, so the measure matches what is sent. `add` no longer mutates the caller's array; it never did in a way callers could see, and it still doesn't.
- **Retry identity.** The split depends only on the tail block's content and the entries. New block ids still come only from `createDataBlock`, which the log feeds through `newDataBlockId` and `Collection.logAppendBlockIds`. A single-entry append mints at most one block, as before. `retry-resends-identical-transforms.spec.ts` passes.
- **Unmeasured bytes.** The measure leaves out `priorHash`, which the `newBlock` hook adds after the decision, and the entry's `blockIds`, which `Log.addActions` writes through `updateAt` after the add because they include the log block the add touched. So they cannot be measured beforehand. Both are documented at `Chain.takenBy` and in `docs/internals.md`. In theory, several entries with tiny action data but very long `blockIds` could share one block and go past the target. Each entry's `blockIds` is bounded by its own transaction, and the general per-block check in `a-writer-refuses-a-block-too-large-to-copy` (prereq'd on this ticket) is the boundary that catches it. So this needs no ticket or tripwire of its own.
- **Other users of the count.** `EntriesPerBlock` is otherwise used only by the reactivity `BLOCK_FILL_SIZE_DEFAULT` and in comments. `BlockFillTracker` only produces logged signals; live rotation is detected by `observeTailCommit`. The drift is documented on `BlockFillTracker` and in `docs/reactivity.md`, and that is enough.
- **Import cycles.** `chain.ts` and `block-size.ts` import `network/transaction-size.js` directly, not a barrel, and `transaction-size.ts` has only type imports. `barrel-import-cycle.spec.ts` passes.
- **Docs.** I read every changed doc. The citations resolve (`yarn lint:docs` is clean). The "still open" paragraph in `docs/internals.md` names the four sibling tickets, and all four are on the board. The line saying a single-entry block is "never larger than the transaction that wrote it" can be off by a block header (tens of bytes) when the entry was appended to an empty existing tail. That is far inside the 512 KiB envelope reserve, so I left the wording.

**Tests.** I kept both new tests.
- The diary test reproduces the bug: 32 × 300 KB appends used to make one 9.8 MB block.
- The chain test is the only check of the multi-entry packing loop and of the comma boundary arithmetic. `ChainInitOptions.blockTargetBytes` is a documented contract of an exported primitive (`chains.md` says "an `add` of several entries packs them by both rules"), even though no production caller adds several entries today.

Neither test restates the implementation or checks a mock.

**Tripwires:** the per-append serialization cost of the tail has a `NOTE:` at `Chain.takenBy`, added by the implementer and still accurate. No new tripwires.

**Major findings / tickets filed:** none.

**Minor fixes applied:** none needed.

**Validation (this pass):** `yarn workspace @optimystic/db-core test` — 1910 passing. `yarn workspace @optimystic/quereus-plugin-optimystic test` — 1064 passing, 14 pending, smoke ok. `yarn lint:docs` — clean. `eslint` on the changed db-core source and test files — clean. The implementer's run of db-p2p (3537 passing) and upgrade-check (143 passing) was not repeated, because nothing changed since.
