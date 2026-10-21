description: Stop building every node with libp2p's hole-punching service. A node that no other machine can connect to directly — no listen addresses, or only relay or loopback ones — leaves it out by default, because between two such nodes it can never succeed and costs relayed messages on every join; an option lets the embedder force it on or off.
architecture: docs/internals.md#third-party-address-learning
files: packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions`, the `dcutr: dcutr()` entry in the `services` map and the comment above it, `relayPlan`), packages/db-p2p/src/network/hole-punching.ts (new), packages/db-p2p/test/hole-punching-rule.spec.ts (new), packages/db-p2p/test/relay-only-pair-opens-no-dcutr-streams.spec.ts (new), packages/db-p2p/test/util/relay-topology.ts (`spawnCircuitOnlyPeer`, `SpawnCircuitOnlyPeerOpts`), packages/db-p2p/test/node-service-set.spec.ts (`EXPECTED_SERVICE_KEYS` and the browser-shaped / RN cases), packages/db-p2p/test/dcutr-direct-upgrade.spec.ts (header comment), docs/internals.md (§Third-Party Address Learning)
----
# A node no peer can dial directly is built without hole punching

Filed from sereus (`tickets/blocked/optimystic-dcutr-between-relay-only-peers` in the sereus repository). sereus `message-cost-accounting`, strand case (two relay-only parties through one loopback relay, Optimystic 1.17.0): 9 `/libp2p/dcutr` streams from the founder's strand node to the joiner's per join, none idle. sereus's phone nodes listen only on a bare `/p2p-circuit` (its "search" listener, `resolveListenAddrs` in sereus `packages/cadre-core/src/cadre-node.ts`), so the rule below must treat a circuit-only listener as "no listen address", not only an empty list.

## What `@libp2p/dcutr` actually does (3.0.28, `dist/src/dcutr.js` and `dist/src/utils.js`)

Settled from the installed source; the plan's choices rest on it.

- **Who opens streams.** On a relayed connection, only the side that *received* it (the "inbound" side, B) acts. Its registrar topology fires `onConnect` only when the remote peer's protocol list includes `/libp2p/dcutr` (that is, after identify, and only if the remote also runs dcutr). So a node without the service neither opens dcutr streams nor gets them opened at it: leaving it out on one side of a pair silences the pair.
- **Unilateral upgrade first.** B reads A's addresses from its peerStore and, if any passes `isPublicAndDialable` (not a circuit address, a transport can dial it, DNS or a non-private IP), dials A directly. No relayed stream is spent on this. Success closes the relayed connection.
- **Then the relayed exchange, three times.** If that fails, B loops `retries` (default 3) times: open a `/libp2p/dcutr` stream over the relayed connection, send `CONNECT` with its own `addressManager.getAddresses()`, read A's `CONNECT`; each side filters the other's list by `isPublicAndDialable` and throws if nothing survives. The loop's `if (i === this.retries) throw` can never fire, so all three attempts run silently. Three streams per relayed connection, matching sereus's 9 for three relayed connections per join.
- **Loopback-only listeners.** `isPublicAndDialable` rejects every private and loopback range, so a node whose only direct listeners are loopback offers the exchange nothing a remote can dial — the same position as a node with no listener. A loopback bind cannot accept from another machine, and no observed public address can be confirmed for it (AutoNAT dials back and finds nothing listening).
- **`/p2p-circuit`-only listeners.** Circuit addresses are filtered out first. A circuit-only node's `CONNECT` therefore carries nothing dialable, so the exchange fails whichever side it is on. The protocol order also blocks the one case that could work: when the circuit-only node is A and B has public addresses, B throws on A's empty list before it sends the `SYNC` that would make A dial B.

So for a node whose advertised addresses include nothing a remote machine could dial, the relayed exchange can never succeed. **The one thing such a node loses by dropping the service is the unilateral upgrade**: when a peer with a public address reaches it *through a relay*, the node, as B, would have dialed that peer directly. That is a real configuration (a public cadre-host dialing a phone by its circuit address), which is why the override below exists in the "on" direction. Two machines behind NAT that *do* listen on a wildcard or LAN address keep the service, so the case where hole punching can genuinely succeed is untouched.

## Design

### The rule — `holePunchingWanted` in `packages/db-p2p/src/network/hole-punching.ts`

```ts
export interface HolePunchingInputs {
	/** `NodeOptions.holePunching`: an explicit boolean wins outright. */
	holePunching?: boolean;
	/** The listen addresses libp2p is given — after `planRelayListenAddrs` rewrote relay entries. */
	listenAddrs: readonly string[];
	announceAddrs?: readonly string[];
	appendAnnounceAddrs?: readonly string[];
}

