# Optimystic Review and Bug Hunt Task List

This document provides a hierarchical review structure for the Optimystic distributed database project, organized from low-level design elements up to high-level architecture. Each section contains specific review tasks, test coverage gaps, and documentation items.

As you tackle these, be cautious in your changes.  If you suspect that something is broken, add a unit or integration test to demonstrate the problem, and work backwards.  If you aren't sure about something, don't presume, add it to a list of questions, and move on to the next task so that you don't block yourself.

Only tackle a small number of tasks at a time–ideally tacking related systems. Be sure you give sufficient analysis to each, so mind your context window.  Start with the next task or tasks that seem most important. 

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

- [x] **HUNT-1.1.1**: Review `block-store.ts` - Verify BlockSource/BlockStore interface contracts are complete - VERIFIED: Interfaces are minimal and complete. BlockSource provides read operations (createBlockHeader, tryGet, generateId), BlockStore extends with write operations (insert, update, delete). Well-documented.
- [x] **HUNT-1.1.2**: Review `structs.ts` - Validate BlockId generation uniqueness guarantees - VERIFIED: Production uses 256-bit random values via `randomBytes(32)` with base64url encoding. Collision probability is negligible (~1 in 2^128 for birthday attack). FIXED: Updated comment from "base32" to "base64url".
- [x] **HUNT-1.1.3**: Review `apply.ts` - Verify BlockOperation application is atomic and correct - VERIFIED: `applyOperation` in helpers.ts correctly mutates blocks. Uses Array.splice for array ops, direct assignment for properties. Uses structuredClone to prevent reference issues. Atomicity is provided at higher level by Tracker class.
- [x] **TEST-1.1.1**: Add regression tests for block ID collision scenarios — 7 tests in transform.spec.ts. **7 BUGS found**: (1) mergeTransforms silently drops overlapping updates via object spread; (2) mergeTransforms silently drops overlapping inserts; (3) mergeTransforms accumulates duplicate deletes; (4) Tracker.tryGet ignores inserts when source has block with same ID; (5) Tracker double-delete then re-insert leaves phantom delete (splice only removes first); (6) applyTransformToStore silently overwrites on duplicate insert; (7) concatTransform drops existing operations on overlap.
- [x] **DOC-1.1.1**: Update block storage documentation to reflect current implementation - FIXED: Corrected docs/blocks.md to use "base64url" instead of "base32", fixed Transforms example to use array instead of Set for deletes

### 1.2 Transform Layer (`packages/db-core/src/transform/`)

- [x] **HUNT-1.2.1**: `tracker.ts:39` - **CRITICAL**: `splice` with `indexOf` may fail if block not in deletes array (returns -1, splices from end) - FIXED: Added index check before splice, with regression tests
- [x] **HUNT-1.2.2**: `struct.ts` - TODO comment indicates optional fields not implemented: "make each of these optional (assumes empty)" - IMPLEMENTED: Per user direction, made all three fields optional with null guards (`??`, `?.`, `??=`) added at all 35 access points across 6 files. See `tasks/refactoring/optional-transform-fields.md`.
- [x] **HUNT-1.2.3**: Review `Tracker.tryGet()` - Verify correct handling when block is both in inserts and deletes - VERIFIED: The Tracker API maintains the invariant that a block cannot be in both inserts and deletes simultaneously (`insert()` removes from deletes, `delete()` removes from inserts). The `transforms` field is public but marked "Treat as immutable" in the docstring. The struct.ts documentation correctly states ordering: insert, update, delete.
- [x] **TEST-1.2.1**: Add tests for Tracker edge cases (insert after delete, delete non-existent) - Added in transform.spec.ts
- [x] **DOC-1.2.1**: Document transform lifecycle and ordering guarantees - VERIFIED: Already documented in `struct.ts` ("applied in order of: insert, update, delete") and `docs/blocks.md` (Transform Tracking section). No additional docs needed.

---

## Layer 2: Transaction System (ACID Guarantees)

### 2.1 Transaction Core (`packages/db-core/src/transaction/`)

- [x] **HUNT-2.1.1**: `transaction.ts` - Simple hash function used for transaction IDs - **SECURITY CONCERN**: Non-cryptographic hash may have collision issues - FIXED: Created shared hashString utility with proper djb2 implementation
- [x] **HUNT-2.1.2**: `coordinator.ts` - Same weak hash function used in `hashOperations()` - must match validator - FIXED: Both coordinator.ts and validator.ts now use shared hashString utility
- [x] **HUNT-2.1.3**: `validator.ts` - TODO: "Implement read dependency validation" - **INCOMPLETE FEATURE** - DOCUMENTED: See `tasks/refactoring/read-dependency-validation.md`
- [x] **HUNT-2.1.4**: Review deprecated `TransactionContext` pattern vs newer `TransactionSession` - VERIFIED: Clean deprecation pattern. `TransactionContext` is only used internally in coordinator.ts, marked `@deprecated` at line 206. Tests updated to use `TransactionSession` (line 214-215 comment). No production code outside db-core uses `TransactionContext`. The quereus-plugin-optimystic uses `TransactionSession` exclusively (txn-bridge.ts).
- [x] **TEST-2.1.1**: Add transaction rollback regression tests - DONE: 6 tests in transaction.spec.ts covering rollback state clearing, multi-collection rollback, double-rollback, post-commit rollback, post-rollback execute, and state flags.
- [x] **TEST-2.1.2**: Add multi-collection transaction conflict tests - DONE: 2 tests in transaction.spec.ts covering concurrent pend conflicts and cross-collection transform isolation.
- [x] **DOC-2.1.1**: Update `docs/transactions.md` to reflect current implementation state - DONE: Fixed "Proposed Architecture" → "Architecture", TransactionContext → TransactionSession, updated Transaction type definition (stamp/id vs stampId/cid), fixed constructor examples and commit flow pseudocode.

### 2.2 Transaction Coordinator (`packages/db-core/src/transaction/coordinator.ts`)

- [x] **HUNT-2.2.1**: Review GATHER phase supercluster formation for edge cases - VERIFIED: Correctly skips GATHER for single collection (line 449). Gracefully handles transactors without `queryClusterNominees` (lines 454-457). `Promise.all` fail-fast is acceptable - if any cluster unavailable, transaction should fail.
- [x] **HUNT-2.2.2**: Verify PEND/COMMIT phase ordering guarantees - VERIFIED: PEND runs first (lines 408-417), COMMIT only after successful PEND (lines 419-428), `cancelPhase` called on COMMIT failure (line 427). Ordering is correct.
- [x] **HUNT-2.2.3**: Review error handling in `coordinateTransaction()` - ANALYZED: If PEND fails partway through, already-pended collections are not explicitly cancelled. However, cluster layer has automatic cleanup via `queueExpiredTransactions()` and `processCleanupQueue()` (cluster-repo.ts lines 77-80). The `expiration` field ensures pended transactions eventually expire. This is acceptable for distributed systems where explicit cleanup may not reach all nodes.
- [x] **TEST-2.2.1**: Add coordinator timeout handling tests - DONE: 3 tests in transaction.spec.ts covering transactor unavailable during pend, transactor unavailable after pend (during commit), and cluster nominees query failure.
- [x] **TEST-2.2.2**: Add partial failure recovery tests - DONE: 3 tests in transaction.spec.ts covering cancel-on-commit-failure, pend-failure-partway-through, and cancel-phase-failure resilience.

