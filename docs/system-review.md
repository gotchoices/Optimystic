# Optimystic Review and Bug Hunt Task List

This document provides a hierarchical review structure for the Optimystic distributed database project, organized from low-level design elements up to high-level architecture. Each section contains specific review tasks, test coverage gaps, and documentation items.

As you tackle these, be cautious in your changes.  If you suspect that something is broken, add a unit or integration test to demonstrate the problem, and work backwards.  If you aren't sure about something, don't presume, add it to a list of questions, and move on to the next task so that you don't block yourself.

Only tackle a small number of tasks at a time–ideally tacking related systems. Be sure you give sufficient analysis to each, so mind your context window.  

For each task, study the related tests and documentation.  Ask yourself: what assumptions does this make; under what conditions would this break; and are there high-quality tests that would benefit us?  Also verify that the documentation is up-to-date.  If it isn't, update it.  Try to move towards the documentation being arranged in an abstraction hierarchy, so we have high-level overvews, separate from low-level detail documents.  Make sure the documents are cross-linked and DRY.

Though we're primarily concerned with correctness, we're also looking for future opportunities to improve the code.  As you find things, add them as a refactoring opportunity as described at the bottom of this doc.
* Make sure we don't have duplicate code
* Make sure we honor the single purpose principle.  If a function or class does n diffierent things, it's a candidate for refactoring.  
* If a function has more than a few local variables and/or more than a few statements, it should probably be decomposed into sub-functions.
* We should favor expressiveness over imperative style.
* Also consider scaling.  How likely is a given data structure to grow large or grow without bound?
* Consider memory and processing efficiency.  How "inner-loop" is the code?
* Library balance.  Are we bloating with library dependencies that would be better inlined?  Are we reinventing the wheel for something that a lean external library would do better?
* Algorithms.  Are we using the best algorithms for the job?

Code comments should be timeless and reflective of the presently implemented design, caveats, etc., not a change log.

If you spot code or design aspects that aren't covered by these tasks, please add them to the task list.

**Scope**: db-core, db-p2p, quereus-plugin-crypto, quereus-plugin-optimystic, reference-peer

---

## Layer 1: Block Storage & Transforms (Foundational)

### 1.1 Block Store (`packages/db-core/src/blocks/`)

- [ ] **HUNT-1.1.1**: Review `block-store.ts` - Verify BlockSource/BlockStore interface contracts are complete
- [ ] **HUNT-1.1.2**: Review `structs.ts` - Validate BlockId generation uniqueness guarantees
- [ ] **HUNT-1.1.3**: Review `apply.ts` - Verify BlockOperation application is atomic and correct
- [ ] **TEST-1.1.1**: Add regression tests for block ID collision scenarios
- [ ] **DOC-1.1.1**: Update block storage documentation to reflect current implementation

### 1.2 Transform Layer (`packages/db-core/src/transform/`)

- [ ] **HUNT-1.2.1**: `tracker.ts:39` - **CRITICAL**: `splice` with `indexOf` may fail if block not in deletes array (returns -1, splices from end)
  ```typescript
  this.transforms.deletes.splice(this.transforms.deletes.indexOf(block.header.id), 1);
  ```
- [ ] **HUNT-1.2.2**: `struct.ts` - TODO comment indicates optional fields not implemented: "make each of these optional (assumes empty)"
- [ ] **HUNT-1.2.3**: Review `Tracker.tryGet()` - Verify correct handling when block is both in inserts and deletes
- [ ] **TEST-1.2.1**: Add tests for Tracker edge cases (insert after delete, delete non-existent)
- [ ] **DOC-1.2.1**: Document transform lifecycle and ordering guarantees

---

## Layer 2: Transaction System (ACID Guarantees)

### 2.1 Transaction Core (`packages/db-core/src/transaction/`)

- [ ] **HUNT-2.1.1**: `transaction.ts` - Simple hash function used for transaction IDs - **SECURITY CONCERN**: Non-cryptographic hash may have collision issues
  ```typescript
  const hash = Array.from(operationsData).reduce((acc, char) => {
      const charCode = char.charCodeAt(0);
      return ((acc << 5) - acc + charCode) & acc;
  }, 0);
  ```
