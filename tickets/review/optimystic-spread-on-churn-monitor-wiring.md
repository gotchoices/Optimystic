description: A node's churn re-replication is now switched on at startup and fed the blocks the node holds, so when a peer disconnects the survivors re-push the data and the replica count is preserved.
files: packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/spread-on-churn-node-wiring.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts
difficulty: medium
----

# Review: Wire SpreadOnChurnMonitor into the node + track owned blocks

## What was implemented

`SpreadOnChurnMonitor` (the churn-resilient spread protocol) was previously **inert on a live
node**: `NetworkManagerService.initSpreadOnChurnMonitor(...)` existed but nothing called it,
nothing called `monitor.trackBlock(...)`, and `createLibp2pNodeBase` never instantiated/started it.
This change activates the **sending** side end-to-end.

### Phase 1 — plumbing + monitor (`spread-on-churn.ts`, `network-manager-service.ts`)

- **`protocolPrefix` is now threaded through** `NetworkManagerService.initSpreadOnChurnMonitor(...)`
  as a **required** 5th param (before the optional `config`) into `SpreadOnChurnDeps.protocolPrefix`.
  This fixes a latent correctness bug: without it, `performSpread`'s `BlockTransferClient` defaulted
  to `protocolPrefix=''` and dialed `buildBlockTransferProtocol('')`, while the node registers the
  handler under `/optimystic/<networkName>` → **every push would fail to dial**.
- **Self-prune in `performSpread`**: when `repo.get` returns no block for a tracked id (the block
  left local storage), the monitor now `trackedBlocks.delete(blockId)` before `continue`, bounding
  the tracked set to blocks actually held locally. (Deleting the current `for...of` Set element is
  safe in V8.)

### Phase 2 — node wiring (`libp2p-node-base.ts`)

- `NodeOptions` gained `spreadOnChurn?: Partial<SpreadOnChurnConfig>`.
- In `createLibp2pNodeBase` (after `coordinatedRepo` is assembled, before the arachnode block):
  the monitor is `init`'d + `start()`ed with `storageRepo` (the **local** repo), `keyNetwork`
  (the `IPeerNetwork`), `clusterSize = options.clusterSize ?? 10`, `protocolPrefix`, and
  `options.spreadOnChurn`.
- **Owned-block feed**: subscribes to `storageRepo.onAnyCollectionChange` **directly** (not
  `node.blockChangeNotifier`, which the cohort-topic block may replace with a decorating bridge) and
  calls `trackBlock(blockId)` for every committed/replicated block id.
- **Non-fatal init**: a wiring failure logs (`db-p2p:spread-on-churn`) and leaves spread inert —
  startup still succeeds (unlike the operator-opted-in cohort-topic block, which hard-fails).
- **`enabled: false`** skips the whole block (no monitor, no `start()`, no subscription, no
  `connection:close` listener) — `node.spreadOnChurnMonitor` is then `undefined`.
- **Disposal**: a `node.stop` wrapper releases the owned-block subscription and stops the monitor
  before transports close, composing with the existing arachnode / clusterMember / cohort-topic
  wrappers. Both steps are idempotent.
- `(node as any).spreadOnChurnMonitor` is exposed for tests/diagnostics.

## How to validate

From `packages/db-p2p`:
- `yarn build` — **passing** (typechecks the new param + `NodeOptions` field across re-exports).
- `yarn test` — full unit suite (integration specs are env-gated and skip). The spread specs:
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/spread-on-churn.spec.ts" "test/spread-on-churn-node-wiring.spec.ts" --reporter spec`
  → **28 passing** at time of handoff.

### Test coverage added (treat as a floor)

- `spread-on-churn.spec.ts`:
  - extended "returns null when block not in local repo" → also asserts `getTrackedBlockCount()`
    drops from 1 → 0 (self-prune).
  - new "protocol prefix" case: constructs with `protocolPrefix: '/optimystic/x'` and asserts the
    mock peerNetwork dialed `buildBlockTransferProtocol('/optimystic/x')` (added a `protocol` field
    to the mock's recorded `PushCall`).
- `spread-on-churn-node-wiring.spec.ts` (NEW, real libp2p solo forming node):
  - monitor started + block-transfer handler registered under `/optimystic/<net>`; an owned-block
    commit pushes `getTrackedBlockCount()` ≥ 1.
  - `node.stop()` invokes `monitor.stop()` (spied) — proves the disposal wrapper drives teardown.
  - `spreadOnChurn: { enabled: false }` → `node.spreadOnChurnMonitor === undefined`, commit still
    succeeds, receive handler still registered.
- `real-libp2p.integration.spec.ts` (NEW, env-gated `OPTIMYSTIC_INTEGRATION=1`): 4-node clusterSize-2
  ring; commit on a 2-member cohort; the owner's `checkNow()` re-pushes to an expansion peer that
  then serves the block from its **own** local storage. Scoped to `checkNow()` (not a real
  `connection:close` + `departureDebounceMs` wait) to stay deterministic and under the idle window.

## Known gaps / things for the reviewer to scrutinize (honest handoff)

1. **The e2e integration test was NOT run during implement.** It is gated behind
   `OPTIMYSTIC_INTEGRATION=1` and stands up real TCP nodes; it may be flaky against live FRET
   topology (the ticket itself flagged this). Please run
   `OPTIMYSTIC_INTEGRATION=1 yarn test:integration` locally and confirm the new churn-replication
   case passes / is not flaky. If it is flaky, the ticket sanctioned scoping it down further (it is
   already scoped to `checkNow()` rather than the debounce timer).
2. **Pre-existing blocks on restart are not re-tracked** until next touched — `onAnyCollectionChange`
   only fires on new commits/replicas, not on startup scan of durable storage. Documented in a code
   comment; an initial-scan enhancement is a follow-on (noted in
   `optimystic-rebalance-monitor-wiring-shared-tracked-set`).
3. **Responsibility-loss eviction (the `lost` signal) is deferred.** Memory is bounded by the
   self-prune; *correctness* relies on `performSpread`'s `rank >= effectiveD` and no-local-data
   guards (tracking a superset never causes a wrong push). Confirm this reasoning holds.
4. **`RebalanceMonitor` remains inert** (out of scope; its unification with the spread tracked-set is
   the backlog ticket above). This change deliberately does not touch it.
5. **Stop-wrapper composition order**: the spread wrapper is installed *before* the arachnode /
   clusterMember / cohort-topic wrappers, so its teardown runs *last* (just before transports close).
   Worth a second look that this ordering is what we want and that a double `node.stop()` is safe.
6. **Source files are mixed EOL** (`spread-on-churn.ts` / `network-manager-service.ts` are CRLF;
   `libp2p-node-base.ts` is LF). Edits preserved each file's existing EOL — verify no stray
   whitespace/line-ending churn slipped into the diff.

## Suggested review checks

- Confirm `protocolPrefix` actually equals `/optimystic/<networkName>` at the call site
  (`libp2p-node-base.ts` `protocolPrefix` const) and matches the registered block-transfer handler.
- Confirm the owned-block feed subscribes to `storageRepo`, not `node.blockChangeNotifier`.
- Confirm `enabled: false` truly registers no `connection:close` listener (the wiring spec asserts
  no monitor; consider whether a stronger libp2p-listener-count assertion is warranted).
- Run the env-gated e2e and judge flakiness.
