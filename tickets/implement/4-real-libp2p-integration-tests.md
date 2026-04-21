description: Add a small, gated suite of real-libp2p integration tests in `packages/db-p2p/test/real-libp2p.integration.spec.ts`. Covers the ticket-4 "solo node / no listen addrs / dial-self hang" class of regression plus a handful of multi-node transport-wiring sanity checks. Runs against actual libp2p (TCP on ephemeral ports), not MockPeerNetwork / MockMeshKeyNetwork.
dependencies:
  - tickets/complete/4-solo-node-schema-ddl-deadlock.md (the motivating hang)
  - tickets/plan/2-fresh-node-ddl-integration-harness.md (parallel; this ticket does not block it)
  - @libp2p/tcp (already a dependency — no new deps required)
files:
  - packages/db-p2p/test/real-libp2p.integration.spec.ts (new)
  - packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts (reference pattern — real-libp2p test using `port: 0`, `bootstrapNodes: []`, cleanup via `afterEach` calling `node.stop()`)
  - packages/db-p2p/test/mesh-sanity.spec.ts (reference pattern — shape of pend/commit/get assertions mirrored over real transport)
  - packages/db-p2p/src/libp2p-node.ts (factory — `createLibp2pNode(options: NodeOptions): Promise<Libp2p>`; see lines 13–20)
  - packages/db-p2p/src/libp2p-node-base.ts (NodeOptions shape; `bootstrapNodes`, `listenAddrs`, `port`, `clusterSize`, `clusterPolicy`, `networkName`, `fretProfile`; lines 50–111)
  - packages/db-p2p/src/libp2p-key-network.ts (Libp2pKeyPeerNetwork — `findCoordinator` over real DHT/FRET)
  - packages/db-p2p/package.json (add `test:integration` script)
----

## Goal

Produce one new test file that exercises the production transport wiring (`createLibp2pNode` + `RestorationCoordinator` + `Libp2pKeyPeerNetwork`) end-to-end over real libp2p, targeting the specific transport-level bug classes that mock-based tests cannot catch. Keep the suite narrow: it is a transport-wiring smoke test, not a replacement for mock-based coverage.

## Design decisions (resolving the plan's open questions)

- **Transport: TCP on ephemeral ports (`port: 0`).** `@libp2p/memory` is not a current dependency, and `fresh-node-ddl-libp2p.spec.ts` already demonstrates a working real-libp2p boot with `port: 0` + empty bootstrap. Reuse that pattern — no new transport dependency.
- **Location: `packages/db-p2p/test/`.** The `packages/integration-tests/` workspace proposed in ticket 2 does not yet exist. Place the file alongside the existing `fresh-node-ddl-libp2p.spec.ts`. If ticket 2 lands and consolidates integration tests into a separate workspace, move this file then.
- **Gating: environment variable `OPTIMYSTIC_INTEGRATION=1`.** Simplest, does not require changing the mocha glob and keeps the file discoverable with the rest. The spec's top-level `before()` hook calls `this.skip()` unless the env var is set. Also add a `test:integration` script to `packages/db-p2p/package.json` that sets the env var and runs mocha with the same glob (mocha skips files where the top-level suite is skipped, so the cost is just loading the file).

## File layout

`packages/db-p2p/test/real-libp2p.integration.spec.ts`:

```
describe('Real libp2p integration', function () {
  this.timeout(30_000);           // boot + arachnode init dominates budget; individual ops ~seconds

  before(function () {
    if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
  });

  // Each test tracks its own nodes[] and calls stop() unconditionally in afterEach.
  let nodes: Libp2p[] = [];
  afterEach(async () => {
    await Promise.allSettled(nodes.map(n => n.stop()));
    nodes = [];
  });

  // --- scenarios below ---
});
```

Helper (local to the file): `spawnNode(overrides): Promise<Libp2p>` wrapping `createLibp2pNode` with the common config (`networkName: 'real-libp2p-it'`, `clusterSize: 1` unless overridden, `clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 }`, `arachnode: { enableRingZulu: true }` matching `fresh-node-ddl-libp2p.spec.ts:28-42`). Pushes the node onto `nodes[]` before returning.

Helper: `pendCommitGet(node, blockId, actionId, rev)` to avoid repeating the three-call sequence from `mesh-sanity.spec.ts:34-45`.

## Scenarios (each an `it()` with its own per-test timeout — 10s for ops, leaving the 30s suite timeout as a ceiling for boot)

- **Solo node, empty bootstrap, no listen addrs (ticket-4 reproducer).**
  Construct `createLibp2pNode({ port: 0, listenAddrs: [], bootstrapNodes: [], clusterSize: 1, ... })`.
  Pend + commit + get a schema block. Assert all three return `success`/correct payload within 10s (a hang = test failure via mocha timeout).
  Also explicitly assert `result[blockId]?.block?.header.id === blockId` to match `mesh-sanity.spec.ts:45`.

