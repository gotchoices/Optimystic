description: If a table is opened in the middle of a SQL statement and that statement then fails, the rows it already wrote to that table are not discarded — they stay staged and get saved at the next commit.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`registerCollection` ~350-362; `savepoints` doc ~253-272; `createSavepoint` ~908-927; `rollbackToSavepoint` ~929-951)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`registerCollections` ~1575-1583; its caller in `doInitialize` ~678-683; `xUpdate`'s late `await this.initialize()` ~2142-2144)
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts (~660-680 — the existing direct-bridge savepoint unit tests)
  - packages/quereus-plugin-optimystic/test/savepoint-rollback.spec.ts (end-to-end savepoint coverage, legacy mode)
repro: static
difficulty: easy
----

# What is wrong

This is the second site of the root cause behind
`bug-coordinator-rollback-skips-late-registered-collections` (ticket 1, independent
of this one — different package, no shared file): **a snapshot map that silently
means "whichever collections happened to be registered when I was taken".**

`TransactionBridge.createSavepoint(depth)` captures the staged state of every
collection in `collectionRegistry` *at that moment*, and `rollbackToSavepoint`
restores only what it captured (`txn-bridge.ts:908-951`). Quereus wraps every
non-FAIL DML statement in an internal savepoint and rolls back to it on a
mid-statement violation, so this is what makes a failed statement discard its
partial rows. A collection registered *after* the savepoint was created is not in
that map, so its rows are not discarded — they stay staged and flush at the next
commit.

Legacy (staged-tracker) mode only: `createSavepoint` returns early when a session is
configured. Legacy mode is the default and is what every plugin test exercises, so
unlike ticket 1 this arm is on the path hosts actually run.

How a table comes to register mid-statement: `registerCollections` runs at the end of
`doInitialize`, and `xUpdate` still calls `await this.initialize()` when the table is
not yet fully initialized (`optimystic-module.ts:2142-2144`). On the ordinary path
the table is connected and initialized while the statement is being planned, which is
before the DML executor creates its statement savepoint. But a table left
*provisionally* initialized by a committed-read connect (`initializeForCommittedRead`
takes the read-only path, which explicitly skips registration) completes its full
initialization inside the first `xUpdate` — i.e. after that statement's savepoint was
captured. A later row of the same statement then violates a constraint, Quereus rolls
back to its savepoint, and the earlier rows survive.

Not reproduced at runtime — read from the code. What would confirm it end to end: a
committed read against a cold table inside an open write transaction (leaving it
provisional), then a multi-row `INSERT` into it whose last row violates the primary
key, then `COMMIT`; the earlier rows are present afterwards.

# The fix

Top up every open savepoint at registration time, in `registerCollection`:

```ts
registerCollection(collection: Collection<any>): void {
  const known = this.collectionRegistry.get(collection.id);
  this.collectionRegistry.set(collection.id, collection);
  if (known === collection) return;          // repeat registration of the same instance
  for (const snapshots of this.savepoints.values()) {
    if (!snapshots.has(collection)) snapshots.set(collection, collection.snapshotPending());
  }
}
```

Why this is sound where a general late capture would not be — and why it differs
from ticket 1's per-collection capture-sequence design: **at registration the
collection has not been staged into.** `registerCollections` runs as a table
initializes, before any DML against it, so the state captured here is clean and every
open savepoint in the stack captures the *same* clean state. Nested savepoint
semantics are therefore untouched: rolling back to any depth in the stack returns the
collection to clean, which is where it was at every one of those depths. The
coordinator cannot use this argument because it does not own its collection map and
is never told when something is added to it; the bridge owns the write point.

Two guards, both load-bearing:

- `known === collection` — a repeat registration of an already-registered instance
  must not re-capture. `registerCollection` is idempotent by id and is called again
  from `reconcileMaintainedIndexes` for already-open index trees, by which time the
  collection may hold this statement's rows. Re-capturing there would record dirty
  state as "before" and the rollback would preserve exactly the rows it must discard.
- `!snapshots.has(collection)` — covers the ordering where an instance is registered,
  replaced by a different instance under the same id, and then re-registered: the
  savepoint already holds that instance's clean capture and must keep it. Testing
  `known !== collection` alone would overwrite it with its current (possibly dirty)
  state.

# Edge cases & interactions

- **Primary repro (bridge level).** Register collection `a`; `createSavepoint(1)`;
  register `b`; stage into both; `rollbackToSavepoint(1)` — both must come back with
  empty pending queues and clean trackers.
- **Nested savepoints.** Register `a`; `createSavepoint(1)`; `createSavepoint(2)`;
  register `b`; stage into `b`; `rollbackToSavepoint(2)` clears `b`; stage into `b`
  again; `rollbackToSavepoint(1)` clears it again. Both depths must hold a `b` entry.
- **Repeat registration after staging.** Register `a`; `createSavepoint(1)`; stage
  into `a`; call `registerCollection(a)` again (same instance — the
  `reconcileMaintainedIndexes` shape); `rollbackToSavepoint(1)` must still discard the
  staged rows. This is the test that fails if the `known === collection` guard is
  dropped.
- **New instance under an existing id** while a savepoint is open: the new instance
  gets its own entry and is restored; the old instance's entry stays untouched.
- **Session mode is unaffected** — `createSavepoint` still returns early, so the
  registry top-up loop runs over an empty savepoint map. Statement-level atomicity in
  session mode is a separate, already-filed gap
  (`backlog/debt-optimystic-session-mode-statement-savepoint-gap`); do not widen into
  it here.
- **`releaseSavepoint` / the `> depth` pruning in `rollbackToSavepoint`** are
  untouched: they key on depth, and the top-up only adds entries inside existing
  depth maps.
- **The dedup NOTE at `createSavepoint`** (first capture per depth wins) is unrelated
  and stays.
- **Cost.** One `snapshotPending` per genuinely-new collection per open savepoint.
  Savepoint depth is a statement/row nesting level (shallow), and a fresh collection's
  transforms are near-empty, so this is negligible — but say so in the comment rather
  than leaving it unexplained.

# Documentation to correct

The `savepoints` field doc at `txn-bridge.ts:264-270` currently carries an
accepted-edge-case parenthetical: *"A tree created after the savepoint, e.g. a
brand-new index mid-statement, is not in that create-time set — an accepted edge case,
unreachable via the DML executor's per-statement savepoints since schema is stable
within a statement."* This fix closes that case as a side effect. Replace the
parenthetical with a statement of the new rule (registration tops up every open
savepoint, sound because registration precedes any DML on that collection) rather
than deleting it silently. Update `registerCollection`'s own doc-comment to say it now
also maintains open savepoints.

# Tests

`adapter-integration.spec.ts` already drives the bridge directly for savepoints
(~660-680) — the bridge-level cases above belong there, or in a focused new spec
alongside `savepoint-rollback.spec.ts` if the setup needs real collections rather than
the existing no-throw smoke tests. A bridge-level test is enough to pin the fix; do
not build a full committed-read-then-failed-statement SQL repro unless it falls out
cheaply, since `initializeForCommittedRead` timing is fiddly to force from SQL and the
bridge-level case is the actual invariant.

# TODO

- Add the open-savepoint top-up to `TransactionBridge.registerCollection`, with both
  guards and a comment stating why capturing at registration is sound (clean at
  registration) and why re-registration must not re-capture.
- Correct the `savepoints` field doc and `registerCollection`'s doc-comment.
- Add the bridge-level tests above.
- Run `yarn build && yarn test` in `packages/quereus-plugin-optimystic` (foreground,
  no redirection — its specs import `../dist/`, so the build must precede the test).
