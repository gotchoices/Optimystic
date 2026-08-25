description: A bug reported by another project has now survived four investigations here because nobody can make it happen on this machine, and each attempt has been a new hand-written scenario. Replace the guessing with a test that mechanically tries every ordering two machines can do, so the failing one is found here instead of downstream.
prereq:
files: packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-libp2p.integration.spec.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/two-node-convergence-invention-race.spec.ts
difficulty: medium
----

# Enumerate the two-node orderings instead of guessing them

## Why this exists

A downstream project reports that a row written on one machine cannot be found through its
secondary index on the other, while the same row on the same machine is found by
primary-key lookup and by full scan. Four passes here have each written *another* hand-picked
two-node scenario, and every one of them converges. The bug is real and deterministic where
it happens; what is missing is the ordering that triggers it.

Hand-picking scenarios has now failed four times in a row. That is the signal to stop
picking and start enumerating.

## What already exists

- `test/two-node-secondary-index-convergence.spec.ts` — two Databases over one 2-node mock
  mesh, table `FormationUsage` with an index on `Token`. Two convergence cases (A-declares-
  then-B-redeclares; both-declare-then-both-write) plus two trace-pinning cases.
- `test/query-helpers.ts` exports `expectIndexAgreesWithScan(db, table, column)` — for every
  value present in `column`, the index-routed seek must return exactly what the full scan
  returns. **This is already the right oracle.** It just is not being applied across enough
  orderings.
- `test/two-node-secondary-index-libp2p.integration.spec.ts` — the same shape over real
  libp2p.
- `packages/db-p2p/test/two-node-convergence-invention-race.spec.ts` — the db-core-level
  analogue, four hand-written invention orderings.
- `createMesh(nodeCount, options)` / `buildNetworkTransactors(mesh)` in
  `packages/db-p2p/src/testing/mesh-harness.ts` build the two-node mesh.

## What to build

One table-driven spec that generates two-node interleavings and applies
`expectIndexAgreesWithScan` on **both** nodes as the closing assertion of every one.

The dimensions worth crossing — each is a real difference between the existing passing
cases and the failing downstream run, and none of them is currently swept:

- **Which node declares the table first**, and whether the second node re-declares the
  table and index or opens cold from the persisted catalog.
- **Whether the index is created before or after the first rows are inserted** on each node.
- **Write order across the two nodes** — A then B, B then A, and both staged before either
  commits.
- **Whether each node reads through the index before writing**, which is what forces (or
  fails to force) a freshly-invented index collection to reconcile. The db-core spec's
  pure-reader case exists precisely because a node that invents a collection and only reads
  it never takes the write path's reconcile.
- **Whether the two nodes write the same indexed value or different ones.** Every existing
  case has both nodes land on the same token value; the downstream scenario redeems
  distinct tokens concurrently.

Generate the cases as data and name each one from its dimensions, so a failure names the
ordering directly rather than pointing at case 37.

## Constraints

- **The sweep must stay inside the runner's budget.** A full cross product is not the goal;
  a deliberately chosen subset is. Measure the wall clock of the generated suite and state
  the number in the handoff. If it does not fit comfortably in a routine `yarn test` run,
  gate the wide sweep behind an env var following this repo's existing convention
  (`RUN_LONG_TESTS=1` and friends — grep `process.env.RUN_` under `test/`), keep a small
  representative subset ungated, and put the exact command in the spec's header comment.
- **A failing case is a finding, not something to relax.** If the sweep turns one red, that
  is the reproduction four passes have been trying to obtain. Do not narrow the generator to
  make it green, do not skip the case, and do not soften `expectIndexAgreesWithScan`. Leave
  it failing, and hand off with the exact ordering that produced it — that hands the next
  stage a root cause instead of another observability step.
- Mirror the existing harness in `two-node-secondary-index-convergence.spec.ts` (two
  `Database` instances, one mesh, `registerTransactor` per node) rather than inventing a new
  one.

## Relationship to the sibling ticket

`1-name-the-revision-each-index-read-and-commit-lands-on` adds the revision fields to the
commit and read traces. If it has landed, a failing case here can be read straight off those
lines; if it has not, this sweep still stands on its own. Neither blocks the other.

## TODO

- Add the generated two-node interleaving spec to `packages/quereus-plugin-optimystic/test/`,
  crossing the dimensions above and closing every case with
  `expectIndexAgreesWithScan` on both nodes.
- Name each generated case from its dimension values.
- Measure the suite's wall clock; gate the wide sweep behind an env var if it does not fit a
  routine test run, and document the command in the spec header.
- If a case fails: capture the ordering, leave the test failing, and say so plainly in the
  handoff rather than adjusting the generator.
- Run `yarn lint`, `yarn build`, `yarn typecheck`, then `yarn test` and
  `OPTIMYSTIC_INTEGRATION=1 yarn test` in `packages/quereus-plugin-optimystic`.
