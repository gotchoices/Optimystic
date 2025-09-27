### FRET: Finger Ring Ensemble Topology (Chord-with-Fingers libp2p overlay for Optimystic)

This document proposes FRET, a Chord-style ring overlay with symmetric successor/predecessor neighbor sets and logarithmic fingers, optimized for fast discovery, low chatter, and robustness under churn. FRET replaces reliance on libp2p's KadDHT for our use-cases (cluster lookup, coordinator selection, and routing hints), while remaining transport-agnostic and libp2p-compatible.

---

### Goals
- Provide discovery and routing for libp2p services without proof-by-exhaustion queries.
- Deterministic or high-probability cluster construction even when n < k.
- Minimize processing and bandwidth; support rapid expansion/shrink (minutes-scale churn).
- Symmetric neighbor sets (successors and predecessors) to maximize overlap and routing resilience.
- One-pass, unified discovery+activity path: route towards cluster and embed the activity once "near enough."
- Local test for in-cluster membership; avoid expensive global searches.

### Identifier space and hashing
- Peer ID: fixed-length ring coordinate r(peer) = SHA-256(peerId.multihash.bytes) truncated/expanded to B bits
- Key coordinate: r(key) = SHA-256(keyBytes) using the same hash family as peers
- Ring arithmetic: all comparisons are modulo 2^B where B = 256 bits
- Distance metric: d(a,b) = min(clockwise_distance(a,b), counterclockwise_distance(a,b))
- Tie-breaking: when equidistant, prefer lexicographic order of peer IDs

### Overlay model: Ring with symmetric neighbors and optional fingers
- Successor set S(p): the next m peers clockwise after p (m = ceil(k/2) by default).
- Predecessor set P(p): the previous m peers counterclockwise before p (m = ceil(k/2)).
- Finger cache: Ordered B+Tree which maintains all known peers in a single ordered index keyed by ring coordinate.  Approximates a finger-table. Secondary index by relevance score (see below) for bounded capacity and victim selection.
- Maybe these are all part of the same cache set, and the successor and predecessor sets just have infinite relevance.

### Relevance scoring and table management
- The routing table has a hard capacity C. When over capacity, evict the lowest-relevance entries.
- Components (bucketless, sparsity-weighted):
  - Access recency (EMA decay) and frequency (log-slowing).
  - Health: success/failure ratio and average RTT.
  - Sparsity bonus over distances: maintain a smooth blend of distances without hard buckets.
    - Compute normalized log-distance x ∈ [0,1] from self to peer (1 = far, 0 = near).
    - Maintain a tiny KDE over x with m fixed centers and EMA occupancy.
    - Sparsity bonus S(x) = clamp(((ideal(x)+ε)/(density(x)+ε))^β, sMin, sMax).
    - This increases score for underrepresented distances and tapers overrepresented ones.
  - Neighbors: entries in S(p) ∪ P(p) are always retained unless explicitly dead.
- Victim selection: lowest score first.

### Join and bootstrap
1. New node chooses any reachable bootstrap peer(s).
2. Bootstrap queried for nearest to destination (new node's ID). Flag also requests a sampling of cached and proximal nodes (to seed the new node's cache).
3. New node incorporates cache (evicting if needed by relevance), dials nearest peer(s) to ID, and repeats until neighborhood reached.
4. Neighborhood detection: when self appears in the two-sided cohort of size m for its own ID
5. Once in neighborhood, performs stabilization (see below) and announces presence to S/P sets
6. Hot-transaction seeding (non-FRET but incorporating hooks): neighbors send recent pend/commit deltas for blocks whose key ranges intersect the new node's responsibility zone. Bounded by rate, size, and time.

### Stabilization and churn handling
- Periodic stabilization (every Ts):
  - Verify reachability of entries in S(p) and P(p); replace failed ones with next best candidates from the Digitree. If incoming message exchange received since last stabilization, skip verification.
  - Exchange compact neighbor snapshots with immediate successors and predecessors; merge deltas.
  - Opportunistically probe a few finger candidates per cycle (budgeted) to maintain logarithmic reachability.
- Failure detection and recovery:
  - Soft failure (timeout): decay relevance score by factor δ (e.g., 0.7); retry with exponential backoff
  - Hard failure (3+ consecutive timeouts or explicit error): remove from S/P; mark as dead in Digitree
  - Recovery: on successful contact after failure, reset relevance score to baseline
- Symmetry: maintain |S(p)| = |P(p)| = m by filling gaps from Digitree candidates

