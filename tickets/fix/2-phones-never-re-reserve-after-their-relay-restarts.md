description: A phone reaches its group only through a relay server, and when that relay restarts the phone loses its slot on it and never asks for one again. The phone stays unreachable until its app restarts. The new two-phones end-to-end test fails on exactly this.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`createLibp2pNode`: hands the listen addresses, including `<relay>/p2p-circuit`, to libp2p once; nothing watches them afterwards)
  - packages/db-p2p/test/two-phones-over-relay.integration.spec.ts (phase 5 is the reproduction and the acceptance test; `waitForReservations` reports each phone's state on failure)
  - packages/db-p2p/test/util/relay-topology.ts (`spawnRestartablePlainRelay`: stops and restarts a relay under the same key on the same address)
  - docs/architecture.md (§ Supported deployment sizes: states this gap; update it when fixed)
  - docs/optimystic.md (§ Deployment Targets, "Relay restarts": tells mobile and browser hosts to supervise the reservation; update or remove it when fixed)
  - ../sereus/packages/cadre-core/src/relay-reservation.ts (prior art in the sibling repository: `superviseRelayReservation`, `driveRelayReservation`, `clearRelayFilterEntry`)
repro: verified
----

# What happens

A node started with a `<relay>/p2p-circuit` listen address, the only shape a phone or browser can take, reserves a slot on that relay once, at start. If the relay restarts, or the node's connection to it drops, the reservation is gone and is never requested again. The node's circuit address disappears, so no other peer can reach it, even though the node soon reconnects to the relay.

Reproduce from `packages/db-p2p`:

```
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js test/two-phones-over-relay.integration.spec.ts --reporter spec
```

Phases 1–4 pass. Phase 5 stops the relay, starts it again as the same peer on the same address, and waits 30 seconds for both phones to hold reservations. It fails every run, reporting that each phone has a connection to the relay but no circuit address.

A throwaway experiment in the same topology, with libp2p's debug logs on (`DEBUG='libp2p:circuit-relay:transport:*,libp2p:reconnect-queue*'`), showed the sequence:

1. The relay stops. Each phone's reservation store drops the reservation, and the circuit listener withdraws its address.
2. The relay starts again. Within about 0.5 s each phone is connected to it: the two phones' attempts to dial each other through the relay reopen that connection. Those attempts fail, because the partner holds no reservation.
3. No new reservation request is ever made.
4. The experiment then called libp2p's transport-manager `listen` on `<relay>/p2p-circuit` again, the step a supervisor would take. Both phones re-reserved immediately, reconnected to each other on their own within about 2 s, and a write crossed.

```
17:51:58.061Z libp2p:circuit-relay:transport:reservation-store removing relay reservation with 12D3KooWKDcb… from local store
17:51:58.062Z libp2p:circuit-relay:transport:listener relay removed 12D3KooWKDcb… our relay 12D3KooWKDcb… true
17:51:58.366Z libp2p:circuit-relay:transport:error circuit relay dial to destination 12D3KooWQuJf… via relay 12D3KooWKDcb… failed - InvalidMessageError: failed to connect via relay with status NO_RESERVATION
   [exp] phones reconnect to the restarted relay: YES after 522ms — A relay conns 1 circuit false; B relay conns 1 circuit false
   [exp] phones re-reserve with no help: NO within 5s — A relay conns 1 circuit false; B relay conns 1 circuit false
17:52:03.911Z libp2p:circuit-relay:transport:listener making reservation on peer 12D3KooWKDcb…
17:52:03.915Z libp2p:circuit-relay:transport:reservation-store created reservation on relay peer 12D3KooWKDcb…
   [exp] phones re-reserve after a transport-manager re-listen: YES after 0ms
   [exp] A and B reconnect to each other on their own once both hold reservations: YES after 2059ms
```

# Why: the installed `@libp2p/circuit-relay-v2` 4.1.3

- `CircuitRelayTransportListener.listen` reserves on a specific relay once. Its `relay:removed` handler clears the listener's addresses and announces the change, and it never listens again.
- The `ReservationStore`'s `connection:close` handler removes the reservation. It re-queues only reservations of type `discovered`, which come from a bare `/p2p-circuit` search address. A `configured` reservation, which is what `<relay>/p2p-circuit` creates, is dropped for good.
- Removing the reservation also removes the relay's keep-alive tag, so libp2p's reconnect queue has no reason to act either.
- A failed reservation request puts the relay in the store's `relayFilter` for the life of the process, and later attempts are refused as "previously invalid". Sereus found that any retry has to clear that entry first.

Sereus already compensates, at the application layer. `superviseRelayReservation` re-checks every 5 s while a reservation is held, and once one is lost it re-drives on a backoff from 2 s to 60 s, clearing the `relayFilter` entry before each attempt. Sereus's `docs/architecture.md` records that before this supervisor, a relay restart left a browser tab undialable until the user reloaded the page. A host of `@optimystic/db-p2p` without such a supervisor does not recover.

# Expected behaviour

A node started with a `<relay>/p2p-circuit` listen address holds a reservation on that relay whenever the relay is reachable, with no app restart. After the relay restarts, or the connection to it drops, the node re-reserves within a bounded time and its circuit address comes back. Phase 5 of `two-phones-over-relay.integration.spec.ts` is the acceptance test. It must pass without changing its assertions or its 30-second budget, and it must not add a re-listen step to the test.

# Open questions for the fix stage

- **Which layer owns it.** One option is the node factory, so every phone or browser host of `db-p2p` gets it. The other is documenting that hosts must supervise, as Sereus does. The release goal of core low-node-count scenarios working on React Native, and the spec's intent, both favour the node. If it moves into the node, Sereus's supervisor would drive the same reservation a second time for Optimystic nodes. Coordinate rather than break it.
- **Trigger and cadence.** Options are the listener's address-change event, a poll, or both, plus backoff bounds. The fix must stop cleanly when the node stops: no timer may keep a stopped process alive (see `withTimeout` in `packages/db-p2p/src/cluster/block-transfer.ts`, fixed for exactly that).
- **Reaching libp2p.** Sereus goes through `node.components.transportManager` and the transport's `reservationStore`, both libp2p internals. Prefer a public route if the installed libp2p has one, and pin whichever route is chosen with a test that fails loudly if libp2p's layout moves.
