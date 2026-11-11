description: The node can now say, for a record, whether the small group of machines that store it is the whole group it knows about and whether each of them has stayed connected without a break, so a later change can skip re-checking a record with a partner that could not have changed it unnoticed. Nothing uses the answer yet.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/network/i-key-network.ts (`ConnectedCohort`, `IKeyNetwork.connectedCohort`), packages/db-p2p/src/network/connection-runs.ts (new, `ConnectionRuns`), packages/db-p2p/src/libp2p-key-network.ts (`connectedCohort`, `connectionRunsOf`, `ServingCohort.spansBand`, `assembleServingCohortOnce`), packages/db-p2p/src/testing/mesh-harness.ts (`MeshConnectionRuns`, the per-node view's `connectedCohort`, `Mesh.reconnect`, `restart`), packages/db-p2p/test/libp2p-key-network.spec.ts (`connectedCohort()` describe, `connect()` doubles), packages/db-p2p/test/open-protocol-stream.spec.ts (`ConnStub.remotePeer`)
----

Part one of GitHub #56. The consumer is the implement ticket `a-held-block-is-not-re-checked-while-its-whole-cohort-stays-connected`; read its "Why this rule" section for the argument this answer serves. This change adds the seam and nothing that reads it.

## What was built

**`IKeyNetwork.connectedCohort?(key): Promise<ConnectedCohort | undefined>`** (db-core). `ConnectedCohort` is `{ members, runs }`: the cohort `findCluster` assembles now, sorted, this node included; and per other member the id of its current *connection run* (the span during which a peer has at least one open connection to this node; its next connection after the last one closes starts a new run with a new id). Absent method or `undefined` means "no such guarantee".

**`ConnectionRuns`** (`packages/db-p2p/src/network/connection-runs.ts`). Built in the `Libp2pKeyPeerNetwork` constructor beside its other listeners. `connection:open` for a peer with no run assigns the next id; a second concurrent connection keeps the run; `connection:close` deletes the run when `libp2p.getConnections(peer)` holds no other connection, the closing one excluded by id. Seeded from `getConnections()` at construction. No removal on stop: the key network removes none of its listeners (nor does `PeerRecordCache`), and it lives as long as the node.

Checked in libp2p 3.3.11 (`connection-manager/index.js`): the connection manager registers its own `connection:close` listener in `start()` and removes the connection there, and `createLibp2pNodeBase` builds the key network after `node.start()`, so the closing connection is normally already gone when ours runs. The id exclusion keeps the answer independent of listener order.

**`Libp2pKeyPeerNetwork.connectedCohort`** answers `undefined` unless all of:

- the path is scoped (`protocolPrefix` set);
- this node is in the cohort;
- `ServingCohort.spansBand`, computed in `assembleServingCohortOnce`: FRET returned fewer peers than `wants`, the band holds no `unknown` peer, and `serving.length <= clusterSize`. The band-width `NOTE:` (a relay shared with many networks never spans its band; revisit by asking FRET, not by the band's length) is at that line;
- every other member has a current run;
- `servingPeersOutside(band)` is empty;
- **`awaitingBootstrapContact()` is false — added beyond the ticket's list.** A configured bootstrap peer not yet heard from may be a serving member this node cannot count yet, the same reason an `unknown` band member stops the answer. Cheap (reads the bootstrap tracker; a peerStore read only for a refused, identified peer). Reviewer: keep or drop.

It reads FRET, the peer-record cache and libp2p's connection list only; it dials nothing.

**Mesh harness.** Each node's own view (`makeNodeKeyNetwork`) implements `connectedCohort`: `undefined` when `findClusterFails` is set, when the node is not in the cohort, or when the cohort is not every mesh node (every mesh node serves, so that is the "not a selection" test); otherwise a member is connected unless the node's `partitionSides` side leaves it out. Runs come from one mesh-wide `MeshConnectionRuns`. `Mesh.reconnect(node)` ends every run the node is on, at both ends; `restart` does the same. **Deviation:** the shared `MockMeshKeyNetwork` does not implement it, since it has no "this node" to answer for. Every coordinator in the harness reads its node's own view, which is where the dependent ticket's consumer will read it.

## Known gaps, for the reviewer

- **A partition ends a mesh run only when a `connectedCohort` call is made while it is in place.** Applied and lifted between two calls, the runs stay as they were. Documented on `Mesh.reconnect`, which is the hook a spec uses to say "the partner disconnected and came back".
- **A peer of this network whose identify has not landed can show a partial protocol list and read `foreign`**, which does not stop the answer. Transient (ends at identify, and the membership change then makes the answer differ). `NOTE:` on `connectedCohort` names the remedy if a stale read is ever traced to it: also answer `undefined` while an identify exchange is in flight (`IdentifyProgress`).
- **No docs change.** Nothing observable changes until the consumer lands; the dependent ticket's docs list (docs/transactions.md § Lazy read-repair window, condition 3) is where the seam gets described.
- **Test doubles fixed, not production code relaxed.** Twelve `connect()` cases in `libp2p-key-network.spec.ts` and `open-protocol-stream.spec.ts` built stub connections with no `remotePeer`, which the new constructor reads. Other key-network paths (`findCluster`, `findCoordinator`, the bootstrap wait) already read `remotePeer` off `getConnections()`; those doubles only got by because those paths never ran. `createLibp2pWithConnect` now stamps a stand-in `connectedPeer` onto connections that name none; `makeConn` in `open-protocol-stream.spec.ts` sets `remotePeer: peerId` (the peer every case there dials).

## Tests added

In `packages/db-p2p/test/libp2p-key-network.spec.ts`, `describe('connectedCohort()')`, over that file's `createMockLibp2p` with a mutable connection list:

- "keeps a partner's run while one of its two connections closes, and starts a new one once its last closes and another opens": run unchanged after one of two connections closes; `undefined` with no connection; a different run id after a new connection opens.
- "is undefined while the band holds a peer not yet identified, and names the whole cohort once it is": `undefined` with an `unknown` band member; after its peerStore record serves (`peer:update`), the three sorted members.

The mesh implementation was exercised by a throwaway spec (two-node mesh: stable run, partition → `undefined`, heal → new run, `reconnect` → new run, `restart` → new run, `findClusterFails` → `undefined`; three-node mesh at `responsibilityK: 2` → `undefined`), deleted afterwards. No permanent mesh test, per the ticket: the dependent ticket's repro uses it.

## Validation run

- `yarn workspace @optimystic/db-core build`, `yarn workspace @optimystic/db-p2p build`: clean.
- `yarn test` in `packages/db-core`: 2060 passing. In `packages/db-p2p`: 3647 passing, 75 pending, 0 failing.
- `yarn workspace @optimystic/db-p2p typecheck` and `@optimystic/db-core typecheck` (both include `test/`): clean.
- `eslint` over the six changed files: clean.
- Not run: `yarn test:integration` (no integration spec touches this seam), the full root `yarn check`.