## Leave
- Graceful departure protocol:
  1. Send leave notification to all S(p) ∪ P(p) with suggested replacements from Digitree
  2. Transfer hot transactions and pending state to successors
  3. Notify any connected peers outside S/P before disconnecting
- Recipients of leave notification immediately remove departing peer and probe suggested replacements

### Determining cluster membership and coordinator (two-sided cohort)
- Two anchors: aSucc = successor(h); aPred = predecessor(h).
- Cohort build (alternating two-sided): [aSucc, aPred, succ¹(aSucc), pred¹(aPred), …] until we collect min(k, n) unique peers, or satisfy a caller-provided wants ≤ k.
- Local membership test: peer p locally computes the alternating two-sided cohort using its S/P index and checks if p is within the first k (or wants) entries.
- Handling n < k: the alternating walk yields min(n, k); quorum adapts automatically.
- Coordinator: not required to be deterministic; any in-cluster member the search lands on may coordinate with threshold signatures.

#### Flexible cohort and thresholding
- The cohort is a means to gather a minimum number of signatures (minSigs = k−x); exact membership may vary slightly across peers due to view differences.
- If some candidates return erroneous validations or are unavailable, they are filtered out and the cohort expands outward symmetrically until minSigs is reached.
- Repository constraint: the cohort must include peers that can serve/commit the target block's repo; if a newly included peer lacks required state, it may sync-on-demand before validating.
- Policy vs primitives: FRET exposes primitives to assemble two-sided cohorts, expand/filter, and provide successor/predecessor walks. Higher layers configure k, x, and repo sync policies.

### Unified find+maybe-act RPC
Single pipeline for discovery and action:
- RouteAndMaybeAct { key, wantK, wants?, ttl, minSigs, digest, activity?, breadcrumbs[], correlationId }
  - key: content key or transaction-affinity key
  - wantK: target cluster size k (or min quorum requirements)
  - wants: optional number of peers requested (≤ k) for partial cohorts or staged discovery
  - ttl: hop/time budget
  - minSigs: num required activity signatures (k−x)
  - digest: lightweight summary (for non-in-cluster probes)
  - activity: optional payload (pend/commit). Included when near enough by size/distribution estimate
  - breadcrumbs: visited peers to prevent loops and provide traceability
  - correlationId: unique request identifier for tracing and deduplication

Routing rule:
1. If local membership test says "in-cluster":
   - If activity included: perform activity (callback) given the two-sided cohort (expand/filter as needed to satisfy minSigs), then return commit certificate
   - If no activity: reply with NearAnchor { anchors: [succ, pred], cohortHint: PeerId[], estimatedClusterSize, confidence } inviting a resend with activity
   - Cache result for correlationId to handle duplicate requests
2. Else (not in-cluster): forward towards h by choosing the next hop that minimizes absolute ring distance to h using S/P (and optional finger cache). Optionally attach redirect hints (local near-h successors/predessors) to speed convergence.
   - Next-hop selection heuristic (connected-first bias):
     - Define cost(peer) = w_d·normDist(h, peer) − w_conn·isConnected(peer) − w_q·linkQuality(peer) + w_b·backoffPenalty(peer).
     - normDist scales absolute ring distance by the estimated network size N_est; use a "near radius" r_near ≈ (ringCirc / N_est)·β to detect proximity to the neighborhood.
     - When far (dist > r_near): allow slack ε_far in distance improvements; prefer already-connected peers even if slightly farther.
     - When near (dist ≤ r_near): require strict distance improvement (ε_near ≈ 0); prioritize most proximal candidates even if disconnected.
     - Confidence-aware: when confidence is low, increase w_conn and reduce reliance on distance; when high, increase w_d and tighten ε_near. Update penalties as observations arrive.
3. TTL guards prevent loops; breadcrumbs help diagnose route quality.

Payload inclusion heuristic:
- Maintain (sizeEstimate, confidence). Include activity if probability of being in-cluster ≥ threshold T based on distance to h vs expected cluster span and confidence.
- Otherwise send digest-only to get redirects/hints, then resend with activity when near.

### Reputation and exclusions (later phase)
- Local scoring for misbehavior (invalid validations, equivocation) increases penalty; above threshold excludes from S/P and routing decisions.
- Gossip of signed evidence remains optional; local autonomy preserved.
- Cluster expansion compensates for excluded peers to maintain k where possible.

### Network size estimation
- Maintain online estimate (n_est, confidence ∈ [0,1]):
  - Arc length method: average gap between consecutive S/P members; n_est = 2^B / avg_gap
  - Finger sampling: probe random points, measure hop counts; use exponential decay model
  - Weighted average of both methods; weight by method confidence
