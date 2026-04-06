# 2PC State Store Interface + DI Wiring

description: Extract 2PC transaction state behind ITransactionStateStore interface with memory-backed default
dependencies: none
files:
  - packages/db-p2p/src/cluster/i-transaction-state-store.ts (NEW - interface + types)
  - packages/db-p2p/src/cluster/memory-transaction-state-store.ts (NEW - in-memory implementation)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (inject store, persist at key points)
  - packages/db-p2p/src/cluster/cluster-repo.ts (inject store, persist at key points)
  - packages/db-p2p/src/repo/coordinator-repo.ts (thread store through factory)
  - packages/db-p2p/src/libp2p-node-base.ts (accept and pass store)
  - packages/db-p2p/src/index.ts (export new modules)
  - packages/db-p2p/test/cluster-coordinator.spec.ts (verify existing tests pass)
  - packages/db-p2p/test/cluster-repo.spec.ts (verify existing tests pass)
----

## Context

`ClusterCoordinator` and `ClusterMember` store all 2PC transaction state in plain `Map`s (cluster-coordinator.ts:39, cluster-repo.ts:74-76). On crash, state is lost and transactions may be orphaned. This ticket extracts that state behind a platform-agnostic interface so that a persistent implementation can be injected later via `IKVStore` (see recovery-persistence ticket).

This is purely a refactoring ticket. The `MemoryTransactionStateStore` preserves exact current behavior. All existing tests must pass unchanged.

## Interface Design

### Persisted Types

Only the serializable subset of transaction state is persisted. Timers, Pending wrappers, and in-flight promises are reconstructed at runtime.

```typescript
/** Serializable coordinator transaction state (excludes timers, Pending wrapper) */
interface PersistedCoordinatorState {
    messageHash: string;
    record: ClusterRecord;
    lastUpdate: number;
    /** Which phase was reached when last persisted */
    phase: 'promising' | 'committing' | 'broadcasting';
    /** Retry state for commit broadcast failures (excludes timer) */
    retryState?: {
        pendingPeers: string[];
        attempt: number;
        intervalMs: number;
    };
}

/** Serializable participant transaction state (excludes timers) */
interface PersistedParticipantState {
    messageHash: string;
    record: ClusterRecord;
    lastUpdate: number;
}
```

### ITransactionStateStore

```typescript
interface ITransactionStateStore {
    // --- Coordinator state (keyed by messageHash) ---
    saveCoordinatorState(messageHash: string, state: PersistedCoordinatorState): Promise<void>;
    getCoordinatorState(messageHash: string): Promise<PersistedCoordinatorState | undefined>;
    deleteCoordinatorState(messageHash: string): Promise<void>;
    getAllCoordinatorStates(): Promise<PersistedCoordinatorState[]>;

    // --- Participant state (keyed by messageHash) ---
    saveParticipantState(messageHash: string, state: PersistedParticipantState): Promise<void>;
    getParticipantState(messageHash: string): Promise<PersistedParticipantState | undefined>;
    deleteParticipantState(messageHash: string): Promise<void>;
    getAllParticipantStates(): Promise<PersistedParticipantState[]>;

    // --- Executed transaction dedup guard ---
    markExecuted(messageHash: string, timestamp: number): Promise<void>;
    wasExecuted(messageHash: string): Promise<boolean>;
    pruneExecuted(olderThan: number): Promise<void>;
}
```

The `getAll*` methods return arrays (not AsyncIterable) since in-flight transaction count is small (typically < 10).

### MemoryTransactionStateStore

Wraps three `Map`s — mirrors the current in-memory behavior exactly. This is the default when no persistent store is injected.

## Wiring Changes

### ClusterCoordinator (cluster-coordinator.ts)

Add optional `stateStore?: ITransactionStateStore` as the last constructor parameter.

Persist at these points (only when `stateStore` is provided):
1. **After storing transaction state** (line ~158) — `saveCoordinatorState(hash, { phase: 'promising', ... })`
2. **After collecting promises, before committing** (in `executeTransaction` ~line 225) — `saveCoordinatorState(hash, { phase: 'committing', ... })`
3. **After consensus broadcast** (~line 537) — `saveCoordinatorState(hash, { phase: 'broadcasting', retryState, ... })`
4. **On cleanup** (lines ~187, ~672-678) — `deleteCoordinatorState(hash)`

