description: A frequently-read block used to get slower over a long session because every read rebuilt it by replaying every past change; reads now reuse a cached built result and stay fast, with a guard that discards the cache the moment the underlying block changes.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/test/cache-source.spec.ts, packages/db-core/test/tracker-read-perf.spec.ts
difficulty: medium
---

## What was built

`Tracker.tryGet`'s source+updates read path was O(block size + accumulated ops) on every read: it
re-fetched the source block and replayed the entire `updates[id]` op list each time. A hot block
(collection header, log tail) that gets one update per operation and is read once per operation made
reading it O(ops²) over a session.

The fix memoizes the materialized (source block + all `updates[id]` ops) result per id inside the
`Tracker`, guarded by a per-id **generation** counter the source exposes. `CacheSource.getGeneration(id)`
returns a monotonic counter bumped at every content-changing site (miss-load, `clear`, and each
delete/insert/update inside `transformCache`); the `Tracker` stamps each memo with the generation it
was built at and drops the memo the moment the source's generation for that id advances. Reads become
O(block size) (the unavoidable defensive clone) with no op replay. Sources that do not expose
`getGeneration` fall back to always-replay (no memo).

See the source files' doc comments for the full mechanism; the two non-obvious design decisions
(post-load generation stamp; `update` does not refresh `memo.gen`) are documented inline at
tracker.ts and were verified during review (below).

## Review findings

**Checked**

- **Read the implement diff (`git show f0e7254`) with fresh eyes before the handoff.** Traced every
  memo lifecycle transition (create / hit / fold-on-update / drop-on-insert-delete-reset / invalidate-on-drift)
  and confirmed the invariant `memo.block == base source content + full updates[id] list` is preserved
  at all five mutation sites.
- **The two flagged deviations from the implement ticket's pseudocode** — the crux the implementer
  asked to be sanity-checked:
  - *Post-load generation stamp.* Correct. `CacheSource` bumps the generation during a miss-load, so
    stamping with the pre-load value would leave the memo one generation behind and force a needless
    reload on the very next read. Correctness is identical either way (pre-load stamping is only
    wasteful, never wrong); post-load is the perf-correct choice.
  - *`update` leaves `memo.gen` untouched.* Correct, and this one **is** a correctness matter, not
    just perf. `memo.gen` records the generation of the base source content, not of the ops. Refreshing
    it to the current source generation would, when the source content drifted between materialization
    and the update, mark stale base content as fresh and serve wrong data on the next read. Leaving it
    untouched keeps the drift check honest.
- **The whole-program safety invariant** ("every cache content mutation for an id either bumps its
  generation or resets the tracker"). Walked the callers: `collection.ts` routes all external content
  change through `sourceCache.clear(...)` (bumps unconditionally, even for evicted/absent ids) or
  `sourceCache.transformCache(...)` (bumps every cached mutation), and both the sync path
  (`replayActions` → `this.tracker.reset()` before `transformCache`) and the coordinator path
  (`applyCommittedToCache` documented "call BEFORE resetting the tracker") clear the memo around the
  drift. `createReadTracker` shares the same `CacheSource`, so a shared-cache drift bumps the generation
  every read tracker observes. Confirmed no other path mutates a cached block object in place: `tryGet`
  returns `structuredClone`, `transformCache` clones inserts, and no caller retains a pre-clone reference.
- **`getGeneration` duck-typing collision.** `CacheSource` is the only class in the repo that defines
  `getGeneration` (grep-confirmed), so `Tracker.sourceGeneration`'s duck-type probe cannot latch onto an
  unrelated method with different semantics.
- **Extra clone on the materialize path.** New code returns `structuredClone(block)` on the ops path
  where the original returned the loaded block directly. This is required (the memo must retain an
  un-handed-out copy) and only costs a second clone on the rare rematerialize; steady-state reads
  (memo hit) do exactly one clone. Not a regression. For a non-cloning plain source it is strictly
  safer (the original leaked a mutable reference).
- **Build + full suite.** `yarn build` exit 0; `yarn test` 1136 passing (was 1135 + the new test
  below). Repo `lint` is a no-op stub ("Lint not configured"); `tsc` is the real type gate and passed.

**Found + fixed inline (minor)**

- **Test-coverage gap on the crux.** The existing "re-materializes on source drift" test never calls
  `update()` between materialization and the drift, so a future edit that wrongly refreshed `memo.gen`
  inside `update()` (the exact hazard the implementer deliberately avoided) would serve stale base
  content and **no test would catch it**. Added
  `tracker-read-perf.spec.ts` → "an update after external source drift does not mask the stale base
  (gen is not refreshed)", which drifts the source, folds an op via `update`, and asserts the next read
  reloads the new base and replays both ops. Verified it exercises the crux (fails if `gen` were
  refreshed). Suite now 1136 passing.

**Found — major (none).** No correctness defects surfaced; the memo invariant holds at every mutation
site and the drift guard is sound.

**Tripwire (parked, not a ticket)** — carried over from implement, verified as genuinely conditional:

- `CacheSource.generations` is never pruned — one small `(id → number)` entry per distinct block id
  ever touched, retained past LRU eviction. Bounded by the number of distinct blocks a collection sees
  over its lifetime; benign now. If it ever grows large enough to matter, evict the generation entry
  alongside the LRU entry (safe: a reload re-bumps from absent/0, forcing a re-materialize). Parked as
  a `NOTE:` at the declaration site in cache-source.ts:17.

**Not asserted (as designed):** timing is not measured — the perf tests count source fetches and op
replays, not wall-clock ratios (timing ratios are CI-flaky). The scaling assertions (fetch count
independent of op count K for K=100 vs K=2000) are the regression floor.

## How to validate

- `cd packages/db-core && yarn test` — 1136 passing.
- `yarn build` — exit 0.
- Perf/correctness coverage lives in `packages/db-core/test/tracker-read-perf.spec.ts` (memo scaling,
  clone isolation, source-drift re-materialize, the new gen-not-refreshed crux test, delete/reset
  invalidation, no-generation-signal fallback) and `packages/db-core/test/cache-source.spec.ts`
  (`getGeneration` starts at 0, advances on miss-load / `transformCache` update / `clear`, stable
  across pure cache hits). `transform.property.spec.ts` exercises the memo path under random transform
  sequences through the real `CacheSource` + `Tracker`.