- Confidence calculation:
  - Base confidence from sample count and recency
  - Zero if disconnected from bootstrap or |S∪P| < m/2
  - Decay by factor 0.95 per minute without updates
- Usage:
  - Operations require min confidence (e.g., 0.3) to proceed
  - Cluster span estimate = k * (2^B / n_est)
  - Near-radius r_near = β * cluster_span where β ∈ [1.5, 3]

### libp2p integration
- Discovery: implement a libp2p peerDiscovery-compatible interface backed by FRET's Digitree. Emits peers from S/P/F (pruned, debounced).
- Protocol IDs and message formats (length-prefixed UTF-8 JSON):
  - /fret/1.0.0/neighbors - JSON-encoded NeighborSnapshot
  - /fret/1.0.0/maybeAct - JSON-encoded RouteAndMaybeAct
  - /fret/1.0.0/leave - JSON-encoded LeaveNotice
  - /fret/1.0.0/ping - JSON-encoded PingLite
- Stream management:
  - Max inbound: 32 (Edge) / 128 (Core)
  - Max outbound: 64 (Edge) / 256 (Core)
  - Stream timeout: 30s default, 10s for ping
  - Multiplexing: reuse streams for multiple requests where possible
  - Snapshot caps: successors/predecessors/sample are profile-bounded (Edge ≤ 6/6/6, Core ≤ 12/12/8)

### Active vs passive state (network manager)
- Passive: background stabilization at a modest cadence; only gentle maintenance (no aggressive dialing).
- Active (connection warm-up; refcount-based): when an operation starts, enter active mode to avoid serial dial chains:
  - Pre-dial/ping a bounded set of hot peers (route-critical successors, near-h nodes, recent routing nodes)
  - Refresh reachability for those entries; keep RPC queues shallow
  - Exit active when all refcounts drop to zero; revert to passive

Notes:
- Active is about connection warm-up, not a strict "tick" loop. Stabilization cadence continues independently (profile-dependent).
- Warm-up budgets are profile-tuned (see Operating profiles) and bounded to protect mobile/edge nodes.

### Partition and merge hooks (outside FRET, but supported)
- Each repo instance initializes with a nonce.
- Neighbors exchanging state include repo nonces; cross-partition healing only allowed if nonces match and revisions do not conflict; otherwise manual reconciliation.
- FRET surfaces "neighborhood merge" events to higher layers when previously disjoint rings connect.

### Fuzzy routing intervals (emergent finger-like structure)
- During routing and stabilization, we bias discovery/merges toward logarithmically spaced intervals around targets rather than exact keys.
- Combined with sparsity-weighted relevance, this seeds routing-relevant peers without explicit finger tables.
- The cache thus self-organizes into a distance-balanced spine that accelerates future lookups, while remaining purely cache/relevance-driven.

### Small vs large networks
- Small (n << k): successor walk yields min(n, k). Deterministic and fast (one hop likely sufficient).
- Large: finger-accelerated greedy routing converges in O(log n) hops. Stabilization keeps fingers fresh under churn.
- Dynamic: symmetric S/P overlap speeds convergence after mass joins/leaves; relevance scoring avoids hotspots.

### Configuration (suggested defaults)
- k (cluster size target): 15
- x (tolerated faulty): 1 (minSigs = k−x = 14)
- m (successors and predecessors): ceil(k/2) = 8
- C (routing table capacity): 2048
- Stabilization period Ts: 1–3s passive; 250–500ms active
- Active pre-dial budget: 4–8 peers per second

### Operating profiles (Edge vs Core)
- Edge (lightweight/mobile):
  - Lower token bucket rates/bytes for neighbor snapshots and maybeAct; smaller snapshot sizes
  - Conservative pre-dial budget (e.g., 2–4 peers/sec; max 2 concurrent); shorter active duration
  - Longer passive stabilization cadence; fewer probes per window
  - Stricter payload caps; prefer digest-only until confidently near-cluster
  - Smaller inbound RPC concurrency; earlier "busy/Retry-After" responses
- Core (server-grade):
  - Higher token rates/bytes and larger snapshots to seed others
  - Aggressive pre-dial (e.g., 6–12 peers/sec; max 4–6 concurrent) during active
  - Faster stabilization cadence; more probes to heal topology quickly
  - Larger payload caps; earlier inclusion of activity to reduce RTTs
  - Higher inbound concurrency; buffered backpressure with bounded queues

### Security and abuse considerations
- Message authentication:
  - All messages signed with sender's private key
  - Correlation IDs prevent replay attacks
  - Timestamp bounds (±5 min) for freshness
