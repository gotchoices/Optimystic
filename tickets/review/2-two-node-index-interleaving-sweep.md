description: A test was added that mechanically tries 144 different orderings two machines can perform against a secondary index, to find a reported bug that four hand-written attempts had failed to trigger. Every ordering passed — the bug still does not reproduce here, and the handoff says which orderings were never tried.
prereq:
files: packages/quereus-plugin-optimystic/test/two-node-index-interleaving-sweep.spec.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, AGENTS.md
difficulty: medium
----

# Review: enumerated two-node index interleavings

## Headline result — read this first

**All 144 generated orderings pass. The downstream bug did not reproduce.**

The ticket's instruction was "if a case fails, that is the reproduction — leave it failing
and hand off the ordering." No case failed. So the honest handoff is the negative one: the
six dimensions crossed here are *not* where the trigger lives, and the list of dimensions
that were **not** swept (below) is now the most valuable thing in this ticket.

This is a fifth failure to reproduce, but it is a different *kind* of failure than the
previous four. Those four each ruled out one hand-picked scenario. This rules out an
enumerated space, which is what makes the un-swept list meaningful rather than arbitrary.

## What was built

`packages/quereus-plugin-optimystic/test/two-node-index-interleaving-sweep.spec.ts` — one
table-driven spec that generates two-node interleavings as data and closes every case with
`expectIndexAgreesWithScan` on **both** nodes.

Six dimensions, full cross product = 2 × 3 × 2 × 3 × 2 × 2 = 144 cases:

| dimension | values | why it is in the sweep |
|---|---|---|
| `declare` | `A`, `B` | the mock mesh assigns block responsibility by key hash, so the two nodes are not interchangeable |
| `open` | `redeclare`, `hydrate`, `both-invent` | second node re-issues the DDL / loads the persisted catalog with no DDL at all / declares the table before any row exists so both nodes stage a fresh collection |
| `index` | `index-first`, `rows-first` | index declared before the first row, or after it (the backfill path) |
| `write` | `a-then-b`, `b-then-a`, `staged-both` | write order across the nodes; `staged-both` opens both transactions and stages both mutations before either commits |
| `read` | `read-first`, `write-first` | whether each node index-seeks its own value before writing it — the arm that never takes the write path's reconcile |
| `token` | `same-token`, `distinct-tokens` | every pre-existing case lands both nodes on the same value; the downstream scenario redeems distinct ones |

Each case name **is** the ordering, e.g.
`declare=B open=hydrate index=rows-first write=staged-both read=write-first token=same-token`,
so a future red case needs no decoding.

Each case: seed row (Id 1) written by the declaring node, then node A writes Id 100 and
node B writes Id 200. Closing assertions, in order:

1. `expectScansConverged` — both nodes' full scan holds all three rows. Not the defect under
   test; it is what stops the index/scan comparison from passing vacuously, since a node whose
   scan is missing the sibling's row has an index legitimately missing it too.
2. `expectIndexAgreesWithScan` on node A and on node B — the ticket's oracle, unmodified.

## Green means something — the negative control

A green sweep is only worth reading if it can go red. Verified against a scratch copy of the
spec (created, run, deleted — not committed) with one mutation: the second node skips its
`create index` in the `open=redeclare` arm. Result: exactly the four `open=redeclare` core
cases failed, all four inside `expectIndexAgreesWithScan` at `query-helpers.ts:140` (the probe
that requires the predicate to have reached `executeIndexScan` rather than falling back to a
full scan). The other eight passed untouched.

So the oracle is live in every case, index routing genuinely happens on both nodes including
the cold-`hydrate` one, and the 144 greens are not vacuous.

## How to run it

```
# routine — 12-case core subset, ~3s
yarn test

# full 144 orderings — also runs under `yarn test:integration` and `yarn check`
OPTIMYSTIC_INTEGRATION=1 yarn test

# this file alone, wide, without dragging in the real-socket specs
RUN_INDEX_SWEEP=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/two-node-index-interleaving-sweep.spec.ts" --reporter spec --exit
```

### Why it is gated, with the measurement

Full sweep: **32s wall clock, 144 cases, median 208ms per case** (min 117ms, p90 304ms, max
460ms — measured with `--reporter spec`, timings summed). This package's suite is **2m21s**,
so ungated the sweep is a **23% tax on every routine run**. That is over the "fits
comfortably" line, so per the ticket's stated fallback it is gated and a 12-case core subset
stays ungated (~3s).

