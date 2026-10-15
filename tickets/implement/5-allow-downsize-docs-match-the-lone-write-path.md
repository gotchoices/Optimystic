description: The docs say `clusterPolicy.allowDownsize` governs whether a node whose cohort view is only itself may commit, but the code never consults it on that path (`pendSolo` / `commitSolo`), so `allowDownsize: false` does not stop a lone write. The maintainer decided on 2026-09-15 not to pin a rule for lone writes yet, so change the docs to describe the code and leave the rule to backlog `partition-healing`.
architecture: docs/correctness.md
files: docs/correctness.md, docs/transactions.md, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/docs/cluster.md, tickets/backlog/more-design/6.5-partition-healing.md
----

# `allowDownsize` docs match the lone-write path

Found while researching GitHub #37; the analysis is in backlog `partition-healing`, section "Arm (2026-10-14)".

`docs/correctness.md` (Theorem 2, the self-coordination guard paragraph) and `docs/transactions.md` (the self-coordination guard section) say a self-only cohort's right to commit is governed by `allowClusterDownsize`. In the code the flag is read only by `ClusterCoordinator.executeTransaction` (its "below configured minimum" refusal), which a cohort of at most one peer never reaches: `CoordinatorRepo.pend` and `CoordinatorRepo.commit` take `pendSolo` / `commitSolo` and do not consult it.

The maintainer does not want a lone-write rule decided now ("make sure the code and docs are consistent"), so this ticket changes the docs, not the code.

## TODO

- Confirm the claim above by reading `CoordinatorRepo.pend`, `CoordinatorRepo.commit`, `pendSolo`, `commitSolo` and `ClusterCoordinator.executeTransaction`. If the code does consult the flag somewhere on the solo path, stop and record that in the review handoff instead.
- Rewrite the two doc passages to state what the flag does: it lets a multi-member cohort smaller than the configured size run consensus; it has no effect when the cohort is this node alone, which always commits alone (durability class `local` or `unrouted`). Point at backlog `partition-healing` for the open question.
- Put the same sentence on the `allowDownsize` field in `packages/db-p2p/src/cluster/cluster-policy.ts`, and in `packages/db-p2p/docs/cluster.md` if it describes the flag.
- In `tickets/backlog/more-design/6.5-partition-healing.md`, replace the sentence beginning "Whichever rule this design settles" with: "The docs now describe the code (`allow-downsize-docs-match-the-lone-write-path`); a rule for lone writes, if one is adopted, changes the code and these docs together."
- No test: docs only. `yarn lint:docs` must pass.
