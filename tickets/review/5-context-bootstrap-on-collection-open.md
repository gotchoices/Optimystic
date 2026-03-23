description: Bootstrap ActionContext from committed tail block in Collection.createOrOpen before walking the log chain — fixes Missing Block when non-tail blocks are still pending after a partial commit
dependencies: 5-pending-block-context-serving (storage-side complement; both needed for full convergence)
files:
  - packages/db-core/src/collection/collection.ts — Collection.createOrOpen, updateInternal, bootstrapContext
  - packages/db-core/test/test-transactor.ts — TestTransactor.get (context.committed support)
  - packages/db-core/test/collection.spec.ts — context bootstrap tests
----

## Summary

When `Collection.createOrOpen` or `updateInternal` constructs a `TransactorSource` with `actionContext: undefined`, then calls `Log.open` → `Chain.open`, every block read during the chain walk passes `context: undefined` to the transactor. If a prior commit completed its tail but non-tail blocks are still pending, the transactor can't serve those blocks without context proving the reader is aware of the committed action. Result: Missing Block.

The fix bootstraps an `ActionContext` from the committed tail block's `state.latest` **before** walking the chain. The tail is always committed first (commit protocol guarantee), so it's readable with `context=undefined`. Its `state.latest` contains the `ActionRev` of the most recent committed action — exactly the proof needed.

## What was built

### `Collection.bootstrapContext` (private static helper)
Reads the `tailId` from the header block, fetches the tail from the transactor, and constructs a bootstrap `ActionContext` from its `state.latest`. Applied in both `createOrOpen` and `updateInternal` before `Log.open`.

### `TestTransactor.get()` enhancement
Added a `context.committed` branch between the `actionId` and `rev` branches. When `context.committed` includes a matching `actionId` for a pending action, the pending block is served — mirroring real coordinator behavior.

### `PartialCommitTransactor` (test helper)
Wraps `TestTransactor` to simulate partial commits: when `partialMode` is ON, `commit()` only commits header + tail blocks, leaving the rest pending.

## Test cases

1. **createOrOpen with pending non-tail blocks** — Creates 34+ entries (overflows chain block at 32), partial-commits one more, then opens a fresh collection handle. Without the fix, chain walk fails. With fix, succeeds and reads all entries.

2. **updateInternal with pending non-tail blocks** — Same overflow scenario, but tests `c2.update()` on an existing handle after a partial commit on c1.

3. **createOrOpen with no prior commits** — Verifies no regression when there's no tailId to bootstrap from (fresh collection).

## Usage / validation

- Build: `npm run build` in `packages/db-core` — clean
- Tests: `npm test` in `packages/db-core` — 264 passing, 0 failing
- The bootstrap context is a stepping stone; `log.getActionContext()` immediately overwrites it with the full context after the chain walk completes
