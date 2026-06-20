description: A bookkeeping set inside the tail-rotation re-registration timer never forgets the tails it has already handled, so a very long-lived, very frequently-rotating subscription slowly accumulates memory that is never reclaimed. Bound that set so it can't grow without limit.
prereq:
files: packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts, packages/db-p2p/test/reactivity/rotation-rereg-scheduler.spec.ts
difficulty: medium
----

# Bound the `RotationReRegistrationScheduler` de-dupe ledger (`seen`)

## Confirmed cause

`RotationReRegistrationScheduler` (`packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts`) keeps two
structures:

- `pending: Map<key, cancel>` (line 100) — successors with a still-armed timer. **Bounded**: an entry is
  removed by `fire` (line 181), `cancel` (lines 152/161), and `stop` (line 175).
- `seen: Set<key>` (line 102) — every successor `newTopicId` (base64url) **ever** scheduled, kept so a late
  duplicate notice for an already-fired successor is a no-op.

`seen` is pruned only by `cancel(topicId)` (drops one, line 162), `cancel()` (clears, line 153) and `stop()`
(clears, line 176). On the **normal** path — `schedule` (adds at line 131) → `fire` (line 181, which deletes
from `pending` but *not* from `seen`) — the key lives in `seen` **forever**. One scheduler is built per
subscription manager (`libp2p-node-base.ts` ~line 998; mesh harness `reactivity-mesh-harness.ts` ~line 577) and
a subscription can be long-lived, so every tail rotation the subscription survives leaves one permanent entry.
Negligible at ~64-min rotation cadence (~22 keys/day) but a genuine slow unbounded-growth leak for a
fast-rotating collection. The scheduler is otherwise correct; this is scalability hardening, not a correctness
bug on the common path.

## Why `seen` must persist across fires (do **not** just delete on fire)

The persistence is load-bearing; a naive "delete in `fire`" is wrong:

- The manager's `rotationHandledFor` guard tracks only the **last** successor (a single value, not a set). After
  a chained `OLD→A→B`, it holds `B`; a late re-surface of the superseded `A` (e.g. a delayed
  `RotationRedirectError`) passes the manager guard (`A !== B`) and reaches the scheduler again.
- `seen` is what de-dupes that re-surface (and the redirect-vs-pre-announce race for the same successor). It
  must outlive the timer fire. So the fix is **bounding**, not removal.

## Chosen approach — bounded insertion-order ledger (FIFO), never evicting a still-pending key

Keep `seen` as an insertion-ordered `Set<string>` (JS `Set` preserves insertion order) and cap it. On overflow,
evict the **oldest** entries **that are not currently in `pending`** until the size is back within the cap.

Rationale for this over the TTL alternative (the ticket listed both):

- **Simplest provable bound.** No timestamps, no coarse-clock pruning pass — just a cap + oldest-first eviction.
- **The race window the ledger guards is short.** It guards near-simultaneous redirect + pre-announce for the
  same successor, plus not-yet-fired chained successors. A re-surface old enough to have been evicted (≥ cap
  distinct successors later) would at worst cause **one redundant, idempotent re-register** — acceptable.
- **The pending-dedup guarantee stays exact regardless of cap.** Because eviction *never* drops a key still in
  `pending`, the invariant "every pending key ∈ `seen`" holds. This matters: if a still-pending key were evicted
  from `seen`, a duplicate notice for that pending successor would pass the `seen.has` check, call `setTimer`
  again, and overwrite its `pending` cancel handle — leaking the first timer and double-firing the move. So
  eviction must skip pending keys. (In practice the oldest entries are virtually always already-fired, since
  pending keys were the most recently scheduled; skipping pending only matters in the rare interleaving where
  `pending.size` itself approaches the cap.)

Resulting bound: `seen.size ≤ max(SEEN_LEDGER_CAP, peak pending.size)`. Under unbounded *sequential* rotations
(schedule → fire, so `pending` drops back to ~0 between successors — the realistic and the test shape), this is
`≤ SEEN_LEDGER_CAP`.

### Cap value

`SEEN_LEDGER_CAP = 1024` (a module-level `const`). Realistic concurrently-*pending* successors number in the
single digits (1 normal, a handful across a chained rotation), so 1024 is comfortably above any real peak while
costing only tens of KB of short base64url strings at the ceiling. Document it as tunable.

