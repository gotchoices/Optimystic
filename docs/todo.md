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

* ~~Separate routing vs replication responsibility~~ ✓ DONE
  * ~~Introduce a dedicated responsibilityK (replica set size/quorum basis) distinct from DHT kBucketSize~~
  * ~~Update repo/cluster services to use responsibilityK when computing responsibility (inCluster vs redirect)~~
  * ~~Expose responsibilityK via `createLibp2pNode` options and/or environment config; default to 1 initially~~

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
