description: A bookkeeping set inside the tail-rotation re-registration timer used to remember every tail it ever handled and never forget any, slowly leaking memory on a long-lived, fast-rotating subscription; it is now capped so it can't grow without limit.
prereq:
files: packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts, packages/db-p2p/test/reactivity/rotation-rereg-scheduler.spec.ts
difficulty: medium
----

# Complete: bound the `RotationReRegistrationScheduler` de-dupe ledger (`seen`)

## What shipped

`RotationReRegistrationScheduler` keeps a `pending: Map<key, cancel>` (bounded by fire/cancel/stop) and a
`seen: Set<key>` idempotence ledger that **survives the timer fire** so a late re-surface of an already-fired
successor stays a no-op. On the normal `schedule → fire` path `seen` was never pruned → unbounded slow growth
on a long-lived, fast-rotating subscription (negligible at the ~64-min cadence, real for a fast collection).

The fix bounds `seen` as an insertion-ordered, capped FIFO with oldest-first eviction that **never evicts a
still-pending key**:

- `export const SEEN_LEDGER_CAP = 1024` (module-level, exported only for the regression test; tunable).
- `private evictSeenOverCap()` — `while (seen.size > cap)`, scan `seen` in insertion order and delete the first
  key **not** in `pending`; if a full pass finds no evictable key, bail (ledger grows with `pending` that round,
  returns within cap once those timers fire).
- `get seenCount(): number` — diagnostic/test seam mirroring `pendingCount`.
- Called from `schedule()` **after** `pending.set` (the load-bearing ordering — see findings below).
- Class-doc "Idempotence" paragraph, the `seen` field doc, and `SEEN_LEDGER_CAP`'s doc updated.

Resulting bound: `seen.size ≤ max(SEEN_LEDGER_CAP, pending.size)`; under sequential rotations `≤ SEEN_LEDGER_CAP`.

## Review findings

**Adversarial pass over the implement diff (commit `eaae341`), scrutinized for SPP / DRY / modularity /
scalability / resource cleanup / error handling / type safety. Result: implementation is correct and
well-documented; one test-coverage gap fixed inline; no major findings, no new tickets filed.**

### Checked — correctness of the eviction logic and the flagged deviation
- **The deliberate deviation (call `evictSeenOverCap()` *after* `pending.set`, not after `seen.add` as the
  sketch said) is correct.** Traced all three shapes:
  - *Normal sequential* (`schedule → fire`): at eviction `pending = {current}`, the oldest `seen` entry is a
    fired key → evicted; the current (newest) key is never a candidate. `seen` pins at the cap.
  - *Sketched ordering (rejected)*: with evict before `pending.set`, when `pending` is at the cap the just-added
    key is the **only** non-pending candidate → it is evicted then immediately re-added to `pending`, leaving a
    pending key **absent from `seen`** (the invariant violation that could let a duplicate notice arm a second
    timer over the live one). The after-`pending.set` placement protects it. Confirmed.
  - *Chained / all-pending*: pending keys are skipped via `!pending.has(key)`; the loop correctly bails when no
    non-pending key exists, letting the ledger grow with `pending` and return within cap once timers fire.
- The `!pending.has(key)` guard handles the **general** case (incl. the test where the oldest keys are still
  pending), not merely the doc's simplification that "pending keys are the most recently scheduled."
- No path checks the bound between `seen.add` and `pending.set`; `seen` can exceed cap only transiently by ≤1
  within a single `schedule`, and eviction runs before `schedule` returns. Confirmed as the implementer claimed.

### Checked — interactions with teardown
- `cancel(topicId)` deletes from both `pending` and `seen`; `cancel()`/`stop()` `clear()` both. The bound only
  ever makes `seen` smaller, and eviction only removes **non-pending** keys (which `cancel(topicId)` holds no
  timer for), so there is no evict-vs-teardown hazard. No new test needed here.

### Found & fixed inline (minor) — de-dupe-after-eviction boundary coverage
- The acceptance criterion "a **within-cap** re-surface of a fired successor stays a no-op" was only exercised at
  count = 1 (eviction inactive). Added a test that, **with eviction active and `seen` pinned at the cap**,
  asserts (a) a recently-fired successor (still in the ledger) re-surfaces as a no-op — no new timer, no extra
  re-register — and (b) the oldest successor (long evicted) degrades to **exactly one** idempotent re-register,
  the documented acceptable behavior past the cap window, and `seen` stays bounded afterward. This pins the
  documented degradation that the implementer's two tests did not cover.

### Checked — performance / scalability
- Eviction is O(`seen.size`) worst-case per overflowing `schedule` but O(1) in practice (with `pending` in
  single digits the first scanned entry is virtually always evictable). Acceptable at this cap and pending size;
  an index/free-list for strict O(1) is not justified. No change.

### Checked — docs / type safety
- `grep` over `docs/` for `seen` / `SEEN_LEDGER` / "idempotence ledger" surfaced no references — the ledger is an
  internal implementation detail of the scheduler, not a documented design parameter, so no doc update is
  warranted. The in-code doc comments were updated by the implement stage and read accurately.
- `SEEN_LEDGER_CAP` is a numeric const; `seenCount` returns `number`. `tsc` build clean. No type issues.

### Not checked / deferred (acknowledged, not blocking)
- **Cap value 1024** is a documented judgement call, not load-tested against a real fast-rotating mesh.
  Acceptable as a tunable constant.
- **No multi-rotation integration/e2e coverage** through the real manager `onRotation` → scheduler path; the new
  getter and bound are internal/additive and break no callers. The unit-level proof via the injected
  `FakeScheduler` is sufficient for this scalability-hardening change.

## Validation (all green)

```
yarn workspace @optimystic/db-p2p build      # tsc — clean, EXIT=0
# rotation-rereg-scheduler.spec.ts: 17 passing (was 16; +1 added this review)
# full test/reactivity/**: 149 passing
```

Lint is not configured for this package (root `lint` is an `echo` stub); `tsc` is the type-check surface and
passes.

## Context

Implement → review of `reactivity-rotation-rereg-seen-ledger-unbounded`, itself filed by the review of
`12.53-reactivity-rotation-rereg-scheduler`.
