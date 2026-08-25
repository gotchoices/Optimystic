description: A test that mechanically tries 144 orderings of two machines writing to an indexed table was reviewed. All orderings still pass, so the reported bug still does not reproduce — but the review found the test's own correctness check had never been shown capable of failing, and pinned it with a self-test.
files: packages/quereus-plugin-optimystic/test/two-node-index-interleaving-sweep.spec.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/query-helpers.spec.ts, AGENTS.md
----

# Complete: enumerated two-node index interleavings

## What shipped

`two-node-index-interleaving-sweep.spec.ts` — a table-driven spec that generates two-node
interleavings as data across six dimensions (which node declares the table, how the second
node opens it, index-before-rows or after, write order, read-before-write or not, same or
distinct indexed values) and closes every generated case with `expectIndexAgreesWithScan` on
both nodes. Full cross product = 144 cases.

**The result is still negative: all 144 orderings pass and the downstream bug does not
reproduce.** That was true at handoff and is still true after review. The value of the ticket
is the enumerated ground it rules out, plus the list of dimensions it does not cover.

During review the sweep's gating was flipped by concurrent work: it is now **ungated** — all
144 run on every `yarn test`, measured at ~13s of that package's ~2m46s suite (~7%), with
`INDEX_SWEEP_CORE_ONLY=1` available to narrow to a 12-case subset for a tight inner loop.
`AGENTS.md` § Testing was checked and matches that reality.

# Review findings

## Checked

Read the implement diff (`4e37b63`) before the handoff summary. Scrutinized the generator, the
case executor, the shared oracle in `query-helpers.ts`, the coverage-guard tests, the gating
logic, and every doc the change touches (`AGENTS.md`, the spec header, the helper docstrings).
Independently re-derived the negative control rather than trusting the handoff's account of it.
Verified the `yarn check` chain actually reaches this file. Checked resource cleanup, comment
accuracy against code behaviour, and coverage claims against the dimension tables.

## Found and fixed in this pass

**The oracle had never been shown able to fail on the arm that matters.** This is the finding
that mattered most. The handoff's negative control tripped only the *routing* assertion
(`indexScans > 0` — "did this query reach an index seek at all"). The *row-set comparison* —
the arm that would actually catch "the index missed a committed row" — was never demonstrated
to fail, and the control itself was a scratch file that was run once and deleted. So the 144
greens rested on an untested oracle, and every other two-node convergence spec in the package
rests on the same helper.

Fixed by adding `packages/quereus-plugin-optimystic/test/query-helpers.spec.ts`, a permanent
self-test that pins both arms against a deliberately broken index: `executeIndexScan` is
patched to drop one entry per seek and the row-set comparison is required to reject it; an
unindexed column is required to trip the routing assertion; a misspelled column is required to
raise rather than pass vacuously; and a healthy table is required to pass. Four tests, ~250ms,
single-node and in-memory (no mesh needed). With this in place the sweep's greens are
meaningful on both arms, and a future refactor of the helper cannot quietly turn every caller
into a no-op.

**Three comments that misdescribed what the code covers.** Each fixed at its site:

- The `read` dimension was documented as producing "a node that invents an index collection
  and only READS it" — the shape a read-only replica has. It does not: each node looks up the
  value it is itself about to write, on its own database, so no case ever has a node read a
  value only the *sibling* writes. Corrected in both the file header and at `runPreReads`.
- `staged-both` was listed as one of three write *orders*. It is a different kind of value —
  it stages both mutations before either commits, and always commits node A first — so "both
  staged, A commits second" is not covered. Corrected at `WRITE_ORDERS`.
- `expectIndexAgreesWithScan`'s docstring claimed the defect class "orphaned entries left by
  an UPDATE" while also stating it only queries values the scan still holds. Those contradict:
  it excludes the most common member of the class it claims. Annotated at the site and routed
  to the ticket below.

## Found and filed

