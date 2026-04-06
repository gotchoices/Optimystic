# 2PC Portable Persistence + Recovery Protocol

description: IKVStore abstraction, PersistentTransactionStateStore implementation, and crash recovery for coordinator and participant
dependencies: 4-2pc-state-store-interface (interface must be wired first)
files:
  - packages/db-p2p/src/storage/i-kv-store.ts (NEW - portable async key-value interface)
  - packages/db-p2p/src/storage/memory-kv-store.ts (NEW - in-memory IKVStore for testing)
  - packages/db-p2p/src/cluster/persistent-transaction-state-store.ts (NEW - IKVStore-backed ITransactionStateStore)
  - packages/db-p2p/src/index.ts (export new modules)
  - packages/db-p2p-storage-fs/src/file-kv-store.ts (NEW - fs-based IKVStore)
  - packages/db-p2p-storage-fs/src/index.ts (export new module)
  - packages/db-p2p-storage-rn/src/mmkv-kv-store.ts (NEW - MMKV-backed IKVStore adapter)
  - packages/db-p2p-storage-rn/src/index.ts (export new module)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (add recovery method)
  - packages/db-p2p/src/cluster/cluster-repo.ts (add recovery method)
  - packages/db-p2p/src/libp2p-node-base.ts (call recovery on startup)
  - packages/db-p2p/test/transaction-state-store.spec.ts (NEW - persistence + recovery tests)
----

## Context

After the `ITransactionStateStore` interface is wired (see dependency ticket), this ticket adds persistent transaction state and startup recovery logic. This is what actually enables crash recovery for 2PC transactions.

The project uses portable storage abstractions (`IRawStorage` with `FileRawStorage`, `MMKVRawStorage`, `MemoryRawStorage` implementations) so it runs on Node, React Native, NativeScript, and browser. Transaction state persistence must follow this same pattern — no direct `fs.promises` or other platform-specific I/O in the store implementation.

Since `IRawStorage` is block-oriented (keyed by `BlockId` + `ActionId`, stores `Transform`/`BlockMetadata`), it doesn't map cleanly to the key-value semantics needed for transaction state. Instead, we introduce a minimal `IKVStore` interface — a general-purpose portable async key-value abstraction. Platform packages provide implementations using their existing infrastructure (`fs.promises`, MMKV, etc.), and `PersistentTransactionStateStore` is written once in `db-p2p` on top of `IKVStore`.

## IKVStore Interface

New file: `packages/db-p2p/src/storage/i-kv-store.ts`

```typescript
/** Portable async key-value store. Platform packages provide implementations. */
export interface IKVStore {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    /** Return all keys matching the given prefix */
    list(prefix: string): Promise<string[]>;
}
```

This is intentionally minimal — just enough for `PersistentTransactionStateStore` and reusable for future needs (e.g., `NetworkStatePersistence` could be refactored to use it).

### MemoryKVStore

New file: `packages/db-p2p/src/storage/memory-kv-store.ts`

In-memory `IKVStore` backed by a `Map<string, string>`. Used for testing `PersistentTransactionStateStore` without platform I/O.

## Platform Implementations

### FileKVStore (db-p2p-storage-fs)

New file: `packages/db-p2p-storage-fs/src/file-kv-store.ts`

Maps keys to files under a base directory. Keys may contain `/` separators which become subdirectories:
- Key `coordinator/abc123` → file `{basePath}/coordinator/abc123.json`
- `list("coordinator/")` → `readdir` on `{basePath}/coordinator/`, return prefixed keys

Uses `fs.promises` — same patterns as `FileRawStorage` (`ensureDir` + `writeFile`, `unlink` ignoring ENOENT, `readdir` + `readFile`).

Export from `packages/db-p2p-storage-fs/src/index.ts`:
```
export * from "./file-kv-store.js";
```

### MMKVKVStore (db-p2p-storage-rn)

New file: `packages/db-p2p-storage-rn/src/mmkv-kv-store.ts`

Trivial adapter wrapping the existing `MMKV` interface (already defined in mmkv-storage.ts):

