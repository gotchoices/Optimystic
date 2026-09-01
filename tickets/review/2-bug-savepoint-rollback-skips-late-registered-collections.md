description: Fixed a bug where opening a database table partway through a SQL statement, then having that statement fail, left the rows it had already written in that table instead of discarding them.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`registerCollection` ~353-388; `savepoints` field doc ~256-289; `createSavepoint` ~929-946; `rollbackToSavepoint` ~959-972)
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts (new describe `registerCollection tops up open savepoints for late-registered collections`, inside the existing `savepoint operations` block, ~680-820)
----

# What was fixed

`TransactionBridge.createSavepoint(depth)` snapshots the staged state of every
registered collection at the moment the savepoint is created. `rollbackToSavepoint`
only restores what was captured. A collection registered *after* the savepoint
existed (a table that finishes initializing mid-statement, e.g. a committed-read
connection completing full init inside its first `xUpdate`) was invisible to that
savepoint, so a mid-statement failure left its rows staged — they'd flush at the
next commit instead of being discarded. Legacy (staged-tracker) mode only, which is
the default and what every plugin test exercises.

# The fix

`registerCollection` now tops up every currently-open savepoint with a clean
snapshot of the collection being registered:

```ts
registerCollection(collection: Collection<any>): void {
  const known = this.collectionRegistry.get(collection.id);
  this.collectionRegistry.set(collection.id, collection);
  if (known === collection) return;
  for (const snapshots of this.savepoints.values()) {
    if (!snapshots.has(collection)) snapshots.set(collection, collection.snapshotPending());
  }
}
```

Sound because registration always precedes any DML on that collection — the
captured "before" state is always clean, at every currently-open depth.

Two guards:
- `known === collection` skips a repeat registration of an already-known instance
  (idempotent by id; `reconcileMaintainedIndexes` re-registers already-open index
  trees, possibly after they've staged this statement's rows — re-capturing then
  would record dirty state as "before").
- `!snapshots.has(collection)` keyed by object identity (not id) — a NEW instance
  registered under an id already in the registry (a table re-initializing
  mid-transaction) still gets its own clean capture; the old instance's own capture
  is left alone.

Updated the `savepoints` field doc-comment (previously carried an "accepted edge
case" note about exactly this gap) and `registerCollection`'s own doc-comment
(previously said the collection just needs to be present "when the coordinator
snapshots on the transaction's first action" — stale language from before the
coordinator's own capture strategy changed; reworded to state the real invariant:
registration must precede staging).

Session mode is unaffected: `createSavepoint` still returns early there, so the
top-up loop runs over an empty savepoint map. Statement-level atomicity in session
mode remains a separate, already-filed gap
(`backlog/debt-optimystic-session-mode-statement-savepoint-gap`).

# Testing performed

Added 4 tests to `adapter-integration.spec.ts`, in a new
`registerCollection tops up open savepoints for late-registered collections`
describe nested inside the existing `savepoint operations` block. These drive
`TransactionBridge` directly with real `Collection` instances (via
`Collection.createOrOpen` over a `TestTransactor` from `@optimystic/db-core/test`
— same pattern as `packages/db-core/test/coordinator-rollback-pending.spec.ts`,
which covers the sibling coordinator-side bug), rather than a full SQL repro:

1. **Primary repro** — register `a`; `createSavepoint(1)`; register `b` (late);
   stage into both; `rollbackToSavepoint(1)` empties both pending queues.
2. **Nested savepoints** — register `a`; open depth 1 and depth 2; register `b`
   after both are open; verify `b` has an independent, correctly-restoring entry
   at each depth.
3. **Repeat registration after staging** — register `a`; open a savepoint; stage
   into `a`; re-register the same instance (the `reconcileMaintainedIndexes`
   shape); rollback must still discard the staged row.
4. **Instance swap under an existing id** — register `original`; open a
   savepoint; stage into it; register a *different* instance `replacement` under
   the same id; stage into that; rollback must empty both (each restored from its
   own capture, keyed by object identity).

Ran (foreground, no redirection):
- `npx tsc --noEmit -p tsconfig.json` — clean.
- `yarn build` — clean (tsup, ESM + DTS).
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min --timeout 20000` from `packages/quereus-plugin-optimystic` — **696 passing, 13 pending (pre-existing, unrelated), 0 failing.**

# Known gaps / what the reviewer should look at

- **No full SQL-level repro was built.** Per the ticket's own guidance, a
  committed-read-then-mid-statement-failure repro through actual SQL is fiddly to
  force reliably (`initializeForCommittedRead` timing), so coverage stops at the
  bridge-level invariant (the 4 tests above) rather than an end-to-end
  `savepoint-rollback.spec.ts`-style test. The bridge-level tests are a faithful
  simulation of the real registration ordering, but nobody has proven the exact
  `initializeForCommittedRead` → `xUpdate` timing described in the original bug
  report actually reaches this code path in production traffic — that inference
  is static, not verified live.
- **The `known === collection` guard's necessity for the "repeat registration
  after staging" test is not airtight.** Working through the exact interleaving
  by hand, the `!snapshots.has(collection)` check alone already prevents
  re-capture in every ordering I could construct, because any savepoint open at
  the time of a repeat registration must already hold an entry for that instance
  (either from `createSavepoint`'s own unconditional sweep, if the collection
  predates the savepoint, or from this same top-up loop's first pass, if it was
  registered late) — so the `known` guard may be defense-in-depth /
  micro-optimization rather than independently load-bearing. I implemented it
  per the ticket's explicit prescribed code (it's harmless either way) but did
  not find an ordering where dropping it alone breaks anything. Worth a second
  look if a reviewer wants to confirm or refute this before treating the guard's
  rationale comment as gospel.
- Only the bridge-level `registerCollection` path was touched. The sibling
  ticket `bug-coordinator-rollback-skips-late-registered-collections` (different
  package, `TransactionCoordinator`) was already implemented and reviewed
  separately — no shared files, no interaction expected, but both address the
  same root-cause shape ("a snapshot map that means whichever collections
  happened to be registered when it was taken").
