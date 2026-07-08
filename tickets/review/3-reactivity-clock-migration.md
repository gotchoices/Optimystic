----
description: Review the change that moved the last reactivity tests off real wall-clock sleeps onto the virtual clock / condition-polling, so those tests run fast and don't flake on timing.
prereq: test-wait-helpers
files: packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts, packages/db-p2p/test/reactivity/notify-transport.spec.ts, packages/db-p2p/test/reactivity/push-state-gossip.spec.ts, packages/db-p2p/src/testing/reactivity-mesh-harness.ts, packages/db-core/src/testing/async-wait.ts
difficulty: medium
----

# What this ticket did

Finished migrating the reactivity `test/reactivity/` folder off fixed real-time sleeps. A test that sleeps
`N` ms and then asserts is both slow and flaky: too short and it fails under load, too long and every run pays
the cost. The two replacements are:

- **`advanceTime(ms)`** — the reactivity mesh harness (`reactivity-mesh-harness.ts`) owns a *virtual clock*:
  timers armed by the code under test route through `armVirtualTimer`, and `advanceTime` fires them
  deterministically (looping until quiescent, so a chained rotation drains in one call). No real time passes.
- **`waitFor(predicate, { description })`** — from `@optimystic/db-core/test` (`async-wait.ts`): polls a
  condition (default 2s bound, 10ms cadence) and throws a described error on timeout. Used where the wait is
  for *real async plumbing* to settle (a fire-and-forget promise chain, an async stream handler), not a timer
  the harness can drive.

## Changes made (3 files)

- **`mesh-slow-subscriber.spec.ts`** — dropped the `delay` import from the harness; added `waitFor`. The old
  `delay(50)` waited for the slow subscriber's *fire-and-forget* gap-backfill (kicked off inside
  `onNotification`, so `wakeSubscriber` resolves before the missed window lands). Replaced with
  `waitFor(() => slow.delivered.length >= 20, …)`. The existing assertions still verify the healed stream is
  exactly `1..20` unique (no loss, no double-delivery) and that at least one backfill RPC fired.

- **`notify-transport.spec.ts`** — removed the private `delay`; added `waitFor`. Both `delay(20)` calls waited
  for the protocol handler's async read-and-deliver IIFE. Replaced with `waitFor` on the actual observable
  state: `received.length > 0` (frame decoded + delivered) and `aborted` (bounded-read failure aborted the
  stream). No timer is involved in this transport, so `waitFor` (not `advanceTime`) is the right tool.

- **`push-state-gossip.spec.ts`** — removed the private `delay`; imported `{ waitFor, delay }` from
  `@optimystic/db-core/test`. The gossip driver's cadence is a **real, non-injectable** unref'd `setInterval`
  (it has a `clock?` dep but it is documented "reserved / unused"; the timer itself is `setInterval`), so a
  fake clock is not available here. The first `delay(40)` (wait for the cadence to fire) became
  `waitFor(() => transport.broadcasts.length > 0, …)`. See the decision note below about the second one.

## Files verified and left unchanged (with reasons)

- **`mesh-tail-rotation.spec.ts`, `mesh-partition-healing.spec.ts`, `mesh-mobile-resume.spec.ts`** — already
  fully on the virtual clock (`advanceTime`) / need no timing at all. No `delay` import, no residual sleep.
- **`rotation-rereg-scheduler.spec.ts`** — already fully virtual via its own `FakeScheduler` (injected
  `setTimer`/`now`). Its only real-time bits are intentional and were left as-is: `flush = setTimeout(0)` is a
  micro/macrotask yield (to let a *swallowed rejection* settle before asserting), not a padded sleep; and the
  test `'production defaults (unref'd setTimeout + Date.now) actually fire the move'` exists specifically to
  exercise the real default timer binding, so it must use a real 0-delay timeout.

# Validation

Package: `packages/db-p2p`. Runner: `node --import ./register.mjs node_modules/mocha/bin/mocha.js …`
(ts-node/esm — type-checks on load, so a type error fails the run).

- Full folder — `test/reactivity/**/*.spec.ts`: **149 passing (~7s)**.
- Touched-files subset (`notify-transport` + `push-state-gossip` + `mesh-slow-subscriber`): **23 passing**,
  re-run 3× — **deterministic** (986ms / 994ms / prior 879ms; the migrated `waitFor` cases settle in tens of
  ms, not the old fixed 50/40/20ms).

No pre-existing failures surfaced; no `.pre-existing-error.md` written.

# What the reviewer should scrutinize (use cases + gaps)

- **Decision to scrutinize — the one retained `delay`.** `push-state-gossip.spec.ts` still has a `delay(40)`
  after `driver.stop()`, asserting **no further rounds fire**. This is a *negative/quiescence* assertion — an
  *absence* of change — which `waitFor` cannot express (it polls for a condition becoming true). Correctness
  is structural: `stop()` synchronously `clearInterval`s and sets `stopped`, and a manual `round()` after stop
  is separately asserted to be a no-op; the sleep only gives a *regressed* implementation a window to reveal
  itself (intervalMs=5 → ~8 ticks would land in 40ms). It is documented inline, not silent. If the reviewer
  wants this fully deterministic, the clean path is to make the driver's cadence timer injectable
  (`start(setIntervalFn?)` or a `timer` dep) and drive it with a fake — a small, contained `push-state-gossip.ts`
  change. Judgment call: the ticket said "use `waitFor` if no injectable timer," and this negative case is
  exactly the residual the `delay` helper's own doc reserves it for. **Parked as a documented decision, noted
  here per the tripwire rule — not filed as a ticket.**

- **Vacuous-pass risk (the ticket's headline edge case).** The migrated cases here do *not* rely on
  `advanceTime` (they use `waitFor` on observable state), so the "timer armed on the real clock, `advanceTime`
  does nothing, assertion passes for the wrong reason" trap does not apply to *these three files*. But the
  reviewer should confirm the **unchanged** `advanceTime`-driven mesh specs genuinely route their timers
  through the harness's `armVirtualTimer` — i.e. that they'd *fail* if the timer weren't advanced. Spot-check:
  the rotation re-registration timer in `mesh-tail-rotation`'s recover-redirect case and `mesh-mobile-resume`'s
  tail-rotation case both assert `scheduler.pendingCount` transitions across `advanceTime`, which is the
  non-vacuous signal.

- **`waitFor` bound sensitivity.** All new `waitFor` calls use the default 2s timeout. These are in-process
  settles (microtask-fast), so 2s is generous; if a heavily-loaded CI ever flakes on one, the fix is an
  explicit `timeoutMs` at that call site (per the `WaitForOptions` doc comment), not raising the default.

- **`mesh-slow-subscriber` predicate is `>= 20`, not `=== 20`.** Intentional: the poll waits for "at least
  fully healed," and the immediately-following assertions pin the exact `1..20`-unique + length-20 (no
  double-delivery) invariant. Confirm those assertions are what actually guards correctness.

- **Re-run for determinism.** Worth another folder run or two on the reviewer's machine; the mesh specs are
  real-Ed25519 and CPU-bound (each ~100–1100ms), so wall-clock varies, but pass/fail should not.
