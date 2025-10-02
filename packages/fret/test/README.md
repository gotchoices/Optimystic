# FRET Test Suite Summary

## Overview
Comprehensive property-based and integration test coverage for FRET (Finger Ring Ensemble Topology), validating ring invariants, cohort assembly, routing, churn handling, and scaling characteristics across multiple mesh sizes and scenarios.

## Protocol Isolation Strategy

### Network-Scoped Protocols
All Optimystic protocols now incorporate `networkName` for complete isolation:

```
/optimystic/{networkName}/fret/1.0.0/neighbors
/optimystic/{networkName}/fret/1.0.0/maybeAct
/optimystic/{networkName}/fret/1.0.0/leave
/optimystic/{networkName}/fret/1.0.0/ping
/optimystic/{networkName}/cluster/1.0.0
/optimystic/{networkName}/repo/1.0.0
/optimystic/{networkName} (identify service)
```

**Benefits**:
- ✅ Complete isolation between networks (test vs prod vs different apps)
- ✅ Nodes from different networks cannot accidentally communicate
- ✅ Consistent branding (`/optimystic/` instead of `/db-p2p/` or `/p2p/`)
- ✅ Supports multiple independent Optimystic networks on same infrastructure

### Multiaddr Parsing
Bootstrap peer ID extraction now uses proper `@multiformats/multiaddr` parsing instead of string manipulation:
- Uses `multiaddr(str).getPeerId()` API
- Gracefully falls back to treating input as raw peer ID
- More robust against future multiaddr format changes

## Test Coverage

### Property Tests
- **DigitreeStore neighbors** (`test/digitree.neighbors.spec.ts`)
  - Validates successor/predecessor wrap-around and uniqueness
  - Tests bounded coverage across varying peer sets
  
- **Cohort assembly** (`test/cohort.assembly.spec.ts`)
  - Verifies two-sided alternation without duplicates
  - Tests deterministic spread of fake peer coordinates

- **Next-hop selector** (`test/selector.connected-first.spec.ts`)
  - Confirms connected-first preference within distance tolerance

- **Size estimator** (`test/size-estimator.spec.ts`)
  - Validates confidence increases with peer count and balanced gaps

### Integration Tests
- **Basic mesh** (`test/fret.mesh.spec.ts`)
  - 3-node mesh with TCP transport
  - Validates discovery and stabilization

- **RouteAndMaybeAct** (`test/route.maybeact.integration.spec.ts`)
  - 3-node routing verification
  - Confirms near anchors, cohort hints, breadcrumbs, and TTL handling

- **Churn/leave handling** (`test/churn.leave.spec.ts`)
  - 4-node mesh with coordinated leave
  - Validates stabilization and replacement warming

- **RPC codec fuzzing** (`test/rpc.fuzz.spec.ts`)
  - Malformed maybeAct payload handling
  - Confirms graceful error handling without crashes

- **Network isolation** (`test/network.isolation.spec.ts`)
  - Different networkNames cannot exchange snapshots (protocol mismatch)
  - Same networkName enables discovery and stabilization

### Profile Behavior Tests (`test/profile.behavior.spec.ts`)
- **Edge profile**
  - Lower rate limits (≤10 initial tokens)
  - Smaller snapshot caps (≤6 successors/predecessors)
  
- **Core profile**
  - Higher concurrency (≥15 initial tokens)
  - Larger snapshot caps (≤12 successors/predecessors)

### Simulation Tests (`test/simulation.spec.ts`)
Deterministic simulation harness with event scheduler and metrics collection:

#### Test Scenarios
1. **N=5, no churn**
   - 5 joins, 5 stabilization cycles
   - Avg neighbors: 4.0
   - Drop rate: 0%

2. **N=10, no churn**
   - 10 joins, 9 stabilization cycles
   - Avg neighbors: 5.8
   - Drop rate: 0%

3. **N=25, light churn (1%/s)**
   - 25 joins, 2 leaves, 19 stabilization cycles
   - Avg neighbors: 7.5
   - Drop rate: 0%

4. **N=100, moderate churn (5%/s)**
   - 100 joins, 37 leaves, 33 stabilization cycles
   - Avg neighbors: 7.8
   - Drop rate: 0%

## Simulation Architecture

### Components
- **DeterministicRNG** (`test/simulation/deterministic-rng.ts`)
  - Mulberry32 PRNG for reproducible test runs
  - Seed-based generation for shuffle, pick, nextInt

- **EventScheduler** (`test/simulation/event-scheduler.ts`)
  - Time-ordered event queue
  - Supports join, leave, connect, disconnect, stabilize events

- **MetricsCollector** (`test/simulation/sim-metrics.ts`)
  - Tracks joins, leaves, connections, stabilization cycles
  - Computes avg neighbor count, path length, drop rate
  - Finalize() produces comprehensive metrics

- **FretSimulation** (`test/simulation/fret-sim.ts`)
  - Headless peer mesh with Digitree stores
  - Deterministic coordinate distribution
  - Configurable churn rates and stabilization intervals

## Fixes Applied

### Runtime Issues
1. **Bootstrap peer ID parsing** (`src/service/fret-service.ts:466-489`)
   - Extract peer ID from multiaddr strings (`/p2p/` or `/ipfs/` components)
   - Prevents InvalidParametersError on stabilization

2. **Ping whitespace responses** (`src/rpc/ping.ts:24-31`)
   - Guard against empty and whitespace-only response bodies
   - Prevents JSON parse errors during stabilization

3. **Self-dial prevention** (`src/service/fret-service.ts:255-509`)
   - Filter self peer ID from announce, preconnect, and stabilization targets
   - Add `hasAddresses()` check to avoid NoValidAddressesError

## Test Results
- **18 passing** (11s)
- All property tests pass with fast-check
- Integration tests validate RPC flows and mesh behavior
- Simulation tests demonstrate convergence and churn resilience
- Network isolation tests confirm protocol-based network segmentation

## Next Steps (Optional)
1. **Path length measurement**: Track hop counts in simulation routing
2. **Convergence time**: Measure time-to-stable-neighbor-set
3. **Libp2p PeerDiscovery integration**: Emit discovered peers to libp2p
4. **Active preconnect mode**: Refcount-based warm-up for operations
5. **Integration with db-p2p**: Wire FRET into NetworkManagerService and coordinator selection

