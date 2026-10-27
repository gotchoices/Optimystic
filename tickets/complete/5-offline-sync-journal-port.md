description: The offline queue now writes through a journal port at every step of an entry's life, can put an entry back after a restart, and the collections gained the operations that restore needs; reviewed, with three small defects fixed inline.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#persistence
files: packages/db-core/src/offline/journal.ts, packages/db-core/src/offline/queue.ts, packages/db-core/src/offline/entry.ts, packages/db-core/src/offline/index.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/segments.ts, packages/db-core/test/offline-queue.spec.ts, packages/db-core/test/collection-segments.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-mode.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-p2p/test/offline-queue-mesh.spec.ts, docs/offline-sync.md, docs/internals.md, docs/debugging.md
difficulty: hard
----

Stage 5 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages), part one of three: the db-core half of persistence, implemented in `ticket(implement): offline-sync-journal-port` and reviewed here. Part two (`offline-sync-journal-store`) implements the port over a key-value store in the plugin; part three (`offline-sync-journal-restore`) restores journaled entries after a restart through `OfflineQueue.restore`.

## What landed

**The port**: `IOfflineJournal` in `packages/db-core/src/offline/journal.ts` with `queued(record)`, `driving(entryId, state)` and `settled(status)`, over `JournalEntryRecord`, `JournalDriveState` and `JournalSettledStatus`. It speaks only entry ids, collection ids, actions and `InFlightAttempt`s.

**The queue** (`OfflineQueue` in `packages/db-core/src/offline/queue.ts`): `OfflineQueueOptions.journal` replaces the old `recordAttempt` hook. `enqueue` is async and writes the entry record before admitting the entry, unsealing every collection (`Collection.unseal`) and rethrowing when the write fails. The drive record is written before each send (a throw aborts the cycle with nothing sent), after a partial commit and after an identity renewal (a throw is logged and the drain goes on). Each terminal status is written before it is emitted (a throw is logged). `restore(init, stage)` holds the drain, registers the entry by its recorded sequence number, stages each collection through the caller's callback, and admits or settles the entry by what the callback answered.

**The collection**: `sealedActions`, `unseal`, `holdsCommitted`, `restoreSealed`, and `SegmentList.insert` and `SegmentList.unseal`. `replayActions` takes an optional entry id whose refusal is recorded but not reported, so `restoreSealed` can return the restored segment's own refusal.

**Callers**: `OfflineMode.enqueue` and `TransactionBridge.sealIntoQueue` are async; a journal failure lands in the bridge's existing failed-commit rollback. The db-p2p mesh spec moved to a journal double.

**Docs**: `docs/offline-sync.md` §What is journaled, §Write ordering, §Identity across attempts, §Restore after a restart; `docs/internals.md` §The offline queue; `docs/debugging.md` `offline` namespace row.

## Review findings

**Read first**: the whole diff of `ticket(implement): offline-sync-journal-port`, then the current `queue.ts`, `journal.ts`, `entry.ts`, `segments.ts` and the collection's new methods in full, then the handoff. Every decision the handoff asked to be checked was traced in the code (identity renewal written once by its two callers, sequence number not consumed by a refused enqueue, the `restoring` guard on `discard`, the four `stage` outcomes, the hold's park-and-signal protocol including the loop's `finally`, dispose during a restore, position flags on insertion, the wake on `takeHold`). The downstream restore ticket's stated contract (`holdsCommitted`, `restoreSealed` with `{ before }` or `'last'`, `queue.restore(init, stage)`) matches what landed.

**Defects found and fixed inline** (minor, each a few lines):