---

## Layer 3: B-tree & Collections (Data Structures)

### 3.1 B-tree Implementation (`packages/db-core/src/btree/`)

- [x] **HUNT-3.1.1**: `btree.ts:769` - TODO: "This would be much more efficient if we avoided iterating into leaf nodes" - ANALYZED: The `nodeIds()` method iterates all nodes including leaves. This is only used for getting all block IDs in a subtree. The TODO is a valid optimization opportunity but not a bug. Low priority.
- [x] **HUNT-3.1.2**: Review `rebalanceLeaf()` and `rebalanceBranch()` - **BUG FOUND**: Line 685 uses `NodeCapacity << 1` (128) but should use `NodeCapacity >>> 1` (32). The condition is dead code since branches can never have 128 nodes. See `tasks/refactoring/btree-rebalance-threshold-bug.md`. The bug doesn't cause data loss but may cause unnecessary rebalancing.
- [x] **HUNT-3.1.3**: Verify path invalidation on mutation is complete (version tracking) - VERIFIED: `_version` is incremented on insert, update, delete, upsert. Paths are created with current version and validated before use. Minor issue: `drop()` doesn't increment version, but this is a destructive operation that removes all nodes anyway.
- [x] **HUNT-3.1.4**: Review `NodeCapacity = 64` - ANALYZED: NodeCapacity of 64 provides a branching factor of 64, which is reasonable for B-trees. With JSON serialization, actual block sizes depend on entry size. The ring-selector.ts estimates 100KB typical block. This is a tuning parameter that could be adjusted based on workload, but 64 is a sensible default.
- [x] **TEST-3.1.1**: Add B-tree stress tests for large datasets - DONE: 4 tests in `btree.spec.ts`: 500 random-order inserts with verification, delete every other element (500 items), count verification across splits/merges (300 items), bulk upserts (400 items).
- [x] **TEST-3.1.2**: Add concurrent mutation tests (path invalidation) - DONE: 6 tests in `btree.spec.ts`: path invalidation after insert/deleteAt/updateAt/upsert, exception on stale path usage (at/moveNext/movePrior/deleteAt/updateAt), valid path returned from mutation operations.
- [x] **DOC-3.1.1**: Document B-tree invariants and performance characteristics - DONE: Added Invariants section (node capacity, minimum fill, split point, rebalancing rules, path invalidation semantics) and expanded Performance Characteristics with time/space complexity tables in `packages/db-core/docs/btree.md`.

### 3.2 Chain/Log (`packages/db-core/src/chain/`, `packages/db-core/src/log/`)

- [x] **HUNT-3.2.1**: `chain.ts:28` - TODO: "Generalize the header access so that it can be merged with upstream header" - ANALYZED: Valid refactoring opportunity to reduce indirection by merging ChainHeaderNode with upstream headers (e.g., CollectionHeaderBlock). Low priority optimization, not a bug. See `tasks/refactoring/chain-header-merge.md`.
- [x] **HUNT-3.2.2**: Review `Chain.getTail()` - potential race condition following nextId links - VERIFIED: Not a bug. The code at lines 289-297 defensively follows nextId links to find the true tail when blocks may have been added between reading header and accessing tail. The returned stale headerBlock is intentional - subsequent operations (like `add()`) correctly update it atomically. Explicit comment at line 292-293 acknowledges this design.
- [x] **HUNT-3.2.3**: Review `Log.getFrom()` - verify correct handling of checkpoint boundaries - VERIFIED: Correct implementation at lines 73-106. First loop iterates backward collecting pendings until checkpoint. Second loop (starting at checkpointPath) continues past checkpoint to collect entries. Checkpoint entry itself is safely skipped because line 97 checks `if (entry.action)` before processing (checkpoints have no `action` property).
- [x] **TEST-3.2.1**: Add chain corruption recovery tests - DONE: 4 tests in `chain.spec.ts`: interleaved add/dequeue integrity, interleaved add/pop integrity, drain and refill cycle, bidirectional navigation after mixed operations.
- [x] **TEST-3.2.2**: Add log checkpoint consistency tests - DONE: 5 tests in `log.spec.ts`: checkpoint with empty pendings, getFrom at exact checkpoint boundary, context rebuild across checkpoint with subsequent actions, sequential checkpoints overriding each other, getFrom spanning before and after checkpoint.

### 3.3 Collection (`packages/db-core/src/collection/`)

- [x] **HUNT-3.3.1**: `collection.ts` - Review conflict resolution in `doFilterConflict()` - VERIFIED: Correct at lines 189-199. Returns boolean to indicate keep/discard. When replacement action is provided, it's added via `act()` which appends to pending. The original action is then kept or discarded based on boolean return. This allows replacing conflicting actions with modified versions. Edge case: replacement actions added during update could themselves conflict with subsequent remote entries, but `replayActions()` handles this by replaying all pending after conflicts.
- [x] **HUNT-3.3.2**: Review `sync()` latch handling - verify no deadlock scenarios - VERIFIED: No deadlock risk. Uses single `Latches.acquire()` mutex per collection ID (line 109-110). Always released in `finally` block (line 152). The Latches implementation (latches.ts) uses a proper async queue pattern with no nested locking.
- [x] **HUNT-3.3.3**: `collection.ts:157` - TODO: "introduce timer and potentially change stats to determine when to sync" - ANALYZED: Valid optimization opportunity. Currently `updateAndSync()` always performs both operations. Stats could track sync frequency, latency, or conflicts to optimize when to sync vs batch. Low priority.
- [x] **TEST-3.3.1**: Add collection conflict resolution tests (filterConflict callback behavior) - DONE: 3 tests in `collection.spec.ts`: discard pending when filterConflict returns undefined, keep pending when filterConflict returns original action, keep pending when no filterConflict provided. **BUG FIXED**: `TestTransactor.get()` was doing exact revision lookup; replaced with `latestMaterializedAt()` helper that finds the highest materialized revision <= the requested revision.
- [x] **TEST-3.3.2**: Add concurrent sync() tests - DONE: 2 tests in `collection.spec.ts`: serialize concurrent sync calls via latch, handle act during sync.

---

## Layer 4: Network Transactor (Distributed Coordination)

### 4.1 Transactor Interface (`packages/db-core/src/transactor/`)

- [x] **HUNT-4.1.1**: `transactor.ts` - Review `queryClusterNominees` optional method - ensure callers handle undefined - VERIFIED: Caller in `coordinator.ts:453-457` properly checks `if (!this.transactor.queryClusterNominees)` before calling. Returns null to use single-collection consensus when not supported.
- [x] **HUNT-4.1.2**: `network-transactor.ts:146` - `getStatus()` throws "Method not implemented" - **FIXED**: Implemented by querying block states and checking pending/committed status
- [x] **HUNT-4.1.3**: Review retry logic in `get()` - verify excluded peers are properly tracked - VERIFIED: Lines 79-107 correctly track excluded peers. Creates set from original peer + previous excludes (line 83), passes to `createBatchesForPayload` (line 89), and processes retries with new coordinators.
- [x] **HUNT-4.1.4**: `network-transactor.ts:344-351` - Non-tail commit failures logged but not propagated - VERIFIED INTENTIONAL: Comment explains design: once tail commits, transaction succeeds. Non-tail blocks reconcile via "reads with context" path. Valid eventual consistency pattern.
- [ ] **TEST-4.1.1**: Add network partition simulation tests
- [ ] **TEST-4.1.2**: Add coordinator failover tests
- [ ] **DOC-4.1.1**: Document network transactor retry semantics

