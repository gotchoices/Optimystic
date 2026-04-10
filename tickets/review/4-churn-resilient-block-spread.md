# Churn-Resilient Block Spread (Middle-Out) — Review

description: Proactive block spreading on neighbor departure — only middle peers push to cluster edges, bounding fan-out to 2d
files:
  - packages/db-p2p/src/cluster/spread-on-churn.ts (NEW - SpreadOnChurnMonitor)
  - packages/db-p2p/src/network/network-manager-service.ts (init + config wiring)
  - packages/db-p2p/src/index.ts (export added)
  - packages/db-p2p/test/spread-on-churn.spec.ts (NEW - 21 tests)
----

## What Was Built

`SpreadOnChurnMonitor` — a `Startable` service that detects peer departures (`connection:close`) and proactively pushes tracked blocks to expansion targets beyond the current cluster boundary, but only from "middle" peers (rank < d) to bound fan-out.

### Core Algorithm

1. On `connection:close` (debounced), for each tracked block:
   - Compute ring coordinate via `hashKey(encode(blockId))`
   - Check eligibility: `fret.neighborDistance(selfId, coord, clusterSize)` < effectiveD
   - Get targets: `fret.expandCohort(cohort, coord, step)` minus existing cohort members
   - Read block from repo, push via `BlockTransferClient` with reason `'replication'`

2. **Dynamic d**: Scales `effectiveD` up under rapid churn (3+ departures in sliding window) or low cluster health (FRET diagnostics ratio < threshold). Capped at `clusterSize / 2`.

3. **Partition suppression**: Skips spread when `partitionDetector.detectPartition()` returns true.

### NetworkManagerService Integration

- `initSpreadOnChurnMonitor(partitionDetector, repo, peerNetwork, clusterSize, config?)` — follows the `initRebalanceMonitor` pattern exactly
- `getSpreadOnChurnMonitor()` accessor
- `stop()` now stops both monitors

### Config

```typescript
SpreadOnChurnConfig {
  enabled: boolean          // default: true
  spreadDistance: number     // d, default: 3
  dynamicSpreadDistance: boolean  // default: true
  healthThreshold: number   // default: 0.6
  departureDebounceMs: number    // default: 5000
  expansionStep: number     // default: 4
}
```

## Testing (21 tests, all passing)

| Category | Tests | What's Verified |
|----------|-------|-----------------|
| Lifecycle | 3 | start/stop register/remove listeners; idempotent; no spread after stop |
| Block tracking | 1 | track/untrack/count |
| Eligibility | 3 | rank < d spreads; rank >= d skips; rank == d skips |
| Expansion targets | 3 | only beyond-cohort peers targeted; self excluded; no-op when no new targets |
| Dynamic d | 2 | increases under rapid churn; uses base d when stable |
| Partition suppression | 1 | no spread during detected partition |
| Debounce | 1 | rapid departures coalesce |
| Config: disabled | 2 | enabled=false skips checkNow and debounced paths |
| SpreadEvent emission | 3 | correct structure; multiple handlers; error isolation |
| Empty/edge cases | 2 | no tracked blocks; block not in repo |

### How to Run

```bash
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/spread-on-churn.spec.ts" --reporter spec --timeout 10000
```

Full suite (377 tests): `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min --timeout 30000`

## Usage

```typescript
import { SpreadOnChurnMonitor } from '@optimystic/db-p2p'

const monitor = new SpreadOnChurnMonitor(
  { libp2p, fret, partitionDetector, repo, peerNetwork, clusterSize: 5 },
  { spreadDistance: 3, expansionStep: 4 }
)

monitor.trackBlock('block-abc')
monitor.onSpread(event => console.log('Spread:', event))
await monitor.start()
// ... later
await monitor.stop()
```

Or via NetworkManagerService:
```typescript
const monitor = networkManager.initSpreadOnChurnMonitor(
  partitionDetector, repo, peerNetwork, 5, { spreadDistance: 3 }
)
monitor.trackBlock('block-abc')
await monitor.start()
```