### Sketch

```ts
/** Upper bound on the idempotence ledger; far above any realistic concurrent-pending count (see class doc). */
const SEEN_LEDGER_CAP = 1024;

// in schedule(), replacing the bare `this.seen.add(key)`:
this.seen.add(key);
this.evictSeenOverCap();

/**
 * Bound the idempotence ledger: evict the oldest entries that are NOT still pending, until within the cap.
 * Never evicts a pending key — that would break the "every pending key ∈ seen" invariant and could double-fire
 * a successor whose duplicate notice then re-armed a timer over the live one. If every entry is still pending
 * (pending.size > cap — not reachable in practice), leave the ledger to grow with pending this round.
 */
private evictSeenOverCap(): void {
  while (this.seen.size > SEEN_LEDGER_CAP) {
    let evicted = false;
    for (const key of this.seen) {          // insertion order: oldest first
      if (!this.pending.has(key)) {
        this.seen.delete(key);
        log("rotation re-registration ledger at cap (%d) — evicted oldest fired successor topic=%s", SEEN_LEDGER_CAP, key);
        evicted = true;
        break;
      }
    }
    if (!evicted) break;
  }
}
```

Also add a diagnostic getter mirroring `pendingCount`, for the regression test to assert the bound:

```ts
/** Size of the idempotence ledger (pending + recently-fired-and-retained). Diagnostic / test seam. */
get seenCount(): number { return this.seen.size; }
```

Update the class-level "Idempotence" doc block (lines 37–45) to note the ledger is now **bounded** (cap +
oldest-fired eviction) and that a re-surface older than the cap degrades to one harmless idempotent re-register.

## Acceptance

- `seen` is provably bounded under unbounded *sequential* rotations of a single long-lived scheduler
  (`≤ SEEN_LEDGER_CAP`).
- Existing de-dupe guarantees still hold: the redirect-vs-pre-announce race for the same successor still moves
  once; a re-surface of a recently-fired/superseded successor **within the cap window** is still a no-op; a
  still-pending successor is **never** evicted (so a duplicate notice for a pending successor never arms a
  second timer).
- A regression test drives many (≥ 10k) distinct successors through schedule→fire and asserts `seenCount`
  stays ≤ `SEEN_LEDGER_CAP`.

## TODO

- [ ] In `rotation-rereg-scheduler.ts`: add the `SEEN_LEDGER_CAP` const, the `evictSeenOverCap()` private method,
  and call it from `schedule()` right after `this.seen.add(key)`.
- [ ] Add the `get seenCount(): number` diagnostic getter next to `pendingCount`.
- [ ] Update the "Idempotence" paragraph of the class/module doc comment to describe the bound and the
  evict-oldest-fired behavior (and that pending keys are never evicted).
- [ ] In `rotation-rereg-scheduler.spec.ts` add tests:
  - Regression: schedule→advance(fire) for 10_000 distinct `newTopicId`s (vary the 2-byte topic across the
    range), asserting `seenCount` never exceeds `SEEN_LEDGER_CAP` and equals the cap once past it. The existing
    `FakeScheduler` + `recorder` fixtures suffice; generate distinct topics with a small helper
    (e.g. `new Uint8Array([i & 0xff, (i >> 8) & 0xff])`).
  - Invariant: schedule `SEEN_LEDGER_CAP + N` successors **without** firing any (all pending), then re-issue a
    duplicate notice for the **first** (oldest) successor; assert it is a no-op (`pendingCount` unchanged, no new
    `delays` entry) — proving a pending key was not evicted.
  - Confirm the existing small-count tests still pass unchanged (all well under the cap).
- [ ] Build + test the package:
  - `yarn workspace @optimystic/db-p2p build`
  - `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`
    (or target the single spec by passing the file path to mocha if the full suite is slow; stream with `tee`,
    never silent-redirect).

## Context

Filed by the review of `12.53-reactivity-rotation-rereg-scheduler`. Production wiring at
`packages/db-p2p/src/libp2p-node-base.ts` (~line 998) and the mesh harness at
`packages/db-p2p/src/testing/reactivity-mesh-harness.ts` (~line 577) construct schedulers; neither reads `seen`
or `seenCount`, so the new getter and the bound are internal/additive and break no callers.
