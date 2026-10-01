description: When a node dials a peer through a relay it is not already connected to, it first has to open the connection to that relay, and on a slow link that did not fit in the time limits derived from the declared round trip. The limits are now sized for that case, and the plugin's overall write budget grows with them.
architecture: packages/db-p2p/readme.md
files:
  - packages/db-p2p/src/rpc-deadline.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/optimystic-node.ts
  - packages/db-p2p/test/link-deadlines.spec.ts
  - packages/db-p2p/test/cold-relayed-dial-fits-the-address-limit.spec.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - packages/quereus-plugin-optimystic/README.md
  - packages/reference-peer/src/cli.ts
  - packages/db-p2p/readme.md
  - packages/db-p2p/docs/cluster.md
  - docs/optimystic.md
----
# A relayed dial through an unconnected relay outruns its deadlines — complete

## What landed

`resolveLinkDeadlines` (`packages/db-p2p/src/rpc-deadline.ts`) sizes every deadline that covers a connection open for the cold path: libp2p takes one `addressDialTimeout` per address, and the circuit transport opens the relay connection inside it. With `r` the declared `linkRoundTripMs`, each floored at its old constant so an undeclared node is unchanged:

- `addressDialTimeoutMs` and the new `libp2pDialTimeoutMs` (libp2p `dialTimeout`): `max(6000 | 10000, 10 r)`.
- `inboundUpgradeTimeoutMs` (libp2p `inboundUpgradeTimeout`, split out of the old `connectionTimeoutMs`): `max(10000, 5 r)`, because the listener's timer never covers the dialer's relay open.
- `dialTimeoutMs` (RPC dial): `max(3000, 11 r)`; `transferTimeoutMs` follows it.
- New `transactionTimeoutMs = max(30000, 4 × dial)`: the `NetworkTransactor` `timeoutMs` used by the Quereus plugin, the reference peer and the `docs/optimystic.md` example.
- `MAX_LINK_ROUND_TRIP_MS` is now `floor((2^31 − 1) / 45)` (about 13 hours), so the transaction budget plus the cluster member's 5 s post-expiration timer still fits a 32-bit timer.

The reproduction is `packages/db-p2p/test/cold-relayed-dial-fits-the-address-limit.spec.ts`: three plain libp2p nodes, the dialer never connected to the relay, and its `addressDialTimeout` set to the cold multiple × r. The implementer measured that it fails at the old multiple of 5.

## Review findings

Read the implement diff (`ticket(implement): a-relayed-dial-through-an-unconnected-relay-outruns-its-deadlines`) before the handoff.

**Checked, no change needed:**
- Arithmetic of every derived field, the ceiling and the ceiling test. At the ceiling, 44 r + 5000 = 2,099,766,752, under 2^31 − 1.
- Every consumer of the removed `connectionTimeoutMs` / `DEFAULT_CONNECTION_TIMEOUT_MS`. None is left (grep over `.ts`/`.md` outside tickets). The `MAX_COHORT_QUERY_TIMEOUT_MS` import that was removed is still used only by `cluster-policy.ts`. The derived cohort budget (3 r) stays under it at the new ceiling.
- `NetworkTransactor` values that scale with `timeoutMs`: the coordinator-cache TTL (`max(2 × timeoutMs, 60 s)`) and the one-round commit's deadline before its fallback. Both grow with it, and both are already documented as budget-relative. No producer caps how far ahead an expiration may be (grepped `packages/db-p2p/src`).
- Every `NetworkTransactor` construction in `src` (the plugin and the reference peer) reads the derived budget. An injected node without `linkDeadlines` falls back to `resolveLinkDeadlines()`.
- The new spec: it is the defect's reproduction, at the lowest layer that reproduces it, with no repo mocks. Proxy teardown matches its two sibling specs. Ran it 3× together with `link-deadlines.spec.ts` and the address-dial spec: 13 passing each time, about 3 s.
- The implementer's deviations (budget held in `LinkDeadlines`, 4 dials rather than 3, the corrected claim about pending-record cost, the changed ceiling, the reference peer's cancel budget). Each one's reasoning holds, and its doc and comment sites agree with it.

**Found and fixed inline (minor):**
- The read-path `NOTE:` at the consult's `withinRequestBudget` call in `packages/db-p2p/src/libp2p-node-base.ts`, and its mirror in `packages/db-p2p/docs/cluster.md` (*Declaring the link instead*), said that "consensus, sync repair or FRET's own dials, which have longer deadlines" open the cold relayed connection. Two of those three are wrong. Commit-path reconciliation fetches through `fetchArchiveFromPeer`, which runs under the same short cohort budget. FRET's RPCs use fixed deadlines (`MAINTENANCE_RPC_TIMEOUT_MS` 2 s, `RPC_TIMEOUT_MS` 5 s in p2p-fret's `dist`) that ignore the declared round trip. Both texts now name the dials that actually carry the full RPC dial deadline: consensus rounds, repo requests and block pushes. They also say that FRET's RPCs cannot open a cold relayed connection either.
- `packages/quereus-plugin-optimystic/README.md` (`link_round_trip_ms`) and the `linkDeadlines` doc in `packages/db-p2p/src/optimystic-node.ts` named only the dial (and cancel) deadlines a host reads from the node. They now include the overall write budget (`transactionTimeoutMs`).

**Tripwires (recorded at their sites, not filed):**
- The read-path budget cannot open a cold relayed connection. This was already recorded by the implementer and is now corrected as above; the condition it waits on is a node that must read from a peer nothing else dials.
- The cancel budget covers a warm cancel only (the collection-factory `NOTE:`). Left as the implementer recorded it.
- FRET's own RPC deadlines do not follow `linkRoundTripMs`. The new wording of the read-path `NOTE:` records this. It lives in the sibling p2p-fret repository and is outside this ticket's anchor. A ticket only makes sense if FRET maintenance is observed to fail on declared slow links.

**Not done / not verified:**
- `yarn test:integration`, and the full db-p2p, plugin and reference-peer suites, were not re-run in review. The review changes are comments and docs only. The implementer reports full db-p2p (3165 passing) and plugin (1001 passing) runs on the same code.
- No `wss` measurement over a real slow link. The cold multiple's margin above the measured 6.6 r rests on handshake accounting, as the handoff says.

**Validation run in review:** `yarn build`, `yarn lint`, `yarn lint:docs`, `yarn typecheck`: clean. Targeted db-p2p specs: 13 passing, 3 runs.

**Follow-up for the host side:** after release, tell sereus-ec the version and the multiples: cold open 10 r, RPC dial 11 r, transaction budget 4 dials. Application admission time is not modelled; add it on top through the explicit overrides.
