# 2PC Portable Persistence + Recovery Protocol

description: IKVStore abstraction, ITransactionStateStore interface, PersistentTransactionStateStore, and crash recovery for coordinator and participant
files:
  - packages/db-p2p/src/cluster/i-transaction-state-store.ts (NEW - interface + persisted state types)
  - packages/db-p2p/src/cluster/memory-transaction-state-store.ts (NEW - in-memory ITransactionStateStore)
  - packages/db-p2p/src/cluster/persistent-transaction-state-store.ts (NEW - IKVStore-backed ITransactionStateStore)
  - packages/db-p2p/src/storage/i-kv-store.ts (NEW - portable async key-value interface)
  - packages/db-p2p/src/storage/memory-kv-store.ts (NEW - in-memory IKVStore for testing)
  - packages/db-p2p-storage-fs/src/file-kv-store.ts (NEW - fs-based IKVStore)
  - packages/db-p2p-storage-rn/src/mmkv-kv-store.ts (NEW - MMKV-backed IKVStore adapter)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (added stateStore param, persistence calls, recoverTransactions)
  - packages/db-p2p/src/cluster/cluster-repo.ts (added stateStore to components, persistence calls, recoverTransactions, wasTransactionExecutedAsync)
  - packages/db-p2p/src/repo/coordinator-repo.ts (threaded stateStore through factory)
  - packages/db-p2p/src/libp2p-node-base.ts (transactionStateStore option, recovery on startup)
  - packages/db-p2p/src/index.ts (exports for new modules)
  - packages/db-p2p-storage-fs/src/index.ts (export FileKVStore)
  - packages/db-p2p-storage-rn/src/index.ts (export MMKVKVStore)
  - packages/db-p2p/test/transaction-state-store.spec.ts (NEW - 31 tests)
----

## What was built

### IKVStore — portable key-value abstraction
Minimal async interface (`get`/`set`/`delete`/`list`) with three implementations:
- **MemoryKVStore** — Map-backed, for testing
- **FileKVStore** — fs.promises-backed, keys with `/` become subdirectories, `.json` file extension
- **MMKVKVStore** — MMKV adapter for React Native, prefixed keys

### ITransactionStateStore — 2PC transaction state interface
Defines persistence methods for coordinator state, participant state, and executed transaction dedup guard:
- `saveCoordinatorState` / `getCoordinatorState` / `deleteCoordinatorState` / `getAllCoordinatorStates`
- `saveParticipantState` / `getParticipantState` / `deleteParticipantState` / `getAllParticipantStates`
- `markExecuted` / `wasExecuted` / `pruneExecuted`

Two implementations:
- **MemoryTransactionStateStore** — Map-backed, default when no persistent store injected
- **PersistentTransactionStateStore** — wraps IKVStore with JSON serialization, key namespace: `coordinator/`, `participant/`, `executed/`

### DI wiring
- `ClusterCoordinator` accepts optional `stateStore` — fire-and-forget persistence at key transaction lifecycle points
- `ClusterMember` accepts optional `stateStore` via `ClusterMemberComponents` — persists participant state, marks executed, prunes expired
- `CoordinatorRepo` threads `stateStore` through to coordinator
- `libp2p-node-base.ts` accepts `transactionStateStore` in `NodeOptions`, passes to both member and coordinator

### Recovery protocol
- **ClusterCoordinator.recoverTransactions()**: Loads persisted states, cleans expired, resumes broadcasting-phase retries, discards stale promising/committing states
- **ClusterMember.recoverTransactions()**: Prunes expired executed entries, restores active participant states with fresh timeouts
- **ClusterMember.wasTransactionExecutedAsync()**: Falls back to persistent store when in-memory map misses
- Recovery called during node startup in `createLibp2pNodeBase()` after cluster components are initialized

## Testing

31 new tests in `packages/db-p2p/test/transaction-state-store.spec.ts`:
- MemoryKVStore: set/get/delete round-trip, prefix list, missing key, non-existent delete
- MemoryTransactionStateStore: full CRUD for coordinator/participant/executed, pruning, getAllStates
- PersistentTransactionStateStore: same suite but over MemoryKVStore (validates JSON serialization layer), concurrent writes
- Recovery scenarios: expired state cleanup, broadcasting phase retry preservation, non-resumable phase cleanup, executed transaction restoration, double-execution prevention, pruneExecuted behavior

All 356 tests pass (`yarn test:db-p2p`). Full workspace test suite passes.

## Usage

```typescript
import { PersistentTransactionStateStore, MemoryKVStore } from '@optimystic/db-p2p';
import { FileKVStore } from '@optimystic/db-p2p-storage-fs';

// Node.js: use FileKVStore
const kvStore = new FileKVStore('/path/to/txn-state');
const stateStore = new PersistentTransactionStateStore(kvStore);

// React Native: use MMKVKVStore
// import { MMKVKVStore } from '@optimystic/db-p2p-storage-rn';
// const kvStore = new MMKVKVStore(mmkvInstance);
// const stateStore = new PersistentTransactionStateStore(kvStore);

// Pass to node creation
const node = await createOptimysticNode({
  ...options,
  transactionStateStore: stateStore
});
```

## Key review points

- All persistence calls are fire-and-forget (catch + log) to avoid slowing the transaction hot path
- Recovery is called after construction but before accepting requests
- Coordinator only resumes broadcasting-phase retries (promising/committing phases are stale after crash)
- Member's `wasTransactionExecutedAsync` provides persistent fallback for dedup guard
- The synchronous `wasTransactionExecuted` method is preserved for backward compatibility
