description: A phone or browser reaches its group only through a relay server, and it silently lost its slot on that relay (becoming unreachable until the app restarts) whenever the relay restarted, the connection to it dropped, or the slot came up for routine renewal. The node now keeps that slot itself; review the supervisor, its wiring into the node factory, and the specs.
files:
  - packages/db-p2p/src/network/relay-reservation.ts (new: the listen-address rewrite `planRelayListenAddrs`, the one libp2p-internals accessor `findCircuitRelayTransport`, the per-relay supervisor `superviseRelayReservation`, and the factory-facing `superviseRelayReservations` and `assertCircuitRelayTransport`)
  - packages/db-p2p/src/libp2p-node-base.ts (the rewrite at `relayPlan` with the accepted-tradeoff and upgrade-tripwire `NOTE:`s; the pre-start transport assertion; supervisors started first inside the post-start `try`, stop wrapper installed before any await, first drives awaited)
  - packages/db-p2p/test/relay-listen-plan.spec.ts (new; rewrite unit spec)
  - packages/db-p2p/test/relay-reservation-seam.spec.ts (new; pins the internals seam and the two libp2p facts the design rests on)
  - packages/db-p2p/test/relay-reservation-supervisor.spec.ts (new; relay restart and hang-up through `createLibp2pNode`, supervisor-level recovery, stop, slot-taken, startup rejections)
  - packages/db-p2p/test/relay-reservation-refresh.integration.spec.ts (new; the 40 s renewal case, gated on `OPTIMYSTIC_INTEGRATION=1`)
  - packages/db-p2p/test/startup-rollback.spec.ts (one added case: a relay that cannot be reserved releases the listener port)
  - packages/db-p2p/test/util/relay-topology.ts (`reservationTtl` option on `spawnPlainRelayNode` and `spawnRestartablePlainRelay`)
  - packages/db-p2p/test/two-phones-over-relay.integration.spec.ts (unchanged; phase 5 is the acceptance test and now passes)
  - docs/architecture.md, docs/optimystic.md, docs/debugging.md, packages/db-p2p/readme.md (docs)
  - tickets/.pre-existing-known.md (the phase 5 entry removed)
difficulty: hard
----

# What was done

A node given `<relay address>/p2p/<relay id>/p2p-circuit` as a listen address now keeps its reservation on that relay itself. `createLibp2pNodeBase` hands libp2p a bare `/p2p-circuit` in its place and runs one supervisor per named relay. The supervisor dials the relay, asks the circuit-relay transport's reservation store for a `discovered` slot on it, waits until the node advertises a circuit address through that relay, and does it again whenever the address goes away. Everything is in `packages/db-p2p/src/network/relay-reservation.ts`; the factory changes are three small blocks in `libp2p-node-base.ts`.

Why the rewrite is not optional, on the installed `@libp2p/circuit-relay-v2` 4.1.3: a listener on the relay-naming shape publishes its address only from inside its own `listen()` and ignores every later reservation, so nothing done after start can bring the address back. A bare listener publishes any `discovered` reservation that fills its pending slot, including the one libp2p re-creates on renewal. `test/relay-reservation-seam.spec.ts` pins both facts on real nodes, so a libp2p upgrade that changes either fails loudly.

## Timings (production defaults, `relay-reservation.ts`)

| Setting | Value | Why |
|---|---|---|
| drive deadline | 10 s | dial, reservation request and the wait for the address share it |
| liveness check while held | 5 s | fallback in case an event is missed |
| backoff after a failed drive | 1 s, doubling | first retry lands fast after a blip |
| backoff cap | 30 s | bounds recovery after a long outage; nothing else reconnects a lone phone |
| address poll inside a drive | 100 ms | `addRelay` resolves a tick before the listener publishes |

Triggers: the first drive at start; libp2p's `self:peer:update` (the listener withdrew or added addresses, debounced about 1 s by libp2p); `peer:connect` for the relay (resets the backoff, so a partner's dial through the relay turns into an immediate re-reserve); the liveness poll; the backoff timer. Drives are serialized per relay. Every timer is `unref`'d through optional chaining, and the dial uses an explicit `AbortController` that `stop()` also aborts.

The timings are constructor options on `superviseRelayReservation`; the factory uses the defaults and `NodeOptions` did not grow a knob. The specs that need short timings use the supervisor directly on plain libp2p nodes.

## Startup contract kept

Node creation still rejects when a named relay cannot be reserved, naming the relay and the reason, and the existing post-start rollback stops everything (`startup-rollback.spec.ts` has the new case, asserting the listener port is released). A listen address naming a relay on a node with no circuit-relay transport rejects before `start()` with "no circuit-relay transport — add circuitRelayTransport() to transports". A host that would rather start offline is a separate decision and was not added.

## How the refresh spec is gated

`relay-reservation-refresh.integration.spec.ts` takes 38 s and is named `*.integration.spec.ts`, so it runs under `yarn test:integration` and `yarn check` rather than `RUN_LONG_TESTS`. It samples the address every 250 ms through the 30 s refresh and asserts the address is never absent at two consecutive samples, plus that the reservation's expiry moved (the refresh actually happened). "Never absent at two consecutive samples" rather than "present at every sample": on 4.1.3 the refresh removes the reservation and re-creates it, so the bare listener withdraws and republishes within one reservation round trip (milliseconds on loopback), and a 250 ms sampler could land in that gap. Measured: 146 samples, 0 absent.

