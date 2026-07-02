description: When a transaction reads data that is already sitting in its local cache, the system forgets to record that it read that data — so a transaction can read stale information and still be wrongly accepted as valid.
files:
  - packages/db-core/src/transactor/transactor-source.ts (tryGet — the only place a read dependency is recorded, ~line 33)
  - packages/db-core/src/transform/cache-source.ts (serves cached blocks without calling the underlying source, ~lines 20-34)
  - packages/db-core/src/collection (Collection / Tracker.tryGet read path)
difficulty: medium
----

# Read-dependency capture misses all cache hits (snapshot-isolation hole)

## The bug

Reads flow Tracker → CacheSource → TransactorSource. A `ReadDependency` (the record
of "this transaction observed block X at revision R") is recorded in exactly one
place: `TransactorSource.tryGet`. But `CacheSource` returns cached blocks *without*
calling the underlying `TransactorSource`. So any block served from the cache
produces **no read dependency**.

A block can be in cache because it was read in a prior transaction on the same
`Collection` instance, or because it was refreshed via `applyCommittedToCache`. In
all those cases the optimistic-concurrency validator never sees the read, so its
stale-read check cannot fire: a transaction can read stale cached state and still
pass validation. Snapshot isolation is currently only "enforced" by the luck of
cache misses.

## Expected behavior

Every read a transaction performs — cache hit or miss — must contribute a read
dependency (block id + observed revision) that the validator can check against
committed state, so a transaction that read a now-superseded revision is rejected.

## Suggested direction (hint, not a mandate)

Record read dependencies *above* the cache: either have `CacheSource` report every
read (id + cached revision) to a listener that accumulates dependencies, or capture
dependencies in `Collection`/`Tracker.tryGet` where every read converges regardless
of which source ultimately serves it. Make sure a block read once from source and
later re-read from cache does not lose or downgrade its recorded revision.

Severity: HIGH — this is the headline correctness guarantee of the transaction layer.
