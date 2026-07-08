description: Fixed two crash-path defects in NetworkTransactor commit/cancel — fire-and-forget cancel calls could crash the process on rejection, and a stale-failure with no detail could throw and hide the real error. Reviewed, hardened with a regression test.
files:
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-core/test/network-transactor.spec.ts
----

## What was done (implement stage)

Three targeted edits in `network-transactor.ts`, all in the commit-failure path:

- **Part A — unhandled rejection on fire-and-forget cancel.** Both `Promise.resolve().then(() => this.cancel…)` cleanup calls fired without a `.catch`. If the cancel rejects (peers unreachable after a commit failure) Node raises a process-fatal unhandled rejection. Added `.catch(e => log('WARN: …', e))` to both (`pend` at line 510, `commitBlock` at line 623), plus the missing `void` prefix at 623.
- **Part B — non-null assert on optional `StaleFailure.missing`.** `commitBlock` used `.missing!`; a reason-only stale failure (`missing` undefined) yielded `undefined` elements that `distinctBlockActionTransforms` destructured → TypeError masking the real failure. Removed `!`, added `.filter((x): x is ActionTransforms => x !== undefined)`, matching the guard already present in the `pend` path (line 516).

## Review findings

**Verdict: implementation is correct and complete for its stated scope. One weak existing test strengthened; one tripwire parked.**

### Checked

- **Diff correctness (Part A).** `void <chain>.catch(...)` correctly attaches the handler to the full promise chain; both fire-and-forget cancel sites covered. Grep confirms no other un-caught `Promise…then` cancel calls in the file. ✓
- **Diff correctness (Part B).** `flatMap(b => …missing)` yields `undefined` elements when `missing` is absent (flatMap does not flatten a non-array return), and the added type-guard filter removes them before `distinctBlockActionTransforms`. Matches the pend-path guard exactly. `distinctBlockActionTransforms([])` returns `[]` safely. Both `.missing!` sites in the codebase are now fixed (grep confirmed). ✓
- **Type safety.** `ActionTransforms` is imported (line 3); the `(x): x is ActionTransforms` predicate typechecks. `tsc --noEmit` exits 0. ✓
- **Reproduction traced.** `TestTransactor.commit` returns a reason-only `{ success:false, reason }` for a never-pended action (test-transactor.ts:306). That response is classified as stale (success===false) in `commitBlock`, so it reaches line 627 — the exact input that crashed before the fix. ✓
- **Resource cleanup / error handling.** Cancel remains best-effort background cleanup; a WARN log on rejection is the right disposition (nothing to recover). ✓
- **Docs.** Read `docs/internals.md` and `docs/correctness.md` mentions of `StaleFailure`/`fire-and-forget`; both describe unrelated subsystems (event emission; general retry guidance) and document no contract this change alters. No doc update needed. ✓
- **Lint + full suite.** `eslint` clean on both files; full `db-core` suite **1159 passing, 0 failing**. ✓

### Found & fixed in this pass (minor)

- **Weak error-path coverage.** The implementer added no tests, and the pre-existing `cancel` test that exercises this path (network-transactor.spec.ts:307) masks the bug: it catches its own manually-thrown `'Commit should have failed'`, so it stayed green whether `commit` threw a TypeError or returned cleanly. Added a focused regression test — `does not crash when a commit fails with only a reason (missing undefined)` — that commits a never-pended action and asserts `commit` resolves to `{ success:false, missing:[] }` rather than throwing. Fails against the pre-fix code (TypeError), passes now.

### Parked (tripwire — no ticket)

- **Reason-only stale failures drop their `reason`.** A `StaleFailure` carrying only a `reason` (no `missing`) is classified as stale and returns `{ success:false, missing:[] }`, so the diagnostic `reason` string is not surfaced (the `throw tailError` branch, which carries the aggregate root-cause message, is skipped). Fine today — the failure still propagates as `success:false`; only diagnostics degrade — and it mirrors the pre-existing `pend`-path behavior. Recorded as a `NOTE:` comment at network-transactor.ts:627 with the trip condition (gate the branch on non-empty `missing` if reason-only rejections ever need their reason surfaced). Not filed as a ticket: conditional, not a latent defect.

### Not found (empty categories)

- **No crashes remaining** on either path — both verified fixed and one covered by a new test.
- **No DRY / modularity issues** — the fix reuses the exact guard pattern already established in `pend`.
- **No regressions** — full suite green; the one behavior change (reason-only commit now returns `{success:false}` instead of throwing a TypeError) is strictly an improvement, and no existing test depended on the crash.
