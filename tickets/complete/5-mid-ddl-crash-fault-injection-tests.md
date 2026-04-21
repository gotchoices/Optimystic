description: Mid-DDL / mid-transaction crash fault-injection tests for the solo-node production stack. Wraps `MemoryRawStorage` with a `CrashingRawStorage` proxy that injects a throw at any `IRawStorage` method boundary, rebuilds the node stack over the preserved raw storage, and asserts the recovery contract for each crash point. Surfaced three gap areas tracked as follow-up fix tickets.
dependencies:
  - tickets/complete/5-get-block-throws-on-pending-only-metadata.md (Crash-A1's "read returns empty state" recovery case relies on this being resolved)
files:
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (new, 11 passing + 1 pending/DESIRED)
  - packages/db-p2p/src/testing/mesh-harness.ts (added `rawStorageFactory?: (index: number) => IRawStorage` to MeshOptions)
  - tickets/fix/5-memory-storage-metadata-reference-leak.md (follow-up)
  - tickets/fix/5-crash-d3-latest-not-updated-silent-invisible-commit.md (follow-up)
  - tickets/fix/5-crash-c-partial-commit-stranded-block.md (follow-up)
----

## What shipped

### Harness hook — `MeshOptions.rawStorageFactory`

`mesh-harness.ts` gained an optional per-node `rawStorageFactory?: (index: number) => IRawStorage`. When omitted, behavior is identical (each node gets a fresh `MemoryRawStorage`). When provided, the factory supplies the `IRawStorage` that backs `StorageRepo` — used by the spec to wrap a real `MemoryRawStorage` with a crashing proxy during the crash phase, then rebuild the node stack over the same preserved raw storage for the recovery phase. Purely additive; no existing callers affected.

### `CrashingRawStorage` proxy (inside the spec)

Implements `IRawStorage` by delegating to an inner store, with a `FaultTrigger` describing:

- `method` — which IRawStorage method to intercept
- `blockId` / `actionId` — optional filters
- `skipCount` — fire after N matching calls (default 0)
- `when: 'before' | 'after'` — throw before delegating (syscall never ran) or after (syscall completed, caller never observed the return)
- `predicate(args)` — differentiates semantically-distinct calls to the same method (e.g. `saveMetadata` during pend-seed vs during `setLatest`)

Fires exactly once per instance; `proxy.fired` lets tests assert the crash actually triggered before checking post-conditions.

### Test cases — all 11 passing, 1 deliberately skipped

All under `describe('Mid-DDL crash recovery (solo node)')` with a 5s timeout (matching `fresh-node-ddl.spec.ts`).

| Suite | Crash point | State asserted | Recovery asserted |
| --- | --- | --- | --- |
| Crash-A1 | `savePendingTransaction` before (single block) | metadata seeded, no pending | default read → empty state; retry-pend + commit → success; cancel → no-op + fresh pend works |
| Crash-B | `savePendingTransaction` before (block index 1 of 3) | b0,b2 have pending (Promise.all fans out); b1 does not | cancel + fresh-action pend succeeds on all three |
| Crash-C | `saveMetadata(setLatest)` after (block index 1 of 3) | b0,b1 fully committed; b2 never processed | retry-commit REJECTED (documents current contract); b2 stranded — flagged for follow-up |
| Crash-D2 | `promotePendingTransaction` before | revision durable, pending present, action not in committed log | retry-commit succeeds (saveRevision idempotent) |
| Crash-D3 | `saveMetadata(setLatest)` before | revision durable, pending promoted, action in committed log, latest mutated IN RAM (documented reference-leak) | retry-commit rejected; reads succeed ONLY because of the leak — flagged for follow-ups |
| Schema-block DDL | `saveRevision` before, driven by `Tree.createOrOpen + tree.replace` via NetworkTransactor | DDL throws | fresh Tree on same id does NOT surface `non-existent chain` or `not found during restore attempt` |

Pending (skipped) test — `Crash-D3 > DESIRED: after fixing the reference leak, a recovery entry-point reconciles latest with max(revisions)` — unskipping is part of the acceptance criteria for the two Crash-D3 follow-up fix tickets.

## Follow-up fix tickets filed

1. **`tickets/fix/5-memory-storage-metadata-reference-leak.md`** — `MemoryRawStorage.getMetadata` returns stored metadata by reference, letting `BlockStorage.setLatest`'s `meta.latest = latest` mutate stored state before `saveMetadata` is called. Masks mid-commit crash visibility on MemoryRawStorage. Fix: clone on return, matching `getMaterializedBlock` and the "Storage Returns References" pitfall in `docs/internals.md`.

2. **`tickets/fix/5-crash-d3-latest-not-updated-silent-invisible-commit.md`** — Even on a correct persistent store, a crash between `promotePendingTransaction` and `setLatest` leaves a durable revision + committed-log entry with `metadata.latest` unchanged. Retry-commit is rejected (pending gone) and reads see the old latest. Needs a dedicated recovery entry-point that reconciles latest with max(revisions), or an opportunistic check on `getLatest()`.

3. **`tickets/fix/5-crash-c-partial-commit-stranded-block.md`** — Sequential multi-block commits that crash partway through leave later blocks stranded (pending + no revision), and retry-commit short-circuits on the already-committed earlier blocks rather than advancing the stranded ones. Needs commit idempotency-on-same-actionId + possibly a startup recovery pass.

The leak ticket should land first so subsequent Crash-D3 assertions can be flipped to match persistent-store behavior without the RAM leak masking state.

## Testing notes

- Full suite: `cd packages/db-p2p && npm test` → 417 passing.
- Spec in isolation: `cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/mid-ddl-crash.spec.ts" --reporter spec` → 11 passing, 1 pending (~40 ms).
- Build: `cd packages/db-p2p && npm run build` → clean.

## Review decisions

- **Crash-C current contract assertion kept as baseline** — documents the partial-commit gap as a forcing function. The Crash-C follow-up fix ticket TODO explicitly flips the assertion when the fix lands.
- **`CrashingRawStorage` kept inline in the spec** — single consumer; extraction to `src/testing/` deferred until a second spec needs it. YAGNI; the ticket already calls out the extraction path.

## Usage for future crash specs

Add a crash point by adding a new `describe` block that:

1. Builds a fresh `MemoryRawStorage`.
2. Calls `buildCrashingMesh(raw, { method, when, blockId?, actionId?, skipCount?, predicate? })` to get a node with the proxy installed.
3. Drives `storageRepo.pend / commit / cancel` (or a NetworkTransactor-driven DDL) against node 0.
4. Asserts `proxy.fired === true` and checks raw-store state via the preserved `raw` reference.
5. Calls `rebuildCleanMesh(raw)` to get a fresh node over the preserved state and asserts recovery behavior.

The `FaultTrigger.predicate` lets a single method (e.g. `saveMetadata`) be targeted at semantically-distinct callers — the Crash-C and Crash-D3 specs both use it to trigger on `meta.latest !== undefined` (setLatest phase) vs the pend-phase metadata seed.
