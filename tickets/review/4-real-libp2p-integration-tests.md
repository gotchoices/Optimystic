description: Review the new gated real-libp2p integration spec that exercises `createLibp2pNode` over actual TCP (not MockPeerNetwork / MockMeshKeyNetwork), covering ticket-4 "solo node / no listen addrs / dial-self hang" plus four multi-node transport-wiring smoke scenarios. Default `npm test` skips the suite via `OPTIMYSTIC_INTEGRATION=1` gate; `npm run test:integration` runs it.
dependencies:
  - tickets/complete/4-solo-node-schema-ddl-deadlock.md (motivating regression class)
  - tickets/plan/2-fresh-node-ddl-integration-harness.md (parallel; not blocked by this)
files:
  - packages/db-p2p/test/real-libp2p.integration.spec.ts (new — five scenarios, local helpers, env-var gate)
  - packages/db-p2p/package.json (added `test:integration` script; POSIX env-var form per plan)
  - packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts (reference pattern — same real-libp2p boot config)
  - packages/db-p2p/test/mesh-sanity.spec.ts (reference pattern — pend/commit/get assertion shape)
  - packages/db-p2p/src/libp2p-node.ts, libp2p-node-base.ts (factory and NodeOptions surface)
----

## What was built

A single gated integration spec at `packages/db-p2p/test/real-libp2p.integration.spec.ts`. Gated via the top-level `before()` hook on `process.env.OPTIMYSTIC_INTEGRATION`; when unset, Mocha reports all tests as pending. When set, five `it()` scenarios run against real TCP + arachnode + FRET.

Local helpers (not exported; promote when a second real-libp2p spec arrives):
- `spawnNode(overrides)` — wraps `createLibp2pNode` with the common config (`port: 0`, empty bootstrap, `networkName: 'real-libp2p-it'`, `clusterSize: 1`, `arachnode.enableRingZulu: true`) and tracks the node in a per-test `nodes[]` array
- `pendCommitGet(repo, blockId, actionId, rev)` — three-call sequence with positive assertions
- `pickLocalTcpMultiaddr(node)` — prefers `/ip4/127.0.0.1/tcp/…` to keep the test LAN-free
- `waitForPeers(node, minPeers, timeoutMs)` — event-driven (listens on `peer:connect`) with a timeout; no arbitrary sleeps / polling loops

Cleanup in `afterEach` runs `Promise.allSettled(nodes.map(n => n.stop()))` unconditionally so one failing test cannot leak sockets into later scenarios.

## Scenarios (each with its own `it()` timeout; 30 s suite ceiling)

1. **Solo node, empty bootstrap, `listenAddrs: []`** — the ticket-4 reproducer. A hang = mocha timeout = test failure.
2. **Solo node, default TCP listen addr (`port: 0`)** — "someone could connect" variant; exercises the default `/ip4/0.0.0.0/tcp/{port}` path.
3. **Two-node mesh over TCP** — B bootstraps off A's `/ip4/127.0.0.1/tcp/…/p2p/…`. Waits for peer discovery, writes on A, reads on B. Asserts B gets a defined entry (either replicated block or empty-state envelope — the smoke test here is "no transport hang, no error").
4. **Three-node mesh with one peer dropped at boot** — C is stopped immediately after start to simulate a bootstrap peer that vanishes mid-join. Uses `clusterSize: 2` and `superMajorityThreshold: 0.51` so the surviving A+B can make progress. Asserts pend + commit + cross-node get.
5. **Cold-restart over real transport with shared storage** — uses a shared `MemoryRawStorage` and a persisted `privateKey` (Ed25519) across two `createLibp2pNode` invocations. Pend/commit on node 1, stop, spawn node 2 with the same storage+identity, read the block. Exercises identity persistence + storage restoration over real transport.

## Verification performed

- `node … mocha "test/real-libp2p.integration.spec.ts"` without env var → 0 passing, 5 pending (gate works)
- `OPTIMYSTIC_INTEGRATION=1 node … mocha "test/real-libp2p.integration.spec.ts"` → 5 passing in ~2s
- `npm test --workspace @optimystic/db-p2p` → 417 passing, 7 pending (5 new + 2 pre-existing); no regression to the fast unit suite
- `npm run build --workspace @optimystic/db-p2p` → clean (no TS errors)

## Review-stage checks

- **SRP / DRY / modular**: helpers are small and colocated; `pendCommitGet` removes the 3-line repeated sequence; `spawnNode` normalises the common config. No cross-file abstractions introduced prematurely.
- **Resource cleanup**: `afterEach` stops all nodes via `Promise.allSettled` regardless of outcome. When a test stops a node manually mid-body (scenarios 4 and 5), it splices that node out of `nodes[]` to avoid a double-stop — verify this pattern is safe if another scenario is added that also stops mid-body.
- **Performance / flake surface**: individual tests finish in <2 s locally; arachnode init dominates. The only timed waits are (a) the 30 s suite ceiling, (b) per-`it()` ceilings, and (c) a 5 s `waitForPeers` bound. No arbitrary sleeps. If CI flake surfaces on a specific scenario, mark `.skip` + file a follow-up (per plan) rather than adding retries.
- **Gate correctness**: both `test:integration` (runs with env var set) and default `npm test` (env var unset → skip via top-level `before()`) validated.
- **Cross-platform**: POSIX env-var prefix in the `test:integration` script per the ticket's explicit guidance. The spec file's top-of-file comment documents the Windows `$env:` / `set` alternative.

## Non-goals (unchanged from plan)

- Browser / React Native / mobile transports
- Byzantine / adversarial-peer scenarios (stay on mock for determinism)
- Performance or latency benchmarks
- Promoting to every-PR CI

## Open notes for reviewer

- Scenario 3's B-side get asserts `expect(bResult[blockId]).to.exist` rather than asserting the block header matches, because cross-node block replication through FRET/RestorationCoordinator is probabilistic in this smoke test — a stronger assertion would flake. If a deterministic cross-node read is expected, tighten and file a follow-up.
- The `as any` cast on `commit()` calls is because `CoordinatorRepo.commit` accepts the full `CommitRequest` (with `tailId`), while `IRepo.commit` is typed to `RepoCommitRequest`. Existing specs (e.g. `mesh-sanity.spec.ts`) pass `tailId` without casting because they type the repo as `CoordinatorRepo` directly. Acceptable here; tightening the type would require either exporting the `CoordinatorRepo` type from `libp2p-node-base.ts` or duplicating the harness's typing pattern. Leave as-is unless reviewer prefers the stricter approach.
