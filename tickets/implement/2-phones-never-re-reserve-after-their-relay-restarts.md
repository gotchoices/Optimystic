description: A phone or browser reaches its group only through a relay server, and it silently loses its slot on that relay (becoming unreachable until the app restarts) whenever the relay restarts, the connection to it drops, or the slot comes up for routine renewal. Make the node keep that slot itself.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`createLibp2pNodeBase`: resolve `listenAddrs` around line 490, `await node.start()` around line 782, and the post-start `try` whose `catch` rolls a failed startup back; add the listen-address rewrite, start the supervisor, install its stop wrapper)
  - packages/db-p2p/src/network/relay-reservation.ts (new; the rewrite, the per-relay supervisor, and the one function that reaches libp2p internals)
  - packages/db-p2p/src/peer-address-book.ts (`routesThroughRelay`: reuse it for "is our circuit address through relay X still advertised")
  - packages/db-p2p/test/two-phones-over-relay.integration.spec.ts (phase 5 is the acceptance test; do not change its assertions, its 30 s budget, or add a re-listen step)
  - packages/db-p2p/test/util/relay-topology.ts (`spawnRestartablePlainRelay`, `spawnPlainRelayNode`; the new behavioural spec needs a relay with a short `reservationTtl`, so add an option)
  - packages/db-p2p/test/startup-rollback.spec.ts (pattern for asserting a failed startup stops everything it started)
  - docs/architecture.md (§ Supported deployment sizes: remove the "known gap" sentences)
  - docs/optimystic.md (§ Deployment Targets, "Relay restarts (mobile and browser)": rewrite to say what the node now does)
  - ../sereus/packages/cadre-core/src/relay-reservation.ts and ../sereus/packages/cadre-core/test/relay-reservation.spec.ts (prior art in the sibling repository; adapt, do not import)
difficulty: hard
repro: verified
----

# What is wrong

A node that can only be reached through a relay listens on `<relay address>/p2p/<relay id>/p2p-circuit`. This is the only shape a phone or browser can take. Libp2p calls it a "configured" relay listen address. At start, libp2p dials that relay and reserves a slot on it. While the slot is held, the node advertises a circuit address (`<relay>/p2p-circuit/p2p/<node>`) that other peers can dial. Once the slot is gone, nothing asks for it again, and the node stays unreachable until the app restarts.

There are three ways to lose the slot, all verified against the installed `@libp2p/circuit-relay-v2` 4.1.3:

1. **The relay restarts.** Phase 5 of `packages/db-p2p/test/two-phones-over-relay.integration.spec.ts` fails every run. Each phone reconnects to the restarted relay within about 0.5 s, but no phone ever holds a circuit address again. Run it from `packages/db-p2p` with `OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js test/two-phones-over-relay.integration.spec.ts --reporter spec`.
2. **The connection to the relay drops** while the relay stays up. This takes the same code path as a restart: the reservation store's `connection:close` handler removes the reservation.
3. **The routine renewal of the slot.** The client renews ("refreshes") a reservation 5 minutes before it expires, or 30 s after it was made if it lives less than 5 minutes. On 4.1.3 the refresh removes the reservation, which withdraws the address, and then re-creates it. A configured listener ignores the re-creation, so the address never comes back even though the store holds a valid reservation. At the relay's default reservation lifetime of 2 hours, every configured-shape node becomes unreachable about 1 h 55 min after it reserved, with no network event at all.

A throwaway experiment in this tree (plain libp2p nodes over loopback WebSockets, relay `reservationTtl: 40_000`, now deleted) measured all of this:

```
+0.1s  configured held at start: true | bare-listener phone held after explicit 'discovered' addRelay: true
+30.1s configured circuit address LOST (store hasReservation=true)
+38.3s after the 30 s refresh: configured held false hasReservation true | bare held true hasReservation true
+38.3s relay stopped; both lose address: true
+41.3s with no help after 3 s: configured held false | bare held false
+41.3s bare: dial relay + 'discovered' addRelay resolved; address back within 3 s: true
+44.4s configured: dial relay + 'configured' addRelay resolved; hasReservation=true; address back within 3 s: false
```

