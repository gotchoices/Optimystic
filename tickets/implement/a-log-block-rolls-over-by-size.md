description: A log block holds 32 entries however large they are, so a diary or table written with large entries builds log blocks too big to copy between machines (32 appends of 300 KB make a 9.8 MB block, against an 8 MiB message limit). Make the log start a new block once the current one is full by size as well as by count, and set the size limit every block must stay under.
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/chain/chain.ts (`EntriesPerBlock`, `Chain.add`, `ChainInitOptions`), packages/db-core/src/log/log.ts (`Log.getChainOptions`), packages/db-core/src/network/transaction-size.ts (`MAX_TRANSACTION_BYTES`, `jsonEncodedBytes`), packages/db-core/src/collection/collection.ts (`Collection.logAppendBlockIds`), packages/db-core/src/reactivity/config.ts (`BLOCK_FILL_SIZE_DEFAULT`), packages/db-core/src/reactivity/rotation.ts (`BlockFillTracker`), packages/db-core/test/retry-resends-identical-transforms.spec.ts, docs/internals.md, docs/architecture.md, docs/reactivity.md, packages/db-core/docs/chains.md, packages/db-core/README.md
repro: verified
----
# A log block rolls over by size

## What is wrong

A collection's log is a chain of blocks; `Chain.add` in `packages/db-core/src/chain/chain.ts` starts a new tail block only when the current one holds `EntriesPerBlock` (32) entries. Every log entry carries its action — for a diary the written data itself, for a SQL write the rows — so the block's size is 32 times the average entry, with nothing bounding it.

Reproduced (a throwaway spec over `TestTransactor`, since deleted): 32 `Diary.append` calls of a 300 KB string produce one log block whose JSON is 9,837,452 bytes, above `MAX_BLOCK_MESSAGE_BYTES` (8,388,608) in `packages/db-p2p/src/protocol-limits.ts`. Each append was a valid transaction well under `MAX_TRANSACTION_BYTES`; the block was not. Every path that copies a whole block to another machine sends it in one message under that cap (block-transfer push, sync archive answers, remote `get` replies), so such a block can never be replicated, repaired or read remotely. Nothing fails at write time.

The other carriers of a block are fixed in sibling tickets (`a-block-copy-travels-unencoded`, `a-remote-read-reply-fits-one-message`); tree nodes in `a-tree-node-splits-by-size`; the writer-side backstop in `a-writer-refuses-a-block-too-large-to-copy`. This ticket sets the limits they all use and fixes the log.

## The limits

Two constants, exported from db-core (suggested home: a new `packages/db-core/src/network/block-size.ts` beside `transaction-size.ts`, re-exported from the package index; import it directly inside db-core, never through a barrel — see Common Pitfalls §6 in `docs/internals.md`):

- `MAX_BLOCK_BYTES` — the most one block may encode to, measured as `jsonEncodedBytes` (UTF-8 length of `JSON.stringify`). Set it equal to `MAX_TRANSACTION_BYTES` (7.5 MiB). Two reasons that pin the value: a block at this size plus the wrapping it travels in (a `get` reply entry's state, an archive revision entry, a push's metadata and proof) fits the 8 MiB frame inside `TRANSACTION_ENVELOPE_RESERVE_BYTES`; and a block holding a single entry is never larger than the transaction that wrote it (the entry is inside that transaction's pend, either as the new tail block's insert or as the update operation that appends it), so no block a single transaction can produce on its own exceeds it.
- `BLOCK_TARGET_BYTES` — the size past which a block holding more than one entry starts a new block (the log here; tree nodes reuse it in `a-tree-node-splits-by-size`). Recommended 1 MiB: it keeps one block's copy far under the frame, so a `get` reply carrying a few blocks still fits one message in the ordinary case, and keeps a single replication push short on slow relayed links (see backlog `bug-a-large-replication-push-stalls-a-relayed-attach`); and it is 32 entries of 32 KiB, so logs of ordinary small entries keep rolling over by count exactly as today. The cost is that logs of large entries spread over more blocks, so walking them reads more blocks.