- [ ] **HUNT-2.1.2**: `coordinator.ts` - Same weak hash function used in `hashOperations()` - must match validator
- [ ] **HUNT-2.1.3**: `validator.ts` - TODO: "Implement read dependency validation" - **INCOMPLETE FEATURE**
- [ ] **HUNT-2.1.4**: Review deprecated `TransactionContext` pattern vs newer `TransactionSession` - ensure no mixed usage
- [ ] **TEST-2.1.1**: Add transaction rollback regression tests
- [ ] **TEST-2.1.2**: Add multi-collection transaction conflict tests
- [ ] **DOC-2.1.1**: Update `docs/transactions.md` to reflect current implementation state

### 2.2 Transaction Coordinator (`packages/db-core/src/transaction/coordinator.ts`)

- [ ] **HUNT-2.2.1**: Review GATHER phase supercluster formation for edge cases
- [ ] **HUNT-2.2.2**: Verify PEND/COMMIT phase ordering guarantees
- [ ] **HUNT-2.2.3**: Review error handling in `coordinateTransaction()` - ensure proper cleanup on failure
- [ ] **TEST-2.2.1**: Add coordinator timeout handling tests
- [ ] **TEST-2.2.2**: Add partial failure recovery tests

---

## Layer 3: B-tree & Collections (Data Structures)

### 3.1 B-tree Implementation (`packages/db-core/src/btree/`)

- [ ] **HUNT-3.1.1**: `btree.ts:769` - TODO: "This would be much more efficient if we avoided iterating into leaf nodes"
- [ ] **HUNT-3.1.2**: Review `rebalanceLeaf()` and `rebalanceBranch()` - verify no data loss during rebalancing
- [ ] **HUNT-3.1.3**: Verify path invalidation on mutation is complete (version tracking)
- [ ] **HUNT-3.1.4**: Review `NodeCapacity = 64` - verify this is optimal for block size
- [ ] **TEST-3.1.1**: Add B-tree stress tests for large datasets
- [ ] **TEST-3.1.2**: Add concurrent mutation tests (path invalidation)
- [ ] **DOC-3.1.1**: Document B-tree invariants and performance characteristics

### 3.2 Chain/Log (`packages/db-core/src/chain/`, `packages/db-core/src/log/`)

- [ ] **HUNT-3.2.1**: `chain.ts:28` - TODO: "Generalize the header access so that it can be merged with upstream header"
- [ ] **HUNT-3.2.2**: Review `Chain.getTail()` - potential race condition following nextId links
- [ ] **HUNT-3.2.3**: Review `Log.getFrom()` - verify correct handling of checkpoint boundaries
- [ ] **TEST-3.2.1**: Add chain corruption recovery tests
- [ ] **TEST-3.2.2**: Add log checkpoint consistency tests

### 3.3 Collection (`packages/db-core/src/collection/`)

- [ ] **HUNT-3.3.1**: `collection.ts` - Review conflict resolution in `doFilterConflict()`
- [ ] **HUNT-3.3.2**: Review `sync()` latch handling - verify no deadlock scenarios
- [ ] **HUNT-3.3.3**: `collection.ts:157` - TODO: "introduce timer and potentially change stats to determine when to sync"
- [ ] **TEST-3.3.1**: Add collection conflict resolution tests
- [ ] **TEST-3.3.2**: Add concurrent sync() tests

---

## Layer 4: Network Transactor (Distributed Coordination)

### 4.1 Transactor Interface (`packages/db-core/src/transactor/`)

- [ ] **HUNT-4.1.1**: `transactor.ts` - Review `queryClusterNominees` optional method - ensure callers handle undefined
- [ ] **HUNT-4.1.2**: `network-transactor.ts:146` - `getStatus()` throws "Method not implemented" - **INCOMPLETE**
- [ ] **HUNT-4.1.3**: Review retry logic in `get()` - verify excluded peers are properly tracked
- [ ] **HUNT-4.1.4**: `network-transactor.ts:319` - Non-tail commit failures logged but not propagated - verify this is intentional
- [ ] **TEST-4.1.1**: Add network partition simulation tests
- [ ] **TEST-4.1.2**: Add coordinator failover tests
- [ ] **DOC-4.1.1**: Document network transactor retry semantics

### 4.2 Transactor Source (`packages/db-core/src/transactor/`)

- [ ] **HUNT-4.2.1**: Review `TransactorSource` context handling for stale reads
- [ ] **TEST-4.2.1**: Add transactor source version conflict tests

