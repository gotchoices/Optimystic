description: A node that no other machine can dial directly (no listen addresses, or only relay or loopback ones) is now built without libp2p's hole-punching service, which can never succeed for it and cost relayed messages on every join; an option lets the embedder force it on or off.
architecture: docs/internals.md#third-party-address-learning
files: packages/db-p2p/src/network/hole-punching.ts (new: `HolePunchingInputs`, `holePunchingWanted`), packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.holePunching`, the decision after `relayPlan`, the `dcutr` entry in the `services` map and its comment), packages/db-p2p/test/hole-punching-rule.spec.ts (new), packages/db-p2p/test/relay-only-pair-opens-no-dcutr-streams.spec.ts (new), packages/db-p2p/test/util/relay-topology.ts (`SpawnCircuitOnlyPeerOpts.holePunching`), packages/db-p2p/test/node-service-set.spec.ts (`EXPECTED_UNDIALABLE_SERVICE_KEYS`), packages/db-p2p/test/dcutr-direct-upgrade.spec.ts (header comment), docs/internals.md (§Third-Party Address Learning, last paragraph), docs/debugging.md (`node-wiring` row)
----
# A node no peer can dial directly is built without hole punching

Filed from sereus: two relay-only phones joining through one loopback relay spent 9 `/libp2p/dcutr` streams per join on hole-punching attempts that can never succeed. sereus's phones listen only on a bare `/p2p-circuit`, so a circuit-only listener counts as "no listen address".

## What was built

- **The rule — `holePunchingWanted` in `packages/db-p2p/src/network/hole-punching.ts`.** An explicit `holePunching` boolean wins. Otherwise the advertised set is `announceAddrs` when non-empty, else `listenAddrs` (after `planRelayListenAddrs` rewrote relay entries) plus `appendAnnounceAddrs`, mirroring libp2p. The service is wanted iff some address in that set has no `p2p-circuit` component and starts with `dns`/`dns4`/`dns6`/`dnsaddr`, or with `ip4`/`ip6` whose host is not loopback (`127.*`, `::1`). Wildcard and private LAN binds count as dialable. Anything else (`/memory`, `/unix`, an empty multiaddr) does not. An address that does not parse counts as dialable and logs `WARN: invalid multiaddr` under `node-wiring`. Components walked with `multiaddr(addr).getComponents()`; `@multiformats/multiaddr-matcher` is not imported (undeclared dep).
- **`NodeOptions.holePunching?: boolean`** — unset = automatic by the rule; `true` forces on; `false` forces off. Doc comment on the field.
- **Wiring in `createLibp2pNodeBase`** — decision computed right after `const listenAddrs = relayPlan.listenAddrs;`; `services` map uses `...(holePunching ? { dcutr: dcutr() } : {})`. The old "inert … neither throw nor break" comment is replaced with the rule, the reason (three relayed attempts per relayed connection), and a `NOTE: accepted tradeoff` that an automatic-off node loses the unilateral upgrade toward a public peer that reaches it through a relay (revisit condition stated; `holePunching: true` is the per-node remedy). AutoNAT is unchanged, with its own comment saying why it stays. When off, one `node-wiring` line: `hole punching off: NodeOptions.holePunching is false` or `hole punching off: no directly dialable listen or announce address`.
- **Docs** — one paragraph at the end of `docs/internals.md` §Third-Party Address Learning. The `node-wiring` row of `docs/debugging.md` names the two new lines (required by `test/logger.spec.ts`'s namespace guard; the rule module logs under `node-wiring` rather than a new namespace, since it runs only during construction).

## Tests

- `test/hole-punching-rule.spec.ts` — the 12-row table from the plan over `holePunchingWanted`: empty, bare circuit, relay-naming circuit, IPv4 and IPv6 loopback → off; wildcard, private LAN, loopback + DNS `announceAddrs` (reverse proxy), circuit + public `appendAnnounceAddrs` → on; forced on with `[]` → on; forced off with a wildcard → off; unparseable → on.
- `test/relay-only-pair-opens-no-dcutr-streams.spec.ts` — plain relay (`spawnPlainRelayNode`, not a party) and two `spawnCircuitOnlyPeer` peers. A `connection:open` listener on each peer wraps every connection's `newStream` and counts requested protocol lists containing `/libp2p/dcutr`. The joiner dials the founder's circuit address; both wait until each holds the other's `/optimystic/<net>/repo/1.0.0` (identify landed). Default case: 0 on both after a 3 s settle (~3.3 s). Forced-on case (`holePunching: true` on both): founder ≥ 1, polled with a 15 s bound (observed in ~0.2 s) — proves the counter sees dcutr streams and pins the override. Plain `yarn test`, not env-gated.
- `test/node-service-set.spec.ts` — updated, nothing added: browser-shaped and RN cases (`listenAddrs: []`) now assert the written-out `EXPECTED_UNDIALABLE_SERVICE_KEYS` (the full set minus `dcutr`); default TCP and `relay: true` cases unchanged.
- `test/dcutr-direct-upgrade.spec.ts` — header comment only: dcutr now present only on a node with a directly dialable address; the loopback smoke's peers run without it (it asserts only the relayed connection); the strong `DCUTR_HOST` case binds a non-private address and keeps it.

## Validation run

- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/db-p2p test` — 3520 passing, 73 pending, 0 failing.
- `RUN_LONG_TESTS=1` `dcutr-direct-upgrade.spec.ts` — the loopback smoke passes; the `RUN_DCUTR_HOLEPUNCH` + `DCUTR_HOST` case was **not** run (needs a non-private NIC address; it is unaffected by the rule since such a node keeps dcutr).
- `yarn lint`, `yarn lint:docs`, `yarn lint:deps` — clean.
- Not run: `yarn check:rn` (the new module imports only `@multiformats/multiaddr`, already used across db-p2p), `yarn test:integration`, other packages' suites (no other package references dcutr or the service set).

## For the reviewer — things worth a second look

- **The stream counter relies on dcutr receiving the same `Connection` object libp2p emits on `connection:open`.** The forced-on case is what proves this holds today; if a libp2p upgrade ever hands topology callbacks a different wrapper, the forced-on case fails (it would not silently pass), so the default case cannot become vacuous unnoticed.
- **IPv4-mapped IPv6 loopback** (`/ip6/::ffff:127.0.0.1/...`, which the parser writes as `::ffff:7f00:1`) is treated as dialable. Not in the plan's loopback set; an unusual bind. Left as is.
- **The rule reads configuration only, once, at construction.** Addresses a node learns at runtime (AutoNAT-observed, a UPnP mapping) are not considered, so e.g. `disableTcp: true` with no `wsPort` on the default factory (empty listen set) is built without dcutr even if it later learns a public address. That is the plan's design; no runtime address source of that kind is wired in this repo today.