## The roll-over rule

When appending an entry, start a new tail block if the current tail already holds `EntriesPerBlock` entries, **or** if it holds at least one entry and its encoded size plus the entry's would exceed `BLOCK_TARGET_BYTES`. An empty tail always takes the entry, so an entry larger than the target sits alone in its own block. Consequence: a log block either holds one entry (and is then no larger than the transaction that wrote it) or is at most about `BLOCK_TARGET_BYTES`. The entry's `blockIds` list is filled in after `Chain.add` (`Log.addActions` calls `updateAt`), so it is not in the measured size; that slop is small against the gap between the target and `MAX_BLOCK_BYTES`, and a single-entry block's whole entry, list included, is inside the pend.

Requirements:

- The decision is a pure function of the tail block's content and the entry, so a retry of the same action at the same revision makes the same decision and sends byte-identical transforms. `Collection.logAppendBlockIds` already hands back the ids an earlier attempt minted; a roll-over by size mints through the same `newDataBlockId` source. `retry-resends-identical-transforms.spec.ts` must keep passing.
- `Chain.add` takes several entries at once; pack them by both count and size in its loop, not only the first.
- Keep `Chain` generic: the size rule is something the log asks for (for example a `ChainInitOptions` field the log's `getChainOptions` sets), or applies to every chain — implementer's call, but say which in `packages/db-core/docs/chains.md`.
- Measuring the tail block costs one serialization per append. The commit path already serializes every touched block once to digest it (`computeBlockContentDigests`), so this is the same order of cost; leave a `NOTE:` tripwire at the measuring site (if appends to large logs ever show this in a profile, keep a running byte count instead).
- An existing oversized tail written by an older build stops growing: the next append rolls over. Nothing shrinks it; it stays uncopyable. Note this in the docs, nothing more.

## Reactivity

`BLOCK_FILL_SIZE_DEFAULT` in `packages/db-core/src/reactivity/config.ts` is documented as "the commit counts the log actually rotates at". With a size rule a log of large entries rotates earlier than that count. Check that `BlockFillTracker` (`packages/db-core/src/reactivity/rotation.ts`) only drives the anticipatory warm-up signal and that live rotation is still detected from observed tail changes (`observeTailCommit`, see `docs/internals.md` *Tail rotation is now live*); if so, correct the comment and the `block_fill_size` rows in `docs/reactivity.md` to say the count is an upper bound, and say a large-entry log warms up late or not at all. If anything treats the count as exact for correctness, raise it in the review handoff.

## Docs

- `docs/internals.md` §A transaction's size limit: replace the "Two related limits" paragraph's reference to this bug with the two constants and the roll-over rule, and point at the sibling tickets' sections once they land. Also the "id of the data block … when the current log block is full (32 entries)" line in the retry-identity bullet.
- `docs/architecture.md` ("32 entries/block"), `packages/db-core/docs/chains.md`, `packages/db-core/README.md`.

## TODO

- Add `MAX_BLOCK_BYTES` and `BLOCK_TARGET_BYTES` with doc comments giving the reasoning above; export them.
- Implement the size-aware roll-over in `Chain.add` (single- and multi-entry) and enable it for the log.
- Regression test (the reproduction, at the lowest layer that shows it): 32 `Diary.append`s of 300 KB over `TestTransactor`; assert every block encodes to at most `BLOCK_TARGET_BYTES` or holds exactly one entry, and that the diary still reads back all 32 entries in order. Keep it cheap (it ran in under a second).
- Check the reactivity fill tracker as described and fix its comments/docs.
- Update the docs listed above.
- Run `yarn build`, `yarn test` for db-core and db-p2p, and `yarn workspace @optimystic/upgrade-check test`.