- Sybil resistance:
  - Proof-based validation failures whispered (validation via hooks)
  - Gradual trust building through successful interactions
  - Diversity requirements in cohort selection (IP ranges, AS numbers)
- Eclipse attack mitigation:
  - Mandatory bootstrap verification through multiple paths
  - Periodic random walks to discover new peers
  - Alert on sudden S/P set changes
- Rate limiting and backpressure on neighbor snapshots and route.maybeAct payloads
- Reputation exclusions locally enforced; evidence objects are signed and bounded

### Migration plan (high-level)
1. Introduce FRET module (routing table, S/P/F management, stabilization loops).
2. Implement neighbor snapshot RPC and active/passive manager.
3. Implement route.maybeAct pipeline and integrate with transactor paths.
4. Replace KadDHT usages with FRET APIs for coordinator/cluster selection.
5. Add size estimation and payload inclusion heuristic.
6. Optional: gossip/evidence and hot-transaction seeding.

### Aspect-oriented implementation plan
- Service shell & lifecycle (A1)
  - Startable service; registrar handle/unhandle; capabilities/dependencies.
  - Modes: Edge/Core profiles; client/server toggle analogous to kad-dht.
  - Ready gate for early queries; allow zero-peers override for single-node dev.
- Routing store (Digitree) & indices (A2)
  - Ordered B+Tree keyed by ring coordinate; secondary relevance index.
  - Bounded capacity with victim selection; infinite relevance for S/P.
  - Import/export compact snapshots for bootstrap and neighbors.
- Neighbor management & snapshots (A3)
  - RPC: neighbors (request/response with caps, tokens, compression).
  - Merge policy with de-dup, score updates, health checks.
- Cohort assembly primitives (A4)
  - Two-sided alternating walk with wants ≤ k; filter/expand API.
  - Membership test helper; repo-capability tagging for members.
- RouteAndMaybeAct pipeline (A5)
  - Async generator for progressive results; breadcrumbs/TTL.
  - Next-hop selector with connected-first bias, distance, link quality, backoff, confidence.
  - Activity callback interface and threshold tracking (minSigs).
- Stabilization & health (A6)
  - Periodic S/P verification, finger probes; jitter; skip if recent traffic.
  - Failure pruning and decay; reinsert on recovery.
- Rate limiting & backpressure (A7)
  - Per-peer token buckets; global in-flight caps; bounded queues.
  - Busy/Retry-After responses; local exponential backoff.
  - Profile-tuned budgets (Edge/Core).
- Metrics, logging, and tracing (A8)
  - Per-op counters/errors/latencies; structured logs with prefixes.
  - Correlation ids across maybeAct phases; hop counts; cohort sizes.
- Repo sync hooks (A9)
  - Signals for "needs repo state"; callback to higher layer to fetch/sync-on-demand.
  - Partition/nonce surfaces for safe merges.
- Integration adapters (A10)
  - PeerDiscovery: emit peers from S/P/F.
  - Replacement hooks for coordinator/cluster selection in core transactor.

### Data structures and algorithms

#### Digitree implementation
- B+Tree with order 32 (31 keys per node, 32 children)
- Primary key: ring coordinate (256-bit)
- Secondary indices:
  - Relevance score (float64, maintained as heap)
  - Last access time (for LRU)
  - Connection state (connected/disconnected/dead)
- Operations:
  - insert(peer, coord): O(log n)
  - findNearest(coord, count): O(log n + count)
  - evictLowestRelevance(): O(log n)
  - updateRelevance(peer, delta): O(log n)

