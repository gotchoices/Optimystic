description: The docs said the `allowDownsize` setting controls whether a node that sees only itself may commit a write, but the code never checks it on that path; the docs and code comments now describe what the code does, and the rule for lone writes stays an open design question.
architecture: docs/correctness.md
files: docs/correctness.md, docs/transactions.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, tickets/backlog/more-design/6.5-partition-healing.md
----

# `allowDownsize` docs match the lone-write path

Docs and comments only, no behaviour change. The maintainer decided on 2026-09-15 not to pin a rule for lone writes yet, so the documents now describe the code, and the open question stays in backlog `partition-healing`.

The wording used everywhere: `allowClusterDownsize` (`clusterPolicy.allowDownsize`, default `true`) decides only whether a cohort of two or more members smaller than `clusterSize` may run consensus (`ClusterCoordinator.executeTransaction`). A cohort of at most one peer (this node alone, or a lookup that named nobody) takes `CoordinatorRepo`'s `pendSolo` / `commitSolo` short-circuit. That path never reads the flag, runs no consensus, and answers with durability class `local` or `unrouted`.

Changed in `ticket(implement): allow-downsize-docs-match-the-lone-write-path`: `docs/correctness.md` Theorem 2 (the self-coordination guard paragraph); `docs/transactions.md` §Self-Coordination Guard (Design) and the "Inside the grace period" bullet; `packages/db-p2p/docs/cluster.md` (the "Downsize rejected" error bullet, the Network-Membership Scoping bullet, and the `ClusterConsensusConfig` sample); JSDoc on `clusterPolicy.allowDownsize` and on `ClusterConsensusConfig.allowClusterDownsize`, which used to say "default false" although every resolver defaults it to `true`; two comments in `libp2p-key-network.ts`; three test comments; and the partition-healing backlog entry.

## Review findings

**Checked against the code:**
- `CoordinatorRepo.pendThroughCluster` and `CoordinatorRepo.commit` both take the solo path when `!cohort.resolved || cohort.peerIds.length <= 1`. Neither path, nor `soloCohortDurability`, reads `allowClusterDownsize`.
- `soloCohortDurability` returns only `unroutedDurability()` or `localDurability(...)`. `acknowledgeCommit` adds only `recordedBy`, so "`local` or `unrouted`" covers every successful solo answer. A storage refusal comes back untouched, with no class.
- `cancel` short-circuits per block through `getClusterSize <= 1`, which also ignores the flag. The docs do not discuss cancel, and they did not need to.
- The flag appears in `executeTransaction` (the `peerCount < clusterSize` refusal), in `makeRecord` (`minRequiredSize`), and in a log field, and nowhere else. A two-member cohort can still be refused by the separate `minAbsoluteClusterSize` / `validateSmallCluster` gate. The new wording describes only what the flag covers and promises nothing about other gates, so it stays accurate.
- Swept every tracked markdown file outside `tickets/` and `tess/`, and all source under `packages/*/src`, for `allowClusterDownsize`, `allowDownsize`, "downsize", "self-only cohort" and "commits alone". No stale claim is left. The remaining "downsize" hits are about the membership admission gate's `low-confidence-downsize`, a different mechanism.
- Theorem 2's **Depends on** line and the guard's "blocks a node from coordinating a write alone" are still true for the guard's hard refusals. Left as they were, as the implementer proposed.

**Fixed in this pass (minor):**
- `tickets/backlog/more-design/6.5-partition-healing.md` said the two documents "both say" the flag governs self-only commits. That is no longer true, so it now reads "both said", in line with the closing sentence the implementer added.

**Tripwire recorded:**
- `ClusterRecord.minRequiredSize` is set when the flag is false, but only a log line reads it, and it sits outside `messageHash`, so any relaying peer can rewrite it. Recorded as a `NOTE:` on the field in `packages/db-core/src/cluster/structs.ts`: if members ever need a size floor, derive it from the member's own configuration. No ticket, because nothing relies on the field today.

**Tests:** none added and none cut. The change is documentation, and the only behaviour involved (a lone write ignores the flag) is the open design question in backlog `partition-healing`, which pins a rule when it adopts one. The implementer's diff touched comments only, with no assertions.

**Validation:** `yarn lint:docs` passes (47 documents, 326 anchored citations). `@optimystic/db-core` and `@optimystic/db-p2p` rebuilt cleanly after the comment edits, which keeps the build-freshness guard satisfied. The smoke test `yarn test -- --grep "carries superMajorityThreshold, allowDownsize"` in db-p2p passes (1 test). The full suite was not run, because no code changed.

**Empty categories:** no new tickets. Every finding was either fixed inline or is conditional. Not applicable to a comment-only change: error handling, resource cleanup, performance, type safety.