The last line matters: on 4.1.3, asking again for a *configured* reservation gets the slot but never republishes the address. Re-requesting cannot fix the configured shape. The ticket's earlier experiment, calling transport-manager `listen` again on `<relay>/p2p-circuit`, works for the restart case. It is a no-op in the refresh case, because `listen` skips reserving when `hasReservation` is already true, and every call also leaves an extra listener behind.

# Root cause, in `@libp2p/circuit-relay-v2` 4.1.3

Source is at `packages/db-p2p/node_modules/@libp2p/circuit-relay-v2/src/transport/`.

- `listener.ts`: `listen()` on a configured address reserves once and calls `addedRelay`. The `relay:created-reservation` handler returns early for `type === 'configured'`, so a reservation made any other way is never published. `relay:removed` clears the addresses and nothing re-listens.
- `reservation-store.ts`:
  - `#removeReservation` re-queues a pending slot only for `discovered` reservations, which is the kind a bare `/p2p-circuit` listener asks for.
  - The refresh path in `addRelay` calls `#removeReservation` before re-reserving.
  - A failed request with `DialError` or `UnsupportedProtocolError` adds the relay to the private `relayFilter`, and later requests are refused with "The relay was previously invalid". The filter is reset only when a reservation is removed while pending slots exist, and a node that uses only configured addresses has none.
- A bare `/p2p-circuit` listener, which libp2p calls "search" mode, behaves differently. It registers a pending slot id and publishes any `discovered` reservation carrying that id. A refresh re-queues the id and the re-created reservation takes it back, so the address returns. After a loss, anything that calls `reservationStore.addRelay(relayId, 'discovered')` brings the address back.

# Why not just upgrade

Upstream 4.2.13 fixes the refresh case for both shapes: a still-connected reservation is refreshed in place, and a configured listener re-applies a refreshed reservation for its own relay. It does **not** fix the restart or dropped-connection cases, because a configured reservation is still dropped on `connection:close` and nothing re-requests it. 4.2.13 also requires `@libp2p/interface ^3.3.0`, while this repo deliberately keeps libp2p core on 3.1.x (`scripts/shared-majors.cjs`, and the accepted-tradeoff note on the `services` cast in `libp2p-node-base.ts`). Bumping circuit-relay-v2 alone would add a third interface minor with different transitive majors, which is the failure class that guard exists for. So the fix has to work on 4.1.3. Leave a `NOTE:` tripwire (see below) for when the libp2p line moves.

# Design

## Where: the node factory

The fix goes in `createLibp2pNodeBase`, so every host of `@optimystic/db-p2p` gets it, whether React Native, NativeScript, browser, or Node. The alternative, documenting that hosts must supervise, is what Sereus already does, and it leaves every other host broken.

## Rewrite relay-naming circuit listen addresses into bare ones

Once `listenAddrs` is resolved (`options.listenAddrs ?? defaults.listenAddrs`), split it:

