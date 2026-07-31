----
description: A node that starts up before connecting to any peers elects itself as the coordinator for a data key and remembers that choice for 30 minutes, so even after real peers connect it keeps answering reads from its own stale local copy instead of asking the network. Fix the coordinator selection/cache so a boot-time self-pick cannot outlive the arrival of real connections.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts
difficulty: medium
----

# Boot-time self-selection poisons the coordinator cache for 30 minutes

## The defect

`Libp2pKeyPeerNetwork.findCoordinator` has three selection tiers: (1) the FRET-neighbor
path, (2) the connected-peer fallback, (3) a last-resort self-selection that is gated by
`shouldAllowSelfCoordination()`. The FRET path's candidate filter keeps a candidate when
it is connected **or when it is self**:

```ts
const connectedFretIds = ids
    .filter(id => (connectedSet.has(id) || id === this.libp2p.peerId.toString()) ...)
```

On a node with ZERO connections (normal during startup, before its first dial completes),
FRET knows only self, so the FRET path picks **self** — labelled `source=fret`, and
**without ever consulting `shouldAllowSelfCoordination()`** (that guard only protects the
last-resort tier). The pick is then written into the coordinator cache by
`recordCoordinator(key, pid)` with the default **30-minute TTL**, and the cache is
consulted before every other tier on subsequent calls.

Result: once real peers connect moments later, every read/write routed through
`findCoordinator` for that key still returns self for up to 30 minutes. Reads are then
served entirely from the node's own local replica. If that node is not part of the write
cohort for later updates (e.g. it is addressless and cannot be dialed by writers), its
replica never advances, and the node is **permanently stale** on that key for the cache
lifetime — a silent split-brain on the read path.

## Observed in the wild (Sereus three-node integration test)

`sereus/packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts`
(topology: A storage+owner, B client-only with `listenAddrs: []`, C dialable; B connects
outbound to A). Debug capture (`DEBUG='optimystic:db-p2p:libp2p-key-network,sereus:cadre:node'`,
`OPTIMYSTIC_VERBOSE=1`) shows, on node B during boot:

```
11:10:44.138 findCoordinator:start key=sxonlUsEqmVX excluded=[]
11:10:44.138 findCoordinator:connected-peers key=sxonlUsEqmVX count=0 peers=[] attempt=0
11:10:44.138 findCoordinator:fret-candidates key=sxonlUsEqmVX ids=[ <B itself> ] connected=[]
11:10:44.138 findCoordinator:done key=sxonlUsEqmVX ms=0 source=fret   ← self picked, cached
11:10:44.462 (B's connection to A is up — 300ms later)
```

Key `sxonlUsEqmVX` is the collection-tree key for the party's `CadrePeer` table. For the
next 45+ seconds every one of B's reads of that key logs `source=cache` and self-serves,
so B keeps returning the stale unsigned owner-vouch revision of peer C's address row
(`addrs=[], sig=(empty)`) while nodes A and C both hold C's fresh self-signed revision.
The Sereus-side symptom is a signature-verification failure on every resolve of C's row,
and the scenario times out. The same race explains the test's flakiness (fails ~4 of 5
runs): when B's first read of that key happens to land AFTER the A-connection is up, A is
picked instead, cached, and everything converges.

A second key (`4_zU4F7SduDN`) read moments later — after the connection was up — cached
A correctly, which confirms the mechanism is purely the boot-time race, not scoping or
FRET membership.

## Expected behavior

A self-coordinator choice made only because no peers were connected yet must not outlive
the arrival of real connections. Candidate remedies (pick the combination that fits the
design; all three may be warranted):

- Do not cache a self pick made on the FRET path when no other candidate was connected
  (or cache it with a very short TTL) — self is always available, so the cache buys
  nothing on that path anyway.
- Invalidate cached SELF entries on `connection:open` (the class already listens to that
  event in `setupConnectionTracking`).
- Route the FRET-path self-pick through `shouldAllowSelfCoordination()` so the guard's
  reasoning (bootstrap vs. suspicious isolation) applies uniformly instead of only on the
  last-resort tier.

## Regression coverage

Unit-testable without real sockets: with a stubbed libp2p whose `getConnections()` is
empty, call `findCoordinator` (self picked and cached), then make `getConnections()`
report a peer that FRET also knows, and call `findCoordinator` again — it must return the
connected peer, not the cached self. Also cover: a self pick made while genuinely alone
(solo node) still works, and repeated calls while alone do not thrash.

## Context

Surfaced by the Sereus ticket `transactor-key-network-ignores-network-scoping` (now in
sereus `tickets/blocked/` waiting on this fix): sharing one `Libp2pKeyPeerNetwork`
instance between a node's own consensus path and its database transactor means the
transactor now inherits cache entries poisoned by early boot-time reads. The pre-fix
second instance merely masked this defect by racing differently.
