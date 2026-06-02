description: Harden the gated DCUtR direct-upgrade integration spec so it actually verifies the hole-punch (currently passes via a weak loopback fallback that would also pass if DCUtR were removed).
files: packages/db-p2p/test/dcutr-direct-upgrade.spec.ts, packages/db-p2p/src/libp2p-node-base.ts
prereq:
----

## Problem

`packages/db-p2p/test/dcutr-direct-upgrade.spec.ts` (gated behind `RUN_LONG_TESTS=1`) is intended to prove that the always-on `@libp2p/dcutr` service registered in `createLibp2pNodeBase` upgrades a relayed peer↔peer connection to a **direct** one.

In the environments available so far (single-host loopback, `127.0.0.1`, under the agent harness) the DCUtR Sync coordination does **not** fire within a 60s window — the connection stays `/p2p-circuit`. To avoid a false failure, the spec falls back to a weaker invariant: "a relayed connection exists and `services.dcutr` is wired."

The weakness: that fallback path would pass even if DCUtR were **misconfigured or removed entirely**, because it only checks for a relayed connection plus service presence (the latter already covered by the always-run `dcutr-autonat-registration.spec.ts`). So the gated spec currently provides no real behavioral guarantee that hole-punching works.

This was confirmed during review: running the spec with `RUN_LONG_TESTS=1` took the fallback path (`direct upgrade NOT observed over loopback within 60s`) and still passed.

## Desired behavior

In an environment where hole-punching genuinely fires (NAT'd peers behind separate addresses, or two distinct hosts / network namespaces / containers, not shared loopback), the spec should assert the **strong** invariant unconditionally: within a timeout, `peerA.getConnections(peerB.peerId)` contains a connection whose `remoteAddr` is not a `/p2p-circuit` multiaddr. No silent fallback that masks a non-upgrade.

## Specification / requirements

- Establish a topology where the two service peers cannot reach each other directly except via DCUtR hole-punch (distinct routable addresses, or separate netns/containers), with the relay as the only initial meeting point.
- Assert the direct (non-circuit) upgrade is observed; failure to upgrade must fail the test, not warn.
- Keep it gated (slow / requires special network setup) so the default `yarn workspace @optimystic/db-p2p test` run is unaffected; document the exact env/topology needed to run it.
- If a reliable single-runner setup isn't feasible, document that this assertion belongs in an out-of-band CI job (multi-host / container network) rather than the agent-runnable suite, and leave the loopback spec only as a smoke-level wiring check (or remove its misleading "upgrades ... to a direct one" title).
- While here, consider whether the duplicated relay/circuit test helpers shared with `circuit-relay-long-lived.spec.ts` warrant extraction into a shared test util.

## Context

The wiring itself is already guarded by the always-run `dcutr-autonat-registration.spec.ts` (presence of `services.dcutr` / `services.autoNAT`). This ticket is purely about giving the *behavioral* hole-punch a real, non-falsifiable assertion.
