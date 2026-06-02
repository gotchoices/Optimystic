description: Review the hardened DCUtR direct-upgrade spec — verify the silent loopback fallback is gone and the strong hole-punch assertion is genuinely non-falsifiable.
prereq:
files: packages/db-p2p/test/dcutr-direct-upgrade.spec.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/test/circuit-relay-long-lived.spec.ts
----

## What was done

The original gated spec (`dcutr-direct-upgrade.spec.ts`) had a single test that asserted the *strong* direct-upgrade invariant **only if it happened to be observed**, and otherwise silently fell back to a weak "a relayed connection exists and `services.dcutr` is wired" check + a `console.warn`. That fallback would pass even if DCUtR were removed entirely — no real behavioral guarantee.

### Root cause confirmed (why loopback never upgrades)

`@libp2p/dcutr` only ever dials candidate addresses where `isPublicAndDialable(ma)` is true, and that helper (`@libp2p/utils` `isPrivate`) rejects every private/loopback range: `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, etc. On a single loopback host both peers advertise only `127.0.0.1` addrs, so DCUtR finds **zero** dialable candidates and never upgrades. This is a deliberate library design choice — hole-punching is meaningless between peers already sharing an interface. Verified by reading:
- `node_modules/@libp2p/dcutr/dist/src/dcutr.js` (`getDialableMultiaddrs` / `attemptUnilateralConnectionUpgrade` → `isPublicAndDialable`)
- `node_modules/@libp2p/dcutr/dist/src/utils.js` (`isPublicAndDialable` → `!isPrivate`)
- `node_modules/@libp2p/utils/dist/src/private-ip.js` (`PRIVATE_IP_RANGES`)

So a reliable single-host loopback hole-punch is **not feasible**, exactly as the ticket anticipated.

### Change: split into two tests with different gates and different guarantees

`describe('DCUtR hole-punch')` now has two independent `it`s:

1. **Loopback relay smoke** (`RUN_LONG_TESTS=1`). Honestly titled "establishes a relayed peer↔peer connection through the circuit relay … no direct upgrade". Spins relay + peerB (circuit listener) + peerA (dialer) over loopback and asserts (a) a connection to peerB exists and (b) at least one is a `/p2p-circuit` connection — proving the relay path works end-to-end. It makes **no** claim about direct upgrade. This replaces the misleading fallback. The redundant `services.dcutr` presence check was dropped (already covered by the always-run `dcutr-autonat-registration.spec.ts`).

2. **Direct hole-punch upgrade** (`RUN_DCUTR_HOLEPUNCH=1` + `DCUTR_HOST=<non-private ip>`). Asserts the strong invariant **unconditionally**: within 60s, `peerA.getConnections(peerB.peerId)` contains a non-`/p2p-circuit` connection. No fallback — a non-upgrade fails. When the env is absent it `skip()`s (never silently passes). All three nodes bind `DCUTR_HOST` so DCUtR sees each peer's non-private addr (the upgrade target) while the relay is the only initial meeting point. A private/loopback `DCUTR_HOST` is rejected fast via `assertRoutableHost(...)` with guidance, so the common misconfiguration can't masquerade as a non-upgrade.

### Shared test util extracted

New `test/util/relay-topology.ts` holds the relay/circuit helpers that were duplicated between `dcutr-direct-upgrade.spec.ts` and `circuit-relay-long-lived.spec.ts`: `spawnRelayNode`, `spawnTcpServicePeer`, `pickRelayTcpAddr`, `pickRelayWsAddr`, `waitForCircuitListen`, `hasDirectConnection`, `waitForDirectConnection`. Each takes an optional `host` so the same helper drives both the loopback smoke topology (default `127.0.0.1`) and the non-private hole-punch topology. `circuit-relay-long-lived.spec.ts` was refactored to import the shared `spawnRelayNode`/`pickRelayWsAddr`/`waitForCircuitListen` (its WS-shaped peer spawners stay local — different transport shape, not worth over-generalizing).

## How it was validated

- `yarn workspace @optimystic/db-p2p build` (tsc type-checks all `src` + `test`) → **pass**.
- Default mode (`--grep "DCUtR"`, no env): both gated tests **pending/skip**, `dcutr-autonat-registration` passes.
- `RUN_LONG_TESTS=1 --grep "DCUtR hole-punch"`: loopback smoke **passes** (108ms), strong test skips.
- `RUN_DCUTR_HOLEPUNCH=1 DCUTR_HOST=127.0.0.1`: strong test **fails loudly** with the `assertRoutableHost` guidance (proves no-silent-masking).
- `RUN_LONG_TESTS=1 --grep "sustained ~2 KiB dials"`: refactored long-lived spec **passes** (41s) — helper extraction caused no regression.

## What to review / known gaps

- **The strong assertion was NOT executed in a real hole-punch environment.** The agent host is Windows loopback only; no non-private bound IP was available, so test #2 has only been exercised through its skip path and its fail-fast guard — **never through a genuine upgrade**. This is the central thing to validate: a reviewer with a non-private bound address (cloud VM public NIC IP, or a public-range container/netns with NAT) should run `RUN_DCUTR_HOLEPUNCH=1 DCUTR_HOST=<ip>` and confirm it goes **green**, not just that it compiles. If the single-process `DCUTR_HOST` topology turns out not to fire reliably (e.g. the unilateral-upgrade path needs genuinely separate hosts), the assertion may need to move to a true multi-process / multi-host harness — file a follow-up rather than re-adding any fallback.
- The smoke test deliberately does **not** assert "no direct connection" on loopback: `connectionManager.autoDial` could in principle form a direct loopback connection independent of DCUtR, which would make a negative assertion flaky. It asserts the positive (a relayed connection exists) only. Confirm that's the right call.
- `assertRoutableHost` is a cheap prefix check (`127.`, `10.`, `192.168.`, `172.16–31.`, `169.254.`, `0.`, `localhost`, `::1`), not a full `isPrivate`. It catches common mistakes; it is not exhaustive (e.g. it won't flag `100.64/10` CGNAT or all IPv6 ULA). Acceptable for a fail-fast DX guard, but note it.
- Out-of-band CI: the strong assertion belongs in a multi-host / container-network job, not the agent-runnable suite — this is documented in the spec header. No CI wiring was added (out of scope for this ticket); a reviewer may want to file that as separate infra work.
