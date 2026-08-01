----
description: A node that starts up before connecting to any peers picks itself as the coordinator for a piece of data and remembers that choice for 30 minutes, so even after real peers show up it keeps answering reads from its own stale copy. Stop the node from remembering a choice it only made because it was still alone, and make the existing "am I allowed to go it alone?" safety check apply to every path that can pick self.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/docs/cluster.md
difficulty: medium
repro: verified
----

# Boot-time self-selection poisons the coordinator cache for 30 minutes

## Reproduction status

Both arms below were **reproduced against a stubbed libp2p** (no sockets) and observed
failing. The `db-p2p` unit suite is green at HEAD otherwise — `1442 passing, 41 pending,
0 failing` via `yarn test` in `packages/db-p2p` — so anything red after this work is new.

## Root cause

One site: `Libp2pKeyPeerNetwork.findCoordinator` in
`packages/db-p2p/src/libp2p-key-network.ts`. Self is admitted into the coordinator
candidate set on the FRET-neighbor path **without ever consulting the self-coordination
guard**, and the resulting self pick is then written into the 30-minute coordinator cache.

The candidate filter (around line 421) keeps a candidate when it is connected **or when it
is self**:

```ts
const connectedFretIds = ids
    .filter(id => (connectedSet.has(id) || id === this.libp2p.peerId.toString())
        && !excludedSet.has(id)
        && !(this.reputation?.isBanned(id)))
```

Two consequences fall out of that one clause, and both were confirmed:

**Arm 1 — the pick gets cached.** On a node with zero connections (normal during startup,
before the first dial completes) FRET knows only self, so the FRET path picks self, logs
`source=fret`, and calls `recordCoordinator(key, pid)` with the default 30-minute TTL
(line ~441). The cache is consulted ahead of every other tier on later calls, so once real
peers connect moments later every read/write for that key still resolves to self for up to
30 minutes and is served from the node's own local replica. If the node is not in the write
cohort for later updates (e.g. it is addressless and writers cannot dial it) its replica
never advances and it is permanently stale on that key for the cache lifetime.

**Arm 2 — the guard is bypassed.** `shouldAllowSelfCoordination()` is only consulted by the
last-resort tier (line ~484). A node that has previously seen a larger network (high-water
mark above 1), currently has zero connections, and disconnected within the grace period is
supposed to *refuse* to self-coordinate and throw `SELF_COORDINATION_BLOCKED` — that guard
exists precisely so a partitioned node does not silently serve its own stale data. But if
self happens to sit in the FRET neighbor set for the key (essentially always on a small or
forming network) the FRET path returns self first and the guard never runs.

The connected-peer fallback tier (line ~454) builds its candidate set from connected
*remote* peers and can never yield self, so it needs no change.

## Observed in the wild

`sereus/packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts`
(A storage+owner, B client-only with `listenAddrs: []`, C dialable; B dials out to A).
With `DEBUG='optimystic:db-p2p:libp2p-key-network,sereus:cadre:node'` and
`OPTIMYSTIC_VERBOSE=1`, node B during boot:

```
11:10:44.138 findCoordinator:start key=sxonlUsEqmVX excluded=[]
11:10:44.138 findCoordinator:connected-peers key=sxonlUsEqmVX count=0 peers=[] attempt=0
11:10:44.138 findCoordinator:fret-candidates key=sxonlUsEqmVX ids=[ <B itself> ] connected=[]
11:10:44.138 findCoordinator:done key=sxonlUsEqmVX ms=0 source=fret   ← self picked, cached
11:10:44.462 (B's connection to A comes up — 300ms later)
```

For the next 45+ seconds every one of B's reads of that key logs `source=cache` and
self-serves, so B keeps returning a stale unsigned revision of peer C's address row while A
and C both hold C's fresh self-signed revision. A second key read moments later — after the
connection was up — cached A correctly, which confirms the mechanism is the boot-time race
and not scoping or FRET membership. The scenario fails roughly four runs in five; it passes
when B's first read of that key happens to land after the A-connection is up.

## Required behavior

A self-coordinator choice made only because no peers were connected yet must not outlive
the arrival of real connections, and every path that can select self must clear the same
guard. Three changes, all in `findCoordinator` / its supporting members:

**A. Never cache a self pick.** In the FRET-path success branch, skip `recordCoordinator`
when the pick is self; return it as today. Self is always reachable, so caching it buys
nothing — the FRET path re-derives it from a local table lookup with no retry sleep. This
also makes behavior uniform with the last-resort self tier, which already returns self
*without* caching it. That asymmetry is what made the FRET path the odd one out.

**B. Drop cached self entries once connections exist.** `recordCoordinator` is `public` and
is also called from outside this class on redirect responses — `RepoClient`
(`src/repo/client.ts:159`), `ClusterClient` (`src/cluster/client.ts:86`) and
`NetworkTransactor` (`packages/db-core/src/transactor/network-transactor.ts:484`) — so a
redirect naming self could still seed an entry that change A cannot prevent. In
`updateNetworkObservations()`, inside the existing `if (connections.length > 0)` branch,
purge every cache entry whose value is self. That branch is exactly the "real connections
have arrived" transition, it is already wired to `connection:open` by
`setupConnectionTracking()`, and it is already directly callable from tests.

**C. Gate the FRET-path self candidate on the guard.** Admit self into
`connectedFretIds` only when `shouldAllowSelfCoordination().allow` is true. When it is
false, drop self from the FRET candidate list and let selection fall through normally — the
connected-peer fallback still gets its chance, and the last-resort tier then produces
`SELF_COORDINATION_BLOCKED` with the accurate reason. Do **not** throw from the FRET path
itself; that would skip a perfectly good connected peer the fallback tier would have found.

Two details on C worth getting right:

- Evaluate the guard **lazily** — only when self actually appears in `ids` — so a node whose
  FRET neighbors are all remote does not pay `detectPartition()` and
  `getNetworkSizeEstimate()` on every attempt.
- Re-evaluate it **per retry attempt** rather than caching the decision for the call. A
  connection can land during the 500ms inter-attempt sleep and legitimately flip the answer.
  This mirrors how `filterByMembership` re-reads the peerStore on each attempt.

None of the three changes should alter behavior for a genuinely solo node: with high-water
mark at or below 1 the guard returns `bootstrap-node` / allow, so self is still selected and
still returned — it simply is not memoized.

## Regression coverage

Add to `packages/db-p2p/test/libp2p-key-network.spec.ts` under a new
`describe('findCoordinator() — boot-time self-selection and cache')`. The existing
`createMockLibp2p` helper takes a fixed `connections` array; these tests need it to be
**mutable between calls**, so either build a local mock with a `getConnections: () => connections`
closure over a reassignable variable, or extend the helper. Note also that `createMockLibp2p`
stores `addEventListener` handlers in a local `listeners` map it never exposes — testing the
purge through a real `connection:open` dispatch would need that exposed, but calling
`(network as any).updateNetworkObservations()` directly is sufficient and matches the
existing test at line ~340.

The two arms below are the exact reproductions that were confirmed failing:

```ts
// ARM 1 — cached boot-time self must not survive a peer connecting.
let connections: Connection[] = [];
let neighbors: string[] = [selfPeerId.toString()];
const fret = {
    getNeighbors: () => neighbors,
    getNetworkSizeEstimate: () => ({ size_estimate: 1, confidence: 0.5 }),
    detectPartition: () => false,
    exportTable: () => undefined,
    assembleCohort: () => []
};
const libp2p = {
    peerId: selfPeerId,
    getConnections: () => connections,
    getMultiaddrs: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    services: { fret }
} as unknown as Libp2p;

const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
const key = new TextEncoder().encode('collection-tree-key');

// Boot-time read, no connections yet -> self is picked (correct) ...
expect((await network.findCoordinator(key)).toString()).to.equal(selfPeerId.toString());

// ... then a real peer connects and FRET learns it, nearer the key than self.
connections = [connTo(peerA)];
neighbors = [peerA.toString(), selfPeerId.toString()];

// The next read must route to the real peer, not the cached boot-time self.
expect((await network.findCoordinator(key)).toString()).to.equal(peerA.toString());
// ^ FAILS at HEAD: returns self from cache.
```

