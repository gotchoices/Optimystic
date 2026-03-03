description: Add lightweight timing metrics, correlation IDs, and optional verbose tracing for transaction performance and network health
dependencies: transaction protocol (db-core), networking layer (db-p2p)
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-p2p/src/protocol-client.ts
  - packages/db-p2p/src/libp2p-key-network.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
  - packages/db-p2p/src/repo/client.ts
  - packages/db-core/src/logger.ts
  - packages/db-p2p/src/logger.ts
----

## Overview

Add observability instrumentation across the transaction pipeline. Three concerns:

1. **Timing metrics (ms)** — lightweight `Date.now()` deltas logged at key boundaries
2. **Correlation ID** — thread `trxId` (transaction stamp id or actionId) through logs so a single transaction's lifecycle can be traced across layers
3. **Verbose tracing flag** — env-gated (`OPTIMYSTIC_VERBOSE`) extra detail (batch contents, peer lists, candidate sets) for diagnosing specific issues

### Design Principles

- Use existing `debug` loggers — no new dependencies
- Use `Date.now()` for timing — no perf_hooks overhead
- Correlation IDs use existing identifiers (TransactionStamp.id, actionId, messageHash) — no new ID generation
- Verbose flag is a single env check cached at module load, not per-call
- Don't restructure existing log calls; augment them with correlation and timing fields

---

## 1. Timing Metrics

### TransactionCoordinator (`db-core/src/transaction/coordinator.ts`)

`coordinateTransaction()` already calls gather/pend/commit phases sequentially. Add `Date.now()` around each phase and log a summary:

```
trx:phases trxId=%s gather=%dms pend=%dms commit=%dms total=%dms
```

Also log phase-level timing on the `execute()` method (engine execution + apply + coordinate).

### NetworkTransactor (`db-core/src/transactor/network-transactor.ts`)

`pend()` and `commit()` already log at start. Add end-of-method timing:

```
pend:done actionId=%s ms=%d batches=%d
commit:done actionId=%s ms=%d
```

The `get()` method should also get end-timing:

```
get:done blockIds=%d ms=%d
```

### DHT Operations (`db-p2p/src/libp2p-key-network.ts`)

`findCoordinator()` already has `this.log('findCoordinator:start ...')`. Add timing to emit:

```
findCoordinator:done key=%s ms=%d source=%s
```

where `source` is one of: `cache`, `fret`, `connected-fallback`, `self`.

`findCluster()` similarly needs start/done timing:

```
findCluster:start key=%s
findCluster:done key=%s ms=%d peers=%d
```

### ProtocolClient (`db-p2p/src/protocol-client.ts`)

Already has dial/first-byte/response timing. No changes needed here — the existing timing is sufficient.

---

## 2. Correlation ID

The transaction already has natural correlation IDs:

- **TransactionStamp.id** (`stamp:xxxx`) — created at BEGIN, stable through lifecycle
- **Transaction.id** (`tx:xxxx`) — finalized at COMMIT
- **actionId** — equals transaction.id, flows through pend/commit/cancel
- **messageHash** — used in ClusterCoordinator, unique per cluster transaction

### Threading Strategy

**TransactionCoordinator**: Already has `transaction.id` in scope. Add `trxId=` prefix to phase logs.

**NetworkTransactor**: Already logs `actionId` in pend/commit/cancel. This IS the correlation ID. Ensure it's on the new timing logs too.

**ProtocolClient**: Add optional `correlationId` to the `processMessage` options. `RepoClient.processRepoMessage()` can extract the actionId from operations (it's in pend.actionId, commit.actionId) and pass it through. Log as `cid=%s` alongside existing peer/protocol fields.

**ClusterCoordinator**: Already uses `messageHash` as correlation in every log call. No changes needed.

---

## 3. Verbose Tracing

Add a `verbose` flag in each package's logger module, read from `process.env.OPTIMYSTIC_VERBOSE` at module load:

```typescript
// In logger.ts (both packages)
export const verbose = typeof process !== 'undefined'
    && (process.env.OPTIMYSTIC_VERBOSE === '1' || process.env.OPTIMYSTIC_VERBOSE === 'true');
```

Use `verbose` to gate additional detail in:

**NetworkTransactor**: After `consolidateCoordinators`, if verbose, log the batch→peer assignments and block distributions.

**ClusterCoordinator**: In `collectPromises` and `commitTransaction`, if verbose, log full peer list with addresses and response payloads (currently only logs peer counts/IDs).

**findCoordinator/findCluster**: If verbose, log the full FRET candidate list and connected peer set (currently truncated to 12 chars).

Guard pattern:
```typescript
if (verbose) log('pend:batches actionId=%s detail=%o', actionId, batchSummary);
```

---

## TODO

Phase 1: Infrastructure
- Add `verbose` export to both `packages/db-core/src/logger.ts` and `packages/db-p2p/src/logger.ts`

Phase 2: Timing metrics
- Add phase timing to `TransactionCoordinator.coordinateTransaction()` and `execute()`
- Add end-of-method timing to `NetworkTransactor.get()`, `pend()`, `commit()`
- Add start/done timing to `Libp2pKeyPeerNetwork.findCoordinator()` and `findCluster()`

Phase 3: Correlation IDs
- Add optional `correlationId` to `ProtocolClient.processMessage()` options, log as `cid=%s`
- Extract and forward correlation ID from `RepoClient.processRepoMessage()` (from actionId in operations)
- Add `trxId` to `TransactionCoordinator` phase logs

Phase 4: Verbose tracing
- Gate batch detail logging in `NetworkTransactor.consolidateCoordinators()` and `pend()`
- Gate full peer/address logging in `ClusterCoordinator.collectPromises()` and `commitTransaction()`
- Gate full candidate logging in `findCoordinator()` and `findCluster()`

Phase 5: Tests
- Add unit test for `verbose` flag parsing (both true/false/absent)
- Add test that correlation IDs appear in timing logs (mock logger, run coordinator, assert log args contain trxId)
- Verify build passes