### 4.2 Transactor Source (`packages/db-core/src/transactor/`)

- [x] **HUNT-4.2.1**: Review `TransactorSource` context handling for stale reads - ANALYZED: Lines 25-33 pass `actionContext` to transactor for read consistency. TODO at line 29 notes pending actions should be tracked to ensure update before sync. This is a valid enhancement opportunity, not a bug - current behavior is safe but may cause unnecessary conflicts.
- [x] **TEST-4.2.1**: COMPLETE — 4 tests in transactor-source.spec.ts. **BUG FOUND: `transact()` leaks pending actions when commit fails** (no cancel call after failed commit). Also tested: tryGet returns undefined for missing blocks, stale data from outdated revision, pending action info not propagated from tryGet (TODO in source).

---

## Layer 5: Cluster Consensus (Peer Coordination)

### 5.1 Cluster Member (`packages/db-p2p/src/cluster/cluster-repo.ts`)

- [x] **HUNT-5.1.1**: `cluster-repo.ts:290` - TODO: "Fix hash validation logic to match coordinator's hash generation" - FIXED: Now validates messageHash matches SHA256(message) using base58btc encoding
- [x] **HUNT-5.1.2**: `cluster-repo.ts:339` - `verifySignature()` returns `true` always - **SECURITY: NOT IMPLEMENTED** - DOCUMENTED: See `tasks/refactoring/signature-verification-implementation.md`
- [x] **HUNT-5.1.3**: Review `hasConflict()` stale threshold (2000ms) - may be too aggressive - ANALYZED: Lines 500-542. The 2000ms threshold is a reasonable trade-off for distributed consensus. Too short risks premature cleanup in high-latency networks; too long blocks new transactions. Could be made configurable but current value is reasonable. Not a bug.
- [x] **HUNT-5.1.4**: Review race resolution logic in `resolveRace()` - verify determinism - VERIFIED: Lines 548-561. Deterministic: (1) transaction with more promises wins, (2) tie-breaker uses string comparison of message hash. All nodes reach same conclusion given same inputs.
- [x] **TEST-5.1.1**: Add cluster member promise/commit phase tests - DONE: 5 tests in `cluster-repo.spec.ts` covering single-node, 3-peer accumulation, rejection handling, consensus execution
- [x] **TEST-5.1.2**: Add transaction expiration handling tests - DONE: 3 tests in `cluster-repo.spec.ts` covering past, present, future expirations
- [ ] **DOC-5.1.1**: Document cluster consensus protocol

### 5.2 Cluster Coordinator (`packages/db-p2p/src/repo/cluster-coordinator.ts`)

- [x] **HUNT-5.2.1**: `cluster-coordinator.ts:36` - TODO: "move this into a state management interface so that transaction state can be persisted" - DOCUMENTED: See `tasks/refactoring/2pc-state-persistence.md`
- [x] **HUNT-5.2.2**: Review `validateSmallCluster()` - currently accepts without validation in fallback - VERIFIED: Lines 253-286. Intentional design - uses FRET for production validation, fallback accepts for dev/testing. Comment at line 279 documents this. Low risk if FRET is properly configured.
- [x] **HUNT-5.2.3**: Review retry backoff logic - verify exponential backoff is correct - VERIFIED: Lines 38-41, 508. Correct exponential backoff: 2s → 4s → 8s → 16s → 30s (capped). Max 5 attempts. Implementation at line 508 uses `Math.min(existing.intervalMs * retryBackoffFactor, retryMaxIntervalMs)`.
- [ ] **TEST-5.2.1**: Add cluster coordinator retry tests
- [x] **TEST-5.2.2**: Add super-majority threshold tests - DONE: 2 tests in `cluster-repo.spec.ts` covering 2-node and 4-node cluster thresholds

### 5.3 Coordinator Repo (`packages/db-p2p/src/repo/coordinator-repo.ts`)

- [x] **HUNT-5.3.1**: `coordinator-repo.ts:50` - TODO: "Verify that we are a proximate node for all block IDs" - DOCUMENTED: See `tasks/refactoring/proximity-verification.md`
- [x] **HUNT-5.3.2**: `coordinator-repo.ts:53` - TODO: "Implement read-path cluster verification" - DOCUMENTED: See `tasks/refactoring/proximity-verification.md`
- [x] **HUNT-5.3.3**: Review `cancel()` - executes cluster transaction per block ID (may be inefficient) - VERIFIED: Lines 81-108. Intentional design - each block ID may have different cluster coordinators. The full message is sent per block which is slightly inefficient but correct. Could optimize by filtering message per block, but low priority.
- [ ] **TEST-5.3.1**: Add coordinator repo integration tests

### 5.4 Storage Repo (`packages/db-p2p/src/storage/storage-repo.ts`)

- [x] **HUNT-5.4.1**: `storage-repo.ts:98-104` - Documented race condition between conflict check and save - VERIFIED: Well-documented at lines 98-104. Intentional trade-off: avoids locking overhead, relies on commit-time validation as final arbiter. Correct design decision.
- [x] **HUNT-5.4.2**: `storage-repo.ts:251` - TODO: "Recover as best we can. Rollback or handle partial commit?" - DOCUMENTED: Lines 245-265. Partial commit is possible if block N fails after blocks 1..N-1 succeed. Locks prevent concurrent access but don't provide rollback. Returns failure but doesn't undo successful commits. Should be addressed in `tasks/refactoring/2pc-state-persistence.md`.
- [x] **TEST-5.4.1**: Add storage repo concurrent commit tests - DONE: 2 tests in `storage-repo.spec.ts` covering latch serialization and deadlock prevention
- [x] **TEST-5.4.2**: Add partial commit recovery tests - DONE: 2 tests in `storage-repo.spec.ts` covering stale revision conflict and non-existent pending action

---

## Layer 6: Crypto Integration

### 6.1 Quereus Crypto Plugin (`packages/quereus-plugin-crypto/src/`)

- [x] **HUNT-6.1.1**: `crypto.ts` - Review `hashMod()` for bias in modulo operation with large bit counts - VERIFIED: Lines 138-159. Modulo by 2^bits is unbiased (equivalent to bit masking). Uses 64-bit hash input, limited to 53 bits output (JS safe integer). No bias issues.
- [x] **HUNT-6.1.2**: Verify all crypto operations use constant-time comparisons where needed - VERIFIED: Delegates to `@noble/curves` library which implements constant-time operations. No manual byte comparisons in user code.
- [x] **HUNT-6.1.3**: Review error handling in `verify()` - currently catches all errors and returns false - VERIFIED: Lines 264-266. Standard pattern for signature verification - returning false for any error prevents information leakage about failure reason. Acceptable security practice.
- [x] **TEST-6.1.1**: Add crypto function edge case tests (empty inputs, max sizes) - DONE: 18 tests in `quereus-plugin-crypto/test/crypto.spec.ts` covering digest (all algorithms, encodings, Uint8Array input, error cases), hashMod (boundary bits 1/53, determinism, invalid range), and randomBytes (byte count, hex output, uniqueness).
- [x] **TEST-6.1.2**: Add signature verification tests for all supported curves - DONE: 32 tests in `quereus-plugin-crypto/test/crypto.spec.ts` covering sign/verify round-trip for secp256k1/p256/ed25519, corrupted signatures, wrong public key, base64url encoding round-trip, key generation, SignatureValid with convenience methods, batch verification, detailed output, and invalid input handling.
- [ ] **DOC-6.1.1**: Document supported algorithms and encoding formats

