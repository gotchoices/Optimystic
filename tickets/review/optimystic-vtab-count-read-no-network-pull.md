description: An investigation expected that counting rows skipped the step that fetches fresh data from other peers; testing shows counting already fetches fresh data exactly like every other read, so there was no bug to fix — the work added a regression test and documentation instead of a code change.
prereq:
files: packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, docs/internals.md
difficulty: hard

## TL;DR for the reviewer

The implement ticket's central hypothesis — **"`select count(*)` does not pull
latest from the network, whereas other reads do"** — was put under an empirical,
harness-independent test and is **FALSE**. `count(*)` reaches
`OptimysticVirtualTable.query()`, runs `executeTableScan()`, and calls
`collection.update()` (the network pull) on exactly the same access path as
`select <col>`. H1, H2, and H3 from the implement ticket are all disproven.

Because there was no defect at the level this ticket scoped, **no product code was
changed.** The work product is:
1. A new regression spec that locks in the correct invariant
   (`test/read-pull-mechanism.spec.ts`).
2. A docs update in `docs/internals.md` stating the invariant explicitly and
   recording that the suspected gap was investigated and disproven.

**The reviewer's job here is unusual: adversarially verify the *negative* claim.**
The risk is not a subtle bug in a fix (there is no fix) — it is that the
"no bug" conclusion is wrong or incomplete. Try hard to find a `count(*)` shape or
configuration that *does* skip `collection.update()`. If you cannot, advance to
`complete/`. If the broader convergence concern still matters (see "Genuinely open"
below), spawn a focused `fix/`/`backlog/` ticket rather than reopening this one.

## What was measured (the evidence)

New spec `packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts`
monkeypatches the **shared** dist prototypes (both `index.js` and `plugin.js`
re-export from one tsup chunk, so the patched prototype is the one the registered
plugin instantiates):
- `OptimysticVirtualTable.prototype.{query, executeTableScan, executePointLookup, executeIndexScan}`
- `Tree.prototype.update` (the network pull)

Counts per read shape (logged in the test output):

| Read shape | `query()` | `executeTableScan` | `executePointLookup` | `Tree.update` (pull) | plan idxStr |
|---|---|---|---|---|---|
| `select count(*) as c` (db.eval) | 1 | 1 | 0 | **1** | `fullscan` |
| `select count(*)` bare (db.eval) | 1 | 1 | 0 | **1** | `fullscan` |
| `count(*)` via `db.get` (H3) | 1 | 1 | 0 | **1** | `fullscan` |
| `count(*) where id = 2` (PK pred) | 1 | 0 | 1 | **1** | `idx=_primary_(0);plan=2` |
| `select id` (full scan) | 1 | 1 | 0 | 1 | `fullscan` |
| point lookup `where id = 3` | 1 | 0 | 1 | 1 | `idx=_primary_(0);plan=2` |

`count(*)` is byte-for-byte the same access path as `select id` (`fullscan` →
`executeTableScan` → `collection.update()`). It is **not** served from
`StatisticsCollector` (a `tableScan` actually runs).

Cross-writer convergence (truest single-process two-peer model — two independent
`Database`s over the SAME on-disk `FileRawStorage` dir):
- Peer A inserts row 1; Peer B (separate Database, same dir) appends rows 2 & 3
  and commits; Peer A then runs `select count(*)` → **returns 3** and the pull
  fired (`Tree.update` count ≥ 1). `select id` also returns 3.
- Conclusion: a count-only reader **does** observe a second writer's committed
  appends after its pull.

Corroboration from the existing suite: `mesh-test-transactor` / distributed specs
spin up a real **3-node libp2p mesh** and show cross-node read convergence
("Node 1/2/3: 3 rows … Data consistent across all nodes") — so pull-on-read
converges across real peers, not just shared in-process storage.

## Why the implement ticket's model was wrong

The implement ticket reasoned: "all three vtab read methods call `update()`, yet
`count(*)` doesn't pull, therefore `count(*)` must not reach `query()`." The hidden
premise — that `count(*)` doesn't pull — came from interpreting a *cadre-level*
(sereus) convergence measurement, never from the optimystic read path itself. Direct
measurement of the read path shows the premise is false. Quereus answers an
aggregate by **streaming rows from an ordinary scan** (there is no row-count vtab
API: confirmed absent in `@quereus/quereus` `vtab/`), so `count(*)` cannot bypass
the cursor — it must drain `query()`, which pulls.

## What changed

- **Added** `packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts`
  (3 tests, all passing): read-shape invocation comparison; all-count-shapes pull
  (rules out H1/H2/H3); cross-writer convergence.
- **Edited** `docs/internals.md`:
  - New subsection under *Read Path*: "Quereus vtab read path — pull-on-read is
    shape-independent" (states the invariant; records the disproven gap).
  - New item under *Debugging Tips → Missing Data Across Nodes* pointing at the
    pull-on-read invariant for the "write-only peer never sees rows" symptom.
- **No source changes.** Deliberately did **not** add a redundant `update()` to a
  count path — count already pulls, and a second pull would be the exact
  double-`update()` regression the implement ticket warned against.

## Validation steps for the reviewer

```
cd packages/quereus-plugin-optimystic
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/read-pull-mechanism.spec.ts" --reporter spec --exit
```
Expect 3 passing; inspect the `[read-pull]` / `[shapes]` / `[cross-writer]` console
lines for the invocation counts above. Full suite (`"test/**/*.spec.ts"`,
min reporter) is green: **222 passing, 5 pending** on this branch.

Adversarial angles worth probing (each would falsify the conclusion):
- A `count(*)` over a **secondary index** / covering index — does it route through
  `executeIndexScan` (which also pulls) or some path that skips `update()`?
- `count(DISTINCT col)`, `count(col)`, `sum`/`min`/`max`, `group by` aggregates.
- A `count(*)` whose plan the optimizer could satisfy from cached stats once
  `estimatedRows` is populated — confirm it still scans (it must, for exactness).
- Whether `query()` is ever short-circuited by an empty-table fast path.

## Genuinely open (NOT this ticket; escalate if it matters)

The originating fix ticket's cadre-level observation — a *blind* (no in-loop reads)
two-peer workload's final `count(*)` poll loop timing out at 30 s in sereus
`convergence-stress` — is **not explained by the optimystic count read path** (which
pulls). Its true cause is unresolved and currently **unreproducible**: the sereus
harness cannot run at optimystic HEAD because `cadre-core/src/schema-verification.ts`
still calls the pre-`8cea904` 4-arg `digest()` signature (`signSchema` throws
`Unsupported output encoding: utf8` at module load). That is a **sereus cross-repo
migration**, out of this repo's scope.

If the reviewer judges the blind-convergence question still open, the right
follow-up is a `fix/` (or `backlog/`, since it's blocked) ticket scoped to: (a) the
sereus cadre digest migration to unblock the harness, then (b) re-running the
`convergence-stress` "Interleaved Inserts" scenario in its blind form. The optimystic
side has been exonerated by the evidence above; do not re-scope that work onto this
slug.

## Suggested disposition

Advance to `complete/` with a `## Review findings` section recording that the
ticket's premise was empirically disproven, the regression guard + docs landed, and
the residual cadre-level repro is a separately-tracked, harness-blocked concern.
