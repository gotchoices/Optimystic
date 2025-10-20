# @optimystic/fret

FRET: Finger Ring Ensemble Topology — a Chord-style ring overlay for libp2p with JSON RPCs and a Digitree-backed cache.

## Features

- **Chord-style Ring**: Distributed hash table with finger table routing
- **Digitree Cache**: Efficient peer storage and lookup
- **Network Size Estimation**: Real-time tracking of network size with confidence metrics
- **Partition Detection**: Monitors for sudden network changes and potential partitions
- **Neighbor Discovery**: Automatic peer discovery and announcement
- **Route Optimization**: Intelligent next-hop selection for DHT operations

## Development

- Build

```
yarn workspace @optimystic/fret build
```

- Test (node only for now)

```
yarn workspace @optimystic/fret test
```

## Network Size Estimation

FRET provides real-time network size estimation by aggregating observations from multiple sources:

### Observation Sources

1. **FRET Digitree**: Primary estimation based on finger table and neighbor cache
2. **Ping Responses**: Peers share their size estimates in ping messages
3. **Neighbor Announcements**: Size hints included in neighbor snapshots
4. **External Reports**: Upper layers (e.g., cluster messages) can report observations

### API

```typescript
interface FretService {
  // Report an external network size observation
  reportNetworkSize(estimate: number, confidence: number, source?: string): void;
  
  // Get current size estimate with confidence
  getNetworkSizeEstimate(): { 
    size_estimate: number; 
    confidence: number; 
    sources: number 
  };
  
  // Calculate rate of network size change (peers/minute)
  getNetworkChurn(): number;
  
  // Detect potential network partition
  detectPartition(): boolean;
}
```

### Size Estimation Algorithm

FRET uses **exponential decay weighting** to favor recent observations:

- Recent observations get higher weight
- Confidence multiplied into weight calculation
- Rolling 5-minute window (configurable)
- Maximum 100 observations stored

### Partition Detection

FRET detects potential partitions using multiple signals:

- **Sudden size drop**: >50% reduction indicates potential partition
- **High churn rate**: >10% peers/minute is suspicious
- **Confidence tracking**: Low confidence suggests instability

### Integration Example

```typescript
// FRET automatically includes size estimates in ping responses
registerPing(node, PROTOCOL_PING, () => {
  return fretService.getNetworkSizeEstimate();
});

// Upper layers can report observations back to FRET
fretService.reportNetworkSize(observedSize, 0.8, 'cluster-message');

// Check network health
if (fretService.detectPartition()) {
  console.warn('Potential network partition detected!');
}
```

## Test harness (local meshes)

A minimal harness will spin up a small libp2p mesh in-process and exercise:
- Join/bootstrap seeding
- Neighbor snapshots and discovery emissions
- Routing (routeAct) hop counts and anchors
- Diagnostics counters (pings, snapshots, announcements)
- Network size estimation accuracy

The harness will live under `test/` and use profile-tuned configs for edge/core.

