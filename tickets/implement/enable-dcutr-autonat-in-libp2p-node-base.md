description: Register `@libp2p/dcutr` (hole-punch upgrade for relayed node↔node connections) and `@libp2p/autonat` (dial-back reachability verdict) as libp2p services in `libp2p-node-base.ts`, so every db-p2p consumer demotes the circuit relay from a permanent data path to a momentary signaling/bootstrap channel and gets a real reachability verdict.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/package.json, packages/db-p2p/test/circuit-relay-long-lived.spec.ts (reference template for the new DCUtR upgrade spec)
effort: medium
prereq:
----

## Goal

Add DCUtR and AutoNAT to the shared libp2p service block built by `createLibp2pNodeBase`. This is a small, self-contained upstream change that benefits every consumer at once (Sereus `cadre-cli`/`cadre-host`/`cadre-provider`, integration-tests) instead of per-app patching.

- **DCUtR** (`@libp2p/dcutr`): when two NAT'd nodes connect through a relay, DCUtR coordinates a simultaneous TCP open (hole punch) and upgrades the relayed connection to a direct one. It composes with the `circuitRelayTransport()` already added in `libp2p-node.ts:30` and the optional `circuitRelayServer` in `libp2p-node-base.ts:238`, and depends on `identify` (already registered at `:229`).
- **AutoNAT** (`@libp2p/autonat`): asks peers to dial back so the node learns whether it is publicly reachable, updating libp2p's address-manager reachability confidence. Lets a publicly reachable node skip an unnecessary relay reservation and lets a CGNAT node know it must keep the relay path. Exposed to consumers via `node.services.autoNAT` so Sereus `cadre-host` can replace its UPnP-success inference (see `../sereus/docs/cadre-host.md`).

## Package versions

Latest published lines are compatible with the existing v3 libp2p stack in this package (`@libp2p/interface ^3.1.0`, `@libp2p/identify ^4.0.10`, `libp2p ^3.1.3`):

- `@libp2p/dcutr`: `^3.0.21` (peer dep `@libp2p/interface ^3.2.3`)
- `@libp2p/autonat`: `^3.0.21`

Use `autoNAT` v1 (`@libp2p/autonat`), not the `@libp2p/autonat-v2` package, to match the rest of the v3 service set.

Imports / service keys (confirmed from package READMEs):

```ts
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
// ...
services: {
  identify: identify({ ... }),
  ping: ping(),
  dcutr: dcutr(),
  autoNAT: autoNAT(),
  pubsub: gossipsub({ ... }),
  ...(options.relay ? { relay: circuitRelayServer(...) } : {}),
  // cluster/repo/sync/blockTransfer/networkManager/fret unchanged
}
```

## Design notes / constraints

- **Always-on, unconditional.** Register both for every consumer regardless of the `transports`/`listenAddrs` override path (`libp2p-node-base.ts:208-209`, `:228-336`). DCUtR/AutoNAT are inert where the transport can't hole-punch or dial back (browser/WS-only) — that is acceptable and must not throw or break the build. Do **not** gate them on `options.relay` or on transport inspection; the relay *server* is the only relay-conditional service.
- **Do not touch the reservation cap.** Leave `circuitRelayServer(options.relayServerInit)` and its `applyDefaultLimit` default exactly as-is. DCUtR is what makes permanent relaying unnecessary, so the default reservation `Limit` stays as a guardrail. This ticket adds services only; it does not alter relay limits, transports, listen addrs, or any other option.
- **Service order.** DCUtR relies on `identify`; keep `identify` before `dcutr` in the services object (it already is — just insert `dcutr`/`autoNAT` after `ping`).
- **No new `NodeOptions` fields required.** Default service config is sufficient. Don't add knobs unless a test forces it.

## Tests

Existing `db-p2p` unit specs must still pass (`yarn workspace @optimystic/db-p2p test`) — these services are additive and should not perturb them. The DCUtR upgrade behavior is a slow, multi-node integration scenario; model the new spec on the existing `test/circuit-relay-long-lived.spec.ts` harness (same `createLibp2pNode` spawn helpers, same `RUN_LONG_TESTS=1` gate so the default run skips it).

