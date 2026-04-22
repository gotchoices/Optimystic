description: Gated real-libp2p integration spec exercising `createLibp2pNode` over actual TCP (not MockPeerNetwork / MockMeshKeyNetwork). Covers ticket-4 "solo node / no listen addrs / dial-self hang" reproducer plus four multi-node transport-wiring smoke scenarios. Default `npm test` skips via `OPTIMYSTIC_INTEGRATION=1` gate; `npm run test:integration` runs it.
dependencies:
  - tickets/complete/4-solo-node-schema-ddl-deadlock.md (motivating regression class)
files:
  - packages/db-p2p/test/real-libp2p.integration.spec.ts (five scenarios, local helpers, env-var gate)
  - packages/db-p2p/package.json (`test:integration` script)
  - packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts (reference pattern — same real-libp2p boot config)
  - packages/db-p2p/test/mesh-sanity.spec.ts (reference pattern — pend/commit/get shape)
  - packages/db-p2p/src/libp2p-node.ts, libp2p-node-base.ts (factory and NodeOptions surface)
----

## What was built

A gated integration spec at `packages/db-p2p/test/real-libp2p.integration.spec.ts`. The suite uses a top-level `before()` hook that calls `this.skip()` unless `process.env.OPTIMYSTIC_INTEGRATION` is set. When set, five `it()` scenarios boot real libp2p nodes with TCP + arachnode + FRET.

Local helpers (colocated; not exported):
- `spawnNode(overrides)` — wraps `createLibp2pNode` with the common config (`port: 0`, empty bootstrap, `networkName: 'real-libp2p-it'`, `clusterSize: 1`, `arachnode.enableRingZulu: true`) and tracks the node in a per-test `nodes[]` array for guaranteed cleanup.
- `pendCommitGet(repo, blockId, actionId, rev)` — three-call sequence with positive assertions.
- `pickLocalTcpMultiaddr(node)` — prefers `/ip4/127.0.0.1/tcp/…` to keep the test LAN-free.
- `waitForPeers(node, minPeers, timeoutMs)` — event-driven (`peer:connect`) with a timeout; no arbitrary sleeps.

Cleanup in `afterEach` snapshots `nodes`, clears the array, then runs `Promise.allSettled(toStop.map(n => n.stop()))` unconditionally so one failing test cannot leak sockets. Scenarios that stop a node mid-body splice that node out of `nodes[]` to avoid double-stop.

## Scenarios (each with its own `it()` timeout; 30 s suite ceiling)

1. **Solo node, empty bootstrap, `listenAddrs: []`** — ticket-4 reproducer. Hang = mocha timeout = test failure.
2. **Solo node, default TCP listen addr (`port: 0`)** — exercises the default `/ip4/0.0.0.0/tcp/{port}` path.
3. **Two-node mesh over TCP** — B bootstraps off A's local TCP multiaddr. Asserts A.pend/commit then B.get returns a defined entry (smoke: "no transport hang, no error"; replication is probabilistic).
4. **Three-node mesh with one peer dropped at boot** — C is stopped immediately to simulate a bootstrap peer that vanishes mid-join. `clusterSize: 2` with `superMajorityThreshold: 0.51` so A+B progress. Asserts pend + commit + cross-node get.
5. **Cold-restart over real transport with shared storage** — shared `MemoryRawStorage` and persisted `privateKey` (Ed25519) across two `createLibp2pNode` invocations. Exercises identity persistence + storage restoration over real transport.

## Verification

- `node … mocha "test/real-libp2p.integration.spec.ts"` without env var → 0 passing, 5 pending (gate works).
- `OPTIMYSTIC_INTEGRATION=1 node … mocha "test/real-libp2p.integration.spec.ts"` → 5 passing in ~2 s.
- `npm test --workspace @optimystic/db-p2p` → 417 passing, 7 pending (5 new + 2 pre-existing); no regression to the fast unit suite.
- `npm run build --workspace @optimystic/db-p2p` → clean.

## Usage

```
# POSIX
npm run test:integration --workspace @optimystic/db-p2p

# Windows (PowerShell)
$env:OPTIMYSTIC_INTEGRATION=1; npm run test:integration --workspace @optimystic/db-p2p

# Windows (cmd)
set OPTIMYSTIC_INTEGRATION=1 && npm run test:integration --workspace @optimystic/db-p2p
```

Default `npm test` continues to skip the suite — CI fast lane unaffected.

## Notes carried forward

- Scenario 3's B-side get asserts `expect(bResult[blockId]).to.exist` rather than matching header content, because cross-node replication through FRET/RestorationCoordinator is probabilistic at this smoke level. If a deterministic cross-node read is required, tighten the assertion in a follow-up.
- The `as any` cast on `commit()` is because `CoordinatorRepo.commit` takes the full `CommitRequest` (with `tailId`), while `IRepo.commit` is typed to `RepoCommitRequest`. Existing specs (e.g. `mesh-sanity.spec.ts`) avoid the cast by typing the repo as `CoordinatorRepo` directly. Left as-is here to keep the spec decoupled from the concrete type.
- Promote the local helpers (`spawnNode`, `pendCommitGet`, `pickLocalTcpMultiaddr`, `waitForPeers`) into a shared harness module once a second real-libp2p spec lands.

## Non-goals

- Browser / React Native / mobile transports.
- Byzantine / adversarial-peer scenarios (mocks give determinism).
- Performance or latency benchmarks.
- Promotion to every-PR CI.
