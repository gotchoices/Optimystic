description: Every node is built with libp2p's direct-connection upgrade (`dcutr`), which on two relay-only peers (phones with no listen addresses, WebSockets through a relay) is negotiated over the relayed circuit and cannot succeed, costing about 9 relayed streams per join in sereus's measurement; leave it out on a node with no listen addresses, or let the embedder turn it off.
files: packages/db-p2p/src/libp2p-node-base.ts (`dcutr: dcutr()` in the services map), packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions`)
tradeoffs: The saving is about nine relayed streams per join, not a recurring cost, and hole punching can succeed between two NAT'd machines that do listen (two cadre-host boxes), which a blanket switch would lose; keying on listen addresses avoids that but is a heuristic.
----
# A node without listen addresses leaves out hole punching

Filed from sereus (`tickets/blocked/optimystic-dcutr-between-relay-only-peers`, split from its FRET-probing ticket once Fret#3 shipped). Related: `backlog/enhancements/dcutr-holepunch-nat-attribution-harness`.

## Measured

sereus `message-cost-accounting`, strand case (two relay-only parties through one loopback relay), 2026-10-20 on Optimystic 1.17.0: 9 `/libp2p/dcutr` streams from the founder's strand node to the joiner's per join (1 during attach, 2 in the first insert, 6 in the 15 s settle window), unchanged from 2026-10-19; none in the idle minute. On a phone each is an exchange through the relay.

## Direction

Prefer leaving `dcutr` out automatically when the node is built with no listen addresses (no embedder change). Otherwise a `NodeOptions` flag sereus would set on such nodes. Check first what `dcutr` does on a node that listens on loopback only.

## Gardener note (2026-10-21)

Pulled from backlog for the next release. Keep the automatic rule as the default (no `dcutr` when the node has no listen addresses, so sereus needs no change), and add a `NodeOptions` override in both directions only if the plan finds the heuristic wrong for a real configuration (loopback-only listeners, `/p2p-circuit`-only listeners). Settle those two cases from libp2p's `dcutr` source before choosing; name the test that counts zero `/libp2p/dcutr` streams between two relay-only nodes.
