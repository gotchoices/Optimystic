----
description: The reactivity tests already have a virtual-clock harness available but several still wait on real timers; finish moving them onto the virtual clock (or a bounded condition-poll where a timer isn't involved).
prereq: test-wait-helpers
files: packages/db-p2p/src/testing/reactivity-mesh-harness.ts, packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts, packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts, packages/db-p2p/test/reactivity/mesh-partition-healing.spec.ts, packages/db-p2p/test/reactivity/mesh-mobile-resume.spec.ts, packages/db-p2p/test/reactivity/push-state-gossip.spec.ts, packages/db-p2p/test/reactivity/notify-transport.spec.ts, packages/db-p2p/test/reactivity/rotation-rereg-scheduler.spec.ts
difficulty: medium
----

The reactivity subsystem is the best-prepared for this migration: `packages/db-p2p/src/testing/reactivity-mesh-harness.ts` already exposes a virtual clock (`ReactivityMesh.advanceTime(ms)` + `now`), and `rotation-rereg-scheduler.spec.ts` already drives everything through a `FakeScheduler`. This batch finishes the job for the reactivity `test/reactivity/` folder.

## Mechanism per file

**Fake clock (preferred — timer is injectable through the harness):**
- `mesh-slow-subscriber.spec.ts` — currently imports `delay` from the harness. If the sleeps are waiting for rotation/drain timers that the harness's virtual timers drive, replace `delay(ms)` with `mesh.advanceTime(ms)`. A sleep that only waits for the harness's own async plumbing (not a timer) becomes a `waitFor` on the observable state.
- `mesh-tail-rotation.spec.ts`, `mesh-partition-healing.spec.ts`, `mesh-mobile-resume.spec.ts` — same: these build a `ReactivityMesh`; drive rotation/heal/resume timing with `advanceTime`, assert on mesh state.
- `rotation-rereg-scheduler.spec.ts` — audit for any residual real sleep; it should already be fully virtual via `FakeScheduler`. Convert any leftover.

**Condition-poll (no injectable clock in these two; verify before assuming):**
- `push-state-gossip.spec.ts`, `notify-transport.spec.ts` — each defines its own private `delay`. First check whether the gossip driver / transport under test accepts an injectable timer. If it does, prefer fake clock. If it does NOT (the sleep is waiting for real transport plumbing to settle), replace the fixed sleep with `waitFor(() => <observable settled state>, { description })` from `@optimystic/db-core/test`. Do not silently leave a padded sleep.

## Design notes

- The harness's `advanceTime` fires virtual timers one-at-a-time until quiescent, so a chained rotation (a fired timer arming another) drains in a single call — see the harness doc comment. Advance by the documented interval, not an arbitrary padded number.
- Prefer asserting the *event/state* the old sleep was implicitly waiting for. A sleep that let a rotation propagate becomes `advanceTime(T_drain)` followed by an assertion that the rotation landed — never just a removal.

## Edge cases & interactions

- **Vacuous pass via un-advanced timers.** If a test replaces a sleep with `advanceTime` but the code under test armed its timer on the *real* clock (not the harness's injected one), advancing does nothing and the assertion may pass for the wrong reason. Confirm every timer in the exercised path routes through the harness's virtual scheduler before trusting a green run.
- **Chained/re-entrant timers.** Rotation re-registration arms follow-on timers; `advanceTime` must drain them (harness already loops — don't hand-roll a single-fire advance).
- **Assertion preservation.** Each migrated case must still assert the propagation/rotation/heal it was waiting for, with an explicit wait for that state — not a bare sleep deletion.
- **push-state-gossip / notify-transport real plumbing.** These may genuinely need condition-polling; the bounded `waitFor` throw protects against a broken condition hanging the run.
- **Determinism.** Re-run the folder several times; fake-clock cases must be timing-independent.

## TODO

- Audit each listed spec for whether its sleeps wait on a harness-driven virtual timer (→ `advanceTime`) or real async plumbing (→ `waitFor`).
- Migrate `mesh-slow-subscriber`, `mesh-tail-rotation`, `mesh-partition-healing`, `mesh-mobile-resume` to `advanceTime`, keeping/strengthening the state assertions.
- Verify `rotation-rereg-scheduler` has no residual real sleep; convert if any.
- For `push-state-gossip` and `notify-transport`: check the driver/transport for an injectable timer; use fake clock if present, otherwise bounded `waitFor` from `@optimystic/db-core/test`.
- Remove now-unused private `delay` definitions.
- Run `test/reactivity/**` repeatedly; confirm determinism and unchanged assertions.
