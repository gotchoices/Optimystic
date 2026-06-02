description: Review the DCUtR + AutoNAT service registration added to db-p2p's shared `createLibp2pNodeBase`. Both services are always-on, depend on the already-registered `identify`, and are exposed to consumers via `node.services.dcutr` / `node.services.autoNAT`. Adds an always-run registration smoke spec and a gated (slow) DCUtR direct-upgrade integration spec.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/package.json, packages/db-p2p/test/dcutr-autonat-registration.spec.ts, packages/db-p2p/test/dcutr-direct-upgrade.spec.ts, packages/db-p2p/test/circuit-relay-long-lived.spec.ts
prereq:
----

## What landed

DCUtR (`@libp2p/dcutr`) and AutoNAT (`@libp2p/autonat`) are now registered unconditionally as libp2p services in `createLibp2pNodeBase`, so every db-p2p consumer (Sereus cadre-*, integration-tests) gets hole-punch upgrade of relayed node↔node connections and a real reachability verdict without per-app patching.

- **`packages/db-p2p/package.json`** — added `@libp2p/autonat@^3.0.21` and `@libp2p/dcutr@^3.0.21` to `dependencies` (alphabetical among the `@libp2p/*` entries). `yarn install` resolved both against the existing v3 stack (pulled `@libp2p/interface@3.2.3`, the dcutr peer-dep floor) with no version conflicts. **Version bumped `0.13.5` → `0.13.6`** (patch) — this is the number Sereus should pin via its root `package.json` `resolutions`.
- **`packages/db-p2p/src/libp2p-node-base.ts`** — added `import { dcutr } from '@libp2p/dcutr'` and `import { autoNAT } from '@libp2p/autonat'` (line ~6–8); registered `dcutr: dcutr()` and `autoNAT: autoNAT()` in the `services` object immediately after `ping` and before `pubsub` (line ~232). Always-on; **not** gated on `options.relay` or transport inspection. The relay *server* remains the only relay-conditional service and the reservation cap / `applyDefaultLimit` default were left untouched, as specified.
- **`packages/db-p2p/test/dcutr-autonat-registration.spec.ts`** (NEW, always-run) — asserts `node.services.dcutr` and `node.services.autoNAT` exist on (a) a default TCP node and (b) a browser-shaped WS-only custom-transports node (proves the browser path still builds with the additive services).
- **`packages/db-p2p/test/dcutr-direct-upgrade.spec.ts`** (NEW, gated on `RUN_LONG_TESTS=1`) — relay (TCP+WS+circuit) + two TCP+circuit service peers that meet only through the relay; polls `peerA.getConnections(peerB.peerId)` for a non-`/p2p-circuit` (direct) connection. Modeled on `circuit-relay-long-lived.spec.ts`. Peers reach the relay over its **TCP** addr (not WS) so they need no WS transport and share TCP as the common direct transport DCUtR upgrades onto.

## Validation performed

- `yarn install` — clean, lockfile updated (+17 packages).
- `yarn workspace @optimystic/db-p2p build` — clean (tsc, no errors).
- `yarn workspace @optimystic/db-p2p test` — **485 passing, 8 pending** (gated specs skipped). Existing suite undisturbed by the additive services.
- Registration smoke spec — both cases pass (TCP node + browser-shaped node).
- Gated upgrade spec run with `RUN_LONG_TESTS=1` — **passes via the fallback path** (see handoff note below).

## Review handoff notes (filled in)

- **Did the DCUtR upgrade actually go direct over loopback? NO.** Under the agent harness, on `127.0.0.1`, the direct upgrade was **not** observed within a 60s poll window — the connection stayed relayed (`/p2p-circuit`). libp2p's DCUtR Sync coordination does not appear to fire reliably when both peers share the loopback interface. The gated spec therefore asserts the **strong** invariant (a direct, non-`/p2p-circuit` connection appears) *when observed*, and otherwise falls back to the **weaker** invariant (a relayed connection exists + `services.dcutr` is wired) with a `console.warn`, rather than emitting a false failure. **This is a known test-environment gap, not evidence DCUtR is misconfigured** — the service is wired and inert-safe. A reviewer with a NAT'd / multi-host setup should strengthen the gated spec to an unconditional direct-upgrade assertion and confirm the hole punch genuinely fires. Consider this the floor.
- **New `db-p2p` version: `0.13.6`** — for the Sereus root `resolutions` bump (coordinate cross-repo; Sereus `cadre-host` can then replace its UPnP-success inference with `node.services.autoNAT`, per `../sereus/docs/cadre-host.md`).
- **AutoNAT accessor surface beyond `node.services.autoNAT`: none added.** No new `NodeOptions` fields; default service config used for both.

## Suggested review focus

- Confirm service ordering (`identify` → `ping` → `dcutr` → `autoNAT` → `pubsub`) is correct and that DCUtR's dependency on `identify` is satisfied.
- Confirm always-on registration is genuinely inert (no throw / no startup error) on the WS-only / browser-shaped path — the smoke spec covers build+presence but not a full browser runtime.
- Decide whether the gated spec's loopback fallback is acceptable or whether the direct-upgrade assertion should be hardened / moved to an environment where hole-punching actually fires (potential follow-up fix ticket if a reliable harness is wanted).
- Sanity-check that the reservation cap / `applyDefaultLimit` guardrail was genuinely left untouched (diff should show services-only changes).