---

## Layer 5: Cluster Consensus (Peer Coordination)

### 5.1 Cluster Member (`packages/db-p2p/src/cluster/cluster-repo.ts`)

- [ ] **HUNT-5.1.1**: `cluster-repo.ts:290` - TODO: "Fix hash validation logic to match coordinator's hash generation"
- [ ] **HUNT-5.1.2**: `cluster-repo.ts:339` - `verifySignature()` returns `true` always - **SECURITY: NOT IMPLEMENTED**
- [ ] **HUNT-5.1.3**: Review `hasConflict()` stale threshold (2000ms) - may be too aggressive
- [ ] **HUNT-5.1.4**: Review race resolution logic in `resolveRace()` - verify determinism
- [ ] **TEST-5.1.1**: Add cluster member promise/commit phase tests
- [ ] **TEST-5.1.2**: Add transaction expiration handling tests
- [ ] **DOC-5.1.1**: Document cluster consensus protocol

### 5.2 Cluster Coordinator (`packages/db-p2p/src/repo/cluster-coordinator.ts`)

- [ ] **HUNT-5.2.1**: `cluster-coordinator.ts:36` - TODO: "move this into a state management interface so that transaction state can be persisted"
- [ ] **HUNT-5.2.2**: Review `validateSmallCluster()` - currently accepts without validation in fallback
- [ ] **HUNT-5.2.3**: Review retry backoff logic - verify exponential backoff is correct
- [ ] **TEST-5.2.1**: Add cluster coordinator retry tests
- [ ] **TEST-5.2.2**: Add super-majority threshold tests

### 5.3 Coordinator Repo (`packages/db-p2p/src/repo/coordinator-repo.ts`)

- [ ] **HUNT-5.3.1**: `coordinator-repo.ts:50` - TODO: "Verify that we are a proximate node for all block IDs"
- [ ] **HUNT-5.3.2**: `coordinator-repo.ts:53` - TODO: "Implement read-path cluster verification"
- [ ] **HUNT-5.3.3**: Review `cancel()` - executes cluster transaction per block ID (may be inefficient)
- [ ] **TEST-5.3.1**: Add coordinator repo integration tests

### 5.4 Storage Repo (`packages/db-p2p/src/storage/storage-repo.ts`)

- [ ] **HUNT-5.4.1**: `storage-repo.ts:98-104` - Documented race condition between conflict check and save
- [ ] **HUNT-5.4.2**: `storage-repo.ts:251` - TODO: "Recover as best we can. Rollback or handle partial commit?"
- [ ] **TEST-5.4.1**: Add storage repo concurrent commit tests
- [ ] **TEST-5.4.2**: Add partial commit recovery tests

---

## Layer 6: Crypto Integration

### 6.1 Quereus Crypto Plugin (`packages/quereus-plugin-crypto/src/`)

- [ ] **HUNT-6.1.1**: `crypto.ts` - Review `hashMod()` for bias in modulo operation with large bit counts
- [ ] **HUNT-6.1.2**: Verify all crypto operations use constant-time comparisons where needed
- [ ] **HUNT-6.1.3**: Review error handling in `verify()` - currently catches all errors and returns false
- [ ] **TEST-6.1.1**: Add crypto function edge case tests (empty inputs, max sizes)
- [ ] **TEST-6.1.2**: Add signature verification tests for all supported curves
- [ ] **DOC-6.1.1**: Document supported algorithms and encoding formats

### 6.2 Signature Validation (`packages/quereus-plugin-crypto/src/signature-valid.ts`)

- [ ] **HUNT-6.2.1**: Review signature validation integration with cluster consensus
- [ ] **TEST-6.2.1**: Add signature validation integration tests

---

## Layer 7: Quereus Optimystic Plugin

### 7.1 Transaction Engine (`packages/quereus-plugin-optimystic/src/transaction/`)

- [ ] **HUNT-7.1.1**: `quereus-engine.ts:15` - Hardcoded version `quereus@0.5.3` - should be dynamic
- [ ] **HUNT-7.1.2**: Review `execute()` - actions collected by coordinator, not returned (verify this is correct)
- [ ] **HUNT-7.1.3**: Review schema hash caching - verify invalidation on DDL is complete
- [ ] **TEST-7.1.1**: Add Quereus engine execution tests
- [ ] **TEST-7.1.2**: Add schema hash consistency tests