- **A non-refusal error out of `restoreSealed`'s replay left the inserted segment in the collection.** The queue's rollback (`unregisterRestored`) drops only segments whose `stage` answered, so the throwing collection kept a sealed segment the queue did not list. The downstream restore ticket plans exactly this path: `BlockUnavailableError` out of `restoreSealed` propagates, the queue rolls back, and the record is retried later, which would then have met its own segment as "already sealed", and the stranded segment would have made the next `commitHead` of the real head throw `not-head`, a drain-stopping defect. `restoreSealed` now drops the segment it inserted before rethrowing; the tracker is left half re-staged, the state a throwing refresh replay already leaves (backlog `debt-a-failed-refresh-can-leave-a-collection-half-restaged`), and the next replay rebuilds it. Doc comment and `docs/offline-sync.md` §Restore after a restart updated. Pinned by a new case in `packages/db-core/test/collection-segments.spec.ts` over a transactor whose `get` rejects: the error propagates, the segment is gone, and the same entry restores once the read is answered.
- **A restore running during an enqueue's journal write could lower `nextSeq` or hand two entries one sequence number.** `enqueue` took `seq = nextSeq` before awaiting the journal and assigned `nextSeq = seq + 1` after, so a restore that raised `nextSeq` meanwhile was undone. `enqueue` now reserves the number before the write and hands it back on failure only when nothing took a later one since; the "a refused enqueue takes the same seq" assertion still holds. Conditional in practice (restores run at start-up), but the fix is two lines and removes a class of duplicate sequence numbers.
- **The all-already-committed restore merged `undefined` classes over classes the drive record knew.** `admitRestored` kept a known class per collection, as the handoff said, but then built a fresh durability with every class `undefined` and passed it to `committed`, whose merge (`recordCollectionDurability`) turns a known class beside an unknown one into unknown. It now settles from `entry.committed` alone, which already lists every collection. The existing test's expectation (unknown classes when the drive record knew none) is unchanged.

**Test hygiene**: the queue spec's `stagedSegment` helper cast an `Error` to `never` to satisfy `RestoredSegment`; it now takes `ActionRefusedError | undefined`, which is what `restoreSealed` returns. The implementer's tests were otherwise read as code under review: the `SegmentList` unit case partly restates the implementation (unseal and insert mechanics) but also covers every refusal branch cheaply, so it stays; no other test was cut.

**Tripwires recorded** (fine now; a `NOTE:` at each site):

- `OfflineQueue.onSealedRefused`, unknown-entry branch: a segment `enqueue` has sealed but not yet registered (journal write outstanding) can be refused by a head commit's replay meanwhile; the refusal stays recorded on the segment and the loop's head check fails the entry once it reaches the head, later than a pending refusal would but never lost.
- `OfflineQueue.whenDrained`: a restore in progress is not waited for, so on an empty queue it answers at once while the restore is about to register an entry. Fine while restores run at start-up.
- `OfflineQueue`, restoring section: `queue.ts` is 1300 lines (`wc -l`); the restore machinery is the section to extract if the file grows again.
- Carried over from the implement handoff, unchanged: `Collection.holdsCommitted` (checkpoints) and `OfflineQueue.restoring` (a `discard` of another entry chained during `stage`).

**Checked and found correct** (no change): the write-then-admit order and its unseal rollback against a head commit that folds and replays meanwhile (the unseal then moves actions whose effects the replay already put in the tracker, which is the state `act` leaves); the hold protocol under every loop state (never started, parked on an empty queue, mid-submission with the pending wake, waiting out the timer, stopped on a defect, disposed mid-park, two restores chained across the loop's exit); `claimRemoval` before `journalSettled` in `committed`, so `whenDrained` and `discard` see a settled entry gone while the status is still being written; `driveState` laying the attempts about to go over the retained ones; `insertBySeq` re-deriving the position flags; the bridge's rollback path for a rejected enqueue (`afterFailedCommit`'s clean-rollback arm, with `restorePending` taking its replay arm since the segment version moved). No accepted-tradeoff `NOTE:` at any touched site was contradicted.

**Not filed**: nothing reached the filing bar. The open tickets touching these files are the two downstream stage-5 tickets, whose contracts were checked rather than amended.

## Validation run

- db-core: `tsc --noEmit` clean; full suite 1994 passing (`tickets/.logs/offline-sync-journal-port.review.db-core.test.log`); `yarn workspace @optimystic/db-core build` clean.
- quereus-plugin-optimystic: `tsc --noEmit` clean; full suite 1099 passing, 14 pending, smoke ok (`tickets/.logs/offline-sync-journal-port.review.plugin.test.log`).
- db-p2p: `test/offline-queue-mesh.spec.ts` 2 passing.
- Root `yarn lint` clean; `yarn lint:docs` clean (48 documents, all citations resolve).
- Not run, as in the implement pass: the full db-p2p suite (only a test file changed there), `yarn check:rn`, and the env-gated integration specs.