- A **relay-naming circuit listen address** has exactly one `p2p-circuit` component, as its last component, with a `p2p` component (the relay's peer id) immediately before it. For each one:
  - Record a supervised relay: its **dial address** is the entry without the trailing `/p2p-circuit`, and its **peer id** is that `p2p` value, normalized with `peerIdFromString(...).toString()`.
  - Hand libp2p a bare `/p2p-circuit` entry in its place, one per relay. libp2p keeps listen addresses as a plain array with no de-duplication (`libp2p/src/address-manager/index.ts`, `this.listen: string[]`), so N bare entries give N listeners and N pending slots.
- A bare `/p2p-circuit` entry the host passed itself is left alone and **not** supervised; the host owns that reservation (this is Sereus's shape, see below). Every other entry passes through unchanged.
- De-duplicate supervised relays by peer id, so two addresses for one relay get one slot and one supervisor.

The published circuit address has the same shape either way: libp2p builds it from the relay's reservation response. Only `addressManager.getListenAddrs()` changes, from `<relay>/p2p-circuit` to `/p2p-circuit`.

## One supervisor per relay

It follows the shape of Sereus's `superviseRelayReservation` and `driveRelayReservation`, reduced to what this node needs.

- **Held check:** some address in `node.getMultiaddrs()` routes through this relay, using `routesThroughRelay(addr, relayPeerId, log)` from `peer-address-book.ts`. The check is per relay, so one relay's slot never satisfies another relay's supervisor.
- **One drive** (fail-soft: never throws, returns a reason string on failure), under one shared deadline of about 10 s:
  1. Clear this relay's entry from `reservationStore.relayFilter` if `remove` exists.
  2. `node.dial(relayDialAddr, { signal })`, using an explicit `AbortController` (not `AbortSignal.timeout`, which is unreliable on Hermes) that the supervisor also aborts on stop.
  3. `reservationStore.addRelay(relayPeerId, 'discovered')`, raced against the deadline because `addRelay` takes no signal.
  4. Wait until the held check passes; `addRelay` resolves a tick before the listener publishes.

  `'discovered'`, not `'configured'`: only `discovered` reservations are published by a bare listener (see the experiment). A concurrent `addRelay` for the same relay from libp2p's own discovery joins the same queue job, so there is no double reservation.
- **Triggers:**
  - The first drive right after `node.start()`.
  - libp2p's public `self:peer:update` event, which fires when the listener withdraws or adds addresses: re-check and, if the slot is lost, drive now.
  - libp2p's public `peer:connect` event for this relay's peer id: if not held, drive now and reset the backoff. In phase 5 the phones' dials to each other reconnect the relay within about 0.5 s, and this turns that into an immediate re-reserve.
  - A liveness poll every 5 s while held, as a fallback in case an event is missed.
  - After a failed drive, retry on a backoff that starts at 1 s and doubles to a 30 s cap. The cap bounds recovery time after a long outage, because nothing else reconnects a lone phone to its relay. A WebSocket dial every 30 s during an outage is cheap.

  Make the timings constructor options so specs can shrink them. Serialize drives per relay: a trigger that arrives during a drive only marks "re-check when done".
- **`HadEnoughRelaysError`** from `addRelay` means relay discovery already filled this relay's pending slot with a reservation on a *different* relay (see the side effect below). Log it once and keep backing off at the cap. It recovers on its own if that other reservation drops.

## Startup behaviour stays as it is today

Today `node.start()` rejects when a configured relay cannot be reserved: libp2p's transport manager defaults to `FaultTolerance.FATAL_ALL`, and a configured listener's `listen()` throws. A bare listener never throws, so keep that contract explicitly:

1. Start the supervisors as the first step inside the post-start `try`.
2. Install their stop wrapper immediately, before awaiting anything, so the rollback `catch` stops them.
3. Await every relay's first drive.
4. If any first drive fails, throw an `Error` naming the relay's dial address and the reason. The existing rollback then stops the node.

A host that would rather start offline and let the supervisor recover is a separate decision; do not add that option in this ticket.

## Stopping

The node's stop path must stop every supervisor before libp2p stops: the usual `const previousStop = node.stop.bind(node); node.stop = async () => { try { stopSupervisors(); } finally { await previousStop(); } }` wrapper.

`stop()` must:
- be idempotent;
- clear pending timers and remove both event listeners;
- abort an in-flight dial;
- discard the result of an in-flight `addRelay` without starting anything after it.

`unref()` every timer where it exists, via `(timer as { unref?: () => void }).unref?.()`; browsers and React Native have none. A pending timer must not keep a stopped Node process alive. This is the same class of bug `withTimeout` in `packages/db-p2p/src/cluster/block-transfer.ts` was fixed for. The backlog ticket `debt-node-factory-wiring-steps-own-their-teardown` may later fold this wrapper into a shared mechanism; follow today's pattern until then.

## Reaching libp2p internals, and pinning them

There is no public libp2p route: the `Libp2p` interface has no `listen`, and nothing public exposes the reservation store. Put the only internals access in **one** function in `relay-reservation.ts`. It reads `(node as { components?: { transportManager?: { getTransports?(): unknown[] } } }).components.transportManager.getTransports()` and duck-types the transport whose `reservationStore` has `addRelay` and `hasReservation`, plus an optional `relayFilter.remove`. It returns `null` instead of throwing. `node.components` is a real public field on libp2p 3.1.3's node class, just not on the interface. Header it with a `NOTE:` naming the installed versions.

If no circuit-relay transport is found while supervised relays exist, fail startup with a legible message: "listen address names a relay but the node has no circuit-relay transport — add circuitRelayTransport() to transports". Today libp2p fails that case too, with an unsupported-listen-address error.

Pin the seam with a fast spec against a real started libp2p node: the transport exists, `addRelay`, `hasReservation` and `relayFilter.remove` are functions, and a bare listener plus `'discovered'` `addRelay` publishes a circuit address over a loopback relay. It must fail loudly if a libp2p upgrade moves any of this.

## Known side effect: relay discovery (record as an accepted tradeoff)

A bare listener's pending slot also turns on libp2p's `RelayDiscovery`. With no peer routing configured, its random walk errors once and ends, which is harmless. Its topology handler, though, can reserve on **any** connected peer that serves the relay hop protocol, and that reservation takes the pending slot meant for the named relay. Every Optimystic node started with `relay: true` serves hop. The node then stays reachable, but through that other relay, so a partner that enrolled its circuit address through the named relay cannot dial it until that reservation drops. This happens only when a relay-only node is directly connected to a second relay server. Sereus runs with the same behaviour.

Record it as a `NOTE: accepted tradeoff` at the rewrite site. The revisit condition is a deployment that connects relay-only nodes to more than one relay server, or the libp2p upgrade below.

## Tripwire for the libp2p upgrade

At the rewrite site add: `NOTE: circuit-relay-v2 >= 4.2 (needs @libp2p/interface ^3.3) refreshes reservations in place and re-applies a configured reservation for its own relay; when the libp2p line moves, revisit keeping the host's configured address and re-requesting with 'configured', which drops the rewrite and the discovery side effect.`

## Sereus

Sereus hands `db-p2p` only bare `/p2p-circuit` listen addresses and runs its own supervisor over them (`../sereus/packages/cadre-core/src/relay-reservation.ts` header: "The configured shape ... is gone from cadre-built nodes entirely"). This node supervises only relay-naming addresses, so nothing gets driven twice and no Sereus change is required. Sereus defers its relay dial until its control database is up, so it keeps its own supervisor even after this lands.

# Tests

- **Rewrite unit spec (fast):**
  - a relay-naming address becomes a bare entry plus a supervised relay;
  - a host's bare `/p2p-circuit` passes through unsupervised;
  - TCP and WebSocket entries are untouched;
  - two relays give two bare entries;
  - two addresses naming one relay give one entry;
  - a CID-form relay id is normalized;
  - a malformed or multi-hop circuit address is left for libp2p to reject.
- **Seam pin spec (fast):** see above.
- **Supervisor behavioural spec** over loopback. Use nodes built with `createLibp2pNode` in the relay-only shape (`spawnCircuitOnlyPeer`) against a restartable plain relay started with a short `reservationTtl`, and give `spawnPlainRelayNode` a `reservationTtl` option.
  - **Refresh:** with a 40 s lifetime the client refreshes at 30 s. The circuit address must be present at every sample (about every 250 ms) from reservation through 38 s. This case takes about 40 s, so gate it like `circuit-relay-long-lived.spec.ts` (`RUN_LONG_TESTS`) or name it `*.integration.spec.ts`; the choice is yours, but say which in the handoff.
  - **Restart with no partner:** a lone relay-only node, relay stopped and started under the same key and address. The address is back within the backoff cap plus a few seconds, with nothing but the supervisor dialing the relay. This is stricter than phase 5.
  - **Drop while the relay stays up:** the relay hangs up on the node (`relay.hangUp(node.peerId)`), and the address comes back.
  - **Stop:** after `node.stop()`, nothing dials the relay again (for example, count relay-side `peer:connect` events for the stopped node's id across a window longer than the cap), and a supervisor stopped mid-backoff leaves no pending timer.
  - **Startup:**
    - an unreachable relay still makes `createLibp2pNode` reject, naming the relay;
    - a missing circuit transport still rejects;
    - the rollback leaves nothing running (follow `startup-rollback.spec.ts`).
- **Acceptance:** phase 5 of `two-phones-over-relay.integration.spec.ts`, unchanged, plus phases 1 to 4 still passing.
- **Regression:** these existing specs build relay-only or circuit-listening peers through `createLibp2pNode`, so run them: `relay-third-party-address-gap`, `relay-inbound-source-address`, `relay-self-relay-only-dial`, `open-protocol-stream-relay`, `dcutr-direct-upgrade` (its `listenOnCircuit` peer), `multi-coordinator-write-relay.integration`, and the long-lived circuit spec if you can afford it. `relay-address-propagation.spec.ts` builds its client with plain `createLibp2p`, so it does not exercise the rewrite. Also run the full `yarn workspace @optimystic/db-p2p test` and the db-p2p type check.

# Docs

- `docs/architecture.md` § Supported deployment sizes: replace "That last step is a known gap today: ... a host without one does not recover." with one sentence saying the node keeps its relay reservation itself.
- `docs/optimystic.md` "Relay restarts (mobile and browser)": replace the paragraph. A node given `<relay>/p2p-circuit` keeps that reservation across relay restarts, dropped connections and the routine renewal, re-reserving within the retry cap. A host that listens on a bare `/p2p-circuit` itself owns that reservation. Mention the discovery side effect in one sentence.
- Check `packages/db-p2p/readme.md`'s React Native and browser sections for any claim that contradicts this.

# TODO

- Add `packages/db-p2p/src/network/relay-reservation.ts` containing:
  - the listen-address split;
  - the single libp2p-internals accessor with its `NOTE:`;
  - the per-relay supervisor with its triggers, backoff, fail-soft drive, `relayFilter` clearing, `HadEnoughRelaysError` handling, and idempotent unref'd stop.
- In `createLibp2pNodeBase`:
  - rewrite `listenAddrs` before building `libp2pOptions`, with the accepted-tradeoff `NOTE:` and the upgrade tripwire `NOTE:` at that site;
  - start the supervisors first inside the post-start `try`;
  - install the stop wrapper immediately;
  - await the first drives and throw a legible error on failure.
- Add a `reservationTtl` option to `spawnPlainRelayNode` and `spawnRestartablePlainRelay` in `test/util/relay-topology.ts`.
- Write the rewrite unit spec, the seam pin spec, and the supervisor behavioural spec (refresh, restart with no partner, drop, stop, startup failures).
- Run phase 5 of `two-phones-over-relay.integration.spec.ts` unchanged until it passes. Then run all its phases, the regression specs listed above, the full db-p2p test suite, and the type check.
- Update `docs/architecture.md` and `docs/optimystic.md` as described, and check the db-p2p readme.
- In the review handoff, state: the timings chosen; how the refresh spec is gated; that the startup fail-fast contract was kept; and any regression spec you could not run.
