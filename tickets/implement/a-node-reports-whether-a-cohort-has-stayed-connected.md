description: Give the node a way to say, for a record, whether the small group of machines that store it is the whole group it knows about and whether each of them has stayed connected without a break, so a later change can skip re-checking a record with a partner that could not have changed it unnoticed.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/network/i-key-network.ts (`IKeyNetwork`), packages/db-p2p/src/libp2p-key-network.ts (`Libp2pKeyPeerNetwork`, `assembleServingCohortOnce`, `servingPeersOutside`, `membershipOverfetch`), packages/db-p2p/src/network/connection-runs.ts (new), packages/db-p2p/src/testing/mesh-harness.ts (`MockMeshKeyNetwork`, the per-node view with `partitionSides`), packages/db-p2p/test/ (a key-network spec over a fake libp2p, if one exists — look for the specs that construct `Libp2pKeyPeerNetwork`)
----

Part one of GitHub #56 (plan ticket `a-quiet-watched-collection-is-read-without-consulting-its-cohort`). The consumer is the dependent ticket `a-held-block-is-not-re-checked-while-its-whole-cohort-stays-connected`; read its "Why this rule" section for the argument this seam serves. This ticket adds the seam and nothing that uses it.

## What the seam answers

"For this block's routing key, is the cohort `findCluster` would assemble now the whole serving network this node knows of, does it include this node, and is every other member connected — and if so, which unbroken connection run is each member on?" A *connection run* is the span during which a remote peer has at least one open connection to this node; it ends when its last connection closes, and the next connection starts a new run with a new id. Two snapshots with the same members and the same run ids prove that no member's connectivity to this node broke between them.

### Interface (db-core)

```ts
/** What `IKeyNetwork.connectedCohort` reports: a cohort that is the whole serving network this node knows of, every member connected. */
export type ConnectedCohort = {
	/** The cohort `findCluster` assembles for the key now, as peer-id strings, this node included, sorted ascending. */
	readonly members: readonly string[];
	/** Per member other than this node: the id of its current connection run. Ids are never reused within a process. */
	readonly runs: Readonly<Record<string, number>>;
};

// on IKeyNetwork, optional like awaitingBootstrapContact / absentCohortMembers:
connectedCohort?(key: RoutingKey): Promise<ConnectedCohort | undefined>;
```

Absent method, or `undefined`, reads as "no such guarantee" — the consumer then behaves exactly as today. Doc comment says so, in the house style of the neighbouring optional methods.

### `undefined` unless every one of these holds (`Libp2pKeyPeerNetwork`)

Evaluated from the same assembly `findCluster` uses (`assembleServingCohortAt`), so the two cannot disagree about the members:

- This node is in the cohort.
- The band holds no `unknown` peer (a peer not yet identified could be a member this node cannot yet count).
- The cohort is not a selection: every `serves` peer in the band is in the cohort (`serving.length <= clusterSize`).
- The band was not cut at the requested width: FRET returned fewer peers than `wants` (`membershipOverfetch()` on the scoped path, `clusterSize` otherwise), so FRET knows no further peer near the key. `foreign` peers (relays, other networks) in the band are fine.
- No remembered serving peer lies outside the band (`servingPeersOutside(band)` is empty) — a partner that went offline but is still remembered makes it `undefined`.
- Every member other than this node has a current connection run.

These together say "every machine that could coordinate a commit to this block, as far as this node can know, is in this cohort". Put a `NOTE:` at the band-width condition: a deployment whose FRET table holds more peers near the key than the over-fetch width (a shared relay full of other networks' nodes) gets `undefined` everywhere and so keeps today's read-repair cadence; revisit if such a deployment reports #56's cost, by asking FRET whether its table holds more peers rather than by reading the band's length.

### Connection runs (`packages/db-p2p/src/network/connection-runs.ts`)

A small class owned by `Libp2pKeyPeerNetwork`, constructed beside its existing `connection:open` listener:

- `connection:open` for a peer with no run → assign `++seq` as its run id. A second concurrent connection keeps the run.
- `connection:close` → if `libp2p.getConnections(peer)` (excluding the closing one, which libp2p may or may not have removed yet — check which) is empty, delete the peer's run. Decide by asking libp2p, not by a private open/close counter that can drift.
- Seed from `libp2p.getConnections()` at construction for connections that opened earlier.
- The map holds connected peers only, so it is bounded by the connection count; nothing to evict.
- `runOf(peerId): number | undefined`.

A relay-to-direct upgrade (DCUtR) that closes the relayed connection after the direct one opened keeps the run; one that closes first starts a new run, which only costs the consumer one consult.

### Mesh harness

`MockMeshKeyNetwork` (and the per-node partition-aware view) implements `connectedCohort` so the dependent ticket's mesh repro can run: members are the node's cohort; a member is connected unless the node's `partitionSides` side excludes it; the run id for a peer changes whenever a re-applied `partitionSides` separates the two and they are later rejoined. Keep it minimal — whatever lets a spec say "the partner disconnected and came back" — and return `undefined` when `findClusterFails` is set. If the harness has no clean way to re-apply a partition mid-test, add a narrow `reconnect(peerId)` test hook that bumps the run rather than inventing a partition lifecycle.

## Edge cases & interactions

- A peer with two connections where one closes: run unchanged. Verified by a test (below).
- A peer that disconnects and reconnects between two snapshots: different run ids. Verified by the same test.
- Self never has a run and never appears in `runs`. By inspection.
- `findCluster` and `connectedCohort` called back to back can see different rings if a peer is identified in between; that is acceptable because the consumer compares two `connectedCohort` snapshots with each other, never a snapshot with a `findCluster` answer. By inspection.
- The unscoped path (`protocolPrefix` unset) classifies nobody: return `undefined` there, since "every serving peer is in the cohort" cannot be judged. By inspection; note it in the doc comment.
- No network work: the method must not dial or open streams — it reads FRET, the peer-record cache and libp2p's connection list only. By inspection.

## Tests

One spec, over whatever fake libp2p the existing key-network specs use: (1) a peer's run id is unchanged while one of its two connections closes and changes after its last connection closes and a new one opens; (2) `connectedCohort` is `undefined` when the band holds an `unknown` peer, and defined with the expected members when it does not. Nothing else — the conditions are a conjunction the dependent ticket's tests exercise end to end.

## TODO

- Add `ConnectedCohort` and the optional `connectedCohort` to `IKeyNetwork` (db-core), exported where the other network types are.
- Add `ConnectionRuns` and wire it into `Libp2pKeyPeerNetwork`'s lifecycle (listeners added where `connection:open` is already observed, removed on stop if the class removes its other listeners).
- Implement `connectedCohort` from `assembleServingCohortAt`'s result plus `servingPeersOutside`, with the band-width `NOTE:`.
- Implement it on the mesh harness's key networks.
- The two tests above.
- `yarn build`, then `yarn test` in `packages/db-core` and `packages/db-p2p`.