### 7.2 Quereus Validator (`packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts`)

- [ ] **HUNT-7.2.1**: Review validator re-execution logic for determinism
- [ ] **TEST-7.2.1**: Add validator determinism tests

### 7.3 Optimystic Adapter (`packages/quereus-plugin-optimystic/src/optimystic-adapter/`)

- [ ] **HUNT-7.3.1**: Review `collection-factory.ts` - verify collection lifecycle management
- [ ] **HUNT-7.3.2**: Review `vtab-connection.ts` - verify virtual table connection handling
- [ ] **HUNT-7.3.3**: Review `txn-bridge.ts` - verify transaction bridging is complete
- [ ] **TEST-7.3.1**: Add adapter integration tests

### 7.4 Schema Management (`packages/quereus-plugin-optimystic/src/schema/`)

- [ ] **HUNT-7.4.1**: Review `schema-manager.ts` - verify schema versioning
- [ ] **HUNT-7.4.2**: Review `index-manager.ts` - verify index consistency
- [ ] **HUNT-7.4.3**: Review `row-codec.ts` - verify encoding/decoding round-trip
- [ ] **TEST-7.4.1**: Add schema migration tests
- [ ] **TEST-7.4.2**: Add row codec edge case tests

---

## Layer 8: Reference Peer

### 8.1 CLI & Service (`packages/reference-peer/src/`)

- [ ] **HUNT-8.1.1**: Review `cli.ts` - verify command-line argument validation
- [ ] **HUNT-8.1.2**: Review `mesh.ts` - verify mesh startup sequencing
- [ ] **TEST-8.1.1**: Add reference peer integration tests
- [ ] **DOC-8.1.1**: Update reference peer documentation

---

## Layer 9: High-Level Architecture Review

### 9.1 Cross-Cutting Concerns

- [ ] **ARCH-9.1.1**: Review error propagation across all layers - ensure consistent error types
- [ ] **ARCH-9.1.2**: Review logging consistency - ensure structured logging throughout
- [ ] **ARCH-9.1.3**: Review timeout handling - ensure consistent timeout semantics
- [ ] **ARCH-9.1.4**: Review resource cleanup - ensure no memory leaks in long-running scenarios

### 9.2 Security Review

- [ ] **SEC-9.2.1**: **CRITICAL**: `cluster-repo.ts:339` - Signature verification not implemented
- [ ] **SEC-9.2.2**: Review all hash functions for cryptographic strength requirements
- [ ] **SEC-9.2.3**: Review input validation at API boundaries
- [ ] **SEC-9.2.4**: Review for timing attacks in crypto operations

### 9.3 Performance Review

- [ ] **PERF-9.3.1**: Review batch processing efficiency in NetworkTransactor
- [ ] **PERF-9.3.2**: Review B-tree node capacity for optimal performance
- [ ] **PERF-9.3.3**: Review caching strategies (CacheSource, schema hash cache)
- [ ] **PERF-9.3.4**: Review cluster consensus round-trip overhead

### 9.4 Documentation

- [ ] **DOC-9.4.1**: Review `docs/architecture.md` for accuracy
- [ ] **DOC-9.4.2**: Review `docs/optimystic.md` for accuracy
- [ ] **DOC-9.4.3**: Review `docs/transactions.md` for accuracy
- [ ] **DOC-9.4.4**: Add missing API documentation

---

## Layer 10: Transactional Theory Validation

### 10.1 ACID Property Guarantees

- [ ] **THEORY-10.1.1**: **Atomicity** - Verify all-or-nothing semantics across multi-collection transactions
  - Review `coordinateTransaction()` failure paths - does partial PEND success lead to inconsistency?
  - Review `cancelPhase()` - does it reliably undo all pending operations?
  - Review what happens if COMMIT succeeds on some critical blocks but fails on others
- [ ] **THEORY-10.1.2**: **Consistency** - Verify constraint enforcement during validation
  - Are constraints checked on all validators or only coordinator?
  - Can schema drift between validator nodes cause inconsistent constraint enforcement?
- [ ] **THEORY-10.1.3**: **Isolation** - Verify snapshot isolation semantics
  - Review Tracker snapshot boundaries - when are changes visible to other transactions?
  - Are concurrent transactions properly isolated during PEND phase?
  - Can read-your-writes semantics be violated during multi-collection transactions?