# Validation run

All from `packages/db-p2p` unless noted.

- Acceptance: `OPTIMYSTIC_INTEGRATION=1 … test/two-phones-over-relay.integration.spec.ts`, unchanged. All five phases pass; phase 5 re-reserves in about 2 s.
- New specs: `relay-listen-plan`, `relay-reservation-seam`, `relay-reservation-supervisor`, `startup-rollback`, `logger` (the namespace-doc check). All pass. Relay restart with no partner re-reserved about 1 s after the relay came back; hang-up while the relay stayed up recovered in 56 to 112 ms.
- Refresh: `OPTIMYSTIC_INTEGRATION=1 … test/relay-reservation-refresh.integration.spec.ts` passes.
- Regression (all pass): `relay-third-party-address-gap`, `relay-inbound-source-address`, `relay-self-relay-only-dial`, `open-protocol-stream-relay`, `relay-address-propagation`, `identify-push-propagation`, `dcutr-direct-upgrade` (loopback smoke under `RUN_LONG_TESTS=1`), `multi-coordinator-write-relay.integration`, and `circuit-relay-long-lived` under `RUN_LONG_TESTS=1`.
- Full suite: `yarn workspace @optimystic/db-p2p test`: 2731 passing, 62 pending, 0 failing.
- `yarn workspace @optimystic/db-p2p typecheck`, root `yarn lint`, `yarn lint:docs`, `yarn lint:deps`: all clean.
- Not run: the DCUtR hole-punch case (`RUN_DCUTR_HOLEPUNCH=1` needs a real non-private NIC; not agent-runnable).

# Use cases for the reviewer

- A phone whose relay restarts, with no partner: `relay-reservation-supervisor.spec.ts` "re-reserves after the relay restarts, with no partner to reconnect it". Only the supervisor's backoff can bring it back, since the relay was down when the slot freed and discovery's one attempt fails and poisons its filter.
- A phone whose relay hangs up but stays up: same file, "re-reserves after the relay hangs up". The address came back in 56 to 112 ms, which is faster than the supervisor's 1 s debounced trigger, so in this case libp2p's own discovery (the hop protocol is in the peer store from our own request) refilled the slot. The spec asserts the outcome (a new relay connection holding a reservation), not who did it. The supervisor's own handling of a lost slot is proven by the restart cases.
- Two phones and a relay restart: phase 5 of `two-phones-over-relay.integration.spec.ts`.
- A second relay taking the slot (the accepted tradeoff): "a slot already filled through another relay …" pins that the supervisor reports it, retries at the cap, and takes the slot back when the other reservation drops.
- Stop: "stopped mid-backoff" (no retry pending, nothing dials the relay when it appears, second stop is a no-op) and "stopped mid-drive" (the in-flight dial is aborted and unwinds well under the drive deadline).

# Known gaps and things worth a second look

- Startup and the slot-taken case interact: if relay discovery reserves on some other hop-serving peer before the first drive (only possible when the node is directly connected to a second relay server at start), the first drive gets `HadEnoughRelaysError` and node creation rejects, per the ticket's fail-fast rule. This combination is not tested through the factory; the slot-taken case is tested at supervisor level only. If a deployment ever bootstraps a relay-only node to two relay servers, this is where it bites.
- `clearRelayFilterEntry` is exercised only through the restart cases (where the store's own reset also runs, because a bare listener always has a pending slot). No spec poisons the filter and proves the explicit clear is what recovers, as Sereus's does. The seam spec pins that `relayFilter.remove` still exists.
- The "stopped mid-drive" case dials `192.0.2.1` (TEST-NET-1) and asserts the drive is still in flight 300 ms later. On a host that refuses such dials at once instead of letting them hang, that assertion fails; the abort it proves would then be untested rather than broken.
- The `peer:connect` trigger has no dedicated assertion; phase 5's 2 s recovery is the evidence it works.
- `docs/debugging.md` states a namespace count (46); the table rows are checked by `logger.spec.ts`, the count is not.
- The supervisor is not run on React Native or a browser here. It avoids `AbortSignal.timeout` and guards `unref`, but that is by construction, not by a run.
- Sereus is unaffected by design: it hands `db-p2p` only bare `/p2p-circuit` entries and runs its own supervisor over them; the plan leaves bare entries alone.

# Tripwires and accepted tradeoffs recorded in code

- `libp2p-node-base.ts` at `relayPlan`: the accepted tradeoff (relay discovery can reserve on a second connected relay server first) and the upgrade tripwire (circuit-relay-v2 4.2+ refreshes in place and re-applies a configured reservation; revisit dropping the rewrite when the libp2p line moves past `@libp2p/interface` 3.1).
- `relay-reservation.ts` at `findCircuitRelayTransport`: the one internals reach-through, with the installed versions and the 4.1.3 mechanics it depends on.
