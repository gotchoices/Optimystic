description: The node can now say, for a record, whether the small group of machines that store it is the whole group it knows about and whether each of them has stayed connected without a break, so a later change can skip re-checking a record with a partner that could not have changed it unnoticed. Nothing uses the answer yet.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/network/i-key-network.ts (`ConnectedCohort`, `IKeyNetwork.connectedCohort`), packages/db-p2p/src/network/connection-runs.ts (`ConnectionRuns`), packages/db-p2p/src/libp2p-key-network.ts (`connectedCohort`, `connectionRunsOf`, `ServingCohort.spansBand`, `assembleServingCohortOnce`), packages/db-p2p/src/testing/mesh-harness.ts (`MeshConnectionRuns`, the per-node view's `connectedCohort`, `Mesh.reconnect`, `restart`), packages/db-p2p/test/libp2p-key-network.spec.ts (`connectedCohort()` describe, `connect()` doubles), packages/db-p2p/test/open-protocol-stream.spec.ts (`ConnStub.remotePeer`)
----

Part one of GitHub #56. Landed in `ticket(implement): a-node-reports-whether-a-cohort-has-stayed-connected`. The consumer is the implement ticket `a-held-block-is-not-re-checked-while-its-whole-cohort-stays-connected`.

## What was built

- **`IKeyNetwork.connectedCohort?(key)`** (db-core) answering a `ConnectedCohort` — `{ members, runs }`: the cohort `findCluster` assembles now, sorted, this node included, and per other member the id of its current *connection run* (the span during which the peer holds at least one open connection to this node; a new connection after the last one closed starts a new run with a new id). Absent method or `undefined` means "no such guarantee".
- **`ConnectionRuns`** (`packages/db-p2p/src/network/connection-runs.ts`): run ids from `connection:open` / `connection:close`, asking libp2p's `getConnections(peer)` (closing connection excluded by id) whether a peer still has a connection, seeded from `getConnections()` at construction.
- **`Libp2pKeyPeerNetwork.connectedCohort`**: `undefined` unless the path is scoped, this node is in the cohort, the cohort spans its FRET band (`ServingCohort.spansBand`: FRET returned fewer peers than asked, no `unknown` band member, no serving member cut by `clusterSize`), every other member has a run, no remembered serving peer lies outside the band, and no configured bootstrap peer is still unheard. Dials nothing.
- **Mesh harness**: each node's own view implements it over a mesh-wide `MeshConnectionRuns`; `Mesh.reconnect(node)` and `restart` end every run the node is on. The shared `MockMeshKeyNetwork` does not implement it (it has no "this node").

## Review findings

Read the implement diff first, then every touched file's surrounding code (`assembleServingCohortOnce`, `servingPeersOutside`, `membershipOf`, `awaitingBootstrapContact`, the cohort reachability gate) and the consumer ticket's contract.

- **Correctness / soundness of the answer — checked, no defect.**
  - A partner that departed but that FRET still keeps live in the band for its dead-grace (the `NOTE:` in `KeyNetworkCohortReachability.judgeCohort`) has no connection run, so the answer is `undefined`. Once FRET drops it, `servingPeersOutside` (which reads `rememberedServing` for a peer whose peerStore record is gone) catches it. Both arms hold.
  - `nearest.length < wants` with `wants = max(4 × clusterSize, clusterSize + 16)` is conservative: a network of exactly `wants` peers never spans its band. The implementer's `NOTE:` at the line already parks the shared-relay case.
  - A self-only cohort answers `{ members: [self], runs: {} }`; the consumer requires at least two members, so that is harmless.
  - Member sets agree with `findCluster` because both read the same `assembleServingCohort`; the consumer additionally checks its snapshot against the consult's peer ids.
- **The `awaitingBootstrapContact` check added beyond the plan — kept.** An unheard bootstrap peer may be a serving member not yet in the band, the same reason an `unknown` band member stops the answer, and it costs a read of the bootstrap tracker. It matches the cohort reachability gate's rule.
- **Identify window (a peer of this network mid-identify reading `foreign`)** — already parked by the implementer's `NOTE:` on `connectedCohort`; the consumer's member-set comparison makes the answer differ once identify lands. No change.
- **Resource cleanup** — `ConnectionRuns` registers listeners it never removes, like the key network's other listeners and `PeerRecordCache`; the map holds connected peers only, so it is bounded by the connection count. No change.
- **Type safety / cross-platform** — `connection-runs.ts` imports types only (it is reachable from the React Native entry). `ConnectedCohort` is exported through db-core's network barrel. No `any`.
- **No other `IKeyNetwork` wrapper needs to forward the method** — checked every implementer of `absentCohortMembers`: only `Libp2pKeyPeerNetwork` and the mesh's per-node view, both of which implement `connectedCohort`.
- **Mesh harness** — a partition ends a mesh run only when a `connectedCohort` call is made while it is in place; documented on `Mesh.reconnect`, which is the hook the consumer's lapse test is told to use. Restart breaking runs is correct (a new process holds no old connections).
- **Tests** — the two new specs pin the run semantics (keep across one of two connections closing, new id after the last closes and another opens) and the `unknown` band member arm, which are the branches with real logic; kept. Did not add one for the remembered-but-absent arm: it composes `servingPeersOutside`, which `absentCohortMembers` already exercises. The doubles fixes (`remotePeer` on stub connections) correct test doubles, not production code; kept.
- **Source hygiene** — comments say why (listener order, the closing connection's exclusion, why every mesh member is read). `libp2p-key-network.ts` is 1937 lines (`wc -l`); this change added about 70. No split ticket filed: it serves no current anchor and nothing open claims it.
- **Docs** — none changed, correctly: nothing observable changes until the consumer lands, and the consumer ticket's docs list (docs/transactions.md § Lazy read-repair window) is where the seam is described.
- **Performance** — one cohort assembly plus one remembered-peer scan per call, no network; called only on a window-expired read by the consumer. No change.

## Validation

- `yarn workspace @optimystic/db-core build`, `yarn workspace @optimystic/db-p2p build`: clean.
- `yarn test` in `packages/db-p2p`: 3647 passing, 75 pending, 0 failing.
- `yarn workspace @optimystic/db-p2p typecheck`, `yarn workspace @optimystic/db-core typecheck`: clean.
- `eslint` over the six changed files: clean.
- Not run: `yarn test:integration` (no integration spec touches this seam), the root `yarn check`.
