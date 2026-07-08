----
description: Reviewed and confirmed the change that moved the last reactivity tests off real wall-clock sleeps onto the virtual clock / condition-polling, so those tests run fast and don't flake on timing.
files: packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts, packages/db-p2p/test/reactivity/notify-transport.spec.ts, packages/db-p2p/test/reactivity/push-state-gossip.spec.ts, packages/db-p2p/src/testing/reactivity-mesh-harness.ts, packages/db-core/src/testing/async-wait.ts
----

# Summary

Migrated the reactivity `test/reactivity/` folder off fixed real-time sleeps. Three spec files changed:

- **`mesh-slow-subscriber.spec.ts`** — `delay(50)` → `waitFor(() => slow.delivered.length >= 20, …)`; the
  gap-backfill is fire-and-forget off `onNotification`, so poll observable delivery state instead of sleeping.
- **`notify-transport.spec.ts`** — two `delay(20)` → `waitFor` on `received.length > 0` / `aborted`; the
  protocol handler reads+delivers on a fire-and-forget async IIFE, no timer involved.
- **`push-state-gossip.spec.ts`** — `delay(40)` (cadence-fired wait) → `waitFor(() => broadcasts.length > 0)`;
  one residual `delay(40)` retained for the post-`stop()` quiescence (negative) assertion, both now sourced
  from `@optimystic/db-core/test`.

`advanceTime`-driven mesh specs (`mesh-tail-rotation`, `mesh-partition-healing`, `mesh-mobile-resume`) and the
`FakeScheduler`-driven `rotation-rereg-scheduler` were already virtual and left unchanged.

# Review findings

**What was checked:** the implement diff (commit 2106ccf) read first with fresh eyes; all three changed spec
files read in full; the `waitFor`/`delay` helper source (`async-wait.ts`); the `@optimystic/db-core/test`
export map (`./test` → `dist/src/testing/index.js`, re-exports `async-wait`); the gossip driver source
(`push-state-gossip.ts`) to confirm the injectable-timer claim; the mesh harness
(`reactivity-mesh-harness.ts`) to confirm `advanceTime` routing; and the whole `test/reactivity/` folder
grepped for residual `delay(`/`setTimeout`/`setInterval`.

**Correctness (checked — no defects):**
- The `waitFor` vs `delay` split is justified against source. `ReactivityPushStateGossipDriver` arms its
  cadence with a bare `setInterval` (`push-state-gossip.ts:130`); its `clock?` dep is the per-round timestamp
  source, **not** the interval timer, so no fake clock is injectable there — `waitFor` is the correct tool.
  The notify handler has no timer at all — `waitFor` on observable state is correct (and strictly better than
  the old fixed sleep).
- Vacuous-pass check on the *unchanged* `advanceTime` specs: the harness's `advanceTime` fires timers armed
  via `armVirtualTimer`, injected as the scheduler's `setTimer`
  (`reactivity-mesh-harness.ts:342/357/604`). The mesh specs assert `scheduler.pendingCount` transitions
  across `advanceTime`, so they would fail if the timer weren't advanced — non-vacuous.

**Coverage (checked — no gap):**
- `node-wiring.spec.ts` is not listed in the ticket. Inspected in full: it has **no** fixed real-time sleep —
  its `setTimeout` references are comment prose plus a `fakeRotationNotice` whose `fireAt` is ~1h out and is
  never awaited (the test only asserts arm/cancel of `pendingCount`). Correctly out of scope; the ticket
  merely omitted it from its "left unchanged" list — a documentation gap, not a defect.

**Tests + lint (both pass):**
- `test/reactivity/**/*.spec.ts`: **149 passing (~9s)**. Touched subset: **23 passing (~2s)**.
- `eslint` on the three changed files: clean (exit 0).
- No pre-existing failures surfaced; no `.pre-existing-error.md` written.

**Retained `delay(40)` (checked — acceptable, not filed):** the post-`stop()` "no further rounds fire"
assertion is a *negative/quiescence* check that a condition-poll cannot express. Correctness is structural
(`stop()` clears the interval + sets `stopped`; a manual `round()` after stop is separately asserted a no-op);
the sleep only gives a regressed impl a window to reveal itself. Documented inline. The clean fully-
deterministic path is to make the driver's cadence timer injectable — a small `push-state-gossip.ts` change.
Not filed: it is the exact residual `delay`'s own doc reserves it for, and the ticket sanctioned `waitFor`
(or a residual sleep) where no injectable timer exists.

**Tripwire (recorded here, no code change):** `mesh-slow-subscriber` polls `waitFor(() => …length >= 20)`
then asserts `length === 20` (no double-delivery). `waitFor` returns the instant length hits 20, which
*narrows* the double-delivery detection window versus the old fixed `delay(50)` — a redundant-backfill
duplicate arriving microseconds after the 20th unique revision would land after the assertion has already
run. Low risk: delivery is in-process and dedupe-guarded, and the folder ran deterministically 149-passing.
Not changed, because the only fixes are (a) re-adding a fixed sleep (undoes the ticket's purpose) or (b) a
quiescence wait the harness can't express here. Parked as knowledge; if this assertion ever flakes, the fix
is to drive the backfill RPCs deterministically, not to widen the poll.

**Minor / major findings:** none. No inline fixes were needed; no new fix/plan/backlog tickets filed.

**Conditional / speculative:** the two tripwires above (retained `delay(40)`; `>= 20` predicate window).
Neither is a queued task.