#### Ranges and paths integration with Digitree
- Reference: Digitree documentation on ranges, iterators, and Paths ([Digitree docs](https://digithought.github.io/Digitree/))
- Successor (clockwise) of coordinate h:
  - p = tree.find(h); if p.on then succ = p else succ = tree.next(p); if succ is off-end, wrap with tree.first()
  - Iterate successors with `ascending` or `moveNext` for K steps; collect into array to avoid path invalidation during mutations
- Predecessor (counterclockwise) of h:
  - p = tree.find(h); pred = tree.prior(p.on ? p : p); if pred is off-start, wrap with tree.last()
  - Iterate predecessors with `descending` or repeated `prior`
- Wrap-around ranges:
  - Clockwise K successors: enumerate `ascending(start)` up to end, then `ascending(tree.first())` until K reached
  - Counterclockwise K predecessors: enumerate `descending(start)` then `descending(tree.last())`
- Paths lifecycle:
  - Paths not returned from mutation are invalid after any mutation; only use mutation-returned paths for further mutation (per Digitree semantics)
  - For stabilization/routing, avoid mutating during iteration; snapshot peer IDs first, then perform network actions
- Key immutability:
  - Entries are frozen; do not mutate keys after insertion; to update coordinates, delete+insert
- Efficient nearest:
  - Use `find` and the "crack" path: `next` yields successor, `prior` yields predecessor; this is O(log n)
- Counting and diagnostics:
  - `getCount` for quick checks; use `first/last`, `ascending/descending` for ordered scans

#### Relevance score calculation (bucketless sparsity model)
```
Inputs per-peer: lastAccess, accessCount, successCount, failureCount, avgLatencyMs.
Global: KDE centers ci (m≈12), occupancy Oi (EMA), kernel width σ, decay α, exponent β.

x = normalized_log_distance(self, peer) ∈ [0,1]
observe: Oi ← (1−α)Oi + α·Kσ(|x−ci|)
density(x) = Σ Oi·Kσ(|x−ci|)
ideal(x) = Σ 1·Kσ(|x−ci|)   // uniform target
S(x) = clamp(((ideal(x)+ε)/(density(x)+ε))^β, sMin, sMax)

base = w_r·recency(lastAccess) + w_f·freq(accessCount) + w_h·health(success/failure, avgLatency)
relevance = base · S(x)
```

Notes:
- No explicit buckets or finger tables; a single ordered Digitree plus sparsity-aware scoring yields an emergent, distance-balanced cache well-suited to routing.
- During a routing walk, temporary (ephemeral) multipliers may bias candidates near the desired step distance, but long-term scores remain governed by S(x).

#### Cohort assembly algorithm
```
function assembleCohort(key, wants, excludeSet):
  succ = findSuccessor(key)
  pred = findPredecessor(key)
  cohort = []
  i = 0
  while cohort.size < wants and (succ or pred):
    if i % 2 == 0 and succ and succ not in excludeSet:
      cohort.add(succ)
      succ = successor(succ)
    elif pred and pred not in excludeSet:
      cohort.add(pred)
      pred = predecessor(pred)
    i++
  return cohort

function isInCluster(self, key, k):
  cohort = assembleCohort(key, k, {})
  return self in cohort
```

### Wire formats

#### Neighbor snapshot (JSON)
```
interface NeighborSnapshotV1 {
  v: 1;
  from: string;                 // PeerId (base58btc)
  timestamp: number;            // unix ms
  successors: string[];         // S(p) peer ids
  predecessors: string[];       // P(p) peer ids
  sample?: Array<{             
    id: string;                 // peer id
    coord: string;              // base64url ring coordinate (32 bytes)
    relevance: number;          // float score
  }>;
  size_estimate?: number;       // n_est
  confidence?: number;          // [0, 1]
  sig: string;                  // base64url signature over canonical JSON
}
```

#### RouteAndMaybeAct (JSON)
```
interface RouteAndMaybeActV1 {
  v: 1;
  key: string;                  // base64url key bytes
  want_k: number;
  wants?: number;
  ttl: number;                  // ms or hops (implementation-specific)
  min_sigs: number;
  digest?: string;              // base64url digest
  activity?: string;            // base64url payload
  breadcrumbs?: string[];       // peer ids
  correlation_id: string;       // base64url uuid/bytes
  timestamp: number;            // unix ms
  signature: string;            // base64url signature
}
```

#### NearAnchor (JSON)
```
interface NearAnchorV1 {
  v: 1;
  anchors: string[];            // [succ, pred]
  cohort_hint: string[];        // small peer id set
  estimated_cluster_size: number;
  confidence: number;           // [0, 1]
}
```

### Implementation notes

#### Concurrency and locking
- Digitree: RWMutex for tree operations; separate mutex for relevance updates
- S/P sets: atomic swaps for updates; read-copy-update pattern
- Stabilization: non-blocking; uses snapshot-and-merge approach
- RPC handlers: bounded worker pools per protocol

#### Error handling patterns
- Network errors: exponential backoff with jitter; max 5 retries
- Invalid messages: log and drop; update sender reputation
- Capacity exceeded: evict by relevance; notify higher layers
- Partition detected: alert and enter conservative mode

#### Testing strategy
- Unit tests: Digitree operations, cohort assembly, relevance scoring
- Integration tests: Join/leave scenarios, stabilization convergence
- Simulation: Large-scale churn patterns, partition/merge behavior
- Benchmarks: Routing latency, memory usage, message overhead

### Open questions / next steps
- Exact relevance weight tuning based on network simulations
- Optimal CBOR vs protobuf tradeoffs for different message types
- Proof-of-work difficulty or stake requirements for Sybil resistance
- Integration timeline with existing KadDHT-dependent code
