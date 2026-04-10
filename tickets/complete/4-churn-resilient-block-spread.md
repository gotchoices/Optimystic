# Churn-Resilient Block Spread (Middle-Out) — Complete

description: Proactive block spreading on neighbor departure — only middle peers push to cluster edges, bounding fan-out to 2d
files:
  - packages/db-p2p/src/cluster/spread-on-churn.ts (SpreadOnChurnMonitor)
  - packages/db-p2p/src/network/network-manager-service.ts (init + config wiring)
  - packages/db-p2p/src/index.ts (export)
  - packages/db-p2p/test/spread-on-churn.spec.ts (23 tests)
  - docs/internals.md (cluster health monitors section)
----

## What Was Built

`SpreadOnChurnMonitor` — a `Startable` service that detects peer departures (`connection:close`) and proactively pushes tracked blocks to expansion targets beyond the current cluster boundary. Only "middle" peers (FRET `neighborDistance` rank < d) spread, bounding fan-out to 2d.

### Key Behaviors

- **Debounced departure handling**: Rapid departures coalesce into a single spread check
- **Dynamic d**: Scales `effectiveD` up under rapid churn (3+ departures) or low cluster health (FRET estimate ratio < threshold), capped at `clusterSize / 2`
- **Partition suppression**: No spread when `partitionDetector.detectPartition()` is true
- **Error isolation**: Individual push failures don't prevent remaining pushes; handler errors don't prevent other handlers

### Integration

Initialized via `NetworkManagerService.initSpreadOnChurnMonitor()`, stopped automatically in `NetworkManagerService.stop()`.

## Review Fixes Applied

1. **Redundant TextEncoder**: Replaced `new TextEncoder()` per-block with module-level `textEncoder` (line 204)
2. **Mock stream fix**: Rewrote `createMockStream` in tests — added `send()`, `[Symbol.asyncIterator]`, varint LP encoding, correct `BlockTransferResponse` shape. Prior mock was non-functional (no `send`, wrong response format, 4-byte length prefix vs varint)
3. **Test gap: push failures**: Added test verifying `succeeded`/`failed` arrays when a target's `connect()` throws
4. **Test gap: health-threshold dynamic d**: Added test for the FRET diagnostics ratio path of `computeEffectiveD`
5. **Docs**: Added "Cluster Health Monitors" section to `docs/internals.md` covering both RebalanceMonitor and SpreadOnChurnMonitor

## Testing (23 tests, all passing)

```bash
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/spread-on-churn.spec.ts" --reporter spec --timeout 10000
```

Full suite: 383 passing, 0 failing.

## Usage

```typescript
const monitor = new SpreadOnChurnMonitor(
  { libp2p, fret, partitionDetector, repo, peerNetwork, clusterSize: 5 },
  { spreadDistance: 3, expansionStep: 4 }
)
monitor.trackBlock('block-abc')
monitor.onSpread(event => console.log('Spread:', event))
await monitor.start()
```

Or via NetworkManagerService:
```typescript
const monitor = networkManager.initSpreadOnChurnMonitor(
  partitionDetector, repo, peerNetwork, 5, { spreadDistance: 3 }
)
```