```typescript
import type { MMKV } from './mmkv-storage.js';
import type { IKVStore } from '@optimystic/db-p2p';

export class MMKVKVStore implements IKVStore {
    constructor(private readonly mmkv: MMKV, private readonly prefix = 'optimystic:txn:') {}
    async get(key: string) { return this.mmkv.getString(this.prefix + key); }
    async set(key: string, value: string) { this.mmkv.set(this.prefix + key, value); }
    async delete(key: string) { this.mmkv.delete(this.prefix + key); }
    async list(prefix: string) {
        const fullPrefix = this.prefix + prefix;
        return this.mmkv.getAllKeys()
            .filter(k => k.startsWith(fullPrefix))
            .map(k => k.slice(this.prefix.length));
    }
}
```

Export from `packages/db-p2p-storage-rn/src/index.ts`:
```
export * from "./mmkv-kv-store.js";
```

## PersistentTransactionStateStore

New file: `packages/db-p2p/src/cluster/persistent-transaction-state-store.ts`

Implements `ITransactionStateStore` using an `IKVStore` for persistence. Written once, works on all platforms.

### Key Namespace

```
coordinator/{messageHash}   → JSON(PersistedCoordinatorState)
participant/{messageHash}    → JSON(PersistedParticipantState)
executed/{messageHash}       → JSON({ timestamp: number })
```

### Implementation Notes

- Constructor takes `IKVStore`
- All methods are thin JSON serialize/deserialize wrappers over `IKVStore` get/set/delete/list
- `getAllCoordinatorStates()` → `kvStore.list("coordinator/")` then `kvStore.get()` each key, parse JSON
- `getAllParticipantStates()` → `kvStore.list("participant/")` then `kvStore.get()` each key, parse JSON
- `pruneExecuted(olderThan)` → `kvStore.list("executed/")`, get each, delete if `timestamp < olderThan`
- `messageHash` is base58btc-encoded, safe for filenames/keys
- JSON serialization (ClusterRecord is fully JSON-serializable — signatures are base64url strings)
- No locking needed: single-process access, JS single-threaded event loop

### Export from db-p2p

Add to `packages/db-p2p/src/index.ts`:
```
export * from "./storage/i-kv-store.js";
export * from "./storage/memory-kv-store.js";
export * from "./cluster/persistent-transaction-state-store.js";
```

## Recovery Protocol

### ClusterCoordinator Recovery

Add `async recoverTransactions(): Promise<void>` method to `ClusterCoordinator`.

Called during node startup (after construction, before accepting requests):

```
1. const states = await stateStore.getAllCoordinatorStates()
2. For each state:
   a. If expired (record.message.expiration < Date.now()):
      - Log warning with messageHash
      - Delete persisted state
   b. If phase === 'broadcasting' and retryState exists:
      - Re-initialize retry timer to resume broadcasting to pending peers
      - Reconstruct ClusterTransactionState in the transactions Map
   c. If phase === 'promising' or 'committing':
      - Transaction was mid-flight when crash occurred
      - Participants have likely timed out; cannot meaningfully resume
      - Log warning, delete persisted state
```

The coordinator does NOT attempt to resume promise/commit collection after a crash — the caller context (`executeClusterTransaction` awaiter) is gone. Only broadcast retries are resumable since they're fire-and-forget.

### ClusterMember Recovery

Add `async recoverTransactions(): Promise<void>` method to `ClusterMember`.

Called during node startup:

```
1. Load executed transactions:
   a. Get all from stateStore (wasExecuted entries)
   b. Populate executedTransactions Map with those not yet expired (< ExecutedTransactionTtlMs)
   c. Prune expired entries from store

2. Load active participant states:
   a. const states = await stateStore.getAllParticipantStates()
   b. For each state:
      - If expired (record.message.expiration < Date.now()):
        Log, delete from store
      - Else:
        Restore into activeTransactions Map
        Set up fresh timeouts based on remaining time to expiration
        (These transactions can respond correctly to coordinator retries)
```

### Startup Wiring (libp2p-node-base.ts)

After constructing `clusterMember` and `coordinatorRepo`, call:
```typescript
await clusterImpl.recoverTransactions?.();
// coordinator recovery is internal to ClusterCoordinator, triggered by CoordinatorRepo or directly
```

The recovery methods are optional (no-op when `stateStore` is undefined).

## Recovery Semantics

