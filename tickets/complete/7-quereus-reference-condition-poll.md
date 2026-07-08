description: The top-level end-to-end tests (SQL-over-distributed-store and the reference peer's diary app) now poll until replicated data actually arrives instead of pausing for a fixed number of seconds; reviewed, verified, and accepted.
files: packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts, packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/reference-peer/test/distributed-diary.spec.ts, packages/db-core/src/testing/async-wait.ts
----

# Outcome

Accepted. The implement-stage conversion of fixed `delay(ms)` propagation sleeps into bounded
condition-polls (`waitForValue` from `@optimystic/db-core/test`) is correct across all three touched
specs. One minor DRY finding fixed inline; no major or blocking issues.

# What the change did (confirmed against the diff)

- **distributed-quereus.spec.ts** — 4 cross-node verification loops (INSERT→3 rows, UPDATE→75,
  DELETE→2 rows, initial-state→qty 100) converted to polls. The UPDATE/DELETE polls check the
  *post-write* value, so they poll **past** stale state.
- **distributed-transaction-validation.spec.ts** — 10 sites converted, including the file-storage
  `SUM=600` poll and the sequential last-writer test where a new poll makes Node 3 observe Node 2's
  `balance=800` before overwriting to 600, turning a propagation-vs-write race into a deterministic
  "last writer wins".
- **distributed-diary.spec.ts** — entry-distribution ordering, storage-consistency read, and
  concurrent-writes convergence converted; the debug `await stmt.all()` that logged `{}` replaced by a
  real row collection.
- **reactive-watch.spec.ts / index-support.spec.ts** — untouched (git stat confirms only 3 spec files
  changed). Their residual `delay()` calls are negative-assertion waits (assert an event did *not*
  fire) which cannot be condition-polled; correctly left alone.

# Review findings

**Checked:** implement diff read first with fresh eyes; `waitFor`/`waitForValue`/`delay` contract in
`async-wait.ts`; the `@optimystic/db-core/test` subpath export + built dist; every converted poll
predicate vs. its subsequent assertion; the `SELECT SUM` null-until-complete edge; the last-writer
determinism poll; the concurrent-writes `>= count` bound vs. exact-equality assertion; all residual
`delay()` sites (11 / 21 / 4, matching the handoff) for missed pollable reads; resource cleanup
(statement finalize); lint + typecheck + real-mesh runs of all three converted specs.

**Correctness — none found.**
- Poll-past-stale predicates verified: UPDATE→`quantity===75`, DELETE→`length===2`, customer→
  `'Charlie'`, sequential balance→`600`, SUM→`total===600`. Each checks the settled post-write value,
  not mere row presence, so none can early-exit on a transiently stale read.
- `SELECT SUM` edge is sound: `SUM(value)` over an empty/partial table yields a row with `total=null`;
  the predicate `r?.total === 600 ? r : undefined` returns `undefined` for both the no-row and the
  partial-sum cases, so the poll cannot early-exit on a wrong sum. `queryGet` returning the row (not
  `undefined`) does not defeat this — readiness is decided by the wrapping predicate, correctly
  separated.
- Concurrent-writes `entries.length >= successfulWrites` then `expect(...).to.equal(successfulWrites)`
  is safe: only fulfilled appends add entries, so length can never exceed the count and `>=` collapses
  to `==`. Assertion is identical to the pre-change one — no regression.
- Residual `delay()` sites are all genuine no-observable-read waits (mesh convergence in `before()`,
  collection/table establishment before the *first* write so a late node attaches rather than forking
  an empty collection, FRET stabilize-between-tests, and originator-node reads of its own just-written
  data which are synchronously consistent). None is a missed pollable read.
- All polls bounded at `timeoutMs: 30_000` with descriptive messages — a broken query fails fast, not
  at the runner idle-timeout.

**Minor — fixed inline (DRY).** `queryAll` / `queryGet` were duplicated verbatim (~20 lines) across
the two quereus specs. AGENTS.md lists "Stay DRY" as a first-class rule. Extracted to
`packages/quereus-plugin-optimystic/test/query-helpers.ts` and imported into both specs. `Database` is
a type-only import there; mocha's `test/**/*.spec.ts` glob does not pick up the non-`.spec.ts` helper,
so it is not run as a test. Re-verified: tsc exit 0, eslint exit 0, and both quereus specs still 10
passing on the real mesh.

**Major — none.** No new fix/plan/backlog tickets filed.

**Docs — no surface.** `grep` of `docs/**/*.md` for the wait helpers / `delay` returns nothing; this
is a test-only refactor with no documentation to update.

**Tripwire (recorded, not ticketed).** `reference-peer` runs mocha with a fixed `--timeout 10000`,
while the new poll bounds are 30s. On a healthy machine the polls return in well under 1s so this
never bites, but on a very slow CI box mocha's 10s per-test timeout would fire *before* the 30s poll
bound, yielding a generic "timeout of 10000ms exceeded" instead of the poll's descriptive message.
This is pre-existing behaviour (the diary `before()` FRET poll already lives under the same 10s cap)
and affects only the failure *message*, not correctness — parked here in findings, matching the
implementer's disposition. No single code site to comment on and no defect to ticket.

# Validation run during review

Real 3-node libp2p mesh, streamed, on Windows.

- `eslint` on the 3 changed specs + new helper → **exit 0**.
- `tsc --noEmit` on `quereus-plugin-optimystic` and `reference-peer` → **exit 0** (before and after the
  DRY extraction).
- **distributed-diary**: 4 passing (6s); entry ordering now deterministic (Node 1/2/3).
- **distributed-quereus**: 4 passing (25s); logs show poll-past-stale (100→75, 3→2 rows).
- **distributed-transaction-validation**: 6 passing (~1m); `total=600` and last-writer `balance=600`
  deterministic.
- Post-extraction re-run of both quereus specs together → **10 passing**.

# Honest gaps carried forward

Not a full per-package `yarn test` sweep — the touched specs were run individually (repeatedly), same
as the implement stage, because the full quereus suite includes several other 15–120s integration
specs that approach the agent idle budget. No pre-existing failures were seen in what was run; a full
sweep is left to CI. `reactive-watch` / `index-support` were not re-run because this diff does not
touch them.
