description: An application cannot measure how many bytes a node sends and receives over relayed versus direct connections, because the node factory gives libp2p no metrics component and offers no option to supply one. Let the embedder pass one in.
architecture: packages/db-p2p/readme.md
files: packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions`, the `libp2pOptions: Libp2pInit` literal), packages/db-p2p/readme.md
tradeoffs: Observation only and no Optimystic code needs it; Sereus can count relayed connections without it, so a maintainer may wait until a deployment actually needs the byte figure, and a metrics implementation adds per-stream bookkeeping on phones.
----
# A node can be given a libp2p metrics component

Source: Sereus ticket `relay-bytes-metrics-libp2p` (its backlog).

Sereus classifies each connection as relayed or direct and reports the counts, but its byte figure (`bytesOverRelay`) stays empty: libp2p's `Connection` carries no byte counter, and a libp2p node counts bytes only when built with a `metrics` implementation. `createLibp2pNode` builds the libp2p options itself (`libp2pOptions` in `packages/db-p2p/src/libp2p-node-base.ts`), sets no `metrics`, and `NodeOptions` has no field to pass one through, so an embedder cannot add one without patching the package.

## Requirement

`NodeOptions` accepts a libp2p metrics factory and hands it to `createLibp2p` unchanged; absent, the node is built exactly as today, with no metrics. Optimystic chooses no implementation and depends on none: the embedder picks one that works on its platforms (browser, Node, React Native). The option is documented in the db-p2p readme, as `connectionMonitor` is. The libp2p version this repository pins must accept the shape passed; the option's type is libp2p's own, so a mismatch is a type error at the embedder.

Sereus's use: report the share of bytes that still travel through relays after connections have had time to go direct, which the relay-reduction work wants to drive toward zero.