/** True when the node should run libp2p's `dcutr` service. */
export function holePunchingWanted(inputs: HolePunchingInputs): boolean;
```

- An explicit `holePunching` boolean is returned as is.
- Otherwise: the **advertised set** is `announceAddrs` when it is non-empty (it replaces the listen addresses, as libp2p does), else `listenAddrs` plus `appendAnnounceAddrs`. The service is wanted iff at least one address in that set is **directly dialable**:
  - not a circuit address (any `p2p-circuit` component — a bare `/p2p-circuit` and `<relay>/p2p/<id>/p2p-circuit` alike), and
  - its first component is `dns`, `dns4`, `dns6` or `dnsaddr`, or `ip4`/`ip6` with a host that is not loopback (`127.0.0.0/8`, `::1`). Wildcard (`0.0.0.0`, `::`) and private LAN binds count as dialable: they are how a NAT'd machine listens, and hole punching can succeed there.
  - Any other address (`/memory`, `/unix`, …) does not count — dcutr's own filter refuses those too.
- Walk components with `multiaddr(addr).getComponents()` and their `name`, as `routesThroughRelay` in `packages/db-p2p/src/peer-address-book.ts` does. `@multiformats/multiaddr-matcher` is not a declared dependency of db-p2p; do not import it (the undeclared-deps check in `yarn lint:deps` fails on it).
- An address that does not parse counts as dialable. That keeps today's behaviour; libp2p reports the malformed address itself at listen time. Do not throw: the rule runs after `resolveStorage` has taken the storage lease.

### `NodeOptions.holePunching?: boolean`

Doc comment says: unset → automatic, by the rule above; `true` forces the service on (a relay-only node that peers with public addresses regularly reach through a relay, where the unilateral upgrade pays); `false` forces it off. One tri-state field rather than two flags.

### Wiring in `createLibp2pNodeBase`

- Compute `const holePunching = holePunchingWanted({ holePunching: options.holePunching, listenAddrs, announceAddrs: options.announceAddrs, appendAnnounceAddrs: options.appendAnnounceAddrs })` right after `const listenAddrs = relayPlan.listenAddrs;`.
- In the `services` map replace `dcutr: dcutr(),` with `...(holePunching ? { dcutr: dcutr() } : {}),`, the same shape as the `relay` entry.
- Replace the comment above it. The current text ("inert where the transport can't hole-punch … they neither throw nor break") is wrong for relay-only pairs: say what the rule is, why (the three relayed attempts per connection described above), the `NOTE: accepted tradeoff` that an automatic-off node loses the unilateral upgrade when a public peer reaches it through a relay (revisit: if relay-only nodes are found staying on relayed links to public peers that could have been direct; `holePunching: true` is the per-node remedy), and that AutoNAT stays (see Out of scope). Keep the AutoNAT half of the comment accurate.
- Log the decision once through `wiringLog` when it is off, naming whether it was the option or the rule (e.g. `hole punching off: no directly dialable listen or announce address`), so an operator reading start-up logs can tell.

### Docs

One paragraph at the end of `docs/internals.md` §Third-Party Address Learning (it is the section about relay-only nodes): a node whose advertised addresses include nothing a remote machine can dial is built without `dcutr`; why; what it loses; `NodeOptions.holePunching` overrides. Cite `holePunchingWanted` in `packages/db-p2p/src/network/hole-punching.ts`. Run `yarn lint:docs`.

## Tests

- **`test/relay-only-pair-opens-no-dcutr-streams.spec.ts` — the test the gardener asked for.** One relay (`spawnPlainRelayNode` or `spawnRelayNode` from `test/util/relay-topology.ts`; the relay is not a party) and two peers from `spawnCircuitOnlyPeer` (WebSockets + circuit transport, listening only on `<relay>/p2p-circuit`). Count streams the way sereus's `message-cost-accounting` does: on each peer, a `connection:open` listener attached before the dial wraps that connection's `newStream` and counts every *requested* protocol list containing `/libp2p/dcutr`, whether or not negotiation succeeds. The joiner dials the founder's circuit address (`waitForCircuitListen`), both sides wait for identify (`test/util/peer-store-wait.ts`), then a settle window of a few seconds (dcutr acts immediately on identify and its three attempts are back to back, so no long wait is needed). Two cases:
  - neither peer sets `holePunching` → **0** dcutr streams on both peers.
  - both peers set `holePunching: true` → the founder (the side that received the relayed connection) requests **at least 1** — poll until seen, bounded, not a fixed wait. This proves the counter is not blind, and pins the override.
  Extend `SpawnCircuitOnlyPeerOpts` with `holePunching?: boolean`, passed through. Runs in plain `yarn test` like the other loopback relay specs; it is not a timeout control.
- **`test/hole-punching-rule.spec.ts`** — one table over `holePunchingWanted`, because the rule branches: `[]` → false; `['/p2p-circuit']` → false; `['<relay>/p2p/<id>/p2p-circuit']` → false; `['/ip4/127.0.0.1/tcp/0']` → false; `['/ip6/::1/tcp/0/ws']` → false; `['/ip4/0.0.0.0/tcp/0']` → true; `['/ip4/192.168.1.5/tcp/4001']` → true; loopback listener with `announceAddrs: ['/dns4/example.com/tcp/443/wss']` (a reverse proxy) → true; `['/p2p-circuit']` with `appendAnnounceAddrs: ['/ip4/203.0.113.7/tcp/4001']` → true; `holePunching: true` with `[]` → true; `holePunching: false` with `['/ip4/0.0.0.0/tcp/0']` → false; an unparseable address → true.
- **`test/node-service-set.spec.ts`** — update, don't add. The browser-shaped and RN cases pass `listenAddrs: []`, so they now register every expected key except `dcutr`: assert against `EXPECTED_SERVICE_KEYS` minus `dcutr` (written out, per the spec's own "never derive" rule) and say why in the doc comment above the literal. The default TCP node (`/ip4/0.0.0.0/tcp/0`) and the `relay: true` node keep `dcutr`.
- **`test/dcutr-direct-upgrade.spec.ts`** — its loopback smoke case (gated `RUN_LONG_TESTS`) builds TCP peers on `127.0.0.1` plus a circuit listener; they now run without dcutr. That case asserts only that a relayed connection exists, so it still holds; update its header comment ("The always-run `node-service-set.spec.ts` independently guards that `services.dcutr` … are wired") to say dcutr is present only on a node with a directly dialable address, and that the strong `DCUTR_HOST` case binds a non-private address and so keeps it. Not runnable here without `RUN_LONG_TESTS=1`; say in the handoff whether you ran it.

## Edge cases & interactions

- **Relay entries in `listenAddrs`.** `planRelayListenAddrs` rewrites `<relay>/p2p/<id>/p2p-circuit` into a bare `/p2p-circuit`; feed the rule the rewritten list. Both shapes are circuit addresses, so the answer is the same either way — verified by the rule table.
- **`announceAddrs` replaces, `appendAnnounceAddrs` is ignored when `announceAddrs` is non-empty** — mirror libp2p and the `NodeOptions` doc comments exactly. Verified by the reverse-proxy row of the table.
- **A relay-only node combined with `announceAddrs`** is refused at start by `assertRelayAddrsAdvertisable`, which runs before the rule; nothing to handle. By inspection.
- **One side with dcutr, one without** (mixed versions, or one node forced on). Since the topology fires only when the remote advertises `/libp2p/dcutr`, a pair where either side lacks it opens no dcutr streams. A forced-on relay-only node still gets the unilateral upgrade toward a public peer that runs dcutr. By inspection of the source cited above.
- **Mixed-version network.** An upgraded relay-only node simply stops advertising `/libp2p/dcutr`; older peers then never start an exchange with it. No wire change, no version gate. By inspection.
- **`identify` dependency.** dcutr declares `@libp2p/identify` as a service dependency; removing dcutr removes nothing identify needs. AutoNAT is untouched. The service-set spec covers the resulting key sets.
- **Prepared streams / limited connections.** `prepared-streams.ts` and `open-protocol-stream.ts` mention "after a DCUtR upgrade"; on a node without dcutr that upgrade never happens, which those paths already handle (a relayed connection that stays relayed). By inspection; no change.
- **Teardown.** The service is absent, so there is nothing to stop. By inspection.

## Out of scope

- AutoNAT on a relay-only node is equally unable to confirm anything (nothing to dial back), but sereus measured no AutoNAT streams on the strand, so it stays. Not filed: no measured cost. If a measurement ever shows `/libp2p/autonat` streams from relay-only nodes, the same rule can gate it.
- Keeping the unilateral upgrade while dropping only the futile relayed exchange (e.g. `dcutr({ retries: 0 })`, which skips the loop but still advertises the protocol, so a listening peer still spends three relayed attempts on a relay-only node that dialed it through a relay) was considered and rejected: it fixes the strand case but not the phone ↔ NAT'd-home-server case, and the override covers the unilateral loss where it matters.

## TODO

- Add `packages/db-p2p/src/network/hole-punching.ts` with `HolePunchingInputs` and `holePunchingWanted`.
- Add `holePunching?: boolean` to `NodeOptions` with its doc comment.
- Wire the decision into the `services` map of `createLibp2pNodeBase`, rewrite the comment above it with the accepted-tradeoff `NOTE:`, and log the off decision.
- Add `test/hole-punching-rule.spec.ts` (the table above).
- Extend `spawnCircuitOnlyPeer` with `holePunching`, and add `test/relay-only-pair-opens-no-dcutr-streams.spec.ts` (zero streams by default; at least one with `holePunching: true`).
- Update `test/node-service-set.spec.ts` for the browser-shaped and RN cases, and the header of `test/dcutr-direct-upgrade.spec.ts`.
- Add the paragraph to `docs/internals.md` §Third-Party Address Learning.
- Build db-p2p, then run `yarn workspace @optimystic/db-p2p test`, `yarn lint`, `yarn lint:docs` and `yarn lint:deps` from the root.