All persistence calls are fire-and-forget with error logging (same pattern as `NetworkStatePersistence.save()` in libp2p-key-network.ts:55).

### ClusterMember (cluster-repo.ts)

Add optional `stateStore?: ITransactionStateStore` to `ClusterMemberComponents` (line ~47).

Persist at these points:
1. **When `shouldPersist = true`** (~line 272) — `saveParticipantState(hash, { record, lastUpdate })`
2. **When clearing transaction** (~line 939) — `deleteParticipantState(hash)`
3. **After marking executed** (~line 640) — `markExecuted(hash, Date.now())`
4. **During expired transaction cleanup** (~line 900) — `pruneExecuted(threshold)`

The `wasTransactionExecuted()` method (line 110) should also check the store when the in-memory map misses (fallback to `await stateStore.wasExecuted(hash)`). Since this method is currently sync, either:
- Make it async (preferred — callers already handle promises)
- Or pre-load on construction (adds init step)

Check callers of `wasTransactionExecuted`: coordinator-repo.ts uses it via the `localCluster` ref (line 90). It's called after `await pending.result()` (line 168), so making it async is straightforward.

### CoordinatorRepo (coordinator-repo.ts)

Thread `stateStore` through the factory function (line 38-56) into `ClusterCoordinator` constructor.

### libp2p-node-base.ts

Add optional `transactionStateStore?: ITransactionStateStore` to `NodeOptions`. Pass to both `clusterMember()` and `coordinatorRepo()` factory.

### Exports (index.ts)

Add:
```
export * from "./cluster/i-transaction-state-store.js";
export * from "./cluster/memory-transaction-state-store.js";
```

## Key Constraints

- All persistence calls are **fire-and-forget** with error logging — must not slow down the transaction hot path
- `MemoryTransactionStateStore` resolves immediately (synchronous Maps wrapped in Promise.resolve)
- No new dependencies
- Cross-platform: interface uses only serializable types (no Node.js specifics)
- Existing tests must pass without modification

## Tests

- Existing `cluster-coordinator.spec.ts` (5 tests) and `cluster-repo.spec.ts` (~30 tests) must pass unchanged
- Add a small unit test for `MemoryTransactionStateStore` CRUD operations

## TODO

### Phase 1: Interface + Memory implementation
- Create `packages/db-p2p/src/cluster/i-transaction-state-store.ts` with `ITransactionStateStore`, `PersistedCoordinatorState`, `PersistedParticipantState`
- Create `packages/db-p2p/src/cluster/memory-transaction-state-store.ts`
- Export both from `packages/db-p2p/src/index.ts`

### Phase 2: Wire into ClusterCoordinator
- Add `stateStore?: ITransactionStateStore` to constructor
- Add `saveCoordinatorState` calls after transaction store, after promise collection, after consensus broadcast
- Add `deleteCoordinatorState` calls on cleanup and retry completion
- Thread through `CoordinatorRepo` factory and constructor

### Phase 3: Wire into ClusterMember
- Add `stateStore?: ITransactionStateStore` to `ClusterMemberComponents`
- Add `saveParticipantState` / `deleteParticipantState` at persist/clear points
- Add `markExecuted` after consensus execution
- Add `pruneExecuted` in `queueExpiredTransactions`
- Make `wasTransactionExecuted` async with store fallback
- Update `ClusterMemberComponents` interface and `clusterMember()` factory
- Update `LocalClusterWithExecutionTracking` in coordinator-repo.ts if `wasTransactionExecuted` becomes async

### Phase 4: Wire into node bootstrap
- Add `transactionStateStore` to NodeOptions in libp2p-node-base.ts
- Pass to clusterMember and coordinatorRepo

### Phase 5: Verify
- Run `yarn test:p2p` — all existing tests must pass
- Add unit tests for MemoryTransactionStateStore
