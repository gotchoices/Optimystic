* Implement cross-collection transactions by concatenating transactors
* Have the NetworkTransactor look for intersections between clusters, rather than arbitrary coordinators.
* Resolve case for concurrent collection creation
* Potential enhancement: have the peers at or around the block's CID submit the block, to make the source more anonymous
* Allow local storage of configuration data to be located in backup storage
* Add Atomic() wrappers to btree to avoid corruption on errors
* Encode an expiration into a transaction ID to create an outer limit, or at least pass an expiration around
* Implement peer reputation system to handle malicious nodes
* Add support for collection-level access controls and permissions
* Optimize block materialization caching strategies
* Implement automatic cluster rebalancing based on network topology changes
* Add metrics and monitoring for transaction performance and network health
* Implement data compression for block storage to reduce network overhead
* Add support for custom collection types beyond trees and diaries
* Implement cross-network federation capabilities for multi-cluster deployments
* Fix for collection test: "should handle concurrent modifications"

* Separate routing vs replication responsibility
  * Introduce a dedicated responsibilityK (replica set size/quorum basis) distinct from DHT kBucketSize
  * Update repo/cluster services to use responsibilityK when computing responsibility (inCluster vs redirect)
  * Expose responsibilityK via `createLibp2pNode` options and/or environment config; default to 1 initially

* Wire real cluster logic (replace stub)
  * Replace `clusterLogic` stub in `libp2p-node` with actual cluster implementation
  * Coordinator-side: use `ClusterCoordinator` to run 2PC across responsibility peers
  * Member-side: implement an `ICluster` member that validates/pends/commits against local `StorageRepo`
  * Ensure `CoordinatorRepo` is used for distributed ops and `StorageRepo` only for local execution

* Strategic instrumentation (debug-based)
  * Add `createLogger(subNamespace)` helper in each package using `debug` with base namespaces:
    * `optimystic:db-core` and `optimystic:db-p2p`
  * Instrument key decision points (minimal but high signal):
    * Key routing: cache hit/miss, selected coordinator, connection count
    * Repo/Cluster services: responsibilityK used, inCluster vs redirect, peer list lengths
    * Protocol client: dial start/ok/fail with protocol and peer, first-byte/response timing
    * NetworkTransactor: batch creation sizes, retries, stale/missing summaries, cancel triggers
    * Batch coordinator: retry paths and excluded peers
    * Storage repo/block storage: pend/commit/cancel entry/exit with ids and revs (no payloads)
    * ClusterCoordinator/Member: phase transitions, majority calc, promise/commit counts
  * Provide env-based toggles via DEBUG (document common useful patterns in README)

* Responsibility-driven redirects
  * With responsibilityK=1, ensure non-coordinators immediately return redirect hints
  * Repo client: single-hop follow, cache hint, then operate directly until cache expiry

* Diagnostics and observability
  * Add lightweight timing metrics (ms) for: DHT closestPeers, protocol roundtrips, pend/commit end-to-end
  * Add a per-request correlation id (e.g. trxId/messageHash) to logs across layers
  * Add optional verbose tracing flag (env) to include batch/peer details when diagnosing

* Test plans (mesh sanity)
  * 3-node mesh, responsibilityK=1: create-diary, add-entry, read-diary; verify redirects then cache
  * Scale to responsibilityK=3 (after Member impl): quorum commit, partial failures, and recovery
  * DHT offline/slow path: verify fallback to connected-peer routing works and logs are informative

* Gossip-based reputation and blacklisting
  * Implement signed misbehavior reports and local reputation scoring (expiring, thresholded)
  * Gossip summaries/evidence (e.g., invalid validations, equivocation) to neighbors; use as inputs, not hard authority
  * Coordinator selection and cluster expansion should down-rank blacklisted peers; expose config/persistence
  * Provide APIs to report bad peers and to query current reputation state; document usage

* Hot transaction seeding on peer join
  * On join, identify regions near the peer ID and request current hot (pending/recent) transactions for those blocks
  * Members/coordinator rebroadcast succinct deltas (pend/commit certs) to new peer with rate limits/TTLs
  * Ensure idempotency and bounded load (per-block caps, backpressure); verify commit certificates on receipt
  * Add observability for join catch-up (counts, bytes, durations)

* Hello world - demo app - test across all layers - messages or something

* FRET overlay validation and testing
  * Build a deterministic simulation harness (headless) for FRET
    * Deterministic RNG + seeded topology generator (N peers on 256-bit ring)
    * Event scheduler for joins/leaves/link-latency; bounded queues to emulate backpressure
    * Metrics: stabilization convergence time, neighbor coverage, path length, drop rates
  * Property-based tests (fast-check)
    * Ring invariants: symmetric m predecessors/successors, wrap-around, no duplicates
    * Cohort assembly: two-sided alternation correctness, monotonic expansion
    * Anchor selection: connected-first preference within tolerance; depends on size estimate/confidence
  * RPC codec fuzzing (JSON)
    * Round-trip encode/ decode; malformed/truncated payloads do not crash handlers
    * Backpressure signals honored; token-bucket limits enforced per-peer and global
  * Size estimator evaluation
    * Synthetic rings with gaps/skew; assert n within tolerance and confidence monotonic with sample size
  * Relevance scoring and eviction
    * Down-rank on failures/timeouts; neighbors have infinite eviction score; verify decay bounds
  * Churn scenarios (simulation)
    * Batched leave/join; proactive neighbor announcements maintain coverage; routeAct still finds anchors
  * Libp2p in-memory integration tests
    * Use memory transport to spin up 3–10 nodes; verify neighbor exchange, routeAct anchors, stabilization without real network
  * Profiles and rate limits
    * Edge vs Core: ensure limits, queue depths, and act concurrency honored
  * CI matrix
    * Run simulation across N∈{5,25,100}, churn∈{0,1,5}%/s, profiles∈{edge,core}; export JSON metrics artifacts

* FRET implementation (remaining)
  * Add round-trip timing into peer cache; given this a relevance score so that "nearer" peers get preference.  How to score?  Maybe incrementally maintain the distribution of timings and gaussian score relatively.
  * Register FRET as a libp2p PeerDiscovery module that emits discovered peers from neighbor snapshots
  * Proactive announcements on start and after topology change (bounded fanout, non-connected only)
  * Iterative anchor lookup and forwarding (maybeAct): TTL, breadcrumbs, connected-first next-hop
  * Seed new peers quickly: include bounded snapshot samples and size/confidence; exchange on first contact
  * Active preconnect mode: pre-dial small anchor/neighbors set; back off on failures
  * Enforce payload bounds and TTL checks in all RPCs; explicit backpressure signals
  * Leave protocol usage: sendLeave to S/P (+bounded expansion) and neighbor announce replacements
  * Optional fingers: maintain small long-range finger set; refresh probabilistically
  * Diagnostics: counters for RPCs, hop counts, convergence; debug toggle in README

* Documentation
  * Expand docs/fret.md with simulator design, invariants, and test methodology
  * Document JSON schemas for RPCs and expected responses with examples