The gate deliberately rides `OPTIMYSTIC_INTEGRATION=1` rather than being a `RUN_`-only
third-tier var. AGENTS.md notes that third-tier vars "run in no script, including `yarn
check`" — a sweep that never runs in CI would defeat its own purpose. On the integration tier
the full 144 run under `yarn test:integration` and the `yarn check` pre-release gate.
`RUN_INDEX_SWEEP=1` is the standalone escape hatch. AGENTS.md § Testing was updated to say so.

The core subset is chosen, not sampled: every dimension value appears ≥4 times, and the pairs
`declare × open`, `open × index`, `write × read`, `write × token` are each covered
exhaustively. A guard test (`keeps the core subset covering every value of every dimension`)
re-checks the per-value half of that claim so the subset cannot silently degrade under a later
edit — but note it does **not** check the pairwise half, which is asserted only in prose.

## Validation run

| command | result |
|---|---|
| `yarn lint` (root) | pass |
| `yarn build` (root) | pass |
| `yarn typecheck` (root) | pass |
| `yarn test` in `packages/quereus-plugin-optimystic` | 500 passing, 13 pending, 0 failing |
| `OPTIMYSTIC_INTEGRATION=1 yarn test` in same | 637 passing, 8 pending, 0 failing |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

The working tree also carries uncommitted edits from concurrently-running sibling tickets
(`docs/debugging.md`, `packages/db-core/src/collection/collection.ts`,
`packages/quereus-plugin-optimystic/src/optimystic-module.ts`, and three specs). Those are not
from this ticket and were left alone; the runs above were against the tree including them.

## Known gaps — what this sweep does NOT cover

Treat these as the candidate list for wherever the trigger actually lives. None of them is
covered by any case here, and several are cheap to add on top of this generator.

- **INSERT only.** No UPDATE and no DELETE anywhere in the sweep. An UPDATE that moves a row
  between index values is the classic way to orphan an index entry, and it is completely
  unexercised. This is the largest gap and, given the downstream symptom, probably the first
  place to look.
- **The oracle is structurally blind to fully-orphaned entries.** `expectIndexAgreesWithScan`
  queries only values the scan still holds (documented in `query-helpers.ts`), so an index
  entry for a value no longer present in any row is never queried and never seen. Combined
  with the point above: the sweep could not have caught an orphan even if one existed.
- **Two nodes, in-process mock mesh only.** No real sockets — the libp2p integration spec
  covers exactly one shape, not the sweep. No mesh larger than 2.
- **No process restart / cold reopen from persisted storage mid-scenario.** `open=hydrate`
  hydrates a fresh `Database` against a live shared transactor; it does not restart a node.
- **`staged-both` is not true concurrency.** Both transactions are open and both mutations
  staged before either commits, but statement execution is deterministically interleaved from
  one JS thread. Nothing here races.
- **No same-primary-key conflict.** Each node writes its own disjoint id (100 / 200).
- **Single-column, non-UNIQUE index only.** No composite index, no UNIQUE index — even though
  `two-node-multi-collection-commit.spec.ts` shows the downstream stack's failing signature
  named a `_uniq_1` index collection.
- **Three rows total per case.** Far too few to split an index btree node, so nothing here
  exercises multi-block index trees.

## Tripwire parked

- Case count multiplies with each added dimension, and 144 is affordable only because the mesh
  is in-process. Parked as a `NOTE:` in the spec's header comment (~line 40) next to the
  measured numbers, where anyone about to add a seventh dimension will meet it.

## Suggested review focus

- Is the un-swept list above the right next move, and is UPDATE/DELETE worth a follow-up
  ticket now rather than after another downstream report? This ticket deliberately did not
  file one — the ticket's scope was the sweep, and widening it is a scoping call.
- The core-subset guard test checks per-value coverage but not the pairwise coverage the
  prose claims. Worth tightening, or is prose enough?
- `expectScansConverged` is a new assertion this ticket added ahead of the ticket's specified
  oracle. It is load-bearing (it is what makes the comparison non-vacuous) but it is stricter
  than the ticket asked for — confirm that is wanted rather than scope creep.
