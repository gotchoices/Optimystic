description: A node that no other machine can dial directly (no listen addresses, or only relay or loopback ones) is now built without libp2p's hole-punching service, which can never succeed for it and cost relayed messages on every join; an option lets the embedder force it on or off.
architecture: docs/internals.md#third-party-address-learning
files: packages/db-p2p/src/network/hole-punching.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/hole-punching-rule.spec.ts, packages/db-p2p/test/relay-only-pair-opens-no-dcutr-streams.spec.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/test/node-service-set.spec.ts, packages/db-p2p/test/dcutr-direct-upgrade.spec.ts, docs/internals.md, docs/debugging.md, packages/db-p2p/docs/repo.md
----
# A node no peer can dial directly is built without hole punching

Filed from sereus: two relay-only phones joining through one loopback relay spent 9 `/libp2p/dcutr` streams per join on hole-punching attempts that can never succeed.

## What landed

- `holePunchingWanted` in `packages/db-p2p/src/network/hole-punching.ts`: an explicit `NodeOptions.holePunching` boolean wins. Otherwise the node runs `dcutr` only when its advertised set (`announceAddrs` when non-empty, else listen addresses after relay planning plus `appendAnnounceAddrs`) contains an address with no `p2p-circuit` component whose host is a DNS name or a non-loopback IP. Wildcard and LAN binds count as dialable. An address that does not parse counts as dialable and is logged.
- `createLibp2pNodeBase` registers `dcutr` only when the rule says so, and logs one `node-wiring` line when it is off. An accepted-tradeoff `NOTE:` at the services map records what an automatic-off node gives up: the direct dial toward a public peer that reaches it through a relay. AutoNAT is unchanged.
- Docs: `docs/internals.md` §Third-Party Address Learning, the `node-wiring` row of `docs/debugging.md`, and (in review) `packages/db-p2p/docs/repo.md`.

## Review findings

Read `ticket(implement): feat-a-node-without-listen-addresses-leaves-out-hole-punching` first, then the handoff.

- **The rule against libp2p's real behavior — checked, correct.** Read `libp2p/dist/src/address-manager/index.js`: a non-empty announce list is returned alone, and append-announce addresses are added only otherwise, which is what `advertisedAddrs` mirrors. Read `@libp2p/dcutr/dist/src/dcutr.js`: the topology's `onConnect` fires only toward a peer advertising dcutr, and the receiving (inbound) side starts the exchange. That matches the claim that leaving the service out on one side silences the pair.
- **Defaults — checked.** The default factory listens on `/ip4/0.0.0.0/tcp/<port>` (keeps dcutr). The RN factory defaults `listenAddrs: []` (drops it, which is what sereus wanted). The `disableTcp` + no `wsPort` case that drops it is described in the handoff and follows from the planned design.
- **Stale doc — fixed.** `packages/db-p2p/docs/repo.md` listed `/libp2p/dcutr` among the protocols every node advertises. It now says this holds only on a node with a directly dialable address, and cites `holePunchingWanted`.
- **Tests — checked, kept as written.** The 12-row table pins named behavior with real branching (announce-replaces, append, loopback, circuit, DNS, override, unparseable). The two-peer stream count is a real end-to-end check, and its forced-on case keeps the default case from passing without checking anything. `node-service-set.spec.ts` covers the drop branch through real factories. Nothing restates the implementation or verifies a mock, so nothing was cut. No test was added: no defect was found.
- **IPv4-mapped IPv6 loopback (`::ffff:7f00:1`) counts as dialable** — an unusual bind; it only keeps dcutr, which is the behavior from before this change. No action.
- **Runtime-learned addresses (AutoNAT, UPnP) are not considered.** The rule reads configuration once, at construction. That is the planned design, and nothing in this repository wires such a source today. Already covered by the accepted-tradeoff `NOTE:` and its revisit condition, so no ticket.
- **Error handling — checked.** A multiaddr that does not parse is logged (`WARN: invalid multiaddr`), not swallowed, and libp2p refuses it at listen anyway.
- **Source hygiene.** `libp2p-node-base.ts` is 2618 lines (`wc -l`), and this ticket added about 30. Splitting the factory is already tracked by backlog `debt-node-factory-wiring-steps-own-their-teardown`, so no new ticket. The services-map comment explains why and records the tradeoff; it does not narrate the code.
- **Type safety / resource cleanup:** no `any`. The test's `afterEach` stops all three nodes. No findings.
- **Tripwires / new tickets:** none.

## Validation (review pass)

- `yarn workspace @optimystic/db-p2p build`: clean.
- `hole-punching-rule.spec.ts`, `relay-only-pair-opens-no-dcutr-streams.spec.ts`, `node-service-set.spec.ts` and `logger.spec.ts` (the namespace guard): 48 passing.
- `yarn lint` and `yarn lint:docs`: clean.
- Not re-run in review: the full db-p2p suite. The implementer ran it (3520 passing, 0 failing), and review changed only a markdown file. Also not re-run: the env-gated `DCUTR_HOST` hole-punch case, which needs a non-private NIC address.
