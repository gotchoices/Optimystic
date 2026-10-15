description: The docs said the `allowDownsize` setting controls whether a node that sees only itself may commit a write, but the code never checks it on that path; the docs and code comments now describe what the code does, and the rule for lone writes stays an open design question.
architecture: docs/correctness.md
files: docs/correctness.md, docs/transactions.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, tickets/backlog/more-design/6.5-partition-healing.md
----

# `allowDownsize` docs match the lone-write path — review handoff

Docs and comments only; no behaviour change. The maintainer decided on 2026-09-15 not to pin a rule for lone writes yet, so the docs now describe the code, and the open question stays in backlog `partition-healing`.

## The code fact, re-confirmed

- `CoordinatorRepo.pend` → `pendThroughCluster` and `CoordinatorRepo.commit` take `pendSolo` / `commitSolo` whenever `resolveCohort` is unresolved or has at most one peer (`packages/db-p2p/src/repo/coordinator-repo.ts`). Neither reads `allowClusterDownsize`. `cancel` short-circuits the same way, per block.
- The flag is read in `ClusterCoordinator.executeTransaction` (the "below configured minimum" refusal, `peerCount < clusterSize`), in `makeRecord` (it sets `ClusterRecord.minRequiredSize`), and in a `cluster-tx:start` log field. A solo cohort reaches none of these.
- Side observation, not acted on: `ClusterRecord.minRequiredSize` is set but nothing reads it except that log line. Members do not enforce it.

## What changed

The wording is the same everywhere: the flag decides only whether a cohort of two or more members smaller than `clusterSize` may run consensus. It has no effect on a cohort of at most one peer (this node alone, or a lookup that named nobody), which always commits alone and is answered as durability class `local` or `unrouted`.

- `docs/correctness.md`, Theorem 2, self-coordination guard paragraph: the false clause is replaced and now cites `pendSolo` / `commitSolo` and `executeTransaction`, pointing to backlog `partition-healing`.
- `docs/transactions.md`: changed in two places. One is §Self-Coordination Guard (Design), the `grace-period-not-elapsed` paragraph. The other is the "Inside the grace period" bullet under §Partition Recovery and Reconciliation, which now links back to the guard section.
- `packages/db-p2p/src/cluster/cluster-policy.ts`: added a JSDoc to the `clusterPolicy.allowDownsize` field.
- Beyond the ticket's list, the same false claim or a wrong default appeared in these places, and each was fixed:
  - `packages/db-p2p/docs/cluster.md`: the "Downsize rejected" error bullet, the Network-Membership Scoping bullet ("completes the write under `allowClusterDownsize`"), and the fenced `ClusterConsensusConfig` sample's comment.
  - `packages/db-core/src/cluster/structs.ts`: the `ClusterConsensusConfig.allowClusterDownsize` JSDoc said "default false". Every resolver (`resolveClusterPolicy`, `CoordinatorRepo`'s constructor, `NetworkManagerService`, `libp2p-node-base`) defaults it to `true`.
  - `packages/db-p2p/src/libp2p-key-network.ts`: changed the `SelfCoordinationDecision` doc comment and the `findCluster`-band comment ("still completes the write under allowClusterDownsize").
  - Test comments only, in `packages/db-p2p/test/libp2p-key-network.spec.ts` (two) and `packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts` (one). No assertions changed.
- `tickets/backlog/more-design/6.5-partition-healing.md`: the "Whichever rule this design settles…" sentence is replaced with the text the ticket specified.

## Validation

- `yarn lint:docs`: passes (47 documents, 326 anchored citations, all resolve).
- Rebuilt `@optimystic/db-core` and `@optimystic/db-p2p` (`tsc`, clean). This keeps the test harness's build-freshness guard from refusing later runs after the comment edits.
- Ran `yarn test -- --grep "carries superMajorityThreshold, allowDownsize"` in `db-p2p`: 1 passing. This only confirms the rebuilt tree loads; it checks no behaviour.
- No tests were added. This ticket is docs only.

## For the reviewer

- Check the new wording against the code paths named above, and check whether "`local` or `unrouted`" covers every solo outcome. `soloCohortDurability` has exactly those two results, and a refused storage pend or commit is returned untouched, without a class.
- `docs/correctness.md` Theorem 2 still lists "self-coordination guard" in its **Depends on** line and says the guard "blocks a node from coordinating a write alone" on shrinkage. That is still true for the guard's hard refusals; I did not change it.
- Line 102 of the partition-healing ticket ("`allowClusterDownsize` (default on) shrinks a cohort to whatever peers are visible") is about multi-member cohorts and is still accurate, so I left it.
