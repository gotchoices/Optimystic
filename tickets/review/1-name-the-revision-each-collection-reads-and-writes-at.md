description: Addendum to a sibling review ticket that covers the same work. Debug logging now names which version of each stored collection a write committed to and a read descended; this file records only the handful of corrections and observations made after that work was committed.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, docs/debugging.md, tickets/review/1-name-the-revision-each-index-read-and-commit-lands-on.md
difficulty: easy
----

# Addendum: name the revision each collection reads and writes at

## Review the sibling ticket, not this one, for the change itself

The runner dispatched two overlapping implement tickets for the same measurement in
parallel. The other one — `1-name-the-revision-each-index-read-and-commit-lands-on`, in
this same folder — carries the **full handoff**: what the accessor is, what the two log
lines print, how to validate, and its own gap list. Its commit (`9d277b3`) already contains
the shared implementation.

**Review the union of the working tree once, using that ticket.** This file exists only so
this slug's transition is on the board, and it carries the few items that landed *after*
that commit and therefore cannot appear there.

## What landed after the sibling's commit

All in the uncommitted working tree at handoff:

- **`docs/debugging.md`** — expanded the "do not subtract `rev=` from `main_rev=`" warning
  into its own indented paragraph under the `main_rev=` bullet, with the real captured
  numbers as evidence (a fully healthy run shows `rev=4 main_rev=3`), and stated that a
  revision is comparable only to another revision *of the same collection*.
- **`docs/debugging.md`** — new caveat under the decision table: **`none` on its own is not
  proof of the invention race.** A collection that has legitimately never been committed
  also reports `none`, and a first insert normally shows the *main table* collection at
  `:none` in the very `commit:collections` line that creates it. Confirmed in a live
  capture from this repo:
  `revs=default/FormationUsage:none,default/FormationUsage/index/formation_usage_by_token:1`.
  `none` is a finding only when something has already been committed under that id.
- **`packages/quereus-plugin-optimystic/src/optimystic-module.ts`** — the same
  per-collection-scale correction in the `logIndexSeek` docblock, which previously repeated
  the implement ticket's wording that the two revisions could be read as a gap.
- **`packages/quereus-plugin-optimystic/src/optimystic-module.ts`** — a new tripwire `NOTE:`
  (see findings below).

## Validation at handoff

```bash
yarn build && yarn typecheck
yarn workspace @optimystic/db-core test
yarn workspace @optimystic/quereus-plugin-optimystic test
```

Build and typecheck clean; db-core **1387 passing**; plugin **481 passing, 13 pending,
0 failing**. The db-p2p spec named in the implement ticket
(`test/two-node-convergence-invention-race.spec.ts`) also passes, 4/4.

To see the lines by hand, note that specs using `captureTrace` **swallow** them (it replaces
the global `debug` sink), so `DEBUG=` prints nothing for those. Use a test that queries
outside `captureTrace`:

```bash
cd packages/quereus-plugin-optimystic
DEBUG='optimystic:quereus-plugin:module' node --import ./register.mjs \
  node_modules/mocha/bin/mocha.js "test/two-node-secondary-index-convergence.spec.ts" \
  --grep "A declares and inserts" --reporter dot
```

## Gap the sibling's list does not name

**Nothing asserts that `none` or `unknown` is ever emitted.** `none` is exercised only
incidentally (a first commit does produce it), and the `unknown` branch — a test double that
omits `committedRevision()` — has no coverage at all. Both are the branches an operator will
lean on hardest when reading a failing log, so they are the ones worth a deliberate test.

## Suite stability — not a failure to chase, but worth knowing

The plugin suite failed twice while the parallel run's builds and tests were competing for
CPU: once with 1 timeout, once with 4. Every failure was `Timeout of 15000ms exceeded`,
never an assertion, and all were in specs this work does not touch (e.g.
`update-pk-move-uniqueness.spec.ts`, which passes in isolation in 942 ms against a 15 s
limit). The suite is green on a quiet machine, so no `tickets/.pre-existing-error.md` was
written — but these fixed 15 s timeouts have very little headroom under load, and a red CI
run of this shape should be re-run before it is read as a regression.

## The implement ticket's secondary observation, answered

The downstream failing run had 123 of 136 `commit:collections` lines at `count=0`, and the
implement ticket asked whether `mode=` makes that legible. **It does, and the answer is
benign.** In `mode=legacy` the reported set is the *dirty* set, so `count=0` means no tree
staged any change — a read-only or no-op transaction, which is exactly what a `SELECT` or a
`CREATE` statement produces. Confirmed directly in this repo's capture: every `count=0` line
sits around a `SELECT`/`CREATE`, while inserts produce `count=2`.

`mode=session` would be a different statement — there the set is the whole live collection
registry, so `count=0` would mean nothing was registered at all, which is rare. Worth one
glance at the actual `mode=` values on those 123 lines before closing the question; if they
are all `mode=legacy`, they are normal and need no further work.

## Review findings

- **Tripwire, parked at the code site.** `index:seek` emits one line **per index-driven
  scan** — unlike `index:tree-open`, which is bring-up only — so a query loop that seeks per
  row emits one line per row. Fine now: the namespace is off by default and the line costs
  nothing when disabled. Recorded as a `NOTE:` on the `logIndexSeek` docblock in
  `packages/quereus-plugin-optimystic/src/optimystic-module.ts`, naming the remedy if it ever
  trips (sample every Nth scan, or split it to its own sub-namespace) rather than deleting
  the line.
- **Corrected before handoff, no ticket:** the implement ticket specified describing the
  index-vs-main revision difference as "the refresh asymmetry as a number". That is wrong —
  the two collections count revisions independently, so the numbers are not on one scale and
  are unequal on healthy runs. Both the doc and the `logIndexSeek` docblock now say so, with
  the captured evidence. This is the one place where following the ticket literally would
  have shipped a diagnostic that lies, so it is worth a reviewer's confirmation.
- **Duplicate-review hazard:** two review tickets exist for one body of work. The sibling
  ticket is the primary; this one is an addendum. Reviewing both in full would double the
  effort for no coverage gain.
