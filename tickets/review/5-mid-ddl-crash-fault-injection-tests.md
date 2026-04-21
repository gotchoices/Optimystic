description: Mid-DDL / mid-transaction crash fault-injection tests for the solo-node production stack. Wraps `MemoryRawStorage` with a `CrashingRawStorage` proxy that injects a throw at any `IRawStorage` method boundary, rebuilds the node stack over the preserved raw storage, and asserts the recovery contract for each crash point. Surfaced three gap areas that are tracked as follow-up fix tickets rather than expanded scope here.
dependencies:
  - tickets/complete/5-get-block-throws-on-pending-only-metadata.md (Crash-A1's "read returns empty state" recovery case relies on this being resolved)
files:
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (new, 11 passing + 1 pending/DESIRED)
  - packages/db-p2p/src/testing/mesh-harness.ts (added `rawStorageFactory?: (index: number) => IRawStorage` to MeshOptions; widened internal rawStorages map to IRawStorage)
  - tickets/fix/5-memory-storage-metadata-reference-leak.md (follow-up)
  - tickets/fix/5-crash-d3-latest-not-updated-silent-invisible-commit.md (follow-up)
  - tickets/fix/5-crash-c-partial-commit-stranded-block.md (follow-up)
----

## What was built

### Harness change — `MeshOptions.rawStorageFactory`

`mesh-harness.ts` gained an optional per-node raw-storage factory hook. When omitted, behavior is identical to before (each node gets a fresh `MemoryRawStorage`). When provided, the factory supplies the `IRawStorage` that backs `StorageRepo` — used by the new spec to (a) wrap a real `MemoryRawStorage` with a crashing proxy for the crash phase, and (b) rebuild the node stack over the same preserved raw storage for the recovery phase.

### `CrashingRawStorage` proxy (inside the spec)

Implements `IRawStorage` by delegating to an inner store, with a `FaultTrigger` describing:

- `method` — which IRawStorage method to intercept
- `blockId` / `actionId` — optional filters
- `skipCount` — fire after N matching calls (default 0)
- `when: 'before' | 'after'` — throw before delegating (syscall never ran) or after (syscall completed, caller never observed the return)
- `predicate(args)` — predicate matcher for differentiating semantically-distinct calls to the same method (e.g. `saveMetadata` during pend-seed vs during `setLatest`)

Fires exactly once per instance; inspecting `proxy.fired` lets tests assert the crash actually triggered before checking post-conditions.

### Test cases (all passing unless noted)

All under `describe('Mid-DDL crash recovery (solo node)')` with a 5s timeout (matching `fresh-node-ddl.spec.ts`).

| Suite | Crash point | State asserted | Recovery asserted |
| --- | --- | --- | --- |
| Crash-A1 | `savePendingTransaction` before (single block) | metadata seeded, no pending | default read → empty state; retry-pend + commit → success; cancel → no-op + fresh pend works |
| Crash-B | `savePendingTransaction` before (block index 1 of 3) | b0,b2 have pending (Promise.all fans out); b1 does not | cancel + fresh-action pend succeeds on all three |
| Crash-C | `saveMetadata(setLatest)` after (block index 1 of 3) | b0,b1 fully committed; b2 never processed | retry-commit REJECTED (documents current contract); b2 left stranded — flagged for follow-up |
| Crash-D2 | `promotePendingTransaction` before | revision durable, pending present, action not in committed log | retry-commit succeeds (saveRevision idempotent) |
| Crash-D3 | `saveMetadata(setLatest)` before | revision durable, pending promoted, action in committed log, latest mutated IN RAM (documented reference-leak) | retry-commit rejected; reads succeed ONLY because of the leak — flagged for follow-ups |
| Schema-block DDL | `saveRevision` before, driven by `Tree.createOrOpen + tree.replace` via NetworkTransactor | DDL throws | fresh Tree on same id does NOT surface `non-existent chain` or `not found during restore attempt` — either rolls back or succeeds cleanly |

### Pending (skipped) test — DESIRED recovery entry-point

`Crash-D3 > DESIRED: after fixing the reference leak, a recovery entry-point reconciles latest with max(revisions)` is `.skip`ped. Unskipping is part of the acceptance criteria for the two Crash-D3 follow-up fix tickets.

## Follow-up fix tickets filed

1. **`tickets/fix/5-memory-storage-metadata-reference-leak.md`** — `MemoryRawStorage.getMetadata` returns the stored metadata by reference, letting `BlockStorage.setLatest`'s `meta.latest = latest` mutate stored state before `saveMetadata` is called. Masks mid-commit crash visibility on MemoryRawStorage. Fix: clone on return, matching `getMaterializedBlock`.

2. **`tickets/fix/5-crash-d3-latest-not-updated-silent-invisible-commit.md`** — Even on a correct persistent store, a crash between `promotePendingTransaction` and `setLatest` leaves a durable revision + committed-log entry with `metadata.latest` unchanged. Retry-commit is rejected (pending gone) and reads see the old latest. Needs a dedicated recovery entry-point that reconciles latest with max(revisions), or an opportunistic check on `getLatest()`.

3. **`tickets/fix/5-crash-c-partial-commit-stranded-block.md`** — Sequential multi-block commits that crash partway through leave later blocks stranded (pending + no revision), and retry-commit short-circuits on the already-committed earlier blocks rather than advancing the stranded ones. Needs commit idempotency-on-same-actionId + possibly a startup recovery pass.

## Validation

- `cd packages/db-p2p && npm run build` — clean.
- `cd packages/db-p2p && npm test` — 417 passing, 2 pending (includes the pre-existing `Scenario B` skipped case and the new `Crash-D3 DESIRED`).

## Use cases / notes for review

- Run the spec in isolation: `cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/mid-ddl-crash.spec.ts" --reporter spec`.
- The `CrashingRawStorage` proxy and `rawStorageFactory` hook are deliberately minimal. If a future spec needs them, consider extracting to `packages/db-p2p/test/helpers/` — but keep the hook on `MeshOptions` as-is (additive, non-breaking for `createMesh` consumers).
- The three follow-up fix tickets are independent but `5-memory-storage-metadata-reference-leak.md` should land first so subsequent Crash-D3 assertions can be flipped to match persistent-store behavior without the RAM leak masking the state.
- Review focus should be on: (1) whether the current Crash-C contract assertion is an acceptable baseline (it documents a real gap), (2) whether `CrashingRawStorage` would be better in `src/testing/` instead of inline in the spec.
