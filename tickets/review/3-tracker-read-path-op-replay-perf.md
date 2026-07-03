description: A frequently-read block used to get slower over a long session because every read rebuilt it by replaying every past change; reads now reuse a cached built result and stay fast, with a guard that discards the cache the moment the underlying block changes.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/test/cache-source.spec.ts, packages/db-core/test/tracker-read-perf.spec.ts
difficulty: medium
---

## What was built

`Tracker.tryGet`'s `updates`-over-source path was O(block size + number of accumulated ops) on
**every** read, because it re-fetched the source block and replayed the entire `updates[id]` op list
each time. A hot block (collection header, log tail) updated once per operation makes reading it once
per operation O(ops²) over a session.

The fix memoizes the materialized (source block + all `updates[id]` ops) result per id inside the
`Tracker`, guarded by a per-id **generation** counter the source exposes so the memo is dropped the
moment the underlying source content for that id changes. Reads become O(block size) (the unavoidable
defensive clone) with no op replay.

### `CacheSource` — per-id generation (packages/db-core/src/transform/cache-source.ts)

- Added `private generations = new Map<BlockId, number>()`, a `bump(id)` helper, and a public
  `getGeneration(id): number` (returns 0 for an unseen id).
- `bump(id)` is called at every content-changing site: `tryGet` miss-load, `clear(ids)` per id,
  `clear()` (bumps every currently-cached id before clearing), and `transformCache` on each delete,
  each insert `set`, and after each `applyOperation` on a cached block. Over-bumping is safe (only
  forces a re-materialize); under-bumping would be a correctness bug, so every mutation bumps.

### `Tracker` — read-path memo (packages/db-core/src/transform/tracker.ts)

- Added `private materialized = new Map<BlockId, { block: T; gen: number }>()` and a
  `sourceGeneration(id)` helper that duck-types the source's optional `getGeneration`.
- `tryGet` updates branch: if a memo exists and the source generation is unchanged (or the source
  has no generation signal), return `structuredClone(memo.block)` — no replay. Otherwise load, apply
  ops via `applyOperations`, and memoize (only when the source reports a generation).
- Kept fresh / invalidated at mutation sites: `update` folds the single new op into the memo block
  in place (O(1), no full replay); `insert` and `delete` drop the memo for that id; `reset` clears
  the whole memo map (so each sync starts clean → bounded memory).

## Deviations from the implement ticket (reviewer: check these)

The ticket's pseudocode stamped the memo with the generation read **before** the load and told
`update` to **refresh** `memo.gen` to the current source generation. I did **the opposite on both**,
deliberately:

- **Stamp with the post-load generation** (`freshGen` read *after* `source.tryGet`). The source bumps
  its generation during a miss-load, so stamping with the pre-load value leaves the memo one
  generation behind and forces a needless reload on the very next read.
- **`update` leaves `memo.gen` untouched.** `memo.gen` records the generation of the *base source
  content* the memo was built from; the ops changed, but the base did not. Refreshing it to the
  current source generation would — in the case the ticket acknowledges but says *not* to rely on
  (source content changed without the tracker being reset) — mark stale base content as fresh and
  serve wrong data. Not refreshing keeps correctness local: if the source generation later advances,
  the read reloads. With post-load stamping, no refresh is needed for performance anyway.

These two changes are coupled: post-load stamping makes the memo generation already-current, which
removes the only reason the ticket had to refresh on `update`. Net effect is the same performance
with strictly stronger local correctness. **Please sanity-check this reasoning** — it is the crux of
the change.

## How to validate

Tests (the floor — both green, full db-core suite 1135 passing, `yarn build` exit 0):

- `packages/db-core/test/tracker-read-perf.spec.ts` (new):
  - **Scaling (counting, not timing):** repeated reads after K ops fetch the source exactly once;
    source-fetch count is identical for K=100 and K=2000 (independent of op count); an op applied
    after materialization is folded in with no reload.
  - **Correctness:** reads return caller-isolated clones (mutating a read can't corrupt the memo);
    a source-drift case (change base content + bump generation) re-materializes and returns the new
    base with ops re-applied over it; `delete`/`reset` invalidate the memo; a plain source *without*
    `getGeneration` never memoizes and always observes external changes.
- `packages/db-core/test/cache-source.spec.ts` (extended): `getGeneration` starts at 0, advances on
  miss-load / `transformCache` update / `clear`, and is stable across pure cache hits.

Existing coverage that already exercises the memo path (all passing): `transform.property.spec.ts`
(fast-check over random transform sequences through `CacheSource`+`Tracker`), `invalidation-client.spec.ts`,
and the collection / network-transactor specs (the `Collection` read/act/update/sync flows).

Run: `cd packages/db-core && yarn test` and `yarn build`.

## Known gaps / where to probe

- **Timing is not asserted** (counting only, on purpose — timing ratios are CI-flaky). The 15×-cost
  regression from the original bench is inferred from the fetch/replay counts, not re-measured here.
- **The whole-program safety argument rests on: every `sourceCache` content mutation for an id either
  bumps its generation or resets the tracker.** I bumped all `CacheSource` mutation entry points
  (`clear`, `transformCache`) and the memo is per-`Tracker`, so a shared `CacheSource` invalidates
  every tracker's memo on drift. Reviewer should confirm there is **no other path that mutates a
  cached block object in place** bypassing `transformCache` (e.g. a caller retaining a reference to a
  block it got before clone semantics, or a future cache method). `tryGet` returns clones and
  `transformCache` clones inserts, so I found none — but this is the invariant to guard.
- **`Tracker.tryGet` insert/delete precedence and the no-ops path are unchanged** — only the
  ops-present source path gained the memo. The malformed insert+delete edge cases documented at
  tracker.ts remain as-is.

## Tripwire (parked, not a ticket)

- `CacheSource.generations` is **never pruned** — it keeps one small `(id → number)` entry per
  distinct block id ever touched, even after LRU eviction from the block cache. Bounded by the number
  of distinct blocks a collection sees over its lifetime; benign now. If it ever grows large enough to
  matter, evict the generation alongside the LRU entry (safe: a reload re-bumps from absent/0, forcing
  a re-materialize). Parked as a `NOTE:` at the declaration site in cache-source.ts.
