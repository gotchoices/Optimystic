# 2PC File Persistence + Recovery Protocol

description: Persistent ITransactionStateStore implementation with crash recovery for coordinator and participant
dependencies: 4-2pc-state-store-interface (interface must be wired first)
files:
  - packages/db-p2p-storage-fs/src/file-transaction-state-store.ts (NEW - file-based implementation)
  - packages/db-p2p-storage-fs/src/index.ts (export new module)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (add recovery method)
  - packages/db-p2p/src/cluster/cluster-repo.ts (add recovery method)
  - packages/db-p2p/test/transaction-state-store.spec.ts (NEW - persistence + recovery tests)
  - packages/db-p2p-storage-fs/package.json (verify no new deps needed)
  - packages/db-p2p/src/libp2p-node-base.ts (call recovery on startup)
----

## Context

After the `ITransactionStateStore` interface is wired (see dependency ticket), this ticket adds a file-based persistent implementation and startup recovery logic. This is what actually enables crash recovery for 2PC transactions.

## FileTransactionStateStore

File-based implementation in `db-p2p-storage-fs`, following the same patterns as `FileRawStorage` (file-storage.ts).

### Directory Layout

```
{basePath}/
├── coordinator/
│   ├── {messageHash}.json       # PersistedCoordinatorState
│   └── ...
├── participant/
│   ├── {messageHash}.json       # PersistedParticipantState
│   └── ...
└── executed/
    ├── {messageHash}.json       # { timestamp: number }
    └── ...
```

### Implementation Notes

- Use `fs.promises` for all I/O (same as FileRawStorage)
- `ensureDir` + `writeFile` pattern from FileRawStorage
- `readdir` + `readFile` for `getAll*` methods
- `unlink` for delete (ignore ENOENT, same as FileRawStorage.deletePendingTransaction)
- `messageHash` is base58btc-encoded, safe for filenames
- JSON serialization (ClusterRecord is fully JSON-serializable — signatures are base64url strings)
- No locking needed: single-process access, JS single-threaded event loop

### Export from db-p2p-storage-fs

Add to `packages/db-p2p-storage-fs/src/index.ts`:
```
export * from "./file-transaction-state-store.js";
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

### Unit tests for FileTransactionStateStore
- Save/get/delete coordinator state round-trip
- Save/get/delete participant state round-trip  
- markExecuted + wasExecuted round-trip
- getAllCoordinatorStates returns all entries
- getAllParticipantStates returns all entries
- pruneExecuted removes old entries, keeps recent
- Delete of non-existent key is no-op (no throw)
- Concurrent writes to different keys

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

### Phase 1: FileTransactionStateStore
- Create `packages/db-p2p-storage-fs/src/file-transaction-state-store.ts`
- Implement all ITransactionStateStore methods using fs.promises
- Export from `packages/db-p2p-storage-fs/src/index.ts`

### Phase 2: Coordinator recovery
- Add `recoverTransactions()` to ClusterCoordinator
- Handle expired cleanup, broadcasting retry resumption, stale state cleanup
- Log all recovery actions

### Phase 3: Member recovery
- Add `recoverTransactions()` to ClusterMember
- Restore executedTransactions from store
- Restore activeTransactions with fresh timeouts
- Clean up expired entries

### Phase 4: Startup wiring
- Call recovery methods during node bootstrap in libp2p-node-base.ts
- Ensure recovery happens before the node accepts incoming requests

### Phase 5: Tests
- Unit tests for FileTransactionStateStore
- Recovery scenario tests for coordinator
- Recovery scenario tests for member (especially double-execution prevention)
- Run full test suite: `yarn test:p2p` and `yarn test:p2p-storage-fs`
