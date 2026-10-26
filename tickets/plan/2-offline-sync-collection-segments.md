description: Let a collection keep its not-yet-sent changes as an ordered series of separately committed transactions, each of which can be sent, dropped or replayed on its own, so the offline queue can live inside the collections instead of beside them.
architecture: docs/offline-sync.md#where-the-queue-lives-segments-in-the-collections
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/test/, docs/offline-sync.md, docs/internals.md
difficulty: hard
----

Stage 2 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages). No plugin change; unit tests in db-core over `TestTransactor`.

## What is wanted

A `Collection`'s staged actions (`getPendingActions`) become an ordered list of **sealed segments**, each owned by a queue entry id, followed by the **open segment** of the current transaction. The doc's [§The segment model](../../docs/offline-sync.md#the-segment-model) gives the shape and the three invariants (order, head alignment, one entry one action list per collection). Proposed additions (names illustrative in the doc; settle them here):

- `sealPending(entryId)` — close the open segment into a sealed one; no-op if nothing was staged.
- `sealedEntries()` — entry ids of sealed segments, in order.
- `dropSealed(entryId)` — remove a segment and rebuild the tracker by replaying what remains.
- `commitHead(entryId, options)` — commit exactly the head segment as one log entry, reusing the sync loop (retries, in-flight identity, own-entry completion) restricted to that segment.

Behaviour to specify and build:

- **Segment-aware replay** ([§Replay with a per-segment refusal](../../docs/offline-sync.md#replay-with-a-per-segment-refusal)): a `TreeGuardRefusedError` while replaying sealed segment `E` excludes `E`, records the refusal, continues with the next segment, and reports `(E, error)` through a callback the collection is constructed with. A refusal in the open segment keeps today's behaviour.
- **Open-segment-only snapshot and restore** ([§Rollback and savepoints only touch the open segment](../../docs/offline-sync.md#rollback-and-savepoints-only-touch-the-open-segment)): `snapshotPending` / `restorePending` capture and restore the open segment only; when sealed segments changed since capture the restore replays sealed-then-open, otherwise it reinstates captured transforms verbatim (keeping the invented-header case `restorePending` already documents). The staged-base pins (`Tracker` `BasePins`, see internals.md *Staged Edits Keep Their Base*) must travel correctly through both arms.
- **The head commit does not hold the latch across the network** ([§The drain does not hold the collection latch across the network](../../docs/offline-sync.md#the-drain-does-not-hold-the-collection-latch-across-the-network)): build the attempt on a snapshot tracker (committed state + head segment) under the latch, release it while the transact is in flight, retake it to apply the outcome — remove the head segment, fold committed transforms into the cache, adopt the revision, then replay what remains. Fold and adoption before the replay (the order `updateInternal` requires, and the precondition of the `NOTE` after a successful attempt in `Collection.syncAttempts`, which this makes live).
- The log entry timestamp for a head commit is a caller-supplied value (the entry's local commit time), passed where `Collection.syncInternal` mints one.

With no sealed segment, every existing path must behave exactly as today.

## Edge cases the plan must cover

Staging into the open segment while a head commit is in flight; a refresh that adopts a rival's revision while a head commit is in flight; a head commit that fails after staging continued; `dropSealed` of a non-head segment; a refusal in a sealed segment discovered by a refresh triggered by a live read; an invented collection (header staged in the tracker) with sealed segments; the in-flight action id (`beginInFlightAction`) and own-entry completion when the retrying segment is the head and others are sealed behind it; byte-identical retries (`packages/db-core/test/retry-resends-identical-transforms.spec.ts` must still hold).

This is large: the planner should split it (for example: segment bookkeeping + segment-aware replay; snapshot/restore; the latch-releasing head commit) into `prereq:`-chained implement tickets.

## Done when

The tests the plan names pass, existing db-core tests pass unchanged, and docs/internals.md describes the segment model where it describes staged actions and replay; docs/offline-sync.md marks the stage implemented.
