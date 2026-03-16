description: Finalize concurrent collection creation test coverage
dependencies: collection creation logic, test infrastructure
files:
  - packages/db-core/test/collection.spec.ts
  - packages/db-core/test/tree.spec.ts
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/src/transactor/transactor-source.ts
----

## Investigation Summary

The concurrent collection creation case has been thoroughly investigated. **The existing code already handles concurrent creation correctly.** The issue was insufficient test coverage, not a code bug.

### How concurrent creation is resolved:

1. Two peers independently call `createOrOpen()` for the same collection ID
2. Both locally create a header block and log chain in their trackers
3. The first peer to `sync()` commits their creation to the transactor (pend + commit at rev 1)
4. The second peer's `sync()` gets a `StaleFailure` from pend (header block at `collectionId` already committed at rev >= request rev)
5. `syncInternal()` calls `updateInternal()` which:
   - Reads the committed log from the winning peer
   - Detects conflicts on the header block (tracker has local insert, committed entry touches same blockId)
   - Calls `replayActions()` which resets the tracker (discarding local creation transforms) and replays any pending user actions against committed state
6. The sync loop exits (empty pending + empty transforms) or retries with correct state
7. The losing peer is now synchronized with the winning peer's state

### Key mechanisms:

- **Pend phase**: Detects committed conflicts (StaleFailure with `missing`) or pending conflicts (StaleFailure with `pending`)
- **Commit phase**: StorageRepo uses per-block locks to ensure only one commit succeeds per revision (final arbiter)
- **Recovery**: `updateInternal()` reads committed state, detects conflicts via `tracker.conflicts()`, resets tracker, replays pending user actions
- **Latches**: Within a single process, concurrent sync calls on the same collection ID are serialized by the static `Latches` class
- **Tree collections**: CollectionTrunk dynamically reads `rootId` from the header each time, so after tracker reset it reads the committed header's rootId

### Test coverage added:

1. `should resolve concurrent creation (first synced wins)` - basic case (renamed from old test)
2. `should allow operations on losing collection after concurrent creation` - verifies post-recovery usability
3. `should resolve concurrent creation with pending data on both peers` - both peers have data, verifies convergence
4. `should handle latch-serialized concurrent sync after concurrent creation` - Promise.all with convergence verification
5. `Tree: should resolve concurrent Tree creation and allow post-recovery operations` - verifies btree state after recovery

All 255 tests pass.

## TODO

- [ ] Review tests for completeness and edge cases (Diary collection concurrent creation, three-peer scenario)
- [ ] Verify build passes
- [ ] Consider adding a brief note to `docs/collections.md` about concurrent creation behavior
