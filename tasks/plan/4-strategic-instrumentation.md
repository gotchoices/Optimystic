----
description: Add debug-based strategic instrumentation across packages
dependencies: debug library
----

Add `createLogger(subNamespace)` helper in each package using `debug` with base namespaces:
- `optimystic:db-core` and `optimystic:db-p2p`

Instrument key decision points (minimal but high signal):
- Key routing: cache hit/miss, selected coordinator, connection count
- Repo/Cluster services: responsibilityK used, inCluster vs redirect, peer list lengths
- Protocol client: dial start/ok/fail with protocol and peer, first-byte/response timing
- NetworkTransactor: batch creation sizes, retries, stale/missing summaries, cancel triggers
- Batch coordinator: retry paths and excluded peers
- Storage repo/block storage: pend/commit/cancel entry/exit with ids and revs (no payloads)
- ClusterCoordinator/Member: phase transitions, majority calc, promise/commit counts

Provide env-based toggles via DEBUG (document common useful patterns in README).
