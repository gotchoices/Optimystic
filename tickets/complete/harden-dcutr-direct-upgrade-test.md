description: Hardened the DCUtR direct-upgrade spec — removed the silent loopback fallback, split into an honest loopback smoke test + a no-fallback strong hole-punch assertion, and extracted shared relay-topology helpers.
files: packages/db-p2p/test/dcutr-direct-upgrade.spec.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/test/circuit-relay-long-lived.spec.ts, packages/db-p2p/src/libp2p-node-base.ts
----

## Summary

The original gated spec asserted the strong direct-upgrade invariant *only if it
happened to be observed*, otherwise silently falling back to a weak "a relayed
connection exists + `services.dcutr` is wired" check plus a `console.warn`. That
fallback would have passed even with DCUtR removed entirely. The implement stage:

- Split `describe('DCUtR hole-punch')` into two independent tests:
  1. **Loopback relay smoke** (`RUN_LONG_TESTS=1`) — asserts only that a relayed
     `/p2p-circuit` connection is established end-to-end. Makes no direct-upgrade
     claim. Honest replacement for the old fallback.
  2. **Direct hole-punch upgrade** (`RUN_DCUTR_HOLEPUNCH=1` + `DCUTR_HOST=<ip>`) —
     asserts the strong invariant unconditionally (a non-`/p2p-circuit` connection
     within 60s). No fallback; non-upgrade fails; absent env `skip()`s (never
     silent-passes). A private/loopback `DCUTR_HOST` is rejected fast by
     `assertRoutableHost`.
- Extracted shared helpers into `test/util/relay-topology.ts`
  (`spawnRelayNode`, `spawnTcpServicePeer`, `pickRelayTcpAddr`, `pickRelayWsAddr`,
  `waitForCircuitListen`, `hasDirectConnection`, `waitForDirectConnection`), each
  parameterized by `host`. Refactored `circuit-relay-long-lived.spec.ts` onto the
  shared spawners.

Root cause of why loopback never upgrades (confirmed): `@libp2p/dcutr` only dials
candidates where `isPublicAndDialable` holds, and `@libp2p/utils` `isPrivate`
rejects every private/loopback range — so on a single loopback host DCUtR finds
zero dialable candidates. A reliable single-host loopback hole-punch is not
feasible, exactly as the ticket anticipated.

## Review findings

### Scope note
The implement commit (`e6000d8`) bundled unrelated cluster work
(`src/cluster/cluster-repo.ts`, `test/cluster-consensus-divergence.spec.ts`,
`docs/internals.md`, and several `tickets/` moves) that belong to other tickets.
These were **not** reviewed here and were left untouched — out of scope for this
ticket. The bundled cluster spec runs in the default suite and passes (see below),
so it introduces no regression.

### What was checked

- **Read the implement diff first** (`git show e6000d8` for the three DCUtR files)
  before the handoff summary, then read the current files end-to-end.
- **Silent fallback removed (primary goal): CONFIRMED.** The old
  `if (upgraded) {...} else { console.warn(...); weak assert }` block is gone in
  full. The smoke test asserts a positive `/p2p-circuit` connection; the strong
  test is a single unconditional `expect(upgraded && hasDirectConnection(...))`
  with no `else`. The associated `eslint-disable no-console` was also removed —
  nothing orphaned.
- **Skip-vs-silent-pass:** both gated tests `this.skip()` when their env is
  absent (verified pending in default mode), never silently pass.
- **Fail-fast guard:** `assertRoutableHost` rejects private hosts with guidance.
- **Cross-references:** `dcutr-autonat-registration.spec.ts` and the new util's
  doc comments stay consistent with the split; no stale references to the old
  `describe('DCUtR direct upgrade')` name or inlined helpers remain.
- **Helper extraction:** `circuit-relay-long-lived.spec.ts` imports the shared
  `spawnRelayNode`/`pickRelayWsAddr`/`waitForCircuitListen` and still type-checks
  and passes; its WS-shaped peer spawners correctly stayed local.
