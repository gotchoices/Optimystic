description: Proactive block spreading on neighbor departure to maintain durability without inner Arachnode rings
dependencies: FRET neighbor tracking, cluster membership, RebalanceMonitor (3-rebalance-monitor), BlockStorage, ClusterClient
files:
  - packages/db-p2p/src/cluster/ (spread protocol implementation)
  - packages/db-p2p/src/storage/arachnode-fret-adapter.ts (ring/churn integration)
  - packages/db-p2p/src/network/network-manager-service.ts (configuration and lifecycle)
----

## Motivation

Optimystic clusters replicate every block across ~20 peers (the cluster size). Under normal operation this provides strong durability. However, without inner Arachnode storage rings in place, the system depends entirely on cluster membership for block durability. As peers churn — leaving the network through graceful departure or unreachability — cluster membership erodes. If enough members leave over time without replacement, blocks lose replicas until they are eventually lost.

Today, the only mechanism that "spreads" block data beyond the original cluster is cache misses: a peer outside the cluster requests a block, triggering restoration, and now holds a copy. But blocks that are written and never read by external peers remain confined to the original cluster. Churn erodes that cluster silently.

Inner Arachnode rings will eventually solve this by providing archival storage tiers, but until those are implemented, the system needs an interim durability mechanism.

## Problem: Flood Amplification

The naive approach — every cluster peer spreads blocks when it detects a neighbor departure — creates a flood. With cluster size ~20, a single departure triggers ~19 independent spread operations pushing the same blocks to the same edge-of-keyspace targets. This 19x amplification turns routine churn into a bandwidth storm and hammers the peers at cluster boundaries.

## Design: Middle-Out Spread

The core insight is that only peers near the **middle** of a cluster need to perform spread operations. FRET organizes peers on a ring and assembles clusters by alternating between right-neighbors (successors) and left-neighbors (predecessors) of the block's coordinate. A block at coordinate `b` has a cluster formed by the `n` nearest ring neighbors on either side. The "middle" peers — those with the smallest ring distance to `b` — are the most topologically stable members of the cluster; they are the last to lose responsibility as membership shifts.

### Spread Eligibility

When a cluster peer detects a neighbor departure:

1. Compute its own ring distance from the block coordinate `b` (using FRET's ring proximity, not XOR).
2. Rank itself among known cluster members by ring distance to `b`.
3. If it is within the closest `d` peers to `b`, it is a **spread-eligible** peer. Otherwise, it suppresses.

`d` defaults to **3**, providing enough redundancy that if one middle peer is also unavailable, the others still act. This bounds the spread fan-out to at most `2d` operations per cluster per churn event (d peers, potentially spreading in both keyspace directions), rather than the full cluster size.

### Spread Targets

Spread-eligible peers push block data to peers at the **edges** of the cluster and slightly beyond — the peers that would become responsible if the cluster needs to expand. Middle peers already know edge peers from ongoing cluster consensus operations, so discovery isn't an issue. Reaching a couple of nodes at each end of the cluster's keyspace range is sufficient.

### Properties

- **Zero coordination overhead**: Each peer independently computes its ring distance to the block coordinate and determines whether it is within `d` of the middle. No leader election, no claim announcements, no protocol messages.
- **Idempotent**: If 2-3 middle peers independently spread the same blocks to the same targets, receivers simply deduplicate. Slight bandwidth waste but no correctness issue.
- **Graceful degradation**: If middle peers themselves depart, the new "middle" of the shrunken cluster inherits spread duty automatically.
- **Churn storm bounded**: Even with rapid departures, at most `2d` peers per cluster react per event.
- **Stable center**: Middle peers are the least likely to leave due to keyspace shifts, maximizing the reliability of the spread mechanism itself.

### Dynamic `d`

The spread distance `d` can grow dynamically in response to cluster health signals:

- If multiple departures are detected within a short window, temporarily increase `d` to improve spread coverage.
- If the cluster size drops below a configurable safety threshold (e.g., `clusterSize * 0.6`), widen `d` proportionally.
- Reset `d` to the default when the cluster stabilizes (new peers join, no recent departures).

### Edge Knowledge

Middle peers have the poorest FRET routing-table knowledge of peers at the cluster edges. However, this is largely mitigated because:

1. **Cluster members already know each other** from consensus (ClusterRecord exchanges), so middle peers have direct knowledge of all current cluster members including edge peers.
2. The only peers that need "discovery" are those just **outside** the current cluster boundary (expansion targets). For these, even coarse FRET routing knowledge is sufficient since the spread only needs to reach a couple of nodes at each end.

## Configuration

This protocol should be a configurable topological mode for the network, since networks with full Arachnode inner rings would not need this overhead:

```typescript
interface SpreadOnChurnConfig {
  /** Enable the churn-resilient spread protocol. Default: true */
  enabled: boolean;
  /** Number of middle-closest peers eligible to spread. Default: 3 */
  spreadDistance: number;
  /** Enable dynamic d scaling based on cluster health. Default: true */
  dynamicSpreadDistance: boolean;
  /** Cluster size ratio below which spread becomes more aggressive. Default: 0.6 */
  healthThreshold: number;
  /** Debounce window for departure detection (ms). Default: 5000 */
  departureDebounceMs: number;
}
```

Network-level durability mode (future, when Arachnode rings are available):

```typescript
type DurabilityMode = 'spread-on-churn' | 'archival' | 'both';
```

## Known Limitations

- **Ungraceful departure with no cached copies**: If a peer holds block data that no other cluster member has (which shouldn't happen under normal cluster replication, but could occur during cluster formation or after a series of failures), ungraceful departure still loses that data. Graceful departures can proactively push data before leaving.
- **Not a replacement for Arachnode**: This is an interim mechanism. Inner Arachnode rings provide true archival durability with capacity-based ring selection. This protocol addresses the gap until those are implemented.

## Relationship to Existing Work

- **RebalanceMonitor** (3-rebalance-monitor): Detects topology changes and responsibility shifts. The spread protocol consumes rebalance events as its trigger source.
- **RestorationCoordinator** (`packages/db-p2p/src/storage/restoration-coordinator-v2.ts`): Already implements pull-on-cache-miss — discovering holders via ring peers and inner storage rings, then fetching block data. The push side of spread is new, but any pull-based recovery triggered by this protocol should reuse `RestorationCoordinator.restore()` rather than duplicating the discovery-and-fetch path. See also `3-block-transfer-protocol`.
- **BlockStorage**: Provides the block data that spread-eligible peers push to targets.
- **ClusterClient/ClusterService**: Existing cluster protocol could be extended for spread messages, or a lightweight dedicated protocol could be added.
- **ArachnodeFretAdapter**: When inner rings are eventually implemented, the spread protocol transitions to the `'archival'` durability mode gracefully.
