description: DCUtR + AutoNAT registered always-on in db-p2p's shared `createLibp2pNodeBase`, exposed via `node.services.dcutr` / `node.services.autoNAT`. Adds an always-run registration smoke spec and a gated (slow) DCUtR direct-upgrade integration spec. Reviewed and completed.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/package.json, packages/db-p2p/test/dcutr-autonat-registration.spec.ts, packages/db-p2p/test/dcutr-direct-upgrade.spec.ts
----

## What landed

`@libp2p/dcutr` (hole-punch upgrade of relayed node↔node connections) and `@libp2p/autonat` (peer dial-back reachability verdict) are now registered unconditionally as libp2p services in `createLibp2pNodeBase`, so every db-p2p consumer (Node `createLibp2pNode`, RN `createLibp2pNode`) gets them without per-app patching. Both depend on the already-registered `identify`. db-p2p version bumped `0.13.5 → 0.13.6` for the downstream Sereus `resolutions` pin.

- `packages/db-p2p/src/libp2p-node-base.ts` — `dcutr: dcutr()` / `autoNAT: autoNAT()` added to the `services` object; always-on, not gated on transport. Relay *server* remains the only relay-conditional service; reservation cap / `applyDefaultLimit` untouched.
- `packages/db-p2p/package.json` — `@libp2p/autonat@^3.0.21`, `@libp2p/dcutr@^3.0.21` added.
- `packages/db-p2p/test/dcutr-autonat-registration.spec.ts` (always-run) — presence of both services on a default-TCP node and a WS-only browser-shaped node.
- `packages/db-p2p/test/dcutr-direct-upgrade.spec.ts` (gated on `RUN_LONG_TESTS=1`) — relay + two TCP+circuit peers; polls for a direct (non-`/p2p-circuit`) connection, with a documented loopback fallback.

## Review findings