Key test (gated, slow — `test/dcutr-direct-upgrade.spec.ts` or similar):
- Spawn a relay node (TCP+WS+circuit, `relay: true`), and two service-peer nodes (TCP+circuit, `relay: false`) that can only find each other through the relay initially.
- Have peer B publish a `/p2p-circuit` listen addr via the relay (reuse `waitForCircuitListen`); peer A dials B's circuit addr.
- **Expected:** within a timeout, `nodeA.getConnections(nodeB.peerId)` yields a connection whose `remoteAddr` is **not** a `/p2p-circuit` multiaddr (i.e. DCUtR upgraded it to direct). Poll for the transition rather than asserting once. If hole-punching over loopback proves flaky in CI, assert the weaker invariant that a non-limited/direct connection eventually appears, and document the limitation in the spec header.

Lightweight build/smoke checks (always-run):
- A spec (or extend an existing libp2p spec) that builds a node via `createLibp2pNode` and asserts `node.services.dcutr` and `node.services.autoNAT` are present — proves registration wired up and the browser-shaped path (custom transports) still builds. `test/injectable-private-key.spec.ts` / `test/mesh-sanity.spec.ts` are good neighbors for a minimal node-spawn assertion.

## TODO

- Add `@libp2p/dcutr@^3.0.21` and `@libp2p/autonat@^3.0.21` to `dependencies` in `packages/db-p2p/package.json` (alphabetically near the other `@libp2p/*` entries); run `yarn install` to update the lockfile.
- Add `import { dcutr } from '@libp2p/dcutr'` and `import { autoNAT } from '@libp2p/autonat'` to `libp2p-node-base.ts`.
- Register `dcutr: dcutr()` and `autoNAT: autoNAT()` in the `services` object after `ping` (before `pubsub`), unconditionally.
- Confirm TypeScript compiles: `yarn workspace @optimystic/db-p2p build`.
- Add a minimal always-run spec asserting `node.services.dcutr` and `node.services.autoNAT` exist on a spawned node (and that a custom-transports/browser-shaped spawn still builds).
- Add the gated DCUtR direct-upgrade integration spec described above, modeled on `circuit-relay-long-lived.spec.ts` (`RUN_LONG_TESTS=1` gate, generous timeout, poll for the direct connection). If loopback hole-punching is unreliable under the agent, mark it `RUN_LONG_TESTS`-gated and assert the weaker direct-connection-appears invariant; do not let it block the default test run.
- Run `yarn workspace @optimystic/db-p2p test` and ensure the existing suite is green.
- Bump `packages/db-p2p` `version` (patch) so Sereus can pin the new build via its root `package.json` `resolutions`; note the new version in the review handoff so the cross-repo bump can be coordinated.

## Review handoff notes (fill in during implement)

- Whether the DCUtR upgrade spec actually observed a direct connection over loopback, or fell back to the weaker invariant (and why).
- The new `db-p2p` version number, for the Sereus `resolutions` bump.
- Any AutoNAT reachability-verdict accessor surface you exposed beyond `node.services.autoNAT` (none expected, but record if added).

## References

- `packages/db-p2p/src/libp2p-node-base.ts:228-336` (services block) and `:208-209` (transports/listenAddrs override resolution)
- `packages/db-p2p/src/libp2p-node.ts:18-35` (default transports incl. `circuitRelayTransport()` — the transport DCUtR upgrades onto)
- `packages/db-p2p/test/circuit-relay-long-lived.spec.ts` (spawn-helper + `RUN_LONG_TESTS` gating template for the new spec)
- Cross-repo (Sereus): `../sereus/docs/cadre-host.md` (AutoNAT as the UPnP-heuristic replacement), `../sereus/docs/STATUS.md`, tickets `web-webrtc-transport-to-bypass-relay` and `relay-usage-connectivity-observability` (this is their node↔node counterpart)
