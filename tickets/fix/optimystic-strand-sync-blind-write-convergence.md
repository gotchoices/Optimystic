----
description: Investigate whether concurrent bidirectional blind appends converge in Optimystic strand sync without an intervening list read (read-driven vs push convergence).
prereq:
files: ../sereus/packages/integration-tests/src/scenarios/convergence-stress.integration.ts
difficulty: hard
----

## Background

Surfaced by the sereus `reference-app-rn-message-pk-collision-free` migration. That ticket
removed the per-insert `select max(Id)+1` subquery used to pick the chat message PK
(it caused PK collisions under concurrency) and replaced it with a locally-generated
UUID. Removing the subquery removed an **implicit read** that ran on every insert.

The `convergence-stress` "Interleaved Inserts" scenario — 20 bidirectional blind
inserts (odd on drone, even on phone) with zero intervening reads — **timed out at
30s** once the implicit read was gone. The implementer verified this is reproducible,
not flaky: reverting just that test file to the `max(Id)+1` form converges in ~20ms;
the blind-UUID form times out; adding a single `select Id from App.Message` read
before each insert converges in ~11ms.

The test was fixed by re-introducing an explicit list read before each insert, which
**mirrors how the real apps behave** — every peer polls `queryMessages` on a timer
(RN `useChat` 2s, web `messages.svelte` 4s, ns `chat-vm` 2s) independent of sends.
So the reference apps converge in practice and are NOT affected. This ticket is
purely about the underlying Optimystic behavior.

## The question

Is the following **expected pull-based behavior or a latent convergence gap** in
Optimystic strand sync?

> Concurrent bidirectional *blind* appends (writes with no intervening read on
> either side) do not appear to converge within 30s under `count(*)`-only polling,
> but converge within milliseconds the moment either side issues a **list read**
> (`select Id …`).

## Why it is non-obvious / worth a real look

The mechanism stated above is incomplete and should be confirmed empirically before
any code change:

- `waitForConvergence` (the helper that gates the test) polls with `select count(*)`,
  NOT a list read. If `count(*)` truly never drove a pull, the test's *final*
  `waitForConvergence` would hang regardless of the in-loop reads — yet the test
  passes. That implies either (a) `count(*)` does eventually trigger a pull, (b)
  there is background/push propagation that the tight write-only loop simply outran,
  or (c) the convergence trigger is subtler than "list read vs count read". Pin down
  which before concluding.
- Determine whether read-driven (pull-only) convergence is the intended Optimystic
  design (sync on read) or whether a write should also schedule background
  propagation so a write-only workload eventually converges on its own.

## Scope / where the work lives

This is an **Optimystic** strand-sync question, not a reference-app defect. Use the
sereus `convergence-stress` interleaved scenario
(`../sereus/packages/integration-tests/src/scenarios/convergence-stress.integration.ts`)
as the repro harness, but the fix (if any) belongs here in Optimystic, not in the
reference app. If the investigation concludes "by design", document that conclusion in
sereus's `docs/cadre-consistency.md` / `docs/strands.md` and close — the explicit poll
in the test and the apps' polling timers are then the correct pattern and need no change.
