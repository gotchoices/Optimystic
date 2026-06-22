description: A node's churn re-replication is now switched on at startup and fed the blocks the node holds, so when a peer disconnects the survivors re-push the data and the replica count is preserved.
files: packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/spread-on-churn-node-wiring.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts
difficulty: medium
----

# Complete: Wire SpreadOnChurnMonitor into the node + track owned blocks

## Summary of implemented work

`SpreadOnChurnMonitor` (the churn-resilient spread protocol) was inert on a live node. This change
activates the **sending** side end-to-end:

- `NetworkManagerService.initSpreadOnChurnMonitor(...)` now threads the node's `protocolPrefix`
  (`/optimystic/<networkName>`) into `SpreadOnChurnDeps`, so churn pushes dial the same
  block-transfer protocol the node registers its receive handler under (a missing prefix dialed `''`
  and every push failed).
- `performSpread` self-prunes a tracked block when `repo.get` reports no local data, bounding the
  tracked set to blocks actually held.
- `createLibp2pNodeBase` inits + starts the monitor with the local `storageRepo`, `keyNetwork`,
  `clusterSize`, and `protocolPrefix`; feeds it owned blocks via `storageRepo.onAnyCollectionChange`
  (commits **and** received replicas); exposes it as `node.spreadOnChurnMonitor`; tears it down in a
  `node.stop` wrapper. `spreadOnChurn: { enabled: false }` skips the whole block. Init failure is
  non-fatal (logged, spread inert).

See commit `19bbb0c` (`ticket(implement): optimystic-spread-on-churn-monitor-wiring`) for the
implement-stage diff; the review-stage fixes below are in the working tree at handoff.

## Review findings

### What was checked
- Implement-stage diff read first, fresh, before the handoff summary.
- `protocolPrefix` call-site value vs the registered block-transfer handler — **match** confirmed
  (`/optimystic/<networkName>/db-p2p/block-transfer/1.0.0`).
- Owned-block feed subscribes to `storageRepo` (not `node.blockChangeNotifier`) — confirmed
  (`libp2p-node-base.ts:684`). Verified `saveReplicatedBlock` emits `onAnyCollectionChange` when a
  replica advances, so received replicas are tracked too.
- `enabled: false` registers no monitor / no `connection:close` listener — confirmed by logic
  (start() never runs → no listener) and by the node-wiring spec.
- Self-prune correctness (deleting the current `for...of` Set element) — correct per spec.
- Stop-wrapper composition + idempotency — confirmed; `NetworkManagerService.stop()` also stops the
  monitor, both teardown paths are idempotent (no double-stop throw).
- EOL: the handoff worried about mixed CRLF/LF; in the tree all touched files are uniformly **LF**
  and `git show --check` flagged no whitespace errors. Non-issue.
- Type safety / error handling / resource cleanup — `(node as any)` casts match surrounding code;
  init failure non-fatal; subscription released + monitor stopped on stop.
- **Lint:** none configured for the package (`yarn lint` is a project-wide echo placeholder); `tsc`
  via `yarn build` is the typecheck and passes.
- **Tests:** `yarn build` ✅; `yarn test` ✅ **1022 passing, 33 pending** (unchanged); full env-gated
  integration suite (`OPTIMYSTIC_INTEGRATION=1`) ✅ **8 passing**, including the new churn case run
  4× with no flakiness (~0.6–0.9s each).

### MAJOR — found and FIXED inline

**Block-transfer receive path was completely broken over real libp2p — the linchpin that made this
ticket's feature non-functional e2e.** The handoff flagged the env-gated churn integration test as
"NOT run during implement … may be flaky." It was not flaky — it **hung for 90s**, exposing a
pre-existing defect in `block-transfer-service.ts` (a file this ticket did not otherwise touch; its
existing tests only call `handlePush`/`handlePull` directly, so the real-stream path had **never**
been exercised). Two compounding bugs:

1. **Wrong stream-handler signature.** libp2p invokes the `registrar.handle` callback with the
   `Stream` as the **first positional argument** (as cluster/repo/dispute services all do). The
   handler read `data.stream`, which is `undefined` for that shape → `pipe(undefined, …)` →
   "Empty pipeline" → the receiver never replied.
2. **Read-to-end deadlock.** Even with the stream in hand, `readRequest` drained the source until
   end-of-stream, but the client sends one length-prefixed request and holds its write side open
   awaiting the reply — so the receiver blocked forever and its reply (written only at teardown) hit
   a closed stream.

Fix: ported the proven **single continuous duplex pipe** pattern from `cluster/service.ts` into
`block-transfer-service.ts` `handleRequest` (read → process → `yield` one response on the same
stream), unwrapped the positional stream arg defensively (mirroring `sync/service.ts`), and removed
the now-orphaned `readRequest`/`sendResponse`. This is a strict improvement (the receive path was
100% dead before) and also un-breaks block-transfer for rebalance/recovery clients. Verified: the
churn re-replication integration test now passes deterministically; full unit + integration suites
green.

### MAJOR — filed as a new ticket

**`block-transfer-response-deadline-and-roundtrip-regression`** (`tickets/fix/`):
- The spread push has **no response-read deadline** — `ProtocolClient.processMessage` bounds only
  the dial, not the response read. A peer that dials OK but never responds hangs `pushBlocks`, and
  since `performSpread` awaits each target serially, one such peer stalls the whole spread pass.
  (This is the *unresponsive-peer* hang; the inline fix above only removed the *happy-path* hang.)
- The block-transfer real-stream round trip has **no default-suite regression test** — only the
  env-gated churn integration test covers it, so a future handler-framing regression would pass
  `yarn test` silently. The ticket adds a non-gated round-trip + no-response test.

### MINOR — reviewed, accepted, no action (documented)

- **Pre-existing/at-startup blocks not re-tracked** until next touched (`onAnyCollectionChange` only
  fires on new commits/replicas; the same applies to transactions recovered during startup, which
  run before the feed subscribes). Acceptable: churn re-replication re-derives over time. An
  initial-scan enhancement is the backlog ticket
  `optimystic-rebalance-monitor-wiring-shared-tracked-set`.
- **`trackedBlocks` growth** is bounded by blocks held locally, pruned lazily on spread — an
  accepted design tradeoff, same backlog ticket covers unification with the rebalance tracked-set.
- **Responsibility-loss eviction (`lost`) deferred** — memory is bounded by the self-prune;
  correctness relies on `performSpread`'s `rank >= effectiveD` + no-local-data guards (tracking a
  superset never causes a wrong push). Reasoning confirmed.
- **`RebalanceMonitor` remains inert** — out of scope, untouched.
- Heavy `(node as any)` casts in the wiring match the existing surrounding style.

## Validation commands

From `packages/db-p2p`:
- `yarn build`
- `yarn test` → 1022 passing, 33 pending
- `OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/real-libp2p.integration.spec.ts" --reporter spec` → 8 passing
