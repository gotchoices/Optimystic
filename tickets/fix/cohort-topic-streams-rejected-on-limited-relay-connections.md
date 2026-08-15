----
description: Cohort-topic messages cannot travel over a relayed connection at all, because the stream helpers forget to opt in to limited connections — so any member reachable only through a relay is cut off from that whole subsystem.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/libp2p-key-network.ts
repro: static — inferred from code; confirm with a unit test dialing a cohort-topic protocol across a circuit-relay-v2 connection (libp2p rejects streams on limited connections unless `runOnLimitedConnection` is set).
difficulty: easy
----
libp2p refuses to open a protocol stream over a *limited* (circuit-relay) connection unless the caller passes `runOnLimitedConnection: true`. Every other dial path in this repo sets it — `libp2p-key-network.ts:542-546` and `:552` set it on both the `newStream` and `dialProtocol` paths, and FRET's `protocols.ts` does the same — but the cohort-topic stream helpers do not:

- `cohort-topic/stream-util.ts:28` — `node.dialProtocol(peer, [protocol])` (used by `requestResponse`)
- `cohort-topic/stream-util.ts:48` — same shape in `sendOneWay`

Callers affected: `topic-router.ts:75` (`dialMember`), `cohort-gossip-transport.ts:56`, `membership-source.ts:52`, `host.ts:659` (`dialSign`).

Consequence: a cohort member whose only connection is through a relay (NAT'd mobile peer — the normal case motivating gotchoices/Optimystic#11) can hold a perfectly good relayed connection and still be unreachable for every cohort-topic exchange, because libp2p rejects the stream on the limited connection.

Fix: pass `runOnLimitedConnection: true` in both helpers (mirror `libp2p-key-network.ts:542-552`). Consider a lint or shared stream-options constant so the next dial site cannot forget it.

Found during the investigation of gotchoices/Optimystic#11; independent of (and not sufficient for) the address-propagation fix in `fix/relay-only-cohort-member-addresses-never-reach-siblings` — this one bites even when the dialer *has* the relayed address.
