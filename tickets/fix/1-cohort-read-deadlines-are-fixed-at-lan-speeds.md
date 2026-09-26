description: When a machine checks with the others in its group before trusting what it holds, each machine gets one second to answer, and that can't be changed. Over a slow link, such as two phones reaching each other through a relay, every answer arrives late and counts as no answer at all, so a machine that rejoins can never catch up. The time allowed should be configurable.
architecture: docs/transactions.md#read-consistency-and-staleness
files: packages/db-p2p/src/repo/coordinator-repo.ts (`LATEST_QUERY_TIMEOUT_MS`, `queryClusterForLatest`, the `withDeadline(… RECONCILE_TIMEOUT_MS …)` in the read-repair acquisition), packages/db-p2p/src/libp2p-node-base.ts (`fetchArchiveFromPeer`'s 1000 ms race, `coordinatorRepoFactory` wiring), packages/db-p2p/src/cluster/reconcile-block.ts (`RECONCILE_TIMEOUT_MS`), packages/db-p2p/src/cluster/cluster-repo.ts (`ReconcileTimeoutMs`, `withReconcileTimeout`), packages/db-p2p/src/cluster/cluster-policy.ts (`ClusterPolicyOptions.clusterPolicy`, `resolveClusterPolicy`), packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig`), docs/transactions.md, packages/db-p2p/docs/cluster.md
difficulty: medium
repro: static
----

# Cohort read deadlines are fixed at LAN speeds

Reported as GitHub issue #22 (gotchoices/Optimystic), by a downstream chat app whose deployments are
two phones reaching each other only through a public circuit relay.

## What happens

A machine that re-attaches after being away reads a block it may be behind on. The coordinator
(`CoordinatorRepo`) consults the block's cohort: it asks each cohort peer for its latest revision
(`queryClusterForLatest` → `clusterLatestCallback` → a `SyncClient.requestBlock` round trip), then,
once a revision is corroborated, fetches the block from the cohort (`acquireBlockFromCohort`, which is
`createReconcileBlock` over `fetchArchiveFromPeer`) and persists it.

Three deadlines on that path are hardcoded constants with no configuration:

| deadline | value | where | what a miss does |
| --- | --- | --- | --- |
| per-peer latest-revision query | 1000 ms | `LATEST_QUERY_TIMEOUT_MS`, coordinator-repo.ts | the peer counts as **silent** |
| per-peer archive fetch | 1000 ms | the `setTimeout` race in `fetchArchiveFromPeer`, libp2p-node-base.ts | resolves `{ success: false }`, the same as "that peer holds nothing" |
| whole reconcile / acquisition pass | 5000 ms | `RECONCILE_TIMEOUT_MS`, reconcile-block.ts (used by both `CoordinatorRepo` read-repair and `ClusterMember.withReconcileTimeout`) | the pass is abandoned |

Each of those round trips is a fresh stream: dial or reuse the connection, multistream-select the
sync protocol, send, receive. Over a relayed link with a round trip near 1.8 s, that cannot finish
in 1 s. In a two-machine cohort the reader has exactly one peer, so one late answer is the whole
quorum: the consult declines every time (`cluster-fetch:peers-silent`, then
`cluster-fetch:no-quorum { cohortPeers: 1, holders: 0, absent: 0, silent: 1, required: 1 }`), and the
reader never catches up. The reporter's app gives up after 120 s with its own "awaiting first sync"
error.

The reporter measured this with a control: the same two parties through the same relay re-attach in
5–10 s at a 1 ms one-way delay, and fail after 120 s at a 900 ms one-way delay (2 of 2 runs each).
Their repro is `test/stack/small-cohort-repro.sh` in the gotchoices/chat repository. We have not run
it; `repro: static` records that the cause here is read from the code, which matches their evidence:
latency is the only variable, and these are the LAN-sized deadlines on that path. The comment at
`queryClusterForLatest` already says to raise the budget if a WAN deployment shows steady
`peers-silent` against healthy peers. The archive fetch's 1000 ms was not mentioned in the report,
and would fail the same way as soon as the consult was allowed to succeed.

## What to build

A deployment on slow links must be able to raise these deadlines. **Defaults do not change**: a node
that sets nothing behaves exactly as today.

- One operator field, `clusterPolicy.cohortQueryTimeoutMs` (on `ClusterPolicyOptions`, carried into
  `ClusterConsensusConfig` by `resolveClusterPolicy` the way `readRepairWindowMs` sits there), the time
  one cohort peer gets to answer one read-path request. Default 1000. It sets **both** per-peer
  deadlines: the latest-revision query and the archive fetch. They are the same kind of round trip to
  the same peer over the same protocol, so a separate setting for each would only let one be raised
  while the other still fails.
- The whole-pass bound becomes `max(RECONCILE_TIMEOUT_MS, 5 × cohortQueryTimeoutMs)`, so it stays
  5000 ms by default and grows with the per-peer budget rather than cutting a slow pass short. It is
  resolved once, alongside the per-peer value, and used by both current callers: the read-path
  acquisition in `CoordinatorRepo`, and `ClusterMember`'s commit-path reconcile. Keep one resolved
  number for both. They share the constant today on purpose ("same operation, same bound", see
  docs/internals.md), and the two callers must not drift apart.
- Validate at resolution: a non-finite value or one ≤ 0 is a configuration error and throws at node
  construction, like other malformed cluster policy.
- Thread it through the direct-constructor path as well (`CoordinatorRepoConfig` via
  `Partial<ClusterConsensusConfig>`), defaulting to 1000 there too, so a hand-wired `CoordinatorRepo`
  and the node assembly resolve the same value.
- `fetchArchiveFromPeer` keeps its current contract: a timed-out fetch resolves to "no archive" and
  the pass moves on to the next peer. Only the number changes.

## Out of scope, deliberately

- **An adaptive budget** (scaled from each peer's observed round-trip time) is the reporter's
  first-listed option. It needs a round-trip estimator and a policy for a peer with no history, which
  is design work. The fixed setting unblocks the reporter now. If adaptation is ever wanted, it would
  replace the default and keep this field as the override.
- **Retrying a missed budget at cohort size ≤ 2** (the reporter's option 2) changes when the read
  path declines, and so what an application observes. Not this ticket.
- **Separating "never asked" from "asked, no answer" in the silent set** (option 3). The consult
  already asks every peer it counts; a peer it could not dial is rejected through the same deadline.
  Not needed for this fix.
- The reporter's secondary note, that a write fails for a moment right after its partner detaches
  ("1/2 approvals"), is a two-member cohort needing both members until membership notices the
  departure. It is transient by their own measurement, and it is a separate question from the
  deadlines.

## Tests that pay for themselves

- `CoordinatorRepo`, unit tier: a `clusterLatestCallback` that answers after 1500 ms. With no setting
  the peer is silent (the read comes back flagged, as today). With `cohortQueryTimeoutMs: 3000` the
  same peer is counted as answering, and its claim is selected. Use fake timers or the class's
  existing clock seam if one covers this; do not make the suite wait on real seconds.
- `resolveClusterPolicy`: the default resolves to 1000 and the pass bound to 5000. A declared 3000
  resolves to a 15000 pass bound. Zero, negative and non-finite values throw.
- Nothing needs to prove that the archive fetch reads the setting beyond the node-base wiring
  passing it through. Keep that wiring on one resolved value, so there is nothing separate to test.

## Docs

- docs/transactions.md § Read Consistency and Staleness: name the setting, what it bounds, and when
  to raise it (steady `cluster-fetch:peers-silent` against peers that are healthy and answering
  everything else).
- packages/db-p2p/docs/cluster.md, where the other `clusterPolicy` fields are documented.
- docs/internals.md: the reconcile bullet that names `RECONCILE_TIMEOUT_MS` now names the resolved
  bound.
- Rewrite the `NOTE:` at `queryClusterForLatest` so it points operators to the setting instead of
  telling them to edit a constant.

## TODO

- Add `cohortQueryTimeoutMs` to `ClusterPolicyOptions.clusterPolicy` and `ClusterConsensusConfig`, resolve it and the derived pass bound in `resolveClusterPolicy`, and validate it there
- Replace `LATEST_QUERY_TIMEOUT_MS` in `CoordinatorRepo` with the resolved value; default it in the constructor's policy block
- Use the resolved pass bound for the read-path acquisition deadline in `CoordinatorRepo` and for `ClusterMember`'s reconcile timeout
- Pass the per-peer value to `fetchArchiveFromPeer` in libp2p-node-base.ts
- Tests as above
- Docs as above
