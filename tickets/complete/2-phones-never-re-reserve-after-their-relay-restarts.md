description: A phone or browser reaches its group only through a relay server, and it silently lost its slot on that relay (becoming unreachable until the app restarts) whenever the relay restarted, the connection to it dropped, or the slot came up for routine renewal. The node now keeps that slot itself; reviewed the supervisor, its wiring into the node factory, and the specs, and added a pre-start guard for a configuration that could never work.
files:
  - packages/db-p2p/src/network/relay-reservation.ts (the listen-address rewrite `planRelayListenAddrs`, the internals accessor `findCircuitRelayTransport`, the per-relay supervisor `superviseRelayReservation`, the factory-facing `superviseRelayReservations`, `assertCircuitRelayTransport` and, added in review, `assertRelayAddrsAdvertisable`)
  - packages/db-p2p/src/libp2p-node-base.ts (the rewrite at `relayPlan` with the accepted-tradeoff and upgrade-tripwire `NOTE:`s; the two pre-start assertions; the supervisors started first inside the post-start `try`)
  - packages/db-p2p/test/relay-listen-plan.spec.ts (rewrite unit spec, plus the announce-guard cases)
  - packages/db-p2p/test/relay-reservation-seam.spec.ts (pins the internals seam and the two libp2p facts the design rests on)
  - packages/db-p2p/test/relay-reservation-supervisor.spec.ts (relay restart and hang-up through `createLibp2pNode`, supervisor-level recovery, stop, slot-taken, startup rejections)
  - packages/db-p2p/test/relay-reservation-refresh.integration.spec.ts (the 40 s renewal case, gated on `OPTIMYSTIC_INTEGRATION=1`)
  - packages/db-p2p/test/startup-rollback.spec.ts (a relay that cannot be reserved releases the listener port)
  - packages/db-p2p/test/util/relay-topology.ts (`reservationTtl` on the plain relays; `announceAddrs` on `spawnCircuitOnlyPeer`)
  - packages/db-p2p/test/two-phones-over-relay.integration.spec.ts (unchanged; phase 5 is the acceptance test and passes)
  - docs/architecture.md, docs/optimystic.md, docs/debugging.md, packages/db-p2p/readme.md (docs)
  - tickets/backlog/debt-node-factory-wiring-steps-own-their-teardown.md (an arm appended: the supervisors' stop wrapper is the eighth instance)
difficulty: hard
----

# Summary

A node given `<relay address>/p2p/<relay id>/p2p-circuit` as a listen address now keeps its reservation on that relay itself. `createLibp2pNodeBase` hands libp2p a bare `/p2p-circuit` in its place and runs one supervisor per named relay. The supervisor dials the relay, asks the circuit-relay transport's reservation store for a `discovered` slot on it, waits until the node advertises a circuit address through that relay, and does it again whenever the address goes away: after a relay restart, after the relay hangs up, and across libp2p's own renewal of the slot. Node creation still rejects when a named relay cannot be reserved, and the existing post-start rollback stops everything.

Why the rewrite to a bare listener is not optional on the installed `@libp2p/circuit-relay-v2` 4.1.3: a listener on the relay-naming shape publishes its address only from inside its own `listen()` and ignores every later reservation, so nothing done after start can bring the address back. A bare listener publishes any `discovered` reservation that fills its pending slot, including the one libp2p re-creates on renewal. The seam spec pins both facts on real nodes so a libp2p upgrade that changes either fails loudly.

Production timings: a 10 s drive deadline shared by the dial, the reservation request and the wait for the address; a 5 s liveness check while held; a backoff from 1 s doubling to a 30 s cap; a 100 ms address poll inside a drive. Triggers are the first drive at start, libp2p's `self:peer:update`, `peer:connect` for the relay (which also resets the backoff), the liveness poll and the backoff timer. Drives are serialized per relay; every timer is `unref`'d; the dial uses an explicit `AbortController` that `stop()` also aborts.

# Review findings

## What was checked

- The implement-stage diff, read before the handoff: the supervisor module, the three factory blocks, the six specs, the test helper, and all four docs.
- The libp2p internals the design rests on, read from the installed `@libp2p/circuit-relay-v2` 4.1.3 source (`transport/listener.ts` and `transport/reservation-store.ts`): the listener ignores `configured` reservations on `relay:created-reservation` and publishes only a `discovered` one whose id matches its pending slot; the store drops a reservation on `connection:close`, re-queues the pending id only for `discovered` ones, refreshes by removing then re-creating, joins a concurrent `addRelay` for the same peer onto the queued job, and resets its relay filter whenever a reservation is removed while a slot is pending. Every claim in the module's `NOTE:` matches the source.
- The libp2p address manager, read from the installed `libp2p` 3.1.3 source: `getAddresses()` returns only the announce set when `announceAddrs` is non-empty. This is the finding below.
- Supervisor lifecycle: the constructor starts the first drive synchronously; a trigger mid-drive only resets the backoff and relies on the drive's own tail to re-check and reschedule; `stop()` clears the timer, removes both listeners, aborts the dial, and settles `firstDrive`; a stopped supervisor never schedules. A `drive()` that somehow throws is caught so `firstDrive` cannot hang and the loop keeps retrying.
- Factory wiring: the supervisors are the first thing inside the post-start `try`, the stop wrapper is installed before the first await, and `awaitFirstDrives` rejecting reaches the rollback `catch`, whose `node.stop()` runs the wrapper. Two relays give two bare listeners and two pending slots; each listener publishes the reservation carrying its own id, and "held" is judged per relay.
- Docs: `docs/debugging.md` states 46 sub-namespaces; counted the table rows the way `logger.spec.ts` scopes the section and got 46. The `listenAddrs` option's own JSDoc said nothing about the rewrite; fixed. The readme's `announceAddrs` section now states the new restriction.
- Open tickets touching the same files: `debt-node-factory-wiring-steps-own-their-teardown` already claims the stop-wrapper pattern in `libp2p-node-base.ts`; the supervisors' wrapper is its eighth instance, appended there as an arm rather than filed anew.
- Lint, docs lint, deps lint, typecheck, the full `@optimystic/db-p2p` suite (2734 passing, 62 pending, 0 failing), the two-phones acceptance spec (all five phases; phase 5 re-reserves in about 2 s) and the refresh integration spec (145 samples, 0 absent) all pass.

## Found and fixed inline

- **`announceAddrs` combined with a relay-naming listen address could never work and failed slowly.** libp2p advertises only the announce set then, so the circuit address never appears in `node.getMultiaddrs()`, the supervisor's "held" check never passes, and node creation would reject after the full 10 s drive deadline with a message about publishing rather than about the configuration. Added `assertRelayAddrsAdvertisable`, called next to the plan before anything is built, rejecting with a message that names the relay and the fix (`appendAnnounceAddrs`). Unit cases in `relay-listen-plan.spec.ts`; a factory-level case in `relay-reservation-supervisor.spec.ts` asserts the rejection lands well inside the drive deadline. This is the boundary-invariant rung: the contradictory configuration is refused at the seam instead of diagnosed after a timeout.
- **The "stopped mid-drive" spec depended on a public black-hole address hanging.** On a host with no default route the dial to TEST-NET-1 is refused at once and the abort would go untested. Replaced with a local TCP server that accepts the socket and never answers the WebSocket handshake, so the hang is deterministic on every host; the server is closed in the spec's `finally`.
- **The slot-taken log line fired once per supervisor lifetime.** A second episode after a recovery went unlogged. The flag now resets when the reservation is held, so each episode logs once; the doc row and the JSDoc say "once per episode".
- **A helper in the supervisor module was named `describe`.** Renamed to `errorMessage` so it cannot be misread as mocha's.
- **The restartable relay rebuilt its options by hand.** Its `start()` now spreads the original options and overrides the key and listen address, which is what the first spawn already did.

## Major findings

None. The only class-level concern, the hand-written stop wrapper, already has a ticket; this change's instance was appended to it as evidence.

## Tripwires recorded

- `libp2p-node-base.ts` at `relayPlan`: the accepted tradeoff (relay discovery can reserve on a second connected relay server first) and the upgrade tripwire (circuit-relay-v2 4.2+ refreshes in place and re-applies a configured reservation; revisit dropping the rewrite when the libp2p line moves past `@libp2p/interface` 3.1). Both were placed by the implementer and read correctly against the source.
- `relay-reservation.ts` at `findCircuitRelayTransport`: the one internals reach-through, with the installed versions and the 4.1.3 mechanics it depends on. Confirmed accurate.
- No new tripwire was needed. The announce interaction became a guard rather than a note because it is definitely wrong the moment that configuration is used, not conditional.

## Considered and declined

- Splitting `relay-reservation.ts` (619 lines before review) into plan and supervisor files. The three parts share the `SupervisedRelay` type and the store interface and are documented as one mechanism; a split would move lines without reducing coupling.
- Replacing the address-based "held" check with `store.hasReservation`. The address is what other peers can use, so it is the right definition; the announce guard removes the one case where the two disagreed.
- Logging less when the internals seam goes missing. A drive logs an error every backoff interval in that state; that is a broken upgrade and should stay loud.

## Known gaps carried forward (unchanged from the handoff, still true)

- Startup and the slot-taken case interact only when a relay-only node is directly connected to a second relay server at start; that combination is tested at supervisor level, not through the factory.
- `clearRelayFilterEntry` is exercised only through the restart cases, where the store's own filter reset also runs; the seam spec pins that `relayFilter.remove` still exists.
- The `peer:connect` trigger has no dedicated assertion beyond phase 5's 2 s recovery.
- The supervisor is not run on React Native or a browser in this repo; it avoids `AbortSignal.timeout` and guards `unref` by construction.
- The DCUtR hole-punch case (`RUN_DCUTR_HOLEPUNCH=1`) needs a real non-private NIC and was not run.