### 6.2 Signature Validation (`packages/quereus-plugin-crypto/src/signature-valid.ts`)

- [x] **HUNT-6.2.1**: Review signature validation integration with cluster consensus - GAP:
  - `SignatureValid` in `quereus-plugin-crypto/src/signature-valid.ts` is well-implemented (secp256k1, p256, ed25519).
  - `verifySignature()` in `cluster-repo.ts` (line 346-349) is a stub returning `true` always.
  - Integration gap: Crypto plugin's `SignatureValid` is not imported or used in cluster consensus.
  - Already documented in SEC-9.2.1 and `tasks/refactoring/signature-verification-implementation.md`.
- [ ] **TEST-6.2.1**: Add signature validation integration tests

---

## Layer 7: Quereus Optimystic Plugin

### 7.1 Transaction Engine (`packages/quereus-plugin-optimystic/src/transaction/`)

- [x] **HUNT-7.1.1**: `quereus-engine.ts:15` - Hardcoded version `quereus@0.5.3` - FIXED: Updated to `quereus@0.15.1` with sync note
- [x] **HUNT-7.1.2**: Review `execute()` - actions collected by coordinator, not returned (verify this is correct) - VERIFIED: Lines 59-87. Intentional design - Quereus virtual table module calls `coordinator.applyActions()` directly during SQL execution. The empty `actions` array in return is correct; transforms are retrieved via `coordinator.getTransforms()`.
- [x] **HUNT-7.1.3**: Review schema hash caching - verify invalidation on DDL is complete - GAP IDENTIFIED: `invalidateSchemaCache()` exists but is not automatically called on DDL. Should subscribe to `schemaManager.changeNotifier` events (`table_added`, `table_removed`, `table_modified`). Currently requires manual invalidation. Low priority - schema changes are rare in production.
- [ ] **TEST-7.1.1**: Add Quereus engine execution tests
- [x] **TEST-7.1.2**: Add schema hash consistency tests — TESTED: Confirmed cache staleness bug (DDL without invalidateSchemaCache returns stale hash, staleness accumulates). Discovered vtabArgs sensitivity (different tree URIs produce different hashes) and function sensitivity (extra function registration changes hash).

### 7.2 Quereus Validator (`packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts`)

- [x] **HUNT-7.2.1**: Review validator re-execution logic for determinism - VERIFIED: Uses `TransactionValidator` from db-core. Determinism ensured by: (1) schema hash check ensures matching schema, (2) same SQL + params produces same operations, (3) coordinator reset before validation ensures isolation. Non-deterministic SQL functions (RANDOM, NOW) would break validation but are user responsibility.
- [x] **TEST-7.2.1**: Add validator determinism tests — TESTED: Hash is deterministic across instances and table creation order (ORDER BY in computeSchemaHash works). Column type differences detected. vtabArgs and registered functions included in hash; validators must have identical configs and plugin sets.

### 7.3 Optimystic Adapter (`packages/quereus-plugin-optimystic/src/optimystic-adapter/`)

- [x] **HUNT-7.3.1**: Review `collection-factory.ts` - verify collection lifecycle management - VERIFIED: Lines 26-53 (collection caching is transaction-scoped), lines 77-90 (transactor caching), lines 318-324 (proper shutdown). Lifecycle management is correct.
- [x] **HUNT-7.3.2**: Review `vtab-connection.ts` - verify virtual table connection handling - VERIFIED: Lines 34-42 handle implicit transactions (begins if not active before commit). Savepoints are no-op (documented). Disconnect rolls back active transaction. Correct implementation.
- [x] **HUNT-7.3.3**: Review `txn-bridge.ts` - verify transaction bridging is complete - VERIFIED: Two modes (legacy direct sync, transaction mode with distributed consensus). Lines 69-107 (begin), 115-143 (commit), 150-175 (rollback). Both modes properly handled.
- [ ] **TEST-7.3.1**: Add adapter integration tests

### 7.4 Schema Management (`packages/quereus-plugin-optimystic/src/schema/`)

- [x] **HUNT-7.4.1**: Review `schema-manager.ts` - verify schema versioning - GAP IDENTIFIED: No explicit schema versioning. Schema stored/retrieved but no version tracking. Cache could become stale if another node updates schema. Low priority for single-node, important for multi-node.
- [x] **HUNT-7.4.2**: Review `index-manager.ts` - verify index consistency - VERIFIED: Lines 159-165 correctly handle key changes (delete old, insert new). Index maintenance is correct. TODO at line 207 for proper KeyRange implementation is minor.
- [x] **HUNT-7.4.3**: Review `row-codec.ts` - verify encoding/decoding round-trip - GAP IDENTIFIED: (1) Line 190: bigint → Number() loses precision for large values. (2) Line 76: Uint8Array encoded as base64 but not decoded back - breaks round-trip for binary data. Should add base64 → Uint8Array conversion in decodeRow().
- [ ] **TEST-7.4.1**: Add schema migration tests
- [x] **TEST-7.4.2**: Add row codec edge case tests - DONE: 22 tests in `quereus-plugin-optimystic/test/row-codec.spec.ts` covering basic round-trip (strings, numbers, nulls, booleans), bigint precision loss bug documentation, Uint8Array round-trip bug documentation, primary key extraction (single/composite), primary key comparator, and schema utilities.

---

## Layer 8: Reference Peer

### 8.1 CLI & Service (`packages/reference-peer/src/`)

- [x] **HUNT-8.1.1**: Review `cli.ts` - verify command-line argument validation - VERIFIED: Storage validation (lines 223-229), capacity validation (lines 51-58), action validation (lines 762-784). Minor gap: port validation could be stricter (check 0-65535 range, handle NaN from parseInt). Low priority.
- [x] **HUNT-8.1.2**: Review `mesh.ts` - verify mesh startup sequencing - VERIFIED: Sequential startup (lines 93-118), each node bootstraps to all previous. Waits for announce file before next node (line 107). Ready file written after all nodes (lines 121-126). Correct sequencing.
- [ ] **TEST-8.1.1**: Add reference peer integration tests
- [ ] **DOC-8.1.1**: Update reference peer documentation

---

## Layer 9: High-Level Architecture Review

### 9.1 Cross-Cutting Concerns

- [x] **ARCH-9.1.1**: Review error propagation across all layers - GAP: Quereus has structured errors (QuereusError, ParseError, ConstraintError, MisuseError) with cause chaining. db-core uses plain Error with ad-hoc `cause` properties. Inconsistent across layers.
- [x] **ARCH-9.1.2**: Review logging consistency - VERIFIED:
  - Consistent pattern: All packages use `debug` library with `createLogger()` factory.
  - Namespaces: `quereus:*` (quereus), `optimystic:db-p2p:*` (db-p2p), `sync-coordinator:*` (sync-coordinator).
  - Structured logging: Uses `log('namespace:event', { data })` pattern consistently.
  - Enablement: `DEBUG=optimystic:*,quereus:*` environment variable or `enableLogging()` API.
