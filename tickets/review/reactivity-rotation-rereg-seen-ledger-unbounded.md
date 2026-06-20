description: A bookkeeping set inside the tail-rotation re-registration timer used to remember every tail it ever handled and never forget any, slowly leaking memory on a long-lived, fast-rotating subscription; it is now capped so it can't grow without limit.
prereq:
files: packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts, packages/db-p2p/test/reactivity/rotation-rereg-scheduler.spec.ts
difficulty: medium
----

# Review: bound the `RotationReRegistrationScheduler` de-dupe ledger (`seen`)

## What the implement stage did

`RotationReRegistrationScheduler` (`packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts`) keeps two
structures: `pending: Map<key, cancel>` (bounded — fire/cancel/stop remove entries) and `seen: Set<key>`, the
idempotence ledger that **survives the timer fire** so a late re-surface of an already-fired successor stays a
no-op. On the normal `schedule → fire` path `seen` was never pruned, so a long-lived, fast-rotating subscription
accumulated one permanent entry per rotation forever — a slow unbounded-growth leak (negligible at the ~64-min
rotation cadence, real for a fast-rotating collection). This was scalability hardening, not a common-path
correctness bug.

The fix bounds `seen` as an **insertion-ordered, capped FIFO** with oldest-first eviction that **never evicts a
still-pending key**:

- **`export const SEEN_LEDGER_CAP = 1024`** — module-level, exported (only so the regression test can assert the
  bound; no production caller reads it). Documented as tunable.
- **`private evictSeenOverCap()`** — `while (seen.size > cap)`, scan `seen` in insertion order and delete the
  first key **not** in `pending`; if a full pass finds no evictable (non-pending) key, bail (ledger grows with
  `pending` that round, returns within cap once those timers fire). Logs each eviction at debug.
- **`get seenCount(): number`** — diagnostic/test seam mirroring `pendingCount`.
- The class-doc "Idempotence" paragraph, the `seen` field doc, and `SEEN_LEDGER_CAP`'s doc now describe the bound,
  the evict-oldest-fired behavior, the never-evict-pending invariant, and that a re-surface older than the cap
  degrades to at most one harmless idempotent re-register.

Resulting bound: `seen.size ≤ max(SEEN_LEDGER_CAP, pending.size)`. Under unbounded **sequential** rotations
(`schedule → fire`, so `pending` returns to ~0 between successors — the realistic and the tested shape) this is
`≤ SEEN_LEDGER_CAP`.

## ⚠️ Deliberate deviation from the ticket sketch — REVIEW THIS FIRST

The ticket sketch said to call `evictSeenOverCap()` **"right after `this.seen.add(key)`"** — i.e. *before*
`this.pending.set(key, cancel)`. **I placed it after `pending.set` instead**, because the sketched placement is
subtly wrong and the ticket's *own* invariant test catches it:

- At eviction time, the just-added `key` is in `seen` but, with the sketched ordering, **not yet in `pending`**.
- Whenever `pending` is already at the cap, that current key is the **only** non-pending candidate, so eviction
  deletes it — and `schedule` then immediately `pending.set`s it. Result: a key in `pending` that is **absent
  from `seen`** — exactly the invariant violation the ticket warns about ("a duplicate notice for that pending
  successor would pass the `seen.has` check… overwrite its `pending` cancel handle… leaking the first timer and
  double-firing the move").
- Running the invariant test against the sketched ordering **fails** (`seenCount` 1024 vs expected 1074, and the
  current key is the one wrongly dropped). Moving the call to **after `pending.set`** protects the current key
  (it is now live/pending), fixes the invariant, and leaves the normal sequential path identical (there `pending`
  is empty, so the oldest *fired* key is evicted and the current key — newest in `seen` — is never a candidate).

A 5-line comment in `schedule()` explains this ordering requirement. **Reviewer: confirm you agree the
after-`pending.set` placement is correct and that there is no path where the bound is checked between `seen.add`
and `pending.set` that could leave `seen` transiently over cap in a way that matters.** (It cannot exceed cap+1
transiently, and the eviction runs before `schedule` returns.)

## Tests added (`packages/db-p2p/test/reactivity/rotation-rereg-scheduler.spec.ts`)

Both new tests pass; all 14 pre-existing scheduler tests still pass unchanged. Added a `topicForIndex(i)` helper
(`new Uint8Array([i & 0xff, (i >> 8) & 0xff])`, 65 536 distinct 2-byte topics) and imported `SEEN_LEDGER_CAP`.

- **Regression (the bound):** drive 10 000 distinct successors through `schedule → advance(fire)` sequentially,
  asserting after each fire `pendingCount` returns to 0 and `seenCount ≤ SEEN_LEDGER_CAP`, and at the end
  `seenCount === SEEN_LEDGER_CAP` (pinned at the cap once past it) and every successor moved exactly once.
- **Invariant (never evict a pending key):** schedule `SEEN_LEDGER_CAP + 50` successors **without firing any**
  (all pending) — asserts `seenCount === total` and `delays.length === total` (ledger grew with `pending`, no
  live key evicted) — then re-issue a duplicate notice for the **oldest** (index 0) successor and assert it is a
  no-op (`pendingCount` and `delays.length` unchanged: no second timer armed over the live one), then advance and
  confirm each pending successor fires exactly once.

## How to validate

```
yarn workspace @optimystic/db-p2p build      # tsc, clean
yarn workspace @optimystic/db-p2p test        # full suite: 857 passing, 30 pending, 0 failing
# or just this spec:
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/reactivity/rotation-rereg-scheduler.spec.ts" --reporter spec
```

Full-suite run above is clean. The `cohort-topic cold-start: parent registration… Error: parent unreachable`
line in the output is an **intentionally-injected error log** inside a passing antidos-coldstart test (asserts
the failure path), not a test failure — the summary reports 0 failing.

## Known gaps / things a reviewer might want to push on

- **Cap value (1024) is a judgement call.** Realistic concurrently-*pending* successors are single digits, so
  1024 is far above any real peak (tens of KB of short base64url strings at the ceiling). Not load-tested against
  a real fast-rotating mesh; it is a documented, tunable constant, not a measured optimum.
- **Eviction is O(seen.size) worst-case per overflowing `schedule`** (a linear scan to find the first non-pending
  key). With `pending` in single digits the first or second entry is virtually always evictable, so it is
  effectively O(1) in practice; only the pathological all-pending case degrades, and there it correctly bails. No
  benchmark was taken. An index/free-list would make it strictly O(1) but adds complexity not justified at this
  cap and pending size — flagging in case the reviewer disagrees.
- **No multi-rotation integration/e2e coverage.** The bound is proven only at the unit level via the injected
  `FakeScheduler`. Production wiring (`libp2p-node-base.ts` ~line 998, mesh harness
  `reactivity-mesh-harness.ts` ~line 577) constructs the scheduler but neither reads `seen`/`seenCount`, so the
  new getter and the bound are internal/additive and break no callers — but no test exercises the bound through
  the real manager `onRotation` path.
- **`cancel()`/`stop()` paths unchanged** (they already `clear()` `seen`), so the bound interacts with teardown
  only by being smaller; no new test covers evict-then-cancel interleavings (eviction only ever removes
  *non-pending* keys, which `cancel(topicId)` would not be holding a timer for anyway).

## Acceptance (all met)

- `seen` provably bounded under unbounded sequential rotations (`≤ SEEN_LEDGER_CAP`) — regression test.
- Existing de-dupe guarantees hold: redirect-vs-pre-announce race still moves once; a within-cap re-surface of a
  fired/superseded successor is still a no-op; a still-pending successor is **never** evicted (invariant test).
- 10k-distinct-successor regression asserts `seenCount ≤ SEEN_LEDGER_CAP`.

## Context

Filed by the review of `12.53-reactivity-rotation-rereg-scheduler`.
