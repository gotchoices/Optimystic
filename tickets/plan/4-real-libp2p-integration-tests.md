description: Add a small suite of integration tests that exercise the stack over a real libp2p transport (not MockPeerNetwork / MockMeshKeyNetwork). The "dial self and hang with no listen addrs" class of bug from ticket 4 can only manifest against real libp2p — mocks turn hangs into silent no-ops. Keep the suite small and gated so it doesn't slow every-PR CI.
dependencies:
  - tickets/complete/4-solo-node-schema-ddl-deadlock.md (the motivating hang)
  - tickets/plan/2-fresh-node-ddl-integration-harness.md (shares the cold-start scenarios; real-libp2p is the transport substitution)
files:
  - packages/db-p2p/src/libp2p-node.ts (real-libp2p node factory)
  - packages/db-p2p/src/libp2p-node-base.ts (shared base; wires RestorationCoordinator)
  - packages/db-p2p/src/libp2p-key-network.ts (findCoordinator over real DHT/FRET)
  - packages/db-p2p/test/mesh-harness.ts (current mock-based harness; the new tests complement it)
  - packages/db-p2p/test/mesh-sanity.spec.ts (Suite 0 solo-node seed to mirror on real libp2p)
  - new: packages/db-p2p/test/real-libp2p.integration.spec.ts
----

## Motivation

The repo's network-level tests (`mesh-sanity`, `cluster-repo`, `coordinator-repo-*`, `spread-on-churn`, `byzantine-fault-injection`, etc.) all run against `MockPeerNetwork` + `MockMeshKeyNetwork` in `mesh-harness.ts`. This is fast and reproducible but hides a whole class of transport-level bugs:

- **Dial-to-self hangs.** The original ticket 4 symptom (solo node, no listen addrs, `RestorationCoordinator` dials itself and blocks forever) is invisible under the mock, because `MockPeerNetwork.connect()` returns `{}` synchronously.
- **Bootstrap-list handling.** Empty bootstrap, single-entry bootstrap, unreachable bootstrap — the mock doesn't distinguish.
- **Transport errors.** Connection resets, timeouts, multi-address selection, NAT / relay fallback — none exercised.
- **Peer discovery timing.** Mock tests pre-register peer metadata; the real DHT/FRET populate asynchronously and code that assumes "someone is always there" can break.
- **Listen-addr variants.** "No listen addrs" (mobile), "memory transport only" (test), "TCP localhost only" (dev), "WebSocket" (browser/RN) — each has been a source of bugs in practice.

Mocks stay. Real-transport tests are additive: a small, targeted suite that ensures the production transport wiring is intact.

## Specification

A new `packages/db-p2p/test/real-libp2p.integration.spec.ts` using actual libp2p with an in-memory transport (or TCP on ephemeral ports). Tests must be:

- **Gated**: runnable as `npm run test:integration` or behind an env flag, not the default `npm test`. We keep CI fast for the unit suite.
- **Timed out**: every test has an explicit ≤10s timeout. A hang must fail the test, not the suite.
- **Cleaned up**: every test stops its libp2p nodes in `afterEach` unconditionally — orphaned nodes between tests are a known source of flake.

### Scenarios

- **Solo node, empty bootstrap, no listen addrs** (ticket-4 reproducer). Construct via `createLibp2pNode({ bootstrapNodes: [], listenAddrs: [], clusterSize: 1 })`. Pend + commit + get the schema block. Must complete within timeout — not hang.
- **Solo node, memory transport, listen on mem addr**. Same flow, but with a working listen addr. Verify the "someone could connect" variant doesn't regress.
- **Two-node mesh over memory transport**. Node A bootstraps, Node B connects via A's multiaddr. Pend on A, get from B. Exercises real DHT/FRET handshake.
- **Three-node mesh with one peer dropped at boot**. Start three nodes, immediately stop one, perform DDL on the remaining two. Exercises real bootstrap-list resilience.
- **Cold-restart over real transport**. Start node, pend, commit, stop node, restart over the same raw storage, read the block back. Complements the in-process cold-restart in the main harness ticket.

Each test asserts *both* success and no-hang (per-test timeout). The smoke test is intentionally narrow — not a replacement for mock-based coverage, just a transport-wiring sanity check.

## Expected outcomes

- Regression protection for the ticket-4 class (dial-to-self, no-listen-addrs, empty-bootstrap).
- Early warning for libp2p version bumps / breaking changes in transport, DHT, or FRET wiring.
- Confidence that the `createLibp2pNode` factory + `RestorationCoordinator` + `Libp2pKeyPeerNetwork.findCoordinator` produce a working node without a mock in the loop.

## Out of scope

- Browser / React Native / mobile transports. Those have their own environment constraints and deserve a separate harness.
- Byzantine / adversarial-peer scenarios — those belong in `byzantine-fault-injection.spec.ts` against the mock where behavior is deterministic.
- Performance benchmarking. Real-transport latency is noisy by design; this suite is correctness-only.
- Promoting this suite to block every PR. It stays gated; a nightly or pre-release run is sufficient.

## Open questions for implement

- Memory transport vs. TCP on ephemeral ports — which is less flaky on Windows + macOS + Linux CI? (Suggest memory transport first; fall back to TCP only if memory-transport semantics differ meaningfully from production.)
- Should this live in `packages/db-p2p/test/` or in a new `packages/integration-tests/` workspace alongside the fresh-node-ddl harness from ticket 2? If the latter becomes its own package, move this there too.
