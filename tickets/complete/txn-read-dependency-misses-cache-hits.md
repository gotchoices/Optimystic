description: A transaction that reads a block already sitting in its local cache now records that read, so it can no longer read stale data and be wrongly accepted at commit. Reviewed and completed.
files:
  - packages/db-core/src/transaction/read-dependency-collector.ts (shared per-txn read-dependency accumulator, max-revision-wins)
  - packages/db-core/src/transactor/transactor-source.ts (records via shared collector; getReadRevision; records only for blocks that exist)
  - packages/db-core/src/transform/cache-source.ts (per-id revision map; records deps on hit AND miss; transformCache/clear maintain revisions)
  - packages/db-core/src/collection/collection.ts (wires one shared collector; applyCommittedToCache/syncInternal thread the committed revision)
  - packages/db-core/src/transaction/coordinator.ts (passes recordCommitted's rev into applyCommittedToCache, success + partial-commit paths)
  - packages/db-core/src/transaction/index.ts (exports ReadDependencyCollector)
  - packages/db-core/test/read-dependency-cache-hit.repro.spec.ts (cross-boundary cache-hit repro)
  - packages/db-core/test/cache-source.spec.ts (read-dependency + collector cases)
  - packages/db-core/test/transactor-source.spec.ts (absent read records no dependency)
  - packages/db-core/docs/collections.md (transformCache call updated)
----
# Complete: read-dependency capture on cache hits

## What shipped

Reads flow `Tracker → CacheSource → TransactorSource`. Previously a read
dependency (`{ blockId, revision }` — the input to the optimistic-concurrency
stale-read check) was recorded in only one place: `TransactorSource.tryGet`, and
only on an actual source fetch. A cache hit serves a block without touching the
source, so any block served from cache recorded **no dependency**. Because the
cache persists across transactions on a `Collection` while dependencies clear at
each transaction boundary, a block read from cache in a later transaction was
silently left out of the read set — the validator never learned the transaction
depended on it, so a superseded revision could be read and still pass commit.

The fix introduces one `ReadDependencyCollector` per collection, owned by
`Collection.createOrOpen` and injected into **both** the `TransactorSource` and the
`CacheSource`, so a block read from either layer records a dependency. The collector
keys by block id and keeps the **highest** revision seen. `CacheSource` keeps a
per-id revision map (learned on a miss-load via a duck-typed `getReadRevision`,
re-emitted on every hit, advanced by `transformCache` when a commit folds new
content in). `transformCache(transform, revision)` now takes the committed revision;
`Collection.applyCommittedToCache` and the coordinator thread `recordCommitted`'s
returned revision into it on both the success and partial-commit paths.

## Review findings

Reviewed the full implement diff (`358e91a`) with fresh eyes against the fix
`1887a7f`, then the handoff. Scrutinised correctness, revision semantics, the
`transformCache` refactor, resource cleanup, type safety, cross-package impact, and
test coverage.

### Checked and correct
- **Revision semantics are consistent end to end.** The read path records
  `state.latest?.rev`; the local-commit path advances the cached revision via
  `recordCommitted` → `getNextRev` (= `actionContext.rev + 1`); the validator
  compares with strict `!==` against `currentState?.latest?.rev`. All three refer to
  the same `latest.rev` value, so the capture neither under- nor over-fires against
  the validator. Confirmed `recordCommitted` returns the same rev it stamps into
  `actionContext`, and `applyCommittedToCache` receives exactly that.
- **`transformCache` update-loop refactor is behaviour-equivalent.** Hoisting
  `cache.get(blockId)` out of the per-op loop yields the same `bump` count (one per
  op, only when cached) and the same guard as before; `revisions` advances only when
  the block is actually cached. Insert/delete/clear all maintain the `revisions` map
  in step with the `cache` map.
- **`ReadDependencyCollector` max-wins never downgrades** — unit-tested both
  directions.
- **Absent blocks record nothing** at both layers (CacheSource miss:absent, and
  TransactorSource's populated-but-blockless entry) — the contract is now uniform.
- **Cross-package impact: none.** `db-p2p` uses only the 3-arg `TransactorSource`
  (the new collector param is optional) and never calls `transformCache`/
  `CacheSource`; the now-required `revision` arg on `transformCache` has no external
  callers. `db-core` build clean.
- **Bootstrap header read** (recorded at `createOrOpen` time) is unchanged from prior
  behaviour — not a regression introduced here.

### Found → filed as follow-up tickets (major)
- **No end-to-end "stale cache-hit read is rejected at commit" test.** The two halves
  — capture (cache hit produces a dependency) and rejection (validator rejects a
  moved revision) — are each unit-tested, but nothing drives the full
  session→coordinator→validator chain through the production `createOrOpen` wiring.
  → `backlog/debt-e2e-stale-cache-hit-read-rejected.md`.
- **Phantom-read protection was incidentally removed** (deviation flagged by the
  implementer). Recording only for existing blocks drops the old accidental
  `blockId@0` dependency for absent reads, so reading "X does not exist" no longer
  invalidates the txn if X is later created. Defensible and not a regression against
  the validator's designed guarantee, but whether phantom protection is *wanted* is
  an isolation-level decision for a human. → `backlog/feat-phantom-read-protection.md`.

### Tripwires (parked, not tickets)
- **`coordinator.execute()` (the server-side engine path, coordinator.ts ~459/476)
  calls `recordCommitted` without `applyCommittedToCache`,** so its collection cache
  is not folded after commit. Pre-existing and untouched by this diff, and orthogonal
  to client-side read-dependency capture (execute()'s collections do not build the
  validated read set). With the new `revisions` map a subsequent cache-hit read there
  would record the pre-commit revision — harmless in all tested paths (suite green),
  because those recorded deps are not submitted for validation server-side. Noted here
  so a future reader knows execute() was consciously left unfolded; if execute() ever
  backs a long-lived cache whose reads are validated, fold the cache there too.
- **LRU eviction can leave a stale `CacheSource.revisions` entry** — benign, the next
  read is a miss that re-learns and overwrites. Already carries a `// NOTE:` at the
  `revisions` field.
- **`CacheSource.revisions` and `TransactorSource.readRevisions` are never pruned**
  (one small `id → number` entry per distinct id seen), exactly like the existing
  `generations` map. Bounded by the collection's distinct-block set; only worth acting
  on if that set grows large. Already NOTE-documented.

### Docs
- `docs/collections.md` updated its `transformCache` call to pass `newRev`. Note: that
  sample already used `this.source.trxContext` where the real code uses
  `actionContext` — pre-existing illustrative-pseudocode drift, not introduced here,
  left as-is. The read-dependency-on-cache-hit mechanism is documented thoroughly in
  code JSDoc on the new/changed files; no doc is now stale or wrong.

### Deviations from the ticket (both accepted)
1. The repro spec wires a shared collector into both layers (the realistic
   `createOrOpen` wiring) rather than the ticket's literal collector-less snippet,
   which would not have captured anything. The ticket explicitly left the assertion
   style to implementer discretion; the cross-boundary assertion is preserved.
2. `TransactorSource` records a dependency only for a block that exists (guarded on
   `block`, not merely on the entry). See the phantom-read-protection ticket above.

## Validation
- Build: `cd packages/db-core && yarn build` — exit 0, clean.
- Tests: `yarn test` — **1180 passing, 0 failing** (streamed to `test.log`).
