description: CollectionChangeEvent can be silently dropped on two StorageRepo recovery paths (get()-driven promotion and failed partial multi-block commit), causing a reactive consumer to miss a wake
prereq: optimystic-vtab-reactive-watch-bridge
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md
----

# Change events silently dropped on StorageRepo recovery paths

## Problem

`StorageRepo` (the per-collection `IBlockChangeNotifier` origin added in
`optimystic-block-change-notification`) emits a `CollectionChangeEvent` only from
the `commit()` happy path, for blocks newly committed on `success: true`. Two
recovery/promotion paths mutate durable storage via `internalCommit` **without**
emitting an event. For a reactive consumer (the Quereus vtab bridge landing in the
prereq ticket) a dropped event is a **missed wake**: the consumer keeps serving a
stale view until some unrelated later commit on the same collection happens to fire.

### Path 1 — `get()`-driven promotion (already flagged by the implementer)

`StorageRepo.get` calls `internalCommit` to promote a stranded, context-proven
non-tail block during a *read* (`storage-repo.ts` ~line 98). That return value is
ignored, so a block that becomes durably committed during a read fires no event.

### Path 2 — failed partial multi-block commit (found in review)

In `commit()`, if `internalCommit` throws on block *N* of a multi-block batch,
blocks `1..N-1` have already landed durably and were added to `collectionBlocks`,
but the method returns `{ success: false }` *before* `emitCollectionChanges`. On the
idempotent retry (same `actionId`/`rev`), blocks `1..N-1` fall into the `alreadyDone`
partition and `continue` — so they **never** reach `collectionBlocks` again and their
event is lost permanently. The miss only escapes notice when every block of a given
collection landed in the failed attempt (a same-collection block committing on the
retry would re-wake the consumer), so it is narrow but real.

## Why this wasn't fixed inline

Changing emission semantics ("emit only on full success, commit-path only") is a
design decision that depends on the not-yet-existent consumer's tolerance:

- **Option A — emit eagerly**: emit for whatever landed even when the overall commit
  returns failure, and emit from the `get()` promotion path. Maximizes liveness;
  consumer must tolerate events for commits later reported as failed and for
  read-driven promotions.
- **Option B — rely on reconciliation**: keep success-only emission and have the
  consumer periodically reconcile (re-read) so a dropped wake self-heals within a
  bounded window. Simpler notifier, weaker latency guarantee.

Pick once the consumer (reactive strand bridge) defines whether a missed wake is a
correctness bug or a bounded-staleness annoyance, then make `StorageRepo` match.

## Acceptance

- Decide and document the emission guarantee (eager vs. success-only + reconcile).
- Whichever is chosen, both paths above behave per that guarantee.
- Tests: a `get()`-promotion-emits (or documented-no-emit) case, and a
  partial-commit-then-successful-retry case asserting the consumer is woken exactly
  per the chosen guarantee.
- Update the "Known silent-drop paths" note in `docs/internals.md` to match.
