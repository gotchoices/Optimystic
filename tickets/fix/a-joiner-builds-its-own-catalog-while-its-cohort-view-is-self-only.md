description: When a second machine joins a freshly founded two-machine group, both machines can each create their own copy of the shared table catalog, because each one briefly (or, in the report, for the whole run) believes it is the only machine responsible for the data. The joiner's copy is then replaced part-way through by the founder's, which is how it comes to need blocks it does not hold.
files:
  - packages/db-p2p/src/libp2p-key-network.ts (`assembleServingCohortAt`, `membershipOf`, `findCoordinator`'s connected-peer fallback, `shouldAllowSelfCoordination`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (the "Solo-cluster short-circuit" exit of `fetchBlockFromCluster`; the solo branch of `commit`, logged `commit:solo-cohort`)
  - packages/db-core/src/collection/collection.ts (`createOrOpen`, `advanceContext` — the `collection:lineage-divergence` report)
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (`CatalogBatch.commit`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`endSchemaBatch`)
  - packages/db-p2p/test/two-node-convergence-invention-race.spec.ts (existing spec about two nodes inventing one collection)
  - ../sereus/packages/cadre-core/src/strand-instance-manager.ts (how a strand's node is built: `networkName`, `protocolPrefix`, `bootstrapNodes`)
difficulty: hard
repro: none
----

# A joiner builds its own catalog while its cohort view is self-only

Split from GitHub issue #27 (https://github.com/gotchoices/Optimystic/issues/27). The read failure itself is handled by ticket `a-joiner-reads-a-missing-block-from-a-self-only-cohort-view`; this ticket is about the state that read was made in. Nothing here was run: the reporter's script needs the sibling sereus packages and a patched Quereus. `repro: none` — the reading below is inferred from the reporter's trace and from code, and the first job is to reproduce it.

## What the trace shows beyond the missing block

```
collection:lineage-divergence id=optimystic/schema site=refresh forkRev=1 heldAction=mf97… readAction=j-Mz… heldRev=2 readRev=3
```

`forkRev=1` means the joiner and the founder disagree about which action is revision 1 of the catalog. So the joiner did not merely fall behind: it created its own catalog (its own revisions 1 and 2), and then a refresh read the founder's log (revision 3 on a different history) and adopted it. Two histories under one collection id is the fork that backlog `6.5-partition-healing` and `debt-repair-cannot-tell-a-fork-from-a-lagging-cohort` describe; here it is produced on loopback with no partition, during an ordinary join.

Three observations from the report bound the cause:

- Both machines' strand-network key networks log `cohort:membership … band=1 serves=1 unknown=0 … cohort=1` and `findCluster … cohort=1 connected=0` for the entire trial — 371 and 355 lines, in passing runs too. `band=1` means the routing table (FRET) itself knows no other member; this is not the "peer known but not yet identified" case (`unknown=0`). The same process's control network reaches a cohort of two early.
- The founder committed its catalog blocks at quorum `local`, cohort of one.
- Data still crosses: the joiner read the founder's log, and in passing runs the joiner later reads a row the founder inserted.

## What is not yet known

How the founder's log reached the joiner while both cohort views were self-only. Two candidates, neither confirmed:

- **Requests routed outside the cohort view.** `findCoordinator`'s connected-peer fallback can pick a connected serving peer that is not in the key's cohort, and `shouldAllowSelfCoordination` can deny self for one call and allow it for the next. If one machine's reads or writes go to the other for some blocks and to itself for others, one transaction's blocks end up split across two machines that each think they are a cohort of one. Confirming lines: `findCoordinator:done … source=connected-fallback`, `findCoordinator:self-read-declined`, and `commit:solo-cohort` on one machine carrying the other's action id.
- **Something above the storage layer copies blocks** (the host's first-sync step in cadre-core).

Which one it is decides where the fix goes, so it must be settled from a trace before any change.

## Expected behaviour

- A machine that was started with a bootstrap peer for a network does not conclude "this collection has never been created" from a view in which it has not yet heard from that peer; it either finds the existing collection or fails in a retryable way. `createOrOpen` inventing a second catalog is the defect.
- Two machines on one loopback network, connected to each other, appear in each other's cohorts for that network within a bounded time, as they do on the control network.
- The issue's question 2 (should a joiner refuse to adopt a newer catalog revision while it has a schema batch open?) is answered by the first point: with one catalog history there is nothing wrong with adopting a newer revision mid-batch — a live refresh adopting concurrent commits and replaying staged work over them is the designed behaviour. Declining adoption would only hide the fork.

## Related

- Backlog `feat-declared-membership-feeds-cohort-assembly`: letting the host hand the storage layer its member list would remove the dependence on what the routing table happens to know. Check whether this ticket reduces to that one once the cause is known.
- GitHub #23 and gotchoices/sereus#18: a cohort of one after a restart with relay-only peers.
- GitHub #20: an earlier self-only-view defect (a remembered absence outliving the view it was settled under).