- [ ] **THEORY-10.1.4**: **Durability** - Verify persistence guarantees
  - Review log checkpoint timing - can acknowledged transactions be lost?
  - What happens if a node crashes between COMMIT and CHECKPOINT?

### 10.2 Two-Phase Commit (2PC) Protocol Correctness

- [ ] **THEORY-10.2.1**: Review PEND phase as "prepare" equivalent
  - Are all participants guaranteed to receive PEND before any COMMIT?
  - What happens if PEND times out on some participants?
- [ ] **THEORY-10.2.2**: Review COMMIT phase as "commit" equivalent
  - Is super-majority threshold correctly computed? (Currently uses FRET network size estimation)
  - Can Byzantine participants cause honest participants to commit while others abort?
- [ ] **THEORY-10.2.3**: Review blocking scenarios
  - Can transaction coordinator failure leave participants in pending state indefinitely?
  - Review `pendingTransactions` expiration logic in `cluster-repo.ts`
- [ ] **THEORY-10.2.4**: Review recovery protocol
  - How do nodes recover pending state after crash/restart?
  - `cluster-coordinator.ts:36` TODO: "move this into a state management interface so that transaction state can be persisted"
- [ ] **TEST-10.2.1**: Add 2PC protocol edge case tests (coordinator failure, participant failure, network partition)

### 10.3 Consensus Algorithm Correctness

- [ ] **THEORY-10.3.1**: Review super-majority threshold calculation
  - How is "network size" estimated for threshold? (FRET service)
  - Can network size estimation errors lead to safety violations?
  - What happens in network partitions where each partition thinks it has super-majority?
- [ ] **THEORY-10.3.2**: Review supercluster formation (GATHER phase)
  - Can two concurrent transactions form overlapping but different superclusters?
  - Is nominee spot-checking sufficient to prevent Sybil attacks?
- [ ] **THEORY-10.3.3**: Review ordering guarantees
  - How are concurrent transactions to the same collection ordered?
  - Is linearizability guaranteed for single-key operations?
  - Review `resolveRace()` determinism - do all nodes reach same conclusion?
- [ ] **THEORY-10.3.4**: Review liveness guarantees
  - Can valid transactions be starved indefinitely?
  - What is the liveness bound under various failure assumptions?
- [ ] **TEST-10.3.1**: Add consensus protocol correctness tests (concurrent conflicting transactions)

### 10.4 Byzantine Fault Tolerance

- [ ] **THEORY-10.4.1**: Review Byzantine fault model
  - What fraction of Byzantine nodes can be tolerated? (f < n/3 is typical)
  - Are signature verification stubs (returning `true`) a BFT violation?
- [ ] **THEORY-10.4.2**: Review validation completeness
  - Can a Byzantine coordinator forge operations hash?
  - Can validators be tricked into accepting invalid transactions?
  - Review `operationsHash` generation - is it collision-resistant?
- [ ] **THEORY-10.4.3**: Review equivocation prevention
  - Can a Byzantine node promise different values to different participants?
  - Is there a way to detect/prove equivocation?
- [ ] **TEST-10.4.1**: Add Byzantine fault injection tests

### 10.5 Optimistic Concurrency Control

- [ ] **THEORY-10.5.1**: Review read dependency tracking
  - `validator.ts` TODO: "Implement read dependency validation" - **INCOMPLETE**
  - How are read sets captured during transaction execution?
  - Can write skew anomalies occur with current implementation?
- [ ] **THEORY-10.5.2**: Review conflict detection
  - `hasConflict()` uses 2000ms stale threshold - is this theoretically sound?
  - Can lost updates occur if conflict detection window is too narrow?
- [ ] **THEORY-10.5.3**: Review retry semantics
  - Are retried transactions guaranteed to see their own prior (failed) writes?
  - What happens if a transaction is retried while original is still pending?
- [ ] **TEST-10.5.1**: Add write-skew and lost-update tests

### 10.6 Deterministic Replay Correctness

- [ ] **THEORY-10.6.1**: Review statement replay determinism
  - Can `Date.now()` or random values cause replay divergence?
  - Are all SQL functions deterministic or properly excluded?
  - Review `QUEREUS_ENGINE_ID` versioning - can engine version drift cause replay failure?
