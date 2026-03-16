description: Review transaction metrics instrumentation — timing, correlation IDs, and verbose tracing
dependencies: none
files:
  - packages/db-core/src/logger.ts
  - packages/db-p2p/src/logger.ts
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-p2p/src/protocol-client.ts
  - packages/db-p2p/src/libp2p-key-network.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
  - packages/db-p2p/src/repo/client.ts
  - packages/db-core/test/transaction-metrics.spec.ts
  - packages/db-p2p/test/transaction-metrics.spec.ts
----

## Summary

Lightweight observability instrumentation was added across the transaction pipeline covering three concerns:

### 1. Timing Metrics (`Date.now()` deltas)
- **TransactionCoordinator.coordinateTransaction()**: logs `trx:phases trxId=%s gather=%dms pend=%dms commit=%dms total=%dms`
- **TransactionCoordinator.execute()**: logs engine/apply/coordinate phase timings with `trxId`
- **NetworkTransactor.get()**: logs `get:done blockIds=%d ms=%d`
- **NetworkTransactor.pend()**: logs `pend:done actionId=%s ms=%d batches=%d`
- **NetworkTransactor.commit()**: logs `commit:done actionId=%s ms=%d`
- **findCoordinator()**: logs `findCoordinator:done key=%s ms=%d source=%s` (source: cache/fret/connected-fallback/self)
- **findCluster()**: logs `findCluster:done key=%s ms=%d peers=%d`

### 2. Correlation IDs
- **TransactionCoordinator**: uses `trxId` (transaction.id) in all phase/execute logs
- **NetworkTransactor**: uses `actionId` as correlation in pend/commit/cancel logs
- **ProtocolClient.processMessage()**: accepts optional `correlationId`, logs as `cid=%s`
- **RepoClient**: extracts actionId from operations and forwards as correlationId
- **ClusterCoordinator**: uses `messageHash` as correlation in all cluster-tx logs

### 3. Verbose Tracing (`OPTIMYSTIC_VERBOSE=1`)
- Both `db-core/src/logger.ts` and `db-p2p/src/logger.ts` export a `verbose` boolean flag
- **NetworkTransactor.pend()**: batch→peer assignments with block distributions
- **ClusterCoordinator.collectPromises()** and **commitTransaction()**: full peer list with addresses
- **findCoordinator()**: full FRET candidate list and connected peer set
- **findCluster()**: full cohort and connected peer detail

### Testing Use Cases
- `verbose` flag is `false` when `OPTIMYSTIC_VERBOSE` is unset
- `verbose` flag is `true` when `OPTIMYSTIC_VERBOSE` is `'1'` or `'true'`
- `verbose` exports are boolean type in both packages
- Build passes (db-core: 261 tests, db-p2p: 268 tests — all passing)
