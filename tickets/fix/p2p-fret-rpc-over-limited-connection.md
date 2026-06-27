description: The peer-ranking layer (FRET) can't talk directly between two nodes that only reach each other through a relay, because its messages aren't allowed over relayed links. It limps along by routing that info through the relay node, but loses that crutch whenever the relay isn't itself a full participant — making peer discovery fragile in relay-heavy setups.
prereq:
files:
  - packages/db-p2p/node_modules/p2p-fret/src/rpc/neighbors.ts (fetchNeighbors / announceNeighbors — conns[0].newStream without runOnLimitedConnection)
  - packages/db-p2p/node_modules/p2p-fret/src/rpc/ping.ts
  - packages/db-p2p/node_modules/p2p-fret/src/rpc/maybe-act.ts
  - packages/db-p2p/node_modules/p2p-fret/src/rpc/leave.ts
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts (converges only TRANSITIVELY via the relay; flaky — skips when it doesn't converge in time)
  - packages/db-p2p/src/libp2p-key-network.ts (connect() — the in-repo precedent: newStream/dialProtocol WITH runOnLimitedConnection:true)
difficulty: medium
----

# FRET wire RPCs do not run over circuit-relay (limited) connections

## What is going on

`p2p-fret` is the keyspace-ranking layer optimystic uses to decide which peers
form the cohort for a given block (`assembleCohort`). It learns peer coordinates
by exchanging routing snapshots over its own libp2p protocols (neighbors / ping /
maybe-act / leave).

Every one of those RPCs opens its stream like this (see `rpc/neighbors.ts`,
`rpc/ping.ts`, `rpc/maybe-act.ts`, `rpc/leave.ts`):

```ts
const conns = node.getConnections(pid);
stream = await conns[0].newStream([protocol]);          // <-- no options
// or, when no existing connection:
stream = await node.dialProtocol(pid, [protocol]);      // <-- no options
```

Neither call passes `runOnLimitedConnection: true`. libp2p **rejects** a stream
opened over a circuit-relay ("limited") connection unless that flag is set (the
RPC catches the throw and returns an empty snapshot). So when two peers can reach
each other *only* through a relay (the browser/NAT "relay-only" topology — two
always-on Sereus `storage` nodes behind NAT, reaching each other through a
reference/relay node), they cannot exchange FRET state **directly** over the
relayed A↔B link.

## What actually happens in practice (measured)

Convergence is NOT impossible — it happens **transitively**. The relay node is
itself a full FRET participant with *direct* (non-relayed) connections to both A
and B, so it gossips each peer's coordinate to the other. `assembleCohort` then
ranks both, and a 2-of-2 (or 3-of-3, when the relay is also ranked into the
cohort) write across the relay reaches super-majority. This is demonstrated by
`multi-coordinator-write-relay.integration.spec.ts`, which PASSES when FRET
converges in time (and `this.skip()`s when it does not — convergence timing is
bimodal/flaky, ~fast or stalled past the 40 s budget).

So the gap is a **robustness/efficiency** problem, not a hard blocker whenever a
directly-connected FRET-participating intermediary exists:

- Every direct-to-relayed-peer FRET RPC throws and is swallowed each gossip round
  (wasted dials / churn).
- Convergence depends on a third party that (a) participates in FRET and (b) holds
  direct connections to both relay-only peers. A pure *transport* relay, or a
  topology where no single intermediary is directly connected to both NAT'd peers,
  would never converge.
- Convergence is slow/flaky even in the favorable case (the integration spec skips
  a meaningful fraction of runs), which would surface as intermittent
  "second storage node won't co-coordinate" in Sereus.

## Expected behavior / specification

- FRET's neighbor / ping / maybe-act / leave RPCs must be able to run over a
  limited (circuit-relay) connection: pass `runOnLimitedConnection: true` (and,
  where appropriate, mirror db-p2p's `negotiateFully` choice) on both the
  `conns[0].newStream([proto], { ... })` reuse path and the
  `node.dialProtocol(pid, [proto], { ... })` fallback. `libp2p-key-network.ts`
  `connect()` is the in-repo precedent for exactly this pattern.
- With that change, two relay-only ("browser-shaped") peers should converge their
  FRET tables *directly* (not only transitively), faster and without depending on a
  directly-connected FRET intermediary.
- Acceptance: `multi-coordinator-write-relay.integration.spec.ts` converges
  reliably (stops `this.skip()`ing on the FRET-stabilization precondition) when run
  with `OPTIMYSTIC_INTEGRATION=1`, including in a topology where the relay is a pure
  transport relay rather than a FRET participant.

## Notes for the fix stage

- This lives in the **external `p2p-fret` package** (`p2p-fret@^0.5.0`, vendored
  under `node_modules`). The change lands upstream and is consumed by db-p2p via a
  version bump — a different change surface/release cadence than the db-p2p
  cluster-RPC fix it complements (`multi-coordinator-write-relay-stream-reset`).
- Consider preferring a direct connection when one exists and only falling back to
  the limited connection (same prefer-direct reasoning as the db-p2p `connect()`
  fix), to avoid relayed-circuit caps on steady-state FRET gossip.
- Consider whether FRET gossip over relayed links needs rate-limiting to avoid
  relay-reservation cap pressure.