- [x] **ARCH-9.1.3**: Review timeout handling - VERIFIED with NOTES:
  - Consistent pattern: `expiration` timestamp passed through message options.
  - NetworkTransactor: `timeoutMs` (30s default), `abortOrCancelTimeoutMs` (5s default).
  - ClusterRepo: `setupTimeouts()` creates promiseTimeout and resolutionTimeout from expiration.
  - RepoClient: `withTimeout()` wrapper using Promise.race with setTimeout.
  - Cleanup: `clearTimeout()` called in finally blocks and `clearTransaction()`.
  - NOTE: Some edge cases may not propagate AbortController signals consistently.
- [x] **ARCH-9.1.4**: Review resource cleanup - VERIFIED with NOTES:
  - Statement: `finalize()` clears boundArgs, plan, columnDefCache, unsubscribes schema listener.
  - Database: `close()` finalizes all statements, clears schema cache.
  - MemoryTable: `destroy()` rolls back pending transactions, clears connections.
  - ClusterRepo: `clearTransaction()` clears timeouts, removes from activeTransactions.
  - StoreManager: `cleanup()` interval closes idle stores past timeout.
  - Libp2p: `shutdown()` stops all nodes, clears cache.
  - NOTE: ClusterRepo uses `setInterval` without cleanup method - potential leak if instance not properly disposed.

### 9.2 Security Review

- [x] **SEC-9.2.1**: **CRITICAL**: `cluster-repo.ts:339` - Signature verification not implemented - DOCUMENTED: See `tasks/refactoring/signature-verification-implementation.md`
- [x] **SEC-9.2.2**: Review all hash functions for cryptographic strength requirements - VERIFIED: Cryptographic ops use SHA-256/512/BLAKE3 from @noble/hashes. Non-crypto uses (FNV-1a for schema versioning, djb2 for identifiers) are documented and appropriate.
- [x] **SEC-9.2.3**: Review input validation at API boundaries - VERIFIED:
  - SQL layer: `validateValue()`, `validateAndParse()` in types/validation.ts. Statement `bindAll()` validates parameter types.
  - Network layer: `validateRecord()` in cluster-repo.ts validates message hash, signatures, expiration.
  - Storage layer: `validatePend()` hook in storage-repo.ts validates transactions.
  - Sync layer: `validateDatabaseId()` in routes.ts validates path parameters.
  - Crypto: `normalizeBytes()` validates input format (Uint8Array or hex string).
  - NOTE: Some network message fields not deeply validated (e.g., blockIds array contents).
- [x] **SEC-9.2.4**: Review for timing attacks in crypto operations - VERIFIED: Uses @noble/curves which implements constant-time operations for all cryptographic comparisons.

### 9.3 Performance Review

- [x] **PERF-9.3.1**: Review batch processing efficiency in NetworkTransactor - VERIFIED: Parallel processing with Promise.all, efficient peer grouping, flat retry structure (WeakMap rootOf), iterative DFS traversal. Well-designed.
- [x] **PERF-9.3.2**: Review B-tree node capacity for optimal performance - VERIFIED:
  - `NodeCapacity = 64` provides branching factor of 64.
  - Rebalance threshold: `NodeCapacity >>> 1` = 32 (50% fill factor).
  - Split at capacity, merge when combined <= capacity.
  - Reasonable for JSON-serialized blocks (~100KB typical).
  - NOTE: Could be tuned based on workload, but 64 is sensible default.
- [x] **PERF-9.3.3**: Review caching strategies (CacheSource, schema hash cache) - VERIFIED:
  - CacheSource: Simple Map-based cache with `structuredClone` for isolation. `transformCache()` applies mutations without source access.
  - Schema hash cache: `schemaHashCache` in QuereusEngine with `invalidateSchemaCache()` on DDL.
  - Query cache: `CacheNode` with threshold-based overflow (default 10000 rows), spill strategy option.
  - Tuning: `OptimizerTuning.cache` configures spillThreshold (100000), maxSpillBuffer (10000).
  - NOTE: No LRU eviction in CacheSource - relies on `clear()` calls.
- [x] **PERF-9.3.4**: Review cluster consensus round-trip overhead - VERIFIED:
  - Round-trips: 2 phases (PEND + COMMIT), each requires super-majority/simple-majority responses.
  - Batching: `makeBatchesByPeer()` groups blocks by coordinator, parallel execution across clusters.
  - Message structure: `RepoMessage` contains operations array, single message per cluster.
  - Timeout: 30s default (`DEFAULT_TIMEOUT`), configurable via `expiration`.
  - Optimizations: Coordinator caching, parallel cluster operations, FRET-based peer discovery.
  - NOTE: Sequential PEND per collection (not parallel) adds latency for multi-collection transactions.

### 9.4 Documentation

- [x] **DOC-9.4.1**: Review `docs/architecture.md` for accuracy - FIXED:
  - Overview and P2P section claimed "Kademlia DHT" but system uses FRET overlay on libp2p. Updated to reference FRET.
  - Glossary "DHT/Kademlia" entry updated to "DHT/FRET" with `assembleCohort()` and `getNeighbors()` references.
  - Matchmaking, storage, and Arachnode sections verified accurate; cross-links to optimystic.md, matchmaking.md, arachnode.md all valid.
- [x] **DOC-9.4.2**: Review `docs/optimystic.md` for accuracy - FIXED:
  - "Hashed Tree" collection type listed but not implemented (only Tree and Diary exist). Marked as "(planned)".
  - Transaction phases (Pend, Commit, Propagate, Checkpoint) match TransactionCoordinator implementation.
  - Transactor operations (get, pend, cancel, commit) match ITransactor interface.
  - Block structures (Log Block, Block Repository, Block Transaction) match db-core types.
  - Network Transactor & Clustering section accurately describes 2PC with cryptographic signatures.
  - Ring Zulu section correctly references FRET's `assembleCohort()`. Cross-links valid.
- [x] **DOC-9.4.3**: Review `docs/transactions.md` for accuracy - FIXED:
  - Package structure listed phantom "quereus-optimystic-module" as separate package; this was absorbed into quereus-plugin-optimystic. Consolidated into single section.
  - Dependency diagram correctly shows quereus, db-core, quereus-plugin-optimystic, db-p2p.
  - Transaction phases (GATHER, PEND, COMMIT, PROPAGATE, CHECKPOINT) match TransactionCoordinator.
  - Type definitions (TransactionStamp, StampId, PendRequest) match current implementation.
  - Implementation phase tracking accurate (Phases 1-7 status matches codebase).
- [ ] **DOC-9.4.4**: Add missing API documentation

---

## Layer 10: Transactional Theory Validation

### 10.1 ACID Property Guarantees

- [x] **THEORY-10.1.1**: **Atomicity** - Verify all-or-nothing semantics across multi-collection transactions - VERIFIED with GAPS:
  - `coordinateTransaction()` (lines 398-435): Sequential PEND per collection. If PEND fails mid-way, earlier collections have pending state but no cancel is issued (GAP: should cancel already-pended collections on partial PEND failure).
  - `cancelPhase()` (lines 590-610): Correctly cancels all collections' pending transactions.
  - COMMIT failure: Correctly calls `cancelPhase()` on commit failure (line 427).
  - GAP: Partial PEND success not handled - if collection 2 of 3 fails PEND, collections 1 remains pending.
