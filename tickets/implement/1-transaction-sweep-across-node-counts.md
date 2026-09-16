description: Every test of a transaction fixes the number of machines in advance, each with its own setup, so a bug that only appears at three machines has no equivalent test at two or four to compare against. Write one test that runs the same transaction scenario at one, two, three, four and five machines and checks, at each size, exactly what the documentation says should happen.
prereq:
files:
  - packages/db-p2p/test/transaction-node-count-sweep.spec.ts (new)
  - packages/db-p2p/src/testing/mesh-harness.ts (`createMesh`; per-node reachability control — confirm what exists before adding any seam)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`resolveClusterPolicy`, `repairCorroborationClusterSize`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (promise super-majority `ceil(0.75n)`; commit majority; the `n = 1` skip)
  - packages/db-p2p/src/repo/coordinator-repo.ts (the durability gate: durable holders over half, including self; the solo short-circuit)
  - packages/db-p2p/test/commit-durability-quorum.spec.ts (today's only durability-gate assertion, at a two-member cohort — the shape to generalize)
  - packages/db-p2p/test/mesh-sanity.spec.ts (Suite 0 solo, Suite 2 promise-threshold failure — the closest existing per-size cases)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (three-node acknowledged-implies-durable and conflict shapes)
  - packages/db-p2p/test/quorum-restore.spec.ts ("how many answering peers a repair needs, by deployment size" — the repair-side table, pinned as a unit; this ticket is its transaction-side counterpart)
  - packages/db-p2p/test/util/two-machine-lifecycle.ts (the documented two-machine configuration, currently used only by integration specs)
  - docs/internals.md (the machines table), packages/db-p2p/docs/cluster.md (promise and commit phases)
difficulty: medium
----

# Why

The maintainer's current focus is transactions working at every node count, especially the low ones. A coverage map of this repository (2026-09-15) found that every transaction spec fixes its node count, and each one builds its own cohort configuration. Consequences, each verified in that map:

- **No file runs one scenario across several sizes.** A regression that bites only at three machines has no sibling assertion at two or four to contrast with.
- **The commit majority and the durability gate are asserted at a two-member cohort only** (`commit-durability-quorum.spec.ts`). Three, four and five are exercised only incidentally, through happy paths.
- **"Both nodes commit and each reads the other's rows" stops at three machines.** Every four- and five-node spec writes from one node.
- **Refusal error shapes are pinned at one, two and three machines, never above.**
- **The documented two-machine configuration appears only in `OPTIMYSTIC_INTEGRATION=1` specs.** Everything in the default `yarn test` lane uses a `clusterSize: 2` or `clusterSize == nodeCount` shortcut, so the configuration real deployments run is untested in the fast lane.

# What to build

One spec, `transaction-node-count-sweep.spec.ts`, on the in-process mesh harness (no sockets, so it runs in plain `yarn test`), with an outer loop over **N = 1, 2, 3, 4, 5**. Same scenario body at every size; only the expectations that the documentation makes size-dependent change.

**Configuration, deliberately the production-shaped one**: default `clusterSize` (the replication factor), with `clusterPolicy.repairCorroborationClusterSize` declared as N, which is what a host application deriving the count from its own membership records would pass. Do **not** use the `clusterSize: N` shortcut; that is the gap this spec exists to close in the fast lane. If the harness cannot express that today, extend the harness rather than the shortcut, and say so in the handoff.

Per size, assert:

1. **Every node writes, every node reads.** Each of the N nodes commits its own row into a shared Tree collection; then every node reads every row. At N = 1 this degenerates to the solo case, which is the point of including it in the same loop.
2. **The acknowledgement rule, from the documentation, with one member unreachable.** With exactly one cohort member unreachable, a commit must be acknowledged where the promise bar `ceil(0.75 × N)` can still be met by the reachable members, and refused where it cannot. Derive the expectation in the spec from the same arithmetic the docs state (so N = 3 needs all three and refuses; N = 4 needs three and tolerates one; N = 5 needs four and tolerates one), and assert the acknowledgement is backed by durable holders over half, not merely a returned success.
3. **The refusal's shape**, at every size that refuses: the typed error and the fields an application would branch on, not just that something threw. Compare against what the existing two- and three-node specs pin, and make the sweep's expectation consistent with them.
4. **Concurrent writers.** Two different nodes write conflicting rows at once: exactly one wins, and the loser's failure is a conflict-shaped result, not an exception of some other kind. At N = 1 this arm is skipped explicitly with a named reason rather than silently.
5. **Acknowledged implies durable.** Every acknowledged row is readable from every reachable node at the end of the size's run.

Report a per-size table (size, promise bar, expected outcome with one member down, observed) through `console.log` at the end, as the relay and lifecycle specs do, so a human reading CI output sees the shape rather than only pass or fail.

# Edge cases & interactions

- **The two-machine, one-away case is under design; do not assert it.** With one of two machines unreachable, whether the survivor's write is accepted depends on a race between its retries and the routing view dropping the peer (see `backlog/more-design/6.5-partition-healing.md`, and the maintainer's decision recorded there that the CRDT sync layer is the intended fix). In the mesh the peer stays in the cohort view, so the outcome should be a deterministic refusal — assert that, and state in a comment that this is the *unchanged-view* case, not the lone-survivor question that ticket owns.
- **N = 1 has no unreachable-member arm.** Skip it explicitly, naming why, rather than looping over an empty set.
- **Runtime.** This is the fast lane. Measure and report total runtime; if it exceeds about thirty seconds, reduce the row count per size rather than dropping a size, and say what you measured.
- **Harness reachability.** No existing mesh spec changes a peer's reachability mid-test. Check what `createMesh` supports; if the only expressible form is "unreachable from the start", use that and note the mid-session case as belonging to `implement/1.5-a-member-that-leaves-mid-session-and-returns`.
- **Do not weaken an assertion to make a size pass.** A size whose real behaviour contradicts the documented rule is a finding: keep the assertion, mark that size's case pending with a reference, and file a `fix/` ticket naming the size and the observed behaviour. That is the outcome this sweep exists to produce.
- **Cohort versus mesh size.** With the default replication factor every node is in every cohort at these sizes; assert that rather than assuming it, so the sweep still means what it says if the placement rule changes (`plan/self-in-cohort-only-when-nearest` is in flight).

# TODO

- Write the sweep with the shared scenario body and per-size expectations derived from the documented arithmetic.
- Run it at least five times; report pass count, per-size runtime, and the observed table.
- File `fix/` tickets for any size whose behaviour contradicts the documentation.
- `yarn lint`, `yarn build`, `yarn workspace @optimystic/db-p2p test`.