### Coordinator crash during promise phase
- Participants waiting for commit will time out and auto-reject via `handleExpiration`
- On coordinator restart: persisted state is detected as stale, cleaned up
- Participant storage-level pending transactions are cleaned up by their own expiration logic

### Coordinator crash during commit phase
- Some participants may have committed, others not
- On restart: if in `broadcasting` phase with retryState, resume retries
- Otherwise: stale, cleaned up (participants handle their own expiration)

### Participant crash after promising
- On restart: restore active transaction from store
- When coordinator retries, participant can respond correctly (already promised)
- If coordinator has given up: participant's expiration timer cleans up

### Participant crash after executing consensus
- On restart: `executedTransactions` is restored from store
- Prevents double execution if coordinator retries consensus broadcast
- This is the **most critical** recovery scenario

## Tests

### Unit tests for IKVStore implementations
- MemoryKVStore: set/get/delete round-trip, list with prefix filtering, delete of non-existent key is no-op
- FileKVStore: same suite but against temp directory (cleanup after test)

### Unit tests for PersistentTransactionStateStore
- Save/get/delete coordinator state round-trip
- Save/get/delete participant state round-trip
- markExecuted + wasExecuted round-trip
- getAllCoordinatorStates returns all entries
- getAllParticipantStates returns all entries
- pruneExecuted removes old entries, keeps recent
- Delete of non-existent key is no-op (no throw)
- Concurrent writes to different keys

Uses `MemoryKVStore` as the backing store — tests the serialization/persistence logic without platform I/O.

### Recovery scenario tests
- **Coordinator recovery: expired transactions cleaned up** — persist a coordinator state with expired message, call recoverTransactions, verify deleted
- **Coordinator recovery: broadcasting phase resumes retries** — persist a broadcasting state with retryState, call recover, verify retry timer is scheduled
- **Coordinator recovery: promising/committing phases cleaned up** — persist non-resumable states, verify deleted after recovery
- **Member recovery: executed transactions restored** — persist executed entries, construct new ClusterMember, call recover, verify wasTransactionExecuted returns true
- **Member recovery: active transactions restored with fresh timeouts** — persist active participant state with future expiration, call recover, verify activeTransactions map populated
- **Member recovery: expired participant states cleaned up** — persist expired participant state, call recover, verify deleted
- **Member recovery: double execution prevented after crash** — persist executed hash, recover, send same transaction record, verify operations NOT re-executed

### Expected test outputs
- All recovery tests should verify both in-memory state AND persistent store state
- Existing `cluster-coordinator.spec.ts` and `cluster-repo.spec.ts` must continue to pass
- `yarn test:p2p` and `yarn test:p2p-storage-fs` must pass

## TODO

### Phase 1: IKVStore interface + implementations
- Create `packages/db-p2p/src/storage/i-kv-store.ts` with `IKVStore` interface
- Create `packages/db-p2p/src/storage/memory-kv-store.ts` (Map-backed, for testing)
- Create `packages/db-p2p-storage-fs/src/file-kv-store.ts` (fs.promises-backed)
- Create `packages/db-p2p-storage-rn/src/mmkv-kv-store.ts` (MMKV adapter)
- Export from respective `index.ts` files

### Phase 2: PersistentTransactionStateStore
- Create `packages/db-p2p/src/cluster/persistent-transaction-state-store.ts`
- Implement all ITransactionStateStore methods via IKVStore with JSON serialization
- Export from `packages/db-p2p/src/index.ts`

### Phase 3: Coordinator recovery
- Add `recoverTransactions()` to ClusterCoordinator
- Handle expired cleanup, broadcasting retry resumption, stale state cleanup
- Log all recovery actions

### Phase 4: Member recovery
- Add `recoverTransactions()` to ClusterMember
- Restore executedTransactions from store
- Restore activeTransactions with fresh timeouts
- Clean up expired entries

### Phase 5: Startup wiring
- Call recovery methods during node bootstrap in libp2p-node-base.ts
- Ensure recovery happens before the node accepts incoming requests

### Phase 6: Tests
- Unit tests for MemoryKVStore and FileKVStore
- Unit tests for PersistentTransactionStateStore (using MemoryKVStore)
- Recovery scenario tests for coordinator
- Recovery scenario tests for member (especially double-execution prevention)
- Run full test suite: `yarn test:p2p` and `yarn test:p2p-storage-fs`
