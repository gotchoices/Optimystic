description: One test now runs the same transaction scenario at one, two, three, four and five machines and checks at each size what the documentation says should happen: every machine writes and reads, two machines race for the same row, one machine goes unreachable, and every saved row is still readable. Review it for what it misses and whether its expectations really follow the documentation.
prereq:
files:
  - packages/db-p2p/test/transaction-node-count-sweep.spec.ts (new — the sweep)
  - packages/db-p2p/test/util/node-count-mesh.ts (new — the production-shaped mesh configuration, a transactor driven by a chosen node, and `setUnreachable`; written to be reused by `implement/1.5-a-member-that-leaves-mid-session-and-returns`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (comment only: one measured sentence added to the all-lose-round NOTE in `pendThroughCluster`'s catch block)
  - tickets/backlog/debt-unpromotable-pending-records-need-a-sweep.md (appended arm: a cancel needs the same quorum the refused write missed)
  - tickets/backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text.md (appended arm: the sweep parses the promise-shortfall text because there is no typed field)
  - packages/db-p2p/test/util/two-machine-lifecycle.ts (`sequentialPhases` is imported from here)
----

# What was built

`transaction-node-count-sweep.spec.ts` runs on the in-process mesh, so it is part of plain `yarn test` (no sockets). It loops over 1–5 machines. Each size gets one mesh and four phases in order. If a phase fails, the phases after it fail straight away and name it, using `sequentialPhases` from the two-machine lifecycle helpers.

**Configuration.** Each mesh is set up the way a real deployment of that size is: `responsibilityK` and the replication factor are left at the default of 10, and the machine count is declared only as `clusterPolicy.repairCorroborationClusterSize: N`. It never uses the `clusterSize: N` shortcut. The harness could already express this, so the harness itself did not change. A first test checks that the mesh actually resolves these numbers: promise fraction 0.75, commit fraction 0.51, replication factor 10, and a repair size of N.

**Expectations come from the documented arithmetic.** The promise bar is `ceil(0.75n)`, the commit bar is `floor(0.51n)+1`, and the durability gate needs more than half the cohort. The fractions are written out in the spec rather than imported, so a change to a default fails next to the docs it would contradict. The arithmetic is also checked against a hand-written table (2 refused, 3 refused, 4 acknowledged, 5 acknowledged). The promise bar is always the one that binds at these sizes, so the durability-gate refusal (`COMMIT_NOT_DURABLE_REASON`) is never reached here. `commit-durability-quorum.spec.ts` still covers that refusal at two members. The spec says this in a comment.

## The phases, per size

1. **Every node writes, every node reads.** Node *i* writes `row-i` into one shared Tree with a transactor that *node i coordinates* (`transactorDrivenBy`). The test records every repo call and asserts that node *i*'s write reached only node *i*. It also checks:
   - At N = 1 the write's durability is `local` with a cohort of 1. At N ≥ 2 it is fully durable with a cohort of N.
   - For every block written, the cohort is the whole mesh, and every node's own storage holds that block at the committed revision.
   - Every node reads every row back through a fresh Tree handle.
2. **Two nodes race one row.** Nodes 0 and 1 open handles before either writes, then write the same key at the same moment. The test asserts:
   - Both first pends asked for the same revision.
   - No pend or commit threw.
   - Every refused attempt passes `isConflictFailure`.
   - Exactly one action committed the contested revision.
   - Each application-level write either landed or was rejected only with `SyncRetryExhaustedError`, and at least one landed.
   - Every node reads the value of whichever write committed last.

   At N = 1 this phase is replaced by a passing `it` whose title gives the reason ("one machine has no second node to race"). That is a decision fixed when the file loads, not a `this.skip()` made after looking at the mesh.
3. **One member unreachable.** `setUnreachable(mesh, [lastNode])` makes cluster calls to that node fail, silences its read-path answers, and makes every driven transactor's repo calls to it reject. The cohort view still names it (a comment marks this as the unchanged-view case, not the lone-survivor question in `backlog/more-design/6.5-partition-healing.md`). Node 0 writes.
   - **Acknowledged (N = 4, 5):** durability is `majority`, `confirmed` is N−1, `unconfirmed` is exactly the away node, and in each node's own storage the committed blocks are held by at least `floor(N/2)+1` nodes, not including the away node.
   - **Refused (N = 2, 3):** `Tree.replace` rejects with a plain `Error` (not `SyncRetryExhaustedError`) whose message starts `Some peers did not complete: `. Its `cause` is an `Error` matching `Failed to get super-majority: a/n approvals (needed k, r rejections)`, with a = N−1, n = N, k = `ceil(0.75N)` and r = 0. Nothing was committed, and no reachable node reads the refused row. This matches what `mesh-sanity.spec.ts` Suite 2 and `cluster-coordinator-supermajority.spec.ts` already check for three nodes.
4. **Acknowledged means durable.** Every row ever acknowledged, at its last acknowledged value, is read back from every node that is still reachable while the away node stays away.

A per-size table is printed through `console.log` when the suite ends.

# Validation

- `yarn lint`: clean. `yarn build`: clean. `tsc --noEmit -p packages/db-p2p` (which includes tests): clean.
- `yarn workspace @optimystic/db-p2p test`: 2790 passing, 62 pending, 0 failing. I did not add any pending tests.
- The spec on its own passed **5 of 5 runs**, 21 tests each, in about 3.5–4.5 s per run including mesh setup (well under the 30 s budget, so no rows were cut). Per-size runtime: size 1 ≈ 50 ms, 2 ≈ 1.2–1.5 s, 3 ≈ 1.1–1.6 s, 4 ≈ 0.4–0.6 s, 5 ≈ 0.5–1.1 s.

Table as observed (identical in shape across all five runs; only timings and which node won varied):

```
size | promise bar | expected, one away | observed, one away                         | two writers racing one row
1    | n/a (solo)  | n/a                | n/a                                        | n/a: no second writer
2    | 2 of 2      | refused            | refused (1/2 promises, needed 2) in ~1.1s  | round 1: both lost; 2 lost attempt(s), all conflicts; rev 3 won; 2 of 2 landed
3    | 3 of 3      | refused            | refused (2/3 promises, needed 3) in ~1.0s  | round 1: both lost; ... rev 4 won; 2 of 2 landed
4    | 3 of 4      | acknowledged       | acknowledged (3 of 4 hold it) in ~30ms     | round 1: both lost; ... rev 5 won; 2 of 2 landed
5    | 4 of 5      | acknowledged       | acknowledged (4 of 5 hold it) in ~45ms     | round 1: both lost; ... rev 6 won; 2 of 2 landed
```

**No size contradicted the documented rule**, so no `fix/` ticket was filed and nothing is marked pending.

# Findings along the way (recorded, not ticketed)

- **A refused write at two or three machines takes about a second, and nearly all of that is a cancel that cannot succeed.** `CoordinatorRepo.cancel` is itself a cluster transaction, so it misses the same super-majority, and `NetworkTransactor` spends all six cancel rounds and then logs `cancel after pend failure did not discharge`. In the case the sweep drives, nothing was stored, so the cost is latency plus a misleading warning. It stops being harmless if a pend reaches consensus and then a member leaves: those records would stay until the member returns. I appended this as an arm to `backlog/debt-unpromotable-pending-records-need-a-sweep` and noted it at the timing site in the spec.
- **Two concurrent writers both lose round one, every time (20 of 20 races).** Both pends reach consensus, because promises are collected in parallel. Each coordinator's own member stores its own pend first, and each writer then hears a cohort refusal. Retry with backoff resolves it, and no revision is ever won twice. The existing NOTE said all-lose rounds need three or more contenders, so I added one measured sentence to that NOTE in `coordinator-repo.ts` (comment only). The spec asserts the safety property, not "one writer wins round one".
- **There is no typed error for "refused because a member is away".** An application can only get the numbers out of the `cause` message text. I appended this to `backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`, and noted that the sweep now incidentally guards the pend aggregate's `Some peers did not complete:` prefix.

# Known gaps and things a reviewer should push on

- **"Node i writes" is made real by self-first routing in a test helper, not by production routing.** `transactorDrivenBy` lists the driver first in `findCluster` and returns it from `findCoordinator` unless it is excluded. Production routes by proximity and may or may not pick the writer. The sweep therefore exercises every node's coordinating path, but not the "writer is not the coordinator" routing. Is that the right trade?
- **Reachability is changed in the middle of a size's run** (the away node took part in phases 1–2), so this is a mid-session departure. **Returning is not covered**: that belongs to `implement/1.5-a-member-that-leaves-mid-session-and-returns`. The helper's docs say the harness models no background healing by the returning node.
- **Only one away node is tested** (the last one), and the writer is always node 0. The case where the away node would have been the proximity-chosen coordinator (transactor failover) is not driven here.
- **The race uses only nodes 0 and 1, and only through the Tree layer.** A three-writer race is not covered. The first-round result is reported, not asserted.
- **The mesh is in-process and deterministic.** The all-lose first round and the ~1 s cancel cost were measured here, not over sockets. On a real network the race's first-round outcome depends on timing.
- **Running `--grep` on a single phase** (for example, only the one-away phase) fails with `BlockUnavailableError(cohort-unreachable)` because the tree was never created. The phases share state, like the two-machine lifecycle specs. Run a whole size (`--grep "3 machines"`) instead.
- **The refusal checks depend on message text** (see the finding above). If the wording changes, this spec goes red on purpose.
