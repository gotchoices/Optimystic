description: A log block used to hold 32 entries however large they were, so a diary or table written with large entries built log blocks too big to copy between machines. The log now starts a new block once the current one is full by size as well as by count, and two new constants set the size limit every block must stay under. Review the change.
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/network/block-size.ts (new: `MAX_BLOCK_BYTES`, `BLOCK_TARGET_BYTES`), packages/db-core/src/network/index.ts, packages/db-core/src/chain/chain.ts (`ChainInitOptions.blockTargetBytes`, `Chain.add`, `Chain.takenBy`), packages/db-core/src/log/log.ts (`Log.getChainOptions`), packages/db-core/src/reactivity/config.ts (`BLOCK_FILL_SIZE_DEFAULT`), packages/db-core/src/reactivity/rotation.ts (`BlockFillTracker`), packages/substrate-simulator/src/reactivity.ts (comment only), packages/db-core/test/diary.spec.ts, packages/db-core/test/chain.spec.ts, docs/internals.md, docs/architecture.md, docs/reactivity.md, packages/db-core/docs/chains.md, packages/db-core/README.md
----
# A log block rolls over by size — review handoff

## What changed

**Two constants**, in `packages/db-core/src/network/block-size.ts`, re-exported through the network barrel and so from `@optimystic/db-core`; imported directly inside db-core:

- `MAX_BLOCK_BYTES` = `MAX_TRANSACTION_BYTES` (7.5 MiB) — the most one block may encode to (`jsonEncodedBytes`). Doc comment gives the two reasons that pin it: it fits the 8 MiB frame inside the same envelope reserve, and a single-entry block is never larger than the transaction that wrote it. Nothing enforces it yet — that is `a-writer-refuses-a-block-too-large-to-copy`.
- `BLOCK_TARGET_BYTES` = 1 MiB — the size past which a block holding more than one entry starts a new one.

**The roll-over rule.** `ChainInitOptions` gained an opt-in `blockTargetBytes`. `Chain.add` now asks `Chain.takenBy(block, entries, start)` how many entries a block takes: up to `EntriesPerBlock` (32), and, when a target is set, no further entry once the block holds one and the next would take its JSON past the target (the block's measured JSON, plus each entry's JSON, plus one byte per separating comma). A block holding no entry always takes the next one. The same function decides for the existing tail and for every new block in the loop, so a multi-entry `add` packs by both count and size. `Log.getChainOptions` sets `blockTargetBytes: BLOCK_TARGET_BYTES`, so every log (both `Log.open` and `Log.create`) uses it; a plain `Chain` without the option behaves exactly as before and never serializes anything. Decision recorded in `packages/db-core/docs/chains.md` §Block roll-over.

**Retry identity.** The decision is a pure function of the tail block's content and the entries, and new block ids still come only from `createDataBlock` (the log's `newDataBlockId`, fed by `Collection.logAppendBlockIds`). `retry-resends-identical-transforms.spec.ts` passes unchanged.

**Reactivity.** Checked: `BlockFillTracker` is used in production only by `ReactivityOriginationManager.trackBlockFill` (db-p2p), which only logs its warm-up/filling signals; live rotation is detected by `observeTailCommit` from a commit naming a new tail. So nothing treats the count as exact for correctness. Comments in `config.ts` and `rotation.ts` and the `block_fill_size` rows/paragraphs in `docs/reactivity.md` now say the count is an upper bound and a large-entry log warms up late or not at all. While there, fixed a stale "(default 56 of 64)" in §Anticipatory warm-up to "24 of 32". The substrate simulator's rotation note now says its figures are an upper bound only for small-entry logs.

**Docs.** `docs/internals.md` §A transaction's size limit: the "Two related limits" paragraph (which cited the now-split backlog bug) is replaced by the block limit, both constants, the roll-over rule, the older-oversized-tail behaviour, and the four sibling tickets still open. The retry-identity bullet's "(32 entries)" now mentions the size rule. `docs/architecture.md`, `packages/db-core/README.md`, `packages/db-core/docs/chains.md` updated. `yarn lint:docs` is clean.

## Tests added

- `packages/db-core/test/diary.spec.ts` — "starts a new log block by size, so large entries never build a block too large to copy": the ticket's reproduction. 32 `Diary.append`s of 300 KB over `TestTransactor`; walks the stored log from `headId` and asserts every block encodes to at most `BLOCK_TARGET_BYTES` or holds exactly one entry, then that the diary reads back all 32 entries in order. Fails on the old code (one 9.8 MB block of 32 entries). Runs in well under a second.
- `packages/db-core/test/chain.spec.ts` — "packs several entries added at once by size as well as by count": a raw `Chain` with a 3,600-byte target and one `add` of nine entries (eight of ~1 KB, one 5 KB in the middle); asserts the per-block entry counts `[3, 1, 1, 3, 1]`, the invariant, and order. This is the multi-entry loop the ticket required; note no production caller adds several entries at once today (`Log.addActions`, `addCheckpoint`, `addInvalidation` each add one), so a reviewer applying the "tests must pay" bar may judge it cuttable.

## Validation run

- `yarn build` (root): clean.
- `yarn workspace @optimystic/db-core test`: 1910 passing.
- `yarn workspace @optimystic/db-p2p test`: 3537 passing, 74 pending (env-gated).
- `yarn workspace @optimystic/upgrade-check test`: 143 passing.
- `eslint` on every changed source/test file: clean. `yarn lint:docs`: clean.

## Known gaps and things to look at

- **Measured size is approximate by design.** It excludes what the log's `newBlock` hook adds to a new block after the decision (`priorHash`, ~60 bytes) and the entry's `blockIds`, written by `Log.addActions` after `Chain.add` via `updateAt`. Both are documented at `Chain.takenBy`; slop is small against the target-to-`MAX_BLOCK_BYTES` gap. A single-entry block's whole entry, `blockIds` included, is in the pend.
- **Cost.** One `jsonEncodedBytes` of the tail block, plus one per added entry, on every log append; repeated on each retry attempt of `Collection.syncAttempts` (the snapshot tracker is rebuilt per attempt). `NOTE:` tripwire at the measuring site in `Chain.takenBy`.
- **Older oversized tails** stop growing (next append rolls over) but are never shrunk, and one already past the frame stays uncopyable — documented, not fixed, per the ticket.
- **`BlockFillTracker` drifts out of step** for a log that rolls over by size: it counts commits and resets only on its own count, not when `observeTailCommit` sees a rotation. Harmless today (signal-only), so left alone; if the warm-up is ever acted on, reset the tracker from `observeTailCommit`'s rotation branch.
- **Entries that are not plain JSON values** (a `Uint8Array` inside an action, say) are measured as `JSON.stringify` renders them, which is also what the wire carries, so the measure matches the frame.
- The four sibling tickets (`a-tree-node-splits-by-size`, `a-remote-read-reply-fits-one-message`, `a-block-copy-travels-unencoded`, `a-writer-refuses-a-block-too-large-to-copy`) take their constants from `packages/db-core/src/network/block-size.ts`; when they land, the "What is still open" paragraph in `docs/internals.md` §A transaction's size limit should be trimmed to match.