- [ ] **THEORY-10.6.2**: Review schema hash correctness
  - Is schema hash computed over all validation-relevant schema elements?
  - Can collation or constraint definitions be omitted from hash?
- [ ] **THEORY-10.6.3**: Review action ordering
  - Are actions applied in deterministic order across all validators?
  - Can JSON serialization order differences cause hash mismatches?
- [ ] **TEST-10.6.1**: Add replay determinism tests (same statements, different nodes, same result)

### 10.7 Network Partition Handling

- [ ] **THEORY-10.7.1**: Review split-brain prevention
  - Can two partitions both achieve super-majority and commit conflicting transactions?
  - Review FRET network size estimation under partitions
- [ ] **THEORY-10.7.2**: Review partition healing
  - What happens when partitions rejoin with divergent state?
  - Is there a reconciliation protocol?
- [ ] **THEORY-10.7.3**: Review CAP tradeoffs
  - Is the system CP or AP? Document the explicit design choice
  - What is the availability impact of requiring super-majority?
- [ ] **TEST-10.7.1**: Add network partition simulation tests

### 10.8 Timestamp and Ordering

- [ ] **THEORY-10.8.1**: Review `TransactionStamp.timestamp` usage
  - Is wall-clock time used for ordering? What about clock skew?
  - Can out-of-order timestamps cause transaction reordering?
- [ ] **THEORY-10.8.2**: Review log entry ordering
  - Is log ordering consistent with commit order?
  - Can log replay produce different state than original execution?
- [ ] **THEORY-10.8.3**: Review revision tracking
  - How are block revisions incremented? Is there a gap detection mechanism?
  - Can revision numbers wrap around?
- [ ] **TEST-10.8.1**: Add clock skew and ordering tests

---

## Priority Summary

### Critical (Security/Data Integrity)
1. **SEC-9.2.1**: Signature verification not implemented
2. **HUNT-1.2.1**: Tracker splice bug may corrupt deletes array
3. **HUNT-2.1.1/2.1.2**: Weak hash function for transaction IDs
4. **THEORY-10.4.1**: Byzantine fault model incomplete (signature stubs)

### High (Incomplete Features / Theory Gaps)
1. **HUNT-2.1.3**: Read dependency validation not implemented
2. **HUNT-4.1.2**: `getStatus()` not implemented
3. **HUNT-5.1.1**: Hash validation logic mismatch
4. **THEORY-10.5.1**: Optimistic concurrency control incomplete (write-skew possible)
5. **THEORY-10.2.4**: 2PC recovery protocol not persisted

### Medium (Technical Debt / Theory Review)
1. **HUNT-5.2.1**: Transaction state not persisted
2. **HUNT-5.3.1/5.3.2**: Proximity verification not implemented
3. **HUNT-7.1.1**: Hardcoded version string
4. **THEORY-10.3.1**: Super-majority threshold under network partition
5. **THEORY-10.1.1**: Atomicity across multi-collection partial failures

### Low (Optimization/Cleanup)
1. **HUNT-3.1.1**: B-tree nodeIds iteration efficiency
2. **HUNT-3.2.1**: Chain header generalization
3. **HUNT-3.3.3**: Sync timing optimization

---

## Review Progress Tracking

| Layer | Total Tasks | Completed | In Progress | Blocked |
|-------|-------------|-----------|-------------|---------|
| 1. Block Storage | 8 | 0 | 0 | 0 |
| 2. Transaction | 11 | 0 | 0 | 0 |
| 3. B-tree/Collections | 14 | 0 | 0 | 0 |
| 4. Network Transactor | 8 | 0 | 0 | 0 |
| 5. Cluster Consensus | 16 | 0 | 0 | 0 |
| 6. Crypto | 6 | 0 | 0 | 0 |
| 7. Quereus Plugin | 12 | 0 | 0 | 0 |
| 8. Reference Peer | 4 | 0 | 0 | 0 |
| 9. Architecture | 12 | 0 | 0 | 0 |
| 10. Transactional Theory | 32 | 0 | 0 | 0 |
| **Total** | **123** | **0** | **0** | **0** |

---

## Refactoring Opportunities

If an opportunity to improve the code or design is found, generate a new file in tasks/refactoring:
* Give it a logical name like "refactor-transaction-state-persistence.md"
* Include: Subsystem, Involved code, doc, and test files, Rationale, and Design options