```ts
// ARM 2 — the FRET-path self-pick must honour the self-coordination guard.
// HWM=5 seen before, zero connections now, disconnected moments ago
// -> shouldAllowSelfCoordination() returns { allow: false, reason: 'grace-period-not-elapsed' }.
const persistence = new MemoryPersistence({
    version: 1,
    networkHighWaterMark: 5,
    lastConnectedTimestamp: Date.now(),
    consecutiveIsolatedSessions: 0
});
const fret = {
    getNeighbors: () => [selfPeerId.toString()],   // self IS a FRET neighbor of this key
    getNetworkSizeEstimate: () => ({ size_estimate: 5, confidence: 0.5 }),
    detectPartition: () => false,
    exportTable: () => undefined,
    assembleCohort: () => []
};
// ...getConnections: () => []
const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
await network.initFromPersistedState();

expect(network.shouldAllowSelfCoordination().allow).to.be.false;  // precondition holds

// Must throw SELF_COORDINATION_BLOCKED rather than quietly returning self.
// ^ FAILS at HEAD: findCoordinator returns self, no throw.
```

Beyond those two, cover:

- **No cache entry is written for a self pick** — after a boot-time `findCoordinator`,
  assert `(network as any).coordinatorCache` holds no entry for that key. This pins change A
  directly rather than only through its downstream effect in ARM 1.
- **Externally-seeded self entry is purged on connection** — call the public
  `recordCoordinator(key, selfPeerId)`, then make `getConnections()` report a peer and call
  `(network as any).updateNetworkObservations()`, then assert `findCoordinator` returns the
  connected peer. This pins change B, which ARM 1 does not reach once A lands.
- **A genuinely solo node still works and does not thrash** — alone (high-water mark 1, no
  connections, FRET knows only self), three consecutive `findCoordinator` calls all return
  self and none of them enters the 500ms retry sleep. Guard against a regression where
  removing the cache entry pushes the solo path into the retry loop; asserting the calls
  complete well under the 500ms inter-attempt delay is enough.
- **Existing scoping tests still pass unchanged** — in particular `findCoordinator prefers
  self (serves) over a not-yet-identified cross-network peer` (line ~744) and `returns self
  on first call when no excludes` (line ~348) both run at high-water mark ≤ 1, so the guard
  allows and they should be unaffected. If either needs editing, that is a signal change C
  went further than intended.

## Documentation

`packages/db-p2p/docs/cluster.md` carries a design-notes bullet list that already documents
coordinator/cohort selection behavior (the network-membership scoping bullet is at line
~644). Add a short bullet there stating that the coordinator cache never memoizes a self
pick, that cached self entries are dropped once connections arrive, and that every tier
which can select self clears `shouldAllowSelfCoordination()` first.

## Context

Surfaced by the Sereus ticket `transactor-key-network-ignores-network-scoping`, now sitting
in sereus `tickets/blocked/` waiting on this fix. Sharing one `Libp2pKeyPeerNetwork` between
a node's own consensus path and its database transactor means the transactor inherits cache
entries poisoned by early boot-time reads; the pre-fix second instance merely masked this by
racing differently.

## TODO

- Skip `recordCoordinator` on the FRET path when the pick is self; keep returning the pick.
  Add a brief comment tying the choice to the last-resort tier's existing no-cache behavior.
- Add a defensive one-line comment at the connected-peer fallback tier noting its candidate
  set is remote-only and therefore cannot yield self.
- Purge self-valued coordinator-cache entries in `updateNetworkObservations()` inside the
  existing `connections.length > 0` branch.
- Consider a `NOTE:` tripwire comment at that purge: it scans the whole cache (bounded at
  `MAX_CACHE_ENTRIES = 1000`) on every connection-open; if connection churn ever makes that
  show up in a profile, track self-keyed entries separately instead.
- Gate the FRET-path self candidate on `shouldAllowSelfCoordination().allow`, evaluated
  lazily and re-evaluated per retry attempt; on refusal drop self and fall through rather
  than throwing.
- Add the regression tests above to `packages/db-p2p/test/libp2p-key-network.spec.ts`.
- Add the design-notes bullet to `packages/db-p2p/docs/cluster.md`.
- Run `yarn build` and `yarn test` in `packages/db-p2p`; baseline to match or beat is
  `1442 passing, 41 pending, 0 failing`.
