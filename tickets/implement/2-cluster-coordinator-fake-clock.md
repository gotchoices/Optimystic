----
description: The cluster-coordinator test is the slowest in the suite because it waits on real 2.5–4.5 second timers; make the coordinator's retry timers injectable so the test can drive them with a fake clock and run in milliseconds.
prereq:
files: packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/test/cluster-coordinator.spec.ts, packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts
difficulty: hard
----

The worst offender in the whole migration. `cluster-coordinator.spec.ts` currently sleeps on real wall-clock timers totaling up to ~4.5s per case (five sleeps of 2500/4500ms plus a few sub-second ones), gated by a `this.timeout(15000)`. These sleeps exist to let the coordinator's scheduled commit-retry timers fire, then assert how many retry attempts happened.

This ticket is self-contained: it makes the source injectable **and** migrates its own test. It has no `prereq` because it does not use the shared condition-poll helper — it uses a fake clock.

## Why a source change is required first

`ClusterCoordinator` schedules its retries with raw `setTimeout` and reads `Date.now()` directly. Advancing a fake clock cannot move a real `setTimeout`, so the test can only wait on real time today. The timer sites:

- `packages/db-p2p/src/repo/cluster-coordinator.ts:241` — delayed callback (promise-phase).
- `:677` — the exponential-backoff commit-retry timer (`setTimeout(() => void this.retryCommits(...), baseInterval)`).
- `:754` — a further scheduled callback.
- `Date.now()` reads at `:210`, `:648`, `:775`, `:798` (e.g. `lastUpdate`, expiration checks).

The project already has a proven, minimal injection shape — copy it, do not invent a new one. See `packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts`:

- `export type RotationTimerCancel = () => void;`
- an injectable `setTimer?: (fn, delayMs) => Cancel` defaulting to an **unref'd** `setTimeout`,
- an injectable `now?: () => number` defaulting to `Date.now`.

And the fake side: `FakeScheduler` in `packages/db-p2p/test/reactivity/rotation-rereg-scheduler.spec.ts` (a deterministic timer queue with `now`, `setTimer`, and `advance(ms)` that fires due timers in ascending `fireAt` order). Reuse its shape for the coordinator test.

## Design

Thread two optional constructor inputs into `ClusterCoordinator` (add to the options/`cfg` in a way consistent with its current constructor signature — it currently takes positional args ending in `stateStore?`, so prefer adding an options bag field or an explicit `clock`/`setTimer` pair; match the surrounding style):

- `now?: () => number` — default `Date.now`. Replace the four direct `Date.now()` reads with `this.now()`.
- `setTimer?: (fn: () => void, delayMs: number) => Cancel` — default an unref'd `setTimeout` wrapper returning a `clearTimeout` cancel. Replace all three `setTimeout` sites (and their corresponding `clearTimeout`) with `this.setTimer(...)` / the returned cancel handle.

The default behavior in production must be byte-for-byte equivalent to today (unref'd setTimeout, `Date.now`), so nothing outside tests changes.

In the test: construct the coordinator with a `FakeScheduler`-style clock. Replace each `await new Promise(r => setTimeout(r, 2500))` with `clock.advance(<intervalMs>)` (plus a microtask flush — `await Promise.resolve()` / `await new Promise(setImmediate)` — because `retryCommits` is async and the assertions read state it mutates after awaiting). The backoff intervals become *exact* and assertable (`equal`), not `greaterThanOrEqual`, because virtual time is deterministic. Drop `this.timeout(15000)` back to the default.

## Edge cases & interactions

- **Async retry callback settling.** `retryCommits` awaits `Promise.all(peer updates)`. After `clock.advance()` fires the timer synchronously, the coordinator's state (`updateCalls`, next scheduled retry) only updates once those promises resolve. The migration must flush microtasks after each advance, or the assertion reads stale state (vacuous pass). This is the single most likely way to get a green-but-wrong test — cover it explicitly.
- **Backoff chaining.** A fired retry timer arms the next one (backoff factor 2). Advancing must fire timers in `fireAt` order and a fired timer may enqueue another — the fake scheduler must handle re-entrant scheduling (the `FakeScheduler.advance` loop already does; mirror it).
- **`clearTimeout` / cancel on success.** When a peer recovers, the coordinator clears the pending retry. The injected cancel handle must actually remove the not-yet-fired timer from the fake queue, so the "no further retries after recovery" assertion holds.
- **Expiration checks read the clock.** `:798` compares `message.expiration` against `Date.now()`. Test fixtures set `expiration: Date.now() + 30000` — with a fake `now` starting at (say) 0, that fixture must be stamped against the *same* clock, or the record looks instantly expired. Stamp fixtures via the injected clock.
- **Production parity.** Default (no injection) path must remain unref'd `setTimeout` + real `Date.now` — verify a non-test construction still behaves identically (unref so an idle retry never pins the process).
- **Determinism across repeat runs.** Run the migrated spec multiple times (e.g. `--repeat` or a loop) — the whole point is it no longer depends on real-time settling.

## TODO

- Add `now?` and `setTimer?` injection to `ClusterCoordinator`, defaulting to `Date.now` / unref'd `setTimeout`, mirroring `rotation-rereg-scheduler.ts`.
- Replace the three `setTimeout` sites + their `clearTimeout`, and the four `Date.now()` reads, with the injected members.
- Confirm no production call site needs updating (defaults preserve behavior); build db-p2p.
- Migrate `cluster-coordinator.spec.ts`: inject a `FakeScheduler`-style clock, replace every real sleep with `clock.advance()` + a microtask flush, stamp fixture expirations against the fake clock, tighten `greaterThanOrEqual` assertions to exact where virtual time now allows, drop `this.timeout(15000)`.
- Run the spec repeatedly to confirm determinism; run db-p2p type-check + full test.
