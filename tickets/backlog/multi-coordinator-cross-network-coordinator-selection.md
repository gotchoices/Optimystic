description: When two separate database networks share the same physical nodes, a write in one network can pick a coordinator that only belongs to the other network and does not speak the first network's protocol, so the write fails to find anyone who can serve it.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (findCoordinator / findCluster — FRET-derived peer selection)
  - packages/db-p2p/src/cluster/client.ts (ClusterClient.update — dials /optimystic/<network>/cluster/1.0.0)
  - packages/db-p2p/src/repo/client.ts (RepoClient — dials /optimystic/<network>/repo/1.0.0; the protocol that "could not negotiate" in the trace)
  - packages/db-p2p/src/libp2p-node-base.ts (per-network protocolPrefix wiring; fret networkName)
  - tickets/backlog/cohort-topic-participant-coord-routing-key-mismatch.md (adjacent FRET routing-key concern)
----

# Cross-network coordinator selection: a peer from another control network is chosen and cannot negotiate the target keyspace's protocol

## Plain summary

This is case **(b)** of the source `fix/` ticket
`multi-coordinator-write-stream-reset-supermajority`, split out because it has a
**different root cause** from case (a) (the relayed inter-coordinator stream
reset, now `implement/multi-coordinator-write-relay-stream-reset`). It was
observed in Sereus when two parties run **distinct control networks**
(`control-<partyA>`, `control-<partyB>`). The fix agent did **not** reproduce
this locally; it is filed from the Sereus trace and code reading, hence backlog
(needs its own reproduce + research pass before implementation).

## Observed trace

```
Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)
  cause=Protocol selection failed - could not negotiate
        /optimystic/control-<partyB>/repo/1.0.0
  (also surfaces as FindCoordinatorError: NO_COORDINATOR_AVAILABLE)
```

The coordinator collects its own promise (1/2) but the second selected
coordinator is a node from a **different** control network that has not
registered `/optimystic/control-<partyB>/repo/1.0.0`, so the dial cannot
negotiate a protocol.

## Hypothesis / what to determine

Each network namespaces its protocols and identify/FRET by `networkName`
(`/optimystic/<networkName>/...` and `fretService({ networkName })` in
`libp2p-node-base.ts`). The defect is that **coordinator/cluster selection for a
block's keyspace can return a peer that does not serve that keyspace's protocol**:

- Determine whether two control networks that share physical nodes / bootstraps
  end up with a FRET ring (or peer set) that mixes peers across `networkName`s.
  `findCluster`/`findCoordinator` derive members from `fret.assembleCohort` /
  `getNeighbors`; if that cohort is not scoped to peers serving this network's
  protocol, a non-serving peer gets picked.
- The "could not negotiate" peer must be excluded from selection for THIS
  keyspace (or the selection must be scoped to the network whose `protocolPrefix`
  the client will dial), so the coordinator never tries to dial a protocol the
  target does not register.

This intersects the existing backlog item
`cohort-topic-participant-coord-routing-key-mismatch` (FRET routing-key
concerns) — coordinate with it; the two may share a root in how FRET coordinates
are keyed across networks.

## Reproduction to build (first task when promoted)

Stand up two `createLibp2pNode` instances with **different** `networkName`s that
share a bootstrap (or are mutually dialed), then drive a write on network A whose
block keyspace selects, as a second coordinator, a node that only serves network
B. Assert the write either (a) never selects the non-serving peer, or (b) fails
fast with a clear "peer does not serve this keyspace" error rather than a generic
super-majority / `NO_COORDINATOR_AVAILABLE` failure.

## Use case / expected behavior

A write targeting a keyspace served by ≥2 coordinators of network A must only
ever select coordinators that actually serve network A's repo/cluster protocol.
A peer from another network must never be chosen as a coordinator for network A's
blocks.
