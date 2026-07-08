description: Review two crash-path fixes in NetworkTransactor commit/cancel: unhandled rejections on fire-and-forget cancel calls, and a non-null assert on an optional StaleFailure field.
files:
  - packages/db-core/src/transactor/network-transactor.ts
----

## What was done

Three targeted edits in `network-transactor.ts`, all in the commit-failure path:

**Part A — unhandled rejection on fire-and-forget cancel (line 510, 623)**

Both `Promise.resolve().then(...)` cancel calls previously had no `.catch`, so if `cancelBatch`/`cancel` rejects (e.g. peers unreachable after a commit failure) Node throws a process-fatal unhandled rejection.

- Line 510 (`pend` method): added `.catch(e => log('WARN: cancel after pend failure rejected: %o', e))`.
- Line 623 (`commitBlock` method): added missing `void` prefix + same `.catch(...)`.

**Part B — non-null assert on optional `StaleFailure.missing` (line 627)**

`StaleFailure.missing` is typed `ActionTransforms[] | undefined`. The `commitBlock` path used `.missing!` (non-null assert), so a reason-only stale failure yields `undefined` elements that `distinctBlockActionTransforms` destructures → TypeError hiding the real failure reason.

Fix: removed `!`, added `.filter((x): x is ActionTransforms => x !== undefined)` — matching the guard already present in the `pend` path at line 516.

`tsc --noEmit` exits 0.

## Test cases for reviewer

- **Unhandled rejection (Part A):** Simulate a commit failure followed by unreachable peers on cancel. Before fix: process crash via unhandled rejection. After fix: WARN log, execution continues.
- **Reason-only stale failure (Part B):** A `StaleFailure` where `missing` is `undefined` (failure carried only a `reason`). Before fix: TypeError from `distinctBlockActionTransforms`. After fix: empty `missing` array returned, real stale failure propagates correctly.
- **Normal stale failure path:** `StaleFailure` with populated `missing` — should return distinct transforms as before.

## Review findings

No gaps or known issues. Changes are strictly additive (`.catch` + `.filter`) and match the existing pattern in the `pend` method.