- **Docs:** the touched/relevant files were read; no DCUtR-facing doc claims the
  old behavior (`docs/internals.md` contains no DCUtR/relay content — its diff in
  this commit is cluster-related, out of scope).

### Validation run (all reproduced the handoff claims)

- `yarn workspace @optimystic/db-p2p build` (tsc strict, types `src`+`test`) → **pass**.
- `yarn test` (full default db-p2p suite) → **502 passing, 9 pending**, incl. the
  bundled cluster spec → no regression from the helper extraction.
- Default `--grep "DCUtR"`: registration passes; both hole-punch tests **pending**.
- `RUN_LONG_TESTS=1 --grep "DCUtR hole-punch"`: loopback smoke **passes** (~100ms);
  strong test pending.
- `RUN_DCUTR_HOLEPUNCH=1 DCUTR_HOST=127.0.0.1`: strong test **fails loudly** via
  `assertRoutableHost` (no silent masking).
- `RUN_LONG_TESTS=1 --grep "sustained ~2 KiB dials"`: refactored long-lived spec
  **passes** (41s).
- Lint: root `lint` is a no-op echo; db-p2p has no lint script — `tsc` strict is
  the type gate and passes.

### Major finding → follow-up filed (`dcutr-holepunch-nat-attribution-harness`, backlog)

The strong assertion is non-falsifiable in the "no fallback / fails-or-skips"
sense, but **not** a clean DCUtR-specific guarantee in its single-process form:

- The test runs all three nodes in one process. `createLibp2pNodeBase` sets
  `connectionManager.autoDial: true`, `minConnections: 1`
  (`libp2p-node-base.ts:219-225`). On a routable host with **no NAT**, once peerA
  learns peerB's direct addr via identify over the circuit, an ordinary direct
  dial *succeeds* — so a non-`/p2p-circuit` connection can form via plain autoDial,
  not necessarily DCUtR's simultaneous-open. Removing `@libp2p/dcutr` would not
  reliably fail the test in a non-NAT environment.
- `assertRoutableHost` rejects private prefixes but does **not** enforce the
  discriminating condition (inbound-direct blocked except via hole-punch). Correct
  attribution to DCUtR depends on the runtime environment genuinely having NAT,
  and nothing enforces that.
- Compounding: the header suggests a "cloud VM's public NIC IP", but on most
  clouds the public IP is external NAT and is not NIC-bindable
  (`/ip4/<public>/tcp/0` → `EADDRNOTAVAIL`). The realistic runnable env is a
  container/netns with a public-range address behind NAT.

This requires an out-of-band NAT/netns harness Claude cannot stand up or validate
on a Windows-loopback host, so it is filed as backlog infra work rather than fixed
inline. Per the prior ticket's instruction, **no fallback was re-introduced.**

### Minor findings (acceptable as-is; no inline change)

- `assertRoutableHost` is a cheap IPv4-prefix check — won't flag `100.64/10`
  CGNAT or IPv6 ULA, and the helpers hardcode `/ip4/` so an IPv6 `DCUTR_HOST`
  would fail at spawn. Acceptable for a fail-fast DX guard; documented in the
  spec header and folded into the follow-up.
- `expect(upgraded && hasDirectConnection(...))` re-checks `hasDirectConnection`
  after `waitForDirectConnection` already returned true — defensive/redundant but
  harmless (guards against a connection drop between poll and assert).
- The smoke test deliberately does not assert "no direct connection" on loopback
  (autoDial could form one independent of DCUtR). Asserting only the positive
  `/p2p-circuit` presence is the correct, non-flaky call.

### Empty categories
No security findings (test-only change, no network-exposed surface). No
performance findings (gated slow tests; default suite unchanged at 19s). No
resource-cleanup findings — `afterEach` stops all spawned nodes via
`Promise.allSettled`, nulling refs first.
