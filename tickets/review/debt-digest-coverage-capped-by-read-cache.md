description: A save that touched more records than the local memory cache holds used to describe only the most recent ~126 of them, quietly leaving the rest unable to gain new replicas by push; now each record's starting content is pinned the moment it is changed, so a save of any size describes everything it read and changed.
files: packages/db-core/src/transform/base-pins.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/atomic.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/collection/collection.ts, packages/db-core/test/digest-cache-coverage.spec.ts, packages/db-core/test/digest.spec.ts
----

# Review: digest coverage no longer capped by the read cache

## What was built

`computeBlockContentDigests` describes a commit from `Tracker.peekMaterialized`, which used to
re-peek the 128-entry `CacheSource` LRU at sync time — so a transaction touching more blocks than
the cache holds had already evicted its own early bases before describing them. Coverage capped at
`min(N, 126)`.

The fix, exactly as the implement ticket designed it: a **transaction-scoped base-pin store**.

- **New `src/transform/base-pins.ts`** — `PinnedBase` (`{ block, rev, gen }`) and `BasePins`
  (`get`/`set`/`delete`/`retainOnly`/`adopt`/`size`), with the memory-shape NOTE (one cloned base
  per update-carrying block, reclaimed at every `reset()`).
- **`Tracker`** — third optional constructor param `public readonly pins: BasePins` (additive; every
  existing call site compiles unchanged). `update()` pins the committed base via a new `protected
  probeBase(id)` the first time an update is staged for an id (fresh-pin guard: one base clone per
  id, re-pin only on generation drift). `insert()`/`delete()` drop the pin; `reset(t)` prunes to the
  ids still in `t.updates` — the single reclamation point, so no coordinator changes were needed.
  `peekMaterialized()` prefers a **fresh** pin (generation must still match) and clones it before
  `applyTransform`; stale or absent pins fall through to the unchanged live-peek path.
- **`Atomic.commit()`** — adopts its pins into the parent tracker **before** `reset()`, so a single
  oversized `act()` keeps the bases its handlers read; `probeBase` chains through a Tracker source,
  so the Atomic pins from the collection's read cache.
- **`Collection.syncAttempts`** — the per-attempt snapshot tracker now shares the live tracker's pin
  store (`new Tracker(this.sourceCache, snapshot, this.tracker.pins)`); `createReadTracker` keeps a
  private store.
- **`digest.ts`** — the accepted-tradeoff NOTE carrying the old cap measurement rewritten to the new
  contract. `struct.ts`'s NOTE verified (does not cite the measurement) and left alone, per ticket.

**One deliberate deviation from the ticket's pseudocode**: the freshness comparisons use a new
chained `baseGeneration(id)` instead of the existing `sourceGeneration(id)`. For an `Atomic`, whose
source is a Tracker (no `getGeneration`), `sourceGeneration` is always `undefined` — the ticket's
literal guard would have re-probed on every update and never matched a pin at use time on the
atomic. `baseGeneration` chains through nested trackers to the same authority `probeBase` pins from
(the collection's `CacheSource`). For a tracker directly over a `CacheSource` — the digest path —
the two are identical.

No wire change: `Transforms`, `CommitRequest`, `BlockContentDigests`, and `blockDigestsField` are
untouched; a commit that declares nothing serializes exactly as before.

## Measurements (reproduce-first, per ticket)

With the coverage spec's `update` module switched to read-then-write (production shape) against
**unmodified** src: 32/32 at N=32, then **126 declared at both N=256 (2x) and N=512 (4x)** — the cap
reproduced. After the fix: **256/256 at 2x, 512/512 at 4x**, and the two old cap-pinning tests
failed exactly as their retirement comments predicted. Coverage spec wall clock: ~120ms total.

## Validation

- `packages/db-core`: full suite **1563 passing** (14s).
- `packages/db-p2p` (consumes Tracker): **2492 passing** (58s).
- `yarn typecheck` (workspace-wide `tsc --noEmit`) and full `yarn build` clean.

Test coverage added:
- `test/digest-cache-coverage.spec.ts` (rewritten; header now states the pin contract):
  small control unchanged; `declares every block it touches` deep-equals declared==touched at 2x
  and 4x; single oversized `act()` exercises the `Atomic.commit` adoption leg; blind-update
  carve-out asserts the never-read/evicted ids stay undeclared **and** nothing was fetched
  (transactor `get` ids captured).
- `test/digest.spec.ts`, new `base pins` block: pin survives LRU eviction (declares with baseRev 7
  and the canonical hash); stale pin after `clear()` → omitted; stale pin after `transformCache()`
  → recomputed from the folded live base at the new rev, explicitly not the stale pinned hash; one
  probe per id across 50 updates (peek spy); insert-after-update drops baseRev;
  delete-after-update omits; `reset()` clears vs `reset(transforms)` retains exactly still-staged
  ids; a drift-blind source (no `getGeneration`) pins nothing and declares via the old live path;
  a digest pass leaves the pin store unchanged. The pre-existing
  `LRU-evicted base: omitted even though a stale cached revision lingers` test (read-far-then-update
  residual) still passes untouched.

## Review focus / known gaps

- **Residual gap (by design, tripwired)**: read-far-then-update — a block read, then evicted by
  128+ other reads, and only then updated — still pins nothing and stays undeclared. `NOTE:` at the
  pin site in `tracker.ts`; closure sketch (pin on read) recorded there.
- **Failed sync attempts leave a few extra pins**: the snapshot tracker's log-append (`addActions`)
  pins the log tail/header blocks into the shared store, and an abandoned (stale-failure) attempt
  never resets that tracker — those pins linger until the live tracker's next reset. Bounded (a few
  log blocks, overwritten per attempt) and freshness-gated at use, but a reviewer may want to
  confirm they're comfortable with the shape. Side effect in the other direction: log tail/header
  bases now also declare under pressure, which they previously didn't.
- **Blind updates to still-cached blocks now declare at stage-time residency** rather than
  digest-time residency (pin captured from the residual seed-warm cache). Same declare-or-omit
  semantics, marginally different id set for a pathological blind writer; the carve-out test pins
  only the guaranteed-evicted subset for exactly this reason.
- **Untested interplay**: coordinator rollback (`reset(structuredClone(transforms))` keeping pins
  for restored ids) and `restorePending` are covered by the reset-retention unit test plus the full
  coordinator suite passing, but no test drives a coordinator rollback and then asserts digest
  coverage of the restored transaction specifically.

## Tripwire index (`## Review findings` seeds)

- `tracker.ts` pin site: read-far-then-update residual gap + pin-on-read closure sketch.
- `base-pins.ts`: memory shape — retention proportional to the transaction's own write footprint.
