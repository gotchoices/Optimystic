# 2PC Portable Persistence + Recovery Protocol

description: IKVStore abstraction, ITransactionStateStore interface, PersistentTransactionStateStore, and crash recovery for coordinator and participant
files:
  - packages/db-p2p/src/storage/i-kv-store.ts (IKVStore interface)
  - packages/db-p2p/src/storage/memory-kv-store.ts (in-memory IKVStore)
  - packages/db-p2p/src/cluster/i-transaction-state-store.ts (ITransactionStateStore interface + persisted types)
  - packages/db-p2p/src/cluster/memory-transaction-state-store.ts (in-memory ITransactionStateStore)
  - packages/db-p2p/src/cluster/persistent-transaction-state-store.ts (IKVStore-backed persistence)
  - packages/db-p2p-storage-fs/src/file-kv-store.ts (fs-backed IKVStore)
  - packages/db-p2p-storage-rn/src/mmkv-kv-store.ts (MMKV-backed IKVStore)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (stateStore, persistence, recoverTransactions)
  - packages/db-p2p/src/cluster/cluster-repo.ts (stateStore, persistence, recoverTransactions, wasTransactionExecutedAsync)
  - packages/db-p2p/src/repo/coordinator-repo.ts (threads stateStore through)
  - packages/db-p2p/src/libp2p-node-base.ts (transactionStateStore option, recovery on startup)
  - packages/db-p2p/src/index.ts (exports)
  - packages/db-p2p-storage-fs/src/index.ts (export FileKVStore)
  - packages/db-p2p-storage-rn/src/index.ts (export MMKVKVStore)
  - packages/db-p2p/test/transaction-state-store.spec.ts (31 tests)
  - packages/db-p2p/test/cluster-repo.spec.ts (2 new tests for persistent dedup)
----

## What was built

### IKVStore — portable key-value abstraction
Minimal async interface (`get`/`set`/`delete`/`list`) with three implementations:
- **MemoryKVStore** — Map-backed, for testing
- **FileKVStore** — fs.promises-backed, keys with `/` become subdirectories
- **MMKVKVStore** — MMKV adapter for React Native, prefixed keys

### ITransactionStateStore — 2PC transaction state persistence
Coordinator state, participant state, and executed-transaction dedup guard. Two implementations:
- **MemoryTransactionStateStore** — Map-backed, default when no persistent store injected
- **PersistentTransactionStateStore** — wraps IKVStore with JSON serialization

### DI wiring
- `ClusterCoordinator` accepts optional `stateStore`; fire-and-forget persistence at key lifecycle points
- `ClusterMember` accepts optional `stateStore`; persists participant state, marks executed, prunes expired
- `CoordinatorRepo` threads `stateStore` through to coordinator
- `libp2p-node-base.ts` accepts `transactionStateStore` in `NodeOptions`

### Recovery protocol
- **ClusterCoordinator.recoverTransactions()**: Loads persisted states, cleans expired, resumes broadcasting-phase retries
- **ClusterMember.recoverTransactions()**: Prunes expired executed entries, restores active participant states with fresh timeouts
- **ClusterMember.wasTransactionExecutedAsync()**: Falls back to persistent store when in-memory map misses; re-populates in-memory map for future sync checks

## Review fixes applied

1. **Removed stale TODO** in `cluster-coordinator.ts` — "move this into a state management interface" was already implemented.
2. **Wired `wasTransactionExecutedAsync` into consensus flow** — the method existed but was never called. Now `processUpdate` calls it before `handleConsensus` for both the `Consensus` and `OurCommitNeeded→Consensus` paths, providing persistent dedup after crash recovery.
3. **Added 2 tests** in `cluster-repo.spec.ts`:
   - `wasTransactionExecutedAsync falls back to persistent store after restart` — verifies sync miss → async hit → sync hit (re-populated)
   - `persistent dedup prevents double execution after restart` — full integration test verifying a restarted member won't re-execute an already-executed transaction

## Testing

- 381 tests pass (`yarn test:db-p2p`), including 31 in `transaction-state-store.spec.ts` and 2 new in `cluster-repo.spec.ts`
- TypeScript compiles cleanly; full workspace build passes

## Usage

```typescript
import { PersistentTransactionStateStore, MemoryKVStore } from '@optimystic/db-p2p';
import { FileKVStore } from '@optimystic/db-p2p-storage-fs';

const kvStore = new FileKVStore('/path/to/txn-state');
const stateStore = new PersistentTransactionStateStore(kvStore);

const node = await createOptimysticNode({
  ...options,
  transactionStateStore: stateStore
});
```