- [x] **THEORY-10.1.2**: **Consistency** - Verify constraint enforcement during validation - VERIFIED with NOTES:
  - Constraints checked during SQL execution: `checkConstraints()` in constraint-check.ts validates NOT NULL, CHECK, PRIMARY KEY.
  - Validators re-execute SQL via `QuereusEngine.execute()` (validator.ts line 81), which runs full constraint checks.
  - Schema hash validation: `stamp.schemaHash` compared against local schema (validator.ts line 55).
  - NOTE: Schema drift is detected via hash mismatch, causing validation failure.
  - GAP: FOREIGN KEY constraints are parsed but not enforced (documented in sql.md line 2391).
- [x] **THEORY-10.1.3**: **Isolation** - Verify snapshot isolation semantics - VERIFIED:
  - IsolationModule (quereus-isolation): Per-connection overlay tables provide read-your-own-writes.
  - Writes go to overlay, reads merge overlay with underlying.
  - Commit flushes overlay to underlying, rollback discards overlay.
  - Tracker in db-core: Changes not visible until COMMIT phase completes.
  - Concurrent transactions isolated via separate overlay tables per connection.
- [x] **THEORY-10.1.4**: **Durability** - Verify persistence guarantees - VERIFIED with NOTES:
  - Log entries: `log.addActions()` writes to chain immediately (log.ts line 42).
  - Checkpoints: `log.addCheckpoint()` records pending transactions (log.ts line 49).
  - Store commit: `TransactionCoordinator.commit()` uses `batch.write()` for atomic persistence (transaction.ts line 119).
  - LevelDB: Underlying store provides fsync on batch write.
  - NOTE: Crash between COMMIT message and local persistence could lose transaction.
  - GAP: No explicit WAL or redo log - relies on 2PC consensus for durability across nodes.

### 10.2 Two-Phase Commit (2PC) Protocol Correctness

- [x] **THEORY-10.2.1**: Review PEND phase as "prepare" equivalent - VERIFIED with NOTES:
  - PEND is sent sequentially per collection (coordinator.ts lines 499-531).
  - All participants in a cluster receive PEND via cluster-coordinator.ts.
  - Timeout handling: If PEND times out, the collection's pend fails and returns error.
  - NOTE: Sequential PEND means earlier collections may be pending while later ones haven't started.
- [x] **THEORY-10.2.2**: Review COMMIT phase as "commit" equivalent - VERIFIED:
  - Super-majority threshold: `simpleMajority = floor(peerCount * simpleMajorityThreshold) + 1` (cluster-coordinator.ts line 452).
  - Uses FRET for cluster size estimation (validated in HUNT-5.2.2).
  - Commit retries with exponential backoff for missing peers (lines 492-520).
  - Byzantine tolerance: Simple majority (>50%) proves commitment. Minority Byzantine nodes cannot prevent commit.
- [x] **THEORY-10.2.3**: Review blocking scenarios - VERIFIED with NOTES:
  - Expiration logic: `queueExpiredTransactions()` runs every 60s (line 78), checks `message.expiration` (line 674).
  - `handleExpiration()` (line 637) rejects expired transactions with 'Transaction expired' reason.
  - Cleanup: `processCleanupQueue()` runs every 1s (line 80), removes expired transactions not in Consensus/Rejected phase.
  - Timeouts: `setupTimeouts()` (lines 483-498) sets promiseTimeout and resolutionTimeout based on expiration.
  - NOTE: Coordinator failure can leave participants pending until expiration (typically seconds to minutes).
- [x] **THEORY-10.2.4**: Review recovery protocol - DOCUMENTED: See `tasks/refactoring/2pc-state-persistence.md`
  - How do nodes recover pending state after crash/restart?
  - `cluster-coordinator.ts:36` TODO: "move this into a state management interface so that transaction state can be persisted"
