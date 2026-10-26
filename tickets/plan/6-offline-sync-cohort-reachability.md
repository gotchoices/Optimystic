description: Teach a networked node to answer "can this collection's group of machines be reached right now?" and to wake the offline queue when a machine reconnects, so queued changes are sent as soon as they can be and never committed by this machine alone.
prereq: offline-sync-db-core-queue
architecture: docs/offline-sync.md#when-to-submit-the-reachability-gate
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/under-replication-drain.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/optimystic-node.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, docs/offline-sync.md
----

Stage 6 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages).

## What is wanted

- The db-p2p implementation of the `ICohortReachability` port stage 3 defines: the cohort that a collection's header and log tail resolve to contains a member other than this node, **or** this node is genuinely alone — no member the key network knows of is missing from the cohort (`absentCohortMembers` in `packages/db-p2p/src/libp2p-key-network.ts`) and no configured bootstrap peer is still awaited (`awaitingBootstrapContact`, same file). Exposed on the node (an `OptimysticNodeAttachments` handle, so no cast is needed) and wired by `CollectionFactory` for the `network` transactor; `local`, `test` and `mesh-test` are always reachable.
- Wake-ups: the queue's wake signal fires on the `connection:open` / `peer:identify` events the `UnderReplicationDrain` already listens to (debounced the same way).

- **The solo-refusing write option** (maintainer decision recorded in [§When to submit: the reachability gate](../../docs/offline-sync.md#when-to-submit-the-reachability-gate)): a per-write option on `SyncOptions`, carried on the pend and commit requests (`PendRequest` / `CommitRequest` or beside them), that makes the solo short-circuit in `CoordinatorRepo` (`soloCohortDurability` in `packages/db-p2p/src/repo/coordinator-repo.ts`) **refuse** a write while this node knows of absent cohort members (`knownAbsent` > 0) or awaits a bootstrap peer, instead of committing it at `local`. The refusal is a typed, transient failure that the stage-1 classification sorts as "cohort unreachable", so the queue waits. A genuinely alone node (nothing known absent, nothing awaited) still commits. The refusal happens before anything is reserved or stored.
- **Default on for every drain:** the queue sets the option on every submission unless the application registered with `offline.allowSoloCommit: true` (add the registration option in the plugin). Writes outside offline mode never set it — the general lone-write decision in backlog `6.5-partition-healing` is unchanged.
- A coordinator on an older build ignores the field; the gate is then the only protection. No version gate.

## Edge cases the plan must cover

A node whose routing view is self-only because peers are still mid-identify (must read unreachable, not alone); a one-machine deployment with no bootstrap peers (reachable — alone); a bootstrap peer refused by the network-membership predicate (`isNetworkMember`) while it serves this network (still awaited — see internals.md *Network Membership Predicate*); a restart with persisted network state; the header and log tail resolving to different cohorts. The two-machine scenario from the doc's test plan (one away; an offline-mode write on the other is queued, not committed alone, and drains when the partner returns) on the in-process mesh.

## Done when

The two-machine scenario passes, docs/offline-sync.md marks the stage implemented, and docs/internals.md mentions the reachability handle where it lists node attachments.