**`backlog/debt-index-sweep-misses-update-delete-and-orphans`** — one ticket, two arms, one
root theme: the sweep only ever INSERTs, and the assertion it closes on is structurally blind
to an index entry whose value no row holds any more. Together those mean the sweep *could not
have caught the classic orphaned-entry defect even if it were present* — so more cases on top
of the current assertion would produce more greens without increasing what is detectable. The
ticket orders the arms accordingly: fix the assertion to compare the index's contents against
the table two-ways first, then add a mutation dimension to the generator.

Filed at the "generalized test" rung rather than as a point bug: the ask is one check that
retires the whole orphan class, not a case per symptom. The `staged-both` commit-order gap and
the never-tried read-only-sibling shape are recorded as further arms on the same ticket, since
they resolve at the same site. Site-claim grep across `backlog/fix/plan/implement/review` found
nothing else touching these paths.

## Recorded as a tripwire, not a ticket

**Nothing closes the 288 `Database` instances the wide arm builds, and nothing tears the mesh
down.** Genuinely conditional rather than a latent defect: the mesh is a pure in-process mock
over `MemoryRawStorage` with no sockets or timers to release, the sibling two-node specs leave
theirs open the same way, and the wide arm completes in ~13s with no failure. But it is
per-case garbage that grows with the case count, and this ticket multiplied the case count by
12. Parked as a `NOTE:` at `createNode`, where the next person to widen the sweep will meet it.

## Checked and deliberately left alone

- **The gating flip.** The sweep moved from gated to ungated via concurrent work while this
  review was running. Verified it is internally consistent (header, `RUN_FULL_SWEEP`, the
  describe title, and `AGENTS.md` all describe the same `INDEX_SWEEP_CORE_ONLY` behaviour) and
  that `yarn check` → `yarn test` genuinely reaches all 144. Left as landed.
- **The `'await' has no effect` hints on `query-helpers.ts` lines 11 and 23.** In `queryAll` /
  `queryGet`, untouched by this ticket, editor-severity only; `yarn lint` and `yarn typecheck`
  both pass. Not this ticket's to churn.
- **`npm run test:integration` fails on Windows** — the script uses a `VAR=1 cmd` prefix, which
  `cmd.exe` cannot parse. Not a test failure and not caused by this change; the repo's
  documented invocation is yarn, and `yarn workspace … test:integration` works. Noted here so
  the next Windows agent does not mistake it for a regression.

## Empty categories

**No pre-existing test failures surfaced**, on either tier — `tickets/.pre-existing-error.md`
was not written, and nothing was skipped, commented out, or loosened. **No `blocked/` ticket
was warranted**: nothing here needs a human decision or an out-of-repo dependency. **No
accepted-tradeoff `NOTE:` was found at any finding's site**, so nothing was suppressed as
already-declined.

# Validation

| command | result |
|---|---|
| `yarn lint` (root) | pass |
| `yarn typecheck` (root) | pass |
| `npm test` in `packages/quereus-plugin-optimystic` | 641 passing, 13 pending, 0 failing (3m) |
| `yarn workspace @optimystic/quereus-plugin-optimystic test:integration` | 646 passing, 8 pending, 0 failing (2m) |
| sweep standalone, wide | 150 passing (144 orderings + 6 coverage guards), 14s |

# Honest limits on this review

The review did not add UPDATE/DELETE coverage or an index-key assertion — that is the filed
ticket, deliberately not done inline because it changes what the sweep can detect rather than
correcting what it claims. The sweep's larger untested dimensions carried over from the
handoff and are catalogued on that ticket: no real sockets, no mesh larger than two nodes, no
process restart mid-scenario, no genuine thread-level concurrency (statement execution is
deterministically interleaved on one JS thread, so nothing here races), no same-primary-key
conflict, no composite or UNIQUE index, and only three rows per case — too few to split an
index tree across blocks. The UNIQUE-index gap is the most pointed of those, since the
downstream stack's failing signature names a `_uniq_1` index collection.