- **Solo node, default TCP listen addr (`port: 0`).**
  Same flow, but without `listenAddrs: []` — falls through to the default `/ip4/0.0.0.0/tcp/{port}` path. Verifies the "someone could connect" variant doesn't regress. Same assertions.

- **Two-node mesh over TCP.**
  Spawn node A with `port: 0` and empty bootstrap. Spawn node B with `port: 0` and `bootstrapNodes: [<A's listen multiaddr>]`. (Read A's multiaddrs via `node.getMultiaddrs().map(a => a.toString())`.) Wait briefly for peer discovery (`await waitForPeers(B, 1, 5_000)` — poll-based helper, no arbitrary sleep). Pend on A → get from B. Assert the block is observable on B within 10s. This exercises the real DHT/FRET handshake.

- **Three-node mesh with one peer dropped at boot.**
  Spawn A, B, C with C bootstrapped off A. Immediately `await C.stop()`. Pend + commit on A with `clusterSize: 2` (A+B), then get from B. Asserts that the remaining two-node mesh makes progress when one bootstrap peer disappears mid-join. If 2-node cluster semantics require `superMajorityThreshold: 0.51`, set it explicitly (mirroring `mesh-sanity.spec.ts:28`).

- **Cold-restart over real transport.**
  Use a shared `MemoryRawStorage` (import from `packages/db-p2p/src/storage/`) passed as `storage` option to both spawns. Spawn node, pend+commit, `await node.stop()`. Spawn a new node with the same `storage` and confirm `coordinatorRepo.get` returns the block. Identity persistence (libp2p `privateKey` option) is only required if the cold-restart path depends on peerId stability — note this in the test as a comment; if tests pass without it, omit.

Each test must assert both the positive outcome (success / expected data) and implicit no-hang (mocha per-test timeout). A hang must fail the test, not the suite.

## Open points the implementer may encounter

- **Peer-discovery timing helper.** No `waitForPeers` exists today. Implement locally in the spec file as a bounded poll on `node.getPeers().length >= n` with 100 ms ticks and a 5 s ceiling. Do not use `setTimeout(resolve, N)`.
- **Multiaddr selection for bootstrap.** `node.getMultiaddrs()` returns all announced addrs including `/ip4/127.0.0.1/...` and possibly LAN addrs. Pick the first that starts with `/ip4/127.0.0.1/tcp/` to keep the test LAN-free.
- **Shared storage for cold-restart.** Check `packages/db-p2p/src/storage/` for a `MemoryRawStorage` export (referenced in `libp2p-node-base.ts:113-118`). If it can be constructed externally and passed through `NodeOptions.storage`, reuse it; if not, document the gap and skip that test behind `it.skip` rather than inventing a new abstraction.
- **Windows + macOS + Linux flake.** `port: 0` TCP binding is portable; the existing `fresh-node-ddl-libp2p.spec.ts` already runs on the same matrix. If a scenario proves flaky, mark `.skip` and file a follow-up rather than adding retries.

## Gating details

In `packages/db-p2p/package.json`, add to `scripts`:

```json
"test:integration": "cross-env OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \"test/**/*.integration.spec.ts\" --colors --reporter spec"
```

If `cross-env` is not already in devDependencies (check first — likely not), use a POSIX-compatible inline form or add it. Simpler path: since Windows CI is not currently the gating factor, use `OPTIMYSTIC_INTEGRATION=1 node ...` and note the Windows form in a comment; developers on Windows can set it via `set` or `$env:`.

The default `npm test` script stays unchanged and will pick up the file (the top-level suite skips cheaply when the env var is unset).

## Non-goals

- Browser / React Native / mobile transports (separate harness).
- Byzantine / adversarial-peer scenarios (stay on mock for determinism).
- Performance or latency benchmarks.
- Promoting to every-PR CI. Nightly / pre-release is sufficient.

## TODO

- Create `packages/db-p2p/test/real-libp2p.integration.spec.ts` with the five scenarios above, the env-var gate, and the `afterEach` cleanup.
- Extract `spawnNode`, `pendCommitGet`, and `waitForPeers` as local helpers in the spec file (not exported — this is the only real-libp2p test file; if a second arrives, promote then).
- Add `test:integration` script to `packages/db-p2p/package.json`. Decide on `cross-env` vs. documented platform-specific env-var invocation; prefer no new dep if the bash form suffices for current CI.
- Run `OPTIMYSTIC_INTEGRATION=1 npm run test:integration --workspace @optimystic/db-p2p` locally and confirm all five scenarios pass within the 30 s suite timeout.
- Run default `npm test --workspace @optimystic/db-p2p` and confirm the new file is skipped (no regression to the fast unit suite).
- Run `npm run build --workspace @optimystic/db-p2p` and confirm no TypeScript errors introduced.
- If the cold-restart scenario cannot be implemented cleanly (no shared-storage path through `NodeOptions`), leave it as `it.skip` with a comment linking back to ticket 2 (fresh-node-ddl-integration-harness) rather than inventing a new API.