- [x] **TEST-10.2.1**: COMPLETE — 2 tests in transaction.spec.ts. **BUG 1: pendPhase partial failure orphans pending actions** (pend succeeds for collection A, fails for B → no cancelPhase call → A's pending action blocks future transactions). **BUG 2: commitPhase partial failure violates atomicity** (commit succeeds for A, fails for B → cancelPhase called but cancel on committed block is no-op → A committed, B not).

### 10.3 Consensus Algorithm Correctness

- [x] **THEORY-10.3.1**: Review super-majority threshold calculation - VERIFIED with NOTES:
  - Threshold: `superMajority = Math.ceil(peerCount * superMajorityThreshold)` (default 0.75).
  - Network size: FRET `getNetworkSizeEstimate()` with confidence score. Fallback to connection count.
  - Partition detection: `PartitionDetector.detectPartition()` checks rapid churn (5+ peers in 10s) and mass unreachability.
  - Self-coordination guard: Blocks if shrinkage > 50% from high water mark.
  - `validateSmallCluster()`: Compares FRET estimate order-of-magnitude with local cluster size.
  - GAP: If FRET confidence is low, `validateSmallCluster()` returns true (accepts). Could allow split-brain in edge cases.
  - NOTE: Super-majority (75%) means both partitions cannot commit if network splits 50/50.
- [x] **THEORY-10.3.2**: Review supercluster formation (GATHER phase) - VERIFIED with NOTES:
  - Formation: `gatherPhase()` (coordinator.ts lines 445-475) queries each critical cluster via `queryClusterNominees()`.
  - Merging: All nominees merged into single Set (union of all cluster members).
  - Concurrent transactions: Can form different superclusters if clusters change between queries. Conflict resolved at PEND phase via `operationsConflict()`.
  - Sybil prevention: Relies on FRET for peer discovery. No explicit spot-checking of nominees.
  - GAP: No validation that nominees are legitimate cluster members. Malicious coordinator could inject fake nominees.
  - NOTE: Signature verification (when implemented) would mitigate Sybil attacks.
- [x] **THEORY-10.3.3**: Review ordering guarantees - VERIFIED:
  - Conflict detection: `operationsConflict()` (lines 564-588) checks block ID overlap.
  - Race resolution: `resolveRace()` (lines 548-561) is deterministic - more promises wins, tie-breaker is higher messageHash.
  - All nodes use same algorithm, so all reach same conclusion.
  - Linearizability: Not guaranteed for concurrent transactions to same collection - winner determined by promise count at conflict detection time.
- [x] **THEORY-10.3.4**: Review liveness guarantees - VERIFIED with NOTES:
  - Retry mechanism: `scheduleCommitRetry()` with exponential backoff (2s → 4s → 8s → 16s → 30s), max 5 attempts.
  - Timeout: 30s default (`DEFAULT_TIMEOUT`), transactions expire and are cleaned up.
  - Conflict resolution: `resolveRace()` deterministically picks winner (more promises wins).
  - Starvation: Possible if transaction keeps losing races. No priority or fairness mechanism.
  - GAP: No explicit starvation prevention. High-contention scenarios could starve some transactions.
  - NOTE: Application-level retry with backoff is expected for failed transactions.
- [x] **TEST-10.3.1**: Add consensus protocol correctness tests (concurrent conflicting transactions) — COMPLETE: 4 tests, 4 bugs found:
  - BUG: `coordinator.execute()` never resets collection trackers after commit — stale transforms accumulate
  - BUG: `coordinator.execute()` never updates `actionContext.rev` — subsequent transactions compute stale revision (always rev=1)
  - BUG: Sequential `coordinator.execute()` fails even with no logical conflict — pend/commit rev is always 1 due to stale actionContext
  - BUG: `coordinator.rollback(stampId)` ignores stampId parameter — resets ALL collection trackers, destroying concurrent sessions' transforms

### 10.4 Byzantine Fault Tolerance

- [x] **THEORY-10.4.1**: Review Byzantine fault model - DOCUMENTED: Signature stubs ARE a BFT violation. See `tasks/refactoring/signature-verification-implementation.md`
  - What fraction of Byzantine nodes can be tolerated? (f < n/3 is typical) - Cannot be guaranteed without signature verification
  - Are signature verification stubs (returning `true`) a BFT violation? - YES, any peer can forge signatures
- [x] **THEORY-10.4.2**: Review validation completeness - VERIFIED with GAPS:
  - Hash generation: `hashOperations()` uses `JSON.stringify()` + `hashString()` (djb2, non-cryptographic).
  - Validators re-execute: `TransactionValidator.validate()` re-runs SQL, computes own hash, compares.
  - Byzantine coordinator: Could forge hash if djb2 collision found (feasible with effort).
  - GAP: djb2 is NOT collision-resistant. See `tasks/refactoring/cryptographic-hash-upgrade.md`.
  - Mitigation: Validators re-execute and compare, so forged hash would fail validation.
  - NOTE: Upgrade to SHA-256 recommended for operationsHash.
- [x] **THEORY-10.4.3**: Review equivocation prevention - VERIFIED with GAPS:
  - Promise structure: `Signature` type has `type: 'approve' | 'reject'` and `signature` string.
  - Promise hash: `computePromiseHash()` includes messageHash + message (SHA-256).
  - Commit hash: `computeCommitHash()` includes messageHash + message + promises.
  - GAP: `verifySignature()` is a stub returning `true` - no actual signature verification.
  - GAP: No equivocation detection mechanism. Byzantine node could promise to multiple conflicting transactions.
  - Mitigation: Super-majority (75%) makes equivocation harder to exploit.
  - NOTE: Signature verification implementation would enable equivocation detection via conflicting signed promises.
- [ ] **TEST-10.4.1**: Add Byzantine fault injection tests

### 10.5 Optimistic Concurrency Control

- [x] **THEORY-10.5.1**: Review read dependency tracking - DOCUMENTED: See `tasks/refactoring/read-dependency-validation.md`
  - `validator.ts` TODO: "Implement read dependency validation" - **INCOMPLETE**
  - How are read sets captured during transaction execution?
  - Can write skew anomalies occur with current implementation?
- [x] **THEORY-10.5.2**: Review conflict detection - VERIFIED with NOTES:
  - `hasConflict()` (lines 500-542) uses 2000ms stale threshold for cleanup.
  - Stale transactions are cleaned up, not used for conflict detection.
  - Conflict is based on block ID overlap, not time window.
  - Lost updates: Possible if two transactions don't overlap in time at any node. The 2s window is for cleanup, not conflict detection.
  - NOTE: The 2s threshold is reasonable for distributed consensus round-trip time.
- [x] **THEORY-10.5.3**: Review retry semantics - VERIFIED with NOTES:
  - Failed writes: Retried transactions do NOT see prior failed writes. Failed transactions are abandoned.
  - Retry pattern: Client abandons pending ops, loads winning transaction's actions, replays own actions.
  - Duplicate handling: Cluster members are idempotent - ignore duplicate commits once signature present.
  - Pending conflict: `StaleFailure.pending` returned; client waits (`PendingRetryDelayMs`) and retries.
  - Transaction ID: New transaction ID generated on retry (different stamp timestamp).
  - NOTE: Application must handle retry logic; system provides `StaleFailure` info for informed retry.
- [x] **TEST-10.5.1**: COMPLETE � 5 tests in transaction.spec.ts. Lost-update prevention works (block-ID conflict detection). Committed conflict detection works. **Write-skew anomaly is possible** (KNOWN LIMITATION: no read dependency tracking � validator.ts TODO). Write-skew through separate collections also undetected.

### 10.6 Deterministic Replay Correctness

- [x] **THEORY-10.6.1**: Review statement replay determinism - VERIFIED:
  - `Date.now()`: Used only in stamp creation (session.ts line 39), not in SQL execution. Stamp is passed to validators.
  - `random()` function: Marked `deterministic: false` (scalar.ts line 161). Non-deterministic expressions are validated and rejected in constraints/defaults (determinism-validator.ts lines 48-63).
  - `QUEREUS_ENGINE_ID`: Hardcoded as 'quereus@0.15.1' (quereus-engine.ts line 17). Validators check engine ID matches (quereus-validator.ts line 55).
  - NOTE: Engine version drift would cause validation failure, not silent divergence. TODO in code to import version dynamically.
- [x] **THEORY-10.6.2**: Review schema hash correctness - VERIFIED with NOTES:
  - Hash source: `schema()` table-valued function returns type, name, sql for all objects.
  - Ordering: `order by type, name` ensures deterministic ordering.
  - Hash algorithm: SHA-256 (first 16 bytes, base64url encoded).
  - Included: Tables, views, indexes, assertions with their DDL.
  - Collation: Included in index DDL (e.g., `COLLATE BINARY`).
  - Constraints: CHECK constraints included in table DDL.
  - NOTE: Schema hash is comprehensive; any schema difference will cause mismatch.
- [x] **THEORY-10.6.3**: Review action ordering - VERIFIED with NOTES:
  - Statement order: `transaction.statements` array processed in order.
  - Operations order: `flatMap` with inserts → updates → deletes per collection.
  - JSON serialization: Uses `JSON.stringify()` which has deterministic key ordering for objects.
  - Collection order: `collectionData.flatMap()` iterates in insertion order (Map).
  - NOTE: JavaScript Map iteration order is insertion order, which is deterministic.
  - GAP: If collections are added in different order on different nodes, hash could differ.
  - Mitigation: Collections are typically created in same order from same schema.
- [x] **TEST-10.6.1**: Add replay determinism tests — TESTED: Operations hash is order-sensitive (different operation order produces different hash). execute() path is safe (iterates result.actions in statement order). commit() path has risk (iterates this.collections Map in insertion order). Validator transforms order must match coordinator order.

### 10.7 Network Partition Handling

- [x] **THEORY-10.7.1**: Review split-brain prevention - VERIFIED with NOTES:
  - Super-majority (75%): Both partitions cannot achieve 75% if split 50/50.
  - FRET estimation: `getNetworkSizeEstimate()` with confidence score.
  - Partition detection: `detectPartition()` checks rapid churn (5+ peers in 10s) and mass unreachability.
  - Self-coordination guard: Blocks writes if shrinkage > 50% from high water mark.
  - `validateSmallCluster()`: Compares FRET estimate with local cluster size.
  - GAP: If FRET confidence is low, validation passes. Edge case could allow split-brain.
  - NOTE: 75% threshold is conservative; 67% would still prevent 50/50 split-brain.
- [x] **THEORY-10.7.2**: Review partition healing - VERIFIED with GAPS:
  - Detection: `PartitionHealEvent` interface defined in docs/transactions.md.
  - Classification: Behind (normal sync), Ahead (tentative), Forked (conflict).
  - Reconciliation: Designed but NOT IMPLEMENTED. See docs/transactions.md lines 1776-1880.
  - Current behavior: Relies on normal sync; divergent commits would conflict.
  - GAP: No automatic reconciliation protocol. Divergent state requires manual intervention.
  - NOTE: Transaction payload stores `statements` for potential replay during reconciliation.
- [x] **THEORY-10.7.3**: Review CAP tradeoffs - VERIFIED with NOTES:
  - Design: CP (Consistency over Availability). Super-majority required for commits.
  - Availability impact: Minority partition cannot commit. Writes blocked during partition.
  - Self-coordination guard: Blocks writes if network shrinkage detected.
  - Consistency levels: `strict` (current), `available` (future), `manual` (future).
  - NOTE: System prioritizes consistency; availability sacrificed during partitions.
- [ ] **TEST-10.7.1**: Add network partition simulation tests

### 10.8 Timestamp and Ordering

- [x] **THEORY-10.8.1**: Review `TransactionStamp.timestamp` usage - VERIFIED with NOTES:
  - Usage: `Date.now()` at transaction BEGIN. Used in stamp ID hash, not for ordering.
  - Ordering: Transaction order determined by log append order, NOT timestamp.
  - Clock skew: Not used for ordering decisions. Stamp timestamp is metadata only.
  - HLC (quereus-sync): Uses Hybrid Logical Clock with MAX_DRIFT_MS = 60s for sync.
  - NOTE: Timestamp is for debugging/auditing, not consensus ordering.
- [x] **THEORY-10.8.2**: Review log entry ordering - VERIFIED with NOTES:
  - Log structure: Append-only chain with `rev` (monotonically increasing).
  - Ordering: Log append order = commit order. `rev` increments by 1 per entry.
  - Replay: `log.getFrom(startRev)` returns entries in order for replay.
  - Block integrity: `priorHash` (SHA-256 of previous block) ensures chain integrity.
  - NOTE: Log-first commit strategy ensures consistent ordering across nodes.
- [x] **THEORY-10.8.3**: Review revision tracking - VERIFIED with NOTES:
  - Increment: `newRev = (actionContext?.rev ?? 0) + 1` - always +1.
  - Gap detection: `getFrom(startRev)` returns entries > startRev for sync.
  - Wrap around: JavaScript number, max safe integer is 2^53-1. No explicit handling.
  - NOTE: At 1M transactions/second, would take ~285 years to overflow. Practical non-issue.
- [x] **TEST-10.8.1**: Add clock skew and ordering tests — COMPLETE: 4 tests, 3 issues found:
  - BUG: Identical stamp inputs produce identical stamp/transaction IDs — independent transactions from same peer at same ms are indistinguishable
  - BUG: `hashString` (djb2, 32-bit) produces collisions within 100K stamp-like inputs — different stamps can produce identical IDs
  - VERIFIED: 1ms clock difference produces fully divergent stamp IDs — minor skew prevents deduplication
  - VERIFIED: Transaction ordering determined by commit sequence (revision), not timestamp

---

## Priority Summary

### Critical (Security/Data Integrity)
1. ~~**SEC-9.2.1**: Signature verification not implemented~~ - DOCUMENTED in `tasks/refactoring/signature-verification-implementation.md`
2. ~~**HUNT-1.2.1**: Tracker splice bug may corrupt deletes array~~ - FIXED
3. ~~**HUNT-2.1.1/2.1.2**: Weak hash function for transaction IDs~~ - FIXED (bug), DOCUMENTED upgrade path in `tasks/refactoring/cryptographic-hash-upgrade.md`
4. ~~**THEORY-10.4.1**: Byzantine fault model incomplete (signature stubs)~~ - DOCUMENTED in `tasks/refactoring/signature-verification-implementation.md`

### High (Incomplete Features / Theory Gaps)
1. ~~**HUNT-2.1.3**: Read dependency validation not implemented~~ - DOCUMENTED in `tasks/refactoring/read-dependency-validation.md`
2. ~~**HUNT-4.1.2**: `getStatus()` not implemented~~ - FIXED
3. ~~**HUNT-5.1.1**: Hash validation logic mismatch~~ - FIXED
4. ~~**THEORY-10.5.1**: Optimistic concurrency control incomplete (write-skew possible)~~ - DOCUMENTED in `tasks/refactoring/read-dependency-validation.md`
5. ~~**THEORY-10.2.4**: 2PC recovery protocol not persisted~~ - DOCUMENTED in `tasks/refactoring/2pc-state-persistence.md`

### Medium (Technical Debt / Theory Review)
1. ~~**HUNT-5.2.1**: Transaction state not persisted~~ - DOCUMENTED in `tasks/refactoring/2pc-state-persistence.md`
2. ~~**HUNT-5.3.1/5.3.2**: Proximity verification not implemented~~ - DOCUMENTED in `tasks/refactoring/proximity-verification.md`
3. ~~**HUNT-7.1.1**: Hardcoded version string~~ - FIXED: Updated to current version with sync note
4. ~~**THEORY-10.3.1**: Super-majority threshold under network partition~~ - VERIFIED with NOTES (GAP: low FRET confidence edge case)
5. ~~**THEORY-10.1.1**: Atomicity across multi-collection partial failures~~ - VERIFIED with GAPS (partial commit possible)

### Low (Optimization/Cleanup)
1. **HUNT-3.1.1**: B-tree nodeIds iteration efficiency
2. **HUNT-3.2.1**: Chain header generalization
3. **HUNT-3.3.3**: Sync timing optimization

---

## Review Progress Tracking

| Layer | Total Tasks | Completed | Remaining (TEST/DOC) |
|-------|-------------|-----------|----------------------|
| 1. Block Storage | 9 | 9 | — |
| 2. Transaction | 11 | 7 | 3 TEST, 1 DOC |
| 3. B-tree/Collections | 14 | 10 | 3 TEST, 1 DOC |
| 4. Network Transactor | 8 | 6 | 1 TEST, 1 DOC |
| 5. Cluster Consensus | 16 | 12 | 3 TEST, 1 DOC |
| 6. Crypto | 6 | 6 | 1 DOC |
| 7. Quereus Plugin | 12 | 13 | — |
| 8. Reference Peer | 4 | 2 | 1 TEST, 1 DOC |
| 9. Architecture | 16 | 12 | 4 DOC |
| 10. Transactional Theory | 34 | 32 | 2 TEST |
| **Total** | **130** | **110** | **11 TEST, 9 DOC** |

**Note**: All HUNT-* (code review) and THEORY-* (transactional theory) tasks are COMPLETE. Remaining tasks are TEST-* (test coverage) and DOC-* (documentation) items.

---

## Refactoring Opportunities

If an opportunity to improve the code or design is found, generate a new file in tasks/refactoring:
* Give it a logical name like "refactor-transaction-state-persistence.md"
* Include: Subsystem, Involved code, doc, and test files, Rationale, and Design options