### Scope / correctness — checked, no blocking issues
- **Service wiring & `identify` dependency**: confirmed satisfied. The object-literal ordering (`identify → ping → dcutr → autoNAT → pubsub`) is cosmetic — libp2p resolves service init order by declared capability/dependency, not literal order. Verified that `@libp2p/interface`'s `serviceCapabilities`/`serviceDependencies` are `Symbol.for(...)` (global symbol registry), so dependency resolution works even across the duplicate-`@libp2p/interface` install noted below. `identify` is present, so the dcutr/autonat dependency resolves.
- **Single construction site**: `createLibp2pNodeBase` is the only place in `src/` that builds the libp2p `services` object; both the Node (`libp2p-node.ts`) and RN (`libp2p-node-rn.ts`) factories delegate to it, so the additive services reach every code path (no second site was missed).
- **Inert-safe on WS-only / browser path**: the always-run smoke spec builds and starts a WS-only custom-transports node with both services present; full node teardown is clean. (A real browser runtime is not exercised — see the implementer's caveat; this is acceptable for the smoke level.)
- **Reservation-cap guardrail untouched**: confirmed via diff — the change is services-only (`dcutr()`/`autoNAT()` two lines plus imports); `applyDefaultLimit` / `relayServerInit` plumbing is unchanged.

### Dependency hygiene — checked, benign
- `@libp2p/dcutr@3.0.21` / `@libp2p/autonat@3.0.21` require `@libp2p/interface@^3.2.x`, but db-p2p pins `@libp2p/interface@^3.1.0` (resolves to `3.1.0`, matching `libp2p@3.1.3`). yarn therefore nested a second copy `@libp2p/interface@3.2.3` under dcutr/autonat. This is install bloat but **not** a runtime hazard: the only cross-package coupling is via the global `Symbol.for` capability tags above, which dedupe regardless of package copy. Build is clean, node starts, all tests pass. Bumping the `@libp2p/interface` floor to `^3.2.3` would dedupe the tree but was intentionally left out of this review pass to avoid lockfile churn; noting it for a future dependency-maintenance sweep, not filing.

### Tests
- `yarn workspace @optimystic/db-p2p build` — clean (tsc, no errors).
- `yarn workspace @optimystic/db-p2p test` — **485 passing, 8 pending** (slow/integration specs gated; gating verified correct). Smoke spec passes both cases.
- Gated `dcutr-direct-upgrade` run with `RUN_LONG_TESTS=1` — **passes, but via the weak fallback**. Re-confirmed the implementer's account: over loopback the direct upgrade was NOT observed within the 60s poll; the connection stayed `/p2p-circuit` and the test fell back to asserting only "a relayed connection exists + `services.dcutr` wired".
  - **Finding (test quality, major)**: as written, that fallback would also pass if DCUtR were *misconfigured or removed*, so the gated spec does not actually verify the hole-punch behavior in any environment available here. This is a documented test-environment limitation, not evidence DCUtR is broken (the wiring is independently proven by the always-run smoke spec). **Disposition: filed `tickets/backlog/harden-dcutr-direct-upgrade-test.md`** to harden the assertion to an unconditional direct-upgrade check in a NAT'd / multi-host CI environment where hole-punching actually fires.

### DRY / style — minor, not actioned
- `dcutr-direct-upgrade.spec.ts` duplicates small helpers (`spawnRelayNode`, `waitForCircuitListen`, `pickRelay*Addr`) that also exist in `circuit-relay-long-lived.spec.ts`. The copies diverge per spec (different transports, TCP-vs-WS relay-addr picking), so extracting a shared test util would couple two otherwise-independent specs for little gain. Left as-is; noted for the hardening ticket to consider if it grows a third copy.

### Docs — checked, no update required for this change
- Read every file the change touches plus the candidate doc surfaces. No existing doc (`docs/architecture.md`, `docs/internals.md`, `packages/db-p2p/readme.md`) enumerates the built-in libp2p service set, so the DCUtR/AutoNAT addition has nowhere to fall out of date. The change is self-documented by the inline comment in `libp2p-node-base.ts`. The `readme.md` libp2p examples (lines ~318–351) are pre-existingly illustrative/stale (they show a `services:` option that `NodeOptions` does not accept) — unrelated to this ticket, left untouched.

### Out-of-scope anomaly found in the working tree — flagged, NOT touched
While checking the working tree I found a **coherent body of uncommitted work unrelated to this ticket**, sitting on top of HEAD:
- `packages/db-p2p/src/cluster/cluster-error.ts` (new, untracked) — structured cluster-error envelope (`__clusterError`, `toClusterErrorEnvelope`, `clusterErrorFromEnvelope`).
- `packages/db-p2p/src/cluster/service.ts` (M) — imports/uses `toClusterErrorEnvelope`.
- `packages/db-p2p/src/cluster/client.ts` (M) — imports `clusterErrorFromEnvelope` and rethrows on the coordinator side.
- `docs/architecture.md` (M) — cluster protocol-prefix rename (`/db-p2p/cluster` → `/{prefix}/cluster`).

This belongs to the cluster protocol / `optimystic-cluster-membership-check` line of work, not DCUtR/AutoNAT. HEAD `client.ts` does **not** import `cluster-error.js` and HEAD has no `cluster-error.ts`, so HEAD is self-consistent; the working tree adds this feature additively. It builds and the full suite passes with it present (so it did not distort the validation above). I deliberately left these files **untouched** — deleting would destroy real in-progress work, and committing is the runner's job, not mine. **Disposition: filed `tickets/backlog/land-orphaned-cluster-error-envelope.md`** so the work is properly reviewed and landed under its own ticket. Reviewer/runner note: if the post-ticket commit sweeps these four files into this DCUtR commit, they should be split back out under that ticket.

## Net assessment
The in-scope DCUtR/AutoNAT change is minimal, correct, and inert-safe; build + the always-run suite are green. Two follow-ups filed (gated-test hardening; orphaned cluster-error work). No inline fixes were required within this ticket's scope.
