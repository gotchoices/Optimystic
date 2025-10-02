# FRET Implementation - Next Steps Prompt

## Context
We've completed comprehensive property and integration testing for FRET (Finger Ring Ensemble Topology), a Chord-style DHT overlay for Optimystic. We also implemented network-scoped protocol isolation. All 18 FRET tests + 115 db-core tests pass.

## What's Done ✅

### Testing & Validation
- **Property tests** using fast-check for ring invariants, cohort assembly, selector logic, and size estimation
- **Integration tests** for 3-4 node meshes with TCP transport (neighbor exchange, routing, churn/leave)
- **Simulation harness** with deterministic RNG, event scheduler, and metrics (tested N=5,10,25,100 with 0-5%/s churn)
- **Profile tests** validating Edge vs Core rate limits and snapshot caps
- **Network isolation tests** confirming different `networkName` values prevent cross-talk

### Protocol Isolation
- Implemented `/optimystic/{networkName}/{service}/{version}` protocol structure
- Updated FRET, cluster, and repo services to use network-scoped protocols
- Proper multiaddr parsing via `@multiformats/multiaddr` (no more `/p2p/` string hacks)
- Complete network isolation verified via tests

### Robustness Fixes
- Self-dial prevention in all FRET operations
- Bootstrap multiaddr → peer ID parsing
- Empty/whitespace ping response guards
- Address validation before dial attempts

## What's Next (Choose Your Adventure)

### Option 1: Complete FRET Features (High Priority)
Per `docs/todo.md` lines 95-104, remaining FRET implementation tasks:

1. **PeerDiscovery module registration**
   - Implement libp2p `PeerDiscovery` interface backed by FRET's Digitree
   - Emit discovered peers from S/P/F sets (pruned, debounced)
   - Hook into libp2p's peer discovery event system

2. **Active preconnect mode** (refcount-based)
   - Track operation refcounts to trigger active mode
   - Pre-dial hot peers before operations to avoid serial dial chains
   - Exit active when refcounts drop to zero

3. **Proactive topology announcements**
   - Bounded fanout after joins and topology changes
   - Target non-connected peers only
   - Respect rate limits per profile

4. **Optional fingers** (logarithmic routing)
   - Maintain small long-range finger set
   - Refresh probabilistically during stabilization
   - Accelerate O(log n) routing in large networks

### Option 2: Wire FRET into db-p2p (Critical Path)
Replace KadDHT dependencies with FRET for production use:

1. **Update NetworkManagerService** (`packages/db-p2p/src/network/network-manager-service.ts`)
   - Replace `getCluster(key)` stub with FRET cohort assembly
   - Use `fretService.assembleCohort(hashedKey, k)` for cluster selection
   - Implement coordinator selection via FRET routing

2. **Update Libp2pKeyPeerNetwork** (`packages/db-p2p/src/libp2p-key-network.ts`)
   - Use FRET's `routeAct` for findCoordinator
   - Leverage FRET neighbors for cluster discovery
   - Remove KadDHT fallback paths

3. **Integration testing**
   - Multi-node mesh tests with actual transactions
   - Verify redirect hints and caching work
   - Test quorum commit with responsibilityK > 1

### Option 3: Enhanced Simulation & Metrics
Expand simulation harness for deeper validation:

1. **Path length tracking**
   - Measure hop counts in routeAct forwarding
   - Verify O(log n) scaling in large networks
   - Compare Edge vs Core routing efficiency

2. **Convergence time metrics**
   - Time-to-stable-neighbor-set after joins
   - Recovery time after mass leave events
   - Partition healing time

3. **CI/CD simulation matrix**
   - JSON artifact export for trend analysis
   - Run across N ∈ {5,25,100}, churn ∈ {0,1,5}%/s, profiles ∈ {edge,core}
   - Automated regression detection

### Option 4: Documentation & Observability
Finalize production readiness:

1. **Debug logging** (per `docs/todo.md` lines 29-40)
   - Add `createLogger(subNamespace)` using `debug` package
   - Instrument key decision points (routing, cluster selection, protocol timing)
   - Document `DEBUG` environment patterns in README

2. **RPC schema documentation** (`docs/fret.md` expansion)
   - Document JSON schemas with examples
   - Add wire format test vectors
   - Simulator design and invariants

3. **Metrics & monitoring**
   - Expose counters for RPCs, hop counts, convergence
   - Per-request correlation IDs across layers
   - Performance benchmarks

## Recommended Next Action

**I suggest Option 2 (Wire FRET into db-p2p)** because:
- It validates the FRET design against real workloads
- Unblocks production use of the distributed transaction system
- Will surface any remaining integration issues early
- Enables end-to-end testing with actual cluster operations

Once Option 2 is complete, circle back to Options 1 (remaining features) and 4 (observability) as needed.

## Files to Review

### FRET Implementation
- `packages/fret/src/service/fret-service.ts` - Core service with routing, stabilization, cohort assembly
- `packages/fret/src/store/digitree-store.ts` - Ring-ordered peer storage
- `packages/fret/src/selector/next-hop.ts` - Connected-first routing logic
- `packages/fret/src/rpc/` - Protocol handlers (neighbors, maybeAct, leave, ping)
- `packages/fret/test/README.md` - Test coverage summary

### Integration Points
- `packages/db-p2p/src/libp2p-node.ts` - Node creation with FRET service
- `packages/db-p2p/src/network/network-manager-service.ts` - Needs FRET integration for getCluster
- `packages/db-p2p/src/libp2p-key-network.ts` - IKeyNetwork implementation
- `packages/db-p2p/src/cluster/service.ts` - Cluster protocol with responsibility checks
- `packages/db-p2p/src/repo/service.ts` - Repo protocol with redirect logic

### Documentation
- `docs/fret.md` - FRET design specification
- `docs/todo.md` - Outstanding tasks and migration plan
- `PROTOCOL-ISOLATION.md` - Protocol isolation strategy and rationale

## Current State
- All tests passing (18 FRET + 115 db-core)
- FRET service registers and runs correctly
- Network isolation validated
- Ready for integration work

## Key Design Principles (Per Workspace Rules)
- Single responsibility principle
- Expressive over imperative style
- Never swallow exceptions (log + propagate)
- ES Modules with `.js` imports
- Tab indentation, single quotes (see `.editorconfig`)
- No superfluous comments
- Production-grade, maintainable code

---

**Prompt for next session**: "I want to wire FRET into db-p2p to replace the KadDHT stubs. Specifically, update NetworkManagerService.getCluster() to use FRET's cohort assembly, and update coordinator selection in libp2p-key-network.ts to use FRET routing. Follow the plan in @PROTOCOL-ISOLATION.md and reference the FRET API from @packages/fret/src/index.ts. Ensure all db-core and db-p2p tests continue to pass."

