description: A phone or browser node keeps its relay slot alive by replacing the relay address the app configured with a generic "any relay" listener, which has a known side effect of sometimes reserving on the wrong relay. The newer relay library now in the tree looks able to keep the configured address instead, which would remove that side effect.
architecture: packages/db-p2p/readme.md
files:
  - packages/db-p2p/src/network/relay-reservation.ts (`planRelayListenAddrs`, `superviseRelayReservation`, the `NOTE:` at `findCircuitRelayTransport`)
  - packages/db-p2p/src/libp2p-node-base.ts (the two `NOTE:`s above `planRelayListenAddrs`)
  - packages/db-p2p/test/relay-reservation-seam.spec.ts (pins what a bare listener publishes)
  - packages/db-p2p/test/relay-reservation-supervisor.spec.ts
  - packages/db-p2p/test/relay-reservation-refresh.integration.spec.ts
  - packages/db-p2p/test/two-phones-over-relay.integration.spec.ts
tradeoffs: The current shape works, is covered by real-socket specs, and matches what Sereus runs; the side effect it would remove only appears when a relay-only node is directly connected to a second relay server, which no known deployment does.
----
# The relay supervisor could keep the address the app configured

## Background

A node that can only be reached through a relay listens on an address that names the relay (`<relay address>/p2p/<relay id>/p2p-circuit`) and holds a slot on it, called a reservation. libp2p asks for that slot once at start. If the relay restarts or the connection to it drops, the slot is gone and libp2p does not ask again, so db-p2p runs its own supervisor per relay (`superviseRelayReservation` in `packages/db-p2p/src/network/relay-reservation.ts`).

On `@libp2p/circuit-relay-v2` 4.1.3 a listener on the relay-naming ("configured") address published a reservation only from inside its own `listen()` call, so nothing a supervisor did later could bring the address back. To get around that, `planRelayListenAddrs` rewrites each configured address into a bare `/p2p-circuit` listener, which publishes any `discovered` reservation, and the supervisor asks for a `discovered` slot on the named relay.

That rewrite has a cost, recorded as an accepted tradeoff in `packages/db-p2p/src/libp2p-node-base.ts` (the `NOTE:` above `planRelayListenAddrs`): a bare listener also turns on libp2p's relay discovery, which can reserve on any connected peer that serves the relay protocol and take the slot meant for the named relay. The supervisor reports it as `relay-reservation:slot-taken`.

## What changed

Ticket `a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout` moved the tree to `@libp2p/circuit-relay-v2` 4.2.13. Read from its transport source (not exercised in a spec):

- `listener.js`: on `relay:created-reservation` a `configured` reservation is now applied when it is for the relay that listener already published. A configured listener keeps its relay recorded after the address is withdrawn, so a later `addRelay(relay, 'configured')` should re-publish the address.
- `reservation-store.js`: a refresh renews the reservation in place while the relay connection is still open, instead of removing and re-creating it.

So the supervisor could leave the app's configured address alone and ask again with `'configured'`. That would remove the rewrite, and with it the discovery side effect.

## What would have to be shown

- A configured listener re-publishes after the relay connection drops and the supervisor asks again with `'configured'`, and after the relay itself restarts. This is the claim read from source above; a spec on real nodes has to confirm it before anything is built on it.
- Node creation still rejects when the relay cannot be reserved at start (today the supervisors' first drives are awaited for that).
- `test/relay-reservation-seam.spec.ts` keeps pinning whatever the new shape relies on, in place of "a bare listener never publishes a `configured` reservation".
- A host that passes a bare `/p2p-circuit` itself is still left alone.
