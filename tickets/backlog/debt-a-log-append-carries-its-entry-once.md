description: When a write's log entry is added to a log block that already holds earlier entries, the write sends that entry to every member twice — once as it is added and once more to fill in the list of blocks it changed — which makes the write larger on the wire and in each member's stored record than it needs to be.
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/log/log.ts (`Log.addActions`), packages/db-core/src/chain/chain.ts (`Chain.add`, `Chain.updateAt`), packages/db-core/src/transform/tracker.ts (how update operations are recorded)
repro: verified
tradeoffs: A large write's entry usually lands in a new log block, where it is carried once already, so this mostly helps small writes, whose pends are dominated by per-request overhead rather than bytes; and any fix changes the operations a write records, which every retry must still reproduce byte for byte.
----
# A log append carries its entry once

`Log.addActions` adds the entry to the log's tail with an empty `blockIds`, then calls `Chain.updateAt` to rewrite the same entry with `blockIds` filled in, because the blocks the write changed include the log blocks the add itself touched. When the add puts the entry in a new block, the rewrite changes the new block in place and the pend carries the entry once, inside that block. When the add appends to a tail block that already holds entries, the tracker records two update operations on that block — the append (`[entries, i, 0, [entry]]`) and the rewrite (`[entries, i, 1, [entryWithBlockIds]]`) — so the pend carries the whole entry twice, and each member stores both operations in the pending record and applies both.

Seen with the large-value bench (`packages/quereus-plugin-optimystic/test/large-value-commit-cost.bench.mjs`) and a dump of the writer's pends: one 256 KiB value per transaction, whose ~350 KB entry fits beside the previous one in the tail, sends the log tail as `[entries,1,0,349946] [entries,1,1,350037]`, and the transaction expands to 4.01× its raw bytes where 2.67× is base64 times the tree's and the log's copy. A small SQL write takes the same path whenever the tail has room, which is nearly every write; its log entry is roughly half of its pend, so the pend is about a third larger than it needs to be (inferred from the same code path, not measured for small rows).

Expected behaviour: the pend carries each log entry once, with its `blockIds`, whether the entry starts a new block or is appended to the tail. The persisted log content is unchanged — only the operations that produce it.

Constraints:

- The append stays a fixed function of the write and the revision it requests (internals *A write's log append is a fixed function of the write and the revision it is requesting*): two attempts at one `(action id, revision)` must produce byte-identical transforms.
- `blockIds` must still name every block the write changes, the log blocks the append touched included.
- Stored pending records and revision transforms written by earlier builds, which carry both operations, must still apply (`packages/upgrade-check`).
