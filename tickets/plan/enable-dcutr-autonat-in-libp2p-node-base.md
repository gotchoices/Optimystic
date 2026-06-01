----
description: The db-p2p libp2p node has no DCUtR (hole punching) and no AutoNAT, so node↔node connections behind NAT relay permanently and nodes cannot tell whether they are publicly reachable. Enable @libp2p/dcutr and @libp2p/autonat in libp2p-node-base so relayed node↔node connections upgrade to direct and reachability is a real verdict.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/package.json
----

## Problem

`createLibp2pNode` builds every consumer's libp2p instance, but two gaps keep circuit relays in the data path for non-browser nodes:

- **No DCUtR.** `libp2p-node-base.ts` registers `identify`, `ping`, `pubsub`, an optional circuit-relay *server*, and the custom cluster/repo/sync/networkManager/fret services — but no `@libp2p/dcutr`. So when two NAT'd nodes connect through a relay, the connection stays relayed for its full lifetime; there is no hole-punch upgrade. The package does not depend on `@libp2p/dcutr`.
- **No AutoNAT.** There is no `@libp2p/autonat` service, so a node has no dial-back verdict on whether it is publicly reachable. A publicly reachable node may needlessly reserve a relay slot, and a node behind CGNAT may assume it is reachable when it is not.

Adding both upstream benefits every consumer at once — the Sereus cadre runtimes (`cadre-cli`, `cadre-host`, `cadre-provider`) and integration-tests — rather than being patched per-app. This work is the node↔node counterpart to the browser WebRTC-upgrade effort happening in the Sereus repo; the goal across both is to demote the circuit relay from a permanent data path to a momentary signaling/bootstrap channel.

## Requirements / specifications

- Add `@libp2p/dcutr` and `@libp2p/autonat` to `db-p2p` dependencies and register them as services in `libp2p-node-base.ts` alongside `identify`/`ping`.
- DCUtR enables direct-connection upgrade for relayed node↔node connections (TCP hole punching). It composes with the circuit-relay transport/server already configured.
- AutoNAT provides a reachability verdict; expose it so consumers can replace reachability heuristics (e.g. Sereus `cadre-host`'s UPnP-success inference) and so a node can decide whether to bother reserving a relay slot.
- Respect the existing `relay`/`relayServerInit` option and the `transports`/`listenAddrs` override path (`libp2p-node-base.ts:74-98`); these services must not break browser/WS-only consumers that pass custom transports. DCUtR/AutoNAT are inert where the transport can't hole-punch (e.g. browser) — that is acceptable.
- Keep the circuit-relay reservation limit at its default (do not lift `applyDefaultLimit`) — DCUtR is what makes permanent relaying unnecessary, so the cap should remain a guardrail.

## Expected behavior / success criteria

- Two NAT'd node-runtime peers that initially connect via relay observably upgrade to a direct connection.
- A publicly reachable node reports a positive AutoNAT verdict and does not hold an unnecessary relay reservation; a CGNAT node reports negative and retains the relay path.
- Existing browser/RN/WS-only consumers (which pass custom `transports`) continue to build and run unchanged.

## Use cases

- Two NAT'd peers in the same cluster: the initial relayed connection hole-punches to direct, removing sustained relay load from the relay server.
- A self-hosted node behind a stubborn NAT learns its true reachability from an AutoNAT dial-back rather than inferring it from UPnP mapping success.

## References

- `packages/db-p2p/src/libp2p-node-base.ts:208-305` (services block: identify/ping/pubsub/relay/cluster/repo/sync/networkManager/fret — no dcutr, no autonat) and `:49-144` (`NodeOptions`, transports/listenAddrs override, `relay`/`relayServerInit`)
- `packages/db-p2p/package.json` (no `@libp2p/dcutr`, no `@libp2p/autonat`)
- Cross-repo consumers (Sereus): `../sereus/docs/cadre-host.md` (AutoNAT named as the intended replacement for the UPnP heuristic), `../sereus/docs/STATUS.md` (relay/discovery gaps), and the Sereus relay-reduction tickets (`web-webrtc-transport-to-bypass-relay`, `relay-usage-connectivity-observability`) that this complements. Coordinate the `db-p2p` version bump that Sereus consumes (linked via root `package.json` `resolutions`).
