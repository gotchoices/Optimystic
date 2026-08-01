description: The example peer program has no command-line option for telling other peers a public address that differs from the one it binds, so the documented "run it behind a TLS proxy" setup can't actually be completed with it.
files: packages/reference-peer/src/cli.ts, packages/reference-peer/README.md, packages/db-p2p/src/libp2p-node-base.ts
difficulty: easy
----

# `optimystic-peer` needs an announce-address flag

## Gap

`packages/db-p2p` now accepts `announceAddrs` / `appendAnnounceAddrs` on `createLibp2pNode`, so a
node that binds `0.0.0.0:9091` can advertise `/dns4/bootstrap.example.com/tcp/443/wss` instead. The
reference-peer CLI never sets either: its option list (`packages/reference-peer/src/cli.ts`, the
`.option(...)` block around line 755) has `--port`, `--ws-port`, `--ws-host`, `--no-tcp`, `--relay`,
but nothing for announcing, and the `createLibp2pNode({ ... })` call at line 374 passes no announce
field.

## Why it matters

The README's own "Browser Bootstrap (WebSocket / WSS)" recipe
(`packages/reference-peer/README.md`, lines 65-94) tells the operator to run the peer behind a Caddy
TLS terminator and hand browsers `/dns4/bootstrap.example.com/tcp/443/wss/p2p/<PEER_ID>`. That
hand-copied dial string works, but the peer itself still tells the network it lives at
`/ip4/0.0.0.0/tcp/9091/ws` — the address it bound. Everything downstream of the peer's own
advertisement therefore carries the unreachable address: what other peers learn about it through
identify, and the base address browsers receive in circuit-relay reservations. The recipe is
completable from the library API but not from the CLI the recipe is written around.

## Expected behavior

A flag (e.g. `--announce-addr <multiaddr>`, repeatable) that forwards to `announceAddrs`, and
probably a second (`--append-announce-addr`) for the additive form, since a bootstrap that also
serves local TCP peers wants its bound addresses kept. Running the README recipe with the flag set
should make `node.getMultiaddrs()` — and hence the peer's identify view at any other node — report
the public `wss` address.

Once it exists, the README recipe should say to use it; today it cannot.

## Not in scope

libp2p also has `noAnnounce` (suppress one specific address) and `announceFilter`. Neither is
exposed on `NodeOptions` either; no consumer has asked for them.
