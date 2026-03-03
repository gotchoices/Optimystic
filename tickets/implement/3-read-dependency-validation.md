# Read Dependency Validation Implementation

description: Implement read dependency capture and validation for optimistic concurrency control to prevent write-skew anomalies
dependencies: None — uses existing BlockActionState infrastructure
files:
  - packages/db-core/src/transactor/transactor-source.ts
  - packages/db-core/src/transform/cache-source.ts
  - packages/db-core/src/transaction/session.ts
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transaction/validator.ts
  - packages/db-core/src/transaction/transaction.ts
  - packages/db-core/src/network/struct.ts
  - packages/db-core/test/transaction.spec.ts
----

## Versioning Strategy

Use **collection-scoped revision** (`BlockActionState.latest.rev`) as the read dependency version.

When `transactor.get()` fetches a block, `GetBlockResult.state.latest?.rev` gives the collection revision at which the block was last modified. This is already tracked per-block at the storage layer (`IBlockStorage.getLatest()`) and returned with every block fetch. No schema changes needed.

`ReadDependency` type is already correct as-is:
```typescript
type ReadDependency = {
    blockId: BlockId;
    revision: number; // collection rev at which block was last modified
};
```

## Architecture

### Read Path (during transaction execution)

```
SQL Query → Tracker.tryGet(blockId)
  → CacheSource.tryGet(blockId)
    → [cache miss] TransactorSource.tryGet(blockId)
      → transactor.get({ blockIds: [blockId], context })
      → GetBlockResult { block, state: { latest?: ActionRev } }
      → Records ReadDependency { blockId, revision: state.latest?.rev ?? 0 }
      → Returns block
    → [cache hit] Returns cached block (read already captured from first fetch)
```

For validation (remote peers), execution happens in fresh isolated state — no cache from prior actions — so all reads go through TransactorSource, capturing every read dependency.

### Validation Path

```
TransactionValidator.validate(transaction, operationsHash)
  → Step 3: For each read in transaction.reads:
    → blockStateProvider(read.blockId) → current BlockActionState
    → If current latest.rev !== read.revision → STALE READ → reject
```

## Phase 1: Read Capture in TransactorSource

**File: `packages/db-core/src/transactor/transactor-source.ts`**

- Add `private readDependencies: ReadDependency[] = []` accumulator
- In `tryGet()`: after receiving `GetBlockResult`, record `{ blockId: id, revision: state.latest?.rev ?? 0 }`
- Add `getReadDependencies(): ReadDependency[]` method
- Add `clearReadDependencies(): void` method (for reuse across transactions)

Key: only record reads for blocks that exist (non-undefined result). A read of a non-existent block should record `revision: 0` to detect if it gets created.

## Phase 2: Wire Reads into TransactionSession

**File: `packages/db-core/src/transaction/session.ts`**

The session builds the `Transaction` object at commit time (line 129-134). Currently `reads: []`.

- The session needs access to accumulated read dependencies from the collections involved
- The coordinator orchestrates collections — reads should be collected from all collection TransactorSources
- Add method to `TransactionCoordinator` to collect reads from all participating collections

**File: `packages/db-core/src/transaction/coordinator.ts`**

- Add `getReadDependencies(): ReadDependency[]` that collects reads from all registered collection TransactorSources
- The coordinator already has access to collections via `this.collections`
- Each collection's source chain: Collection → tracker → sourceCache → TransactorSource
- Need a way to access TransactorSource from Collection (may need to expose it or pass reads up)

**Design choice**: Add `getReadDependencies()` to `Collection` (or the source interface) that delegates to TransactorSource.

## Phase 3: Validation in TransactionValidator

**File: `packages/db-core/src/transaction/validator.ts`**

- Add `BlockStateProvider` type: `(blockId: BlockId) => Promise<{ latest?: ActionRev } | undefined>`
- Extend `TransactionValidator` constructor to accept a `BlockStateProvider`
- Implement step 3 (lines 81-83): iterate `transaction.reads`, query current block state, compare revisions
- Reject with descriptive reason: `"Stale read: block ${blockId} was at revision ${expected} but is now at ${actual}"`

**File: `packages/db-core/src/network/struct.ts`** (types only, if BlockStateProvider is shared)

The `PendValidationHook` already passes the full `Transaction` to validators. The validator needs a way to look up current block state. Since the validator is instantiated with a factory, the `BlockStateProvider` should be injected at construction time.

## Phase 4: Testing

**File: `packages/db-core/test/transaction.spec.ts`**

- Update the existing write-skew test (line ~2067, "should allow write-skew anomaly") to verify that with read dependency validation, the write-skew is now DETECTED and REJECTED
- Rename test to something like "should detect write-skew via read dependency validation"
- Add test: valid transaction with reads that haven't changed → should pass
- Add test: transaction reading non-existent block (rev 0) that gets created → should detect
- Add test: transaction with no reads → should pass (backward compatible)

## TODO

### Phase 1: Read Capture
- [ ] Add `readDependencies` accumulator and `getReadDependencies()`/`clearReadDependencies()` to `TransactorSource`
- [ ] In `tryGet()`, record `{ blockId, revision: state.latest?.rev ?? 0 }` from `GetBlockResult.state`
- [ ] Handle case where `result[id]` is undefined (block not found — record rev 0 if appropriate)

### Phase 2: Wire Reads into Transaction
- [ ] Expose read dependencies from Collection through to TransactionCoordinator
- [ ] In `TransactionSession.commit()`, collect reads and include in Transaction
- [ ] Update `createTransactionId()` call to include actual reads (currently hardcoded `[]`)
- [ ] Clear read dependencies after commit (or rollback)

### Phase 3: Validation
- [ ] Define `BlockStateProvider` type in validator.ts
- [ ] Add `blockStateProvider` to `TransactionValidator` constructor
- [ ] Implement read dependency validation loop at the TODO stub (line 81-83)
- [ ] Wire `BlockStateProvider` in quereus-validator.ts (or wherever validators are instantiated)

### Phase 4: Testing
- [ ] Update write-skew test to verify detection
- [ ] Add test: reads unchanged → validation passes
- [ ] Add test: reads changed → validation rejects
- [ ] Add test: no reads → validation passes (backward compat)
- [ ] Ensure build passes
