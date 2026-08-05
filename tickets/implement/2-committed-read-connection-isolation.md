description: When the database asks this plugin for a read of only already-committed data, the plugin currently hands back a view that is entangled with the writer's own connection and can be assembled from two different moments in time. Give that read its own clean, single-moment view.
prereq: committed-read-pinned-snapshot
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts, packages/quereus-plugin-optimystic/test/committed-read.spec.ts, docs/transactions.md
difficulty: hard
----

# Isolate the committed-read view from the writer's connection

## Context

Quereus 4.8 (installed; `packages/quereus-plugin-optimystic/package.json`
devDependency is already bumped to `^4.8.0`) can run a read-only statement
*outside* the execution mutex, concurrently with another statement's commit. It
gates that on two module declarations in `vtab/module.ts`:

- `concurrencyMode?: 'serial' | 'reentrant-reads' | 'fully-reentrant'` — may the
  runtime issue concurrent calls on ONE connection? Default `'serial'`.
- `readCommittedSnapshot?: boolean` — does a `_readCommitted` connection serve a
  stable, self-consistent committed snapshot for the life of the scan? Default
  `false`.

The engine reads the second via `getModuleReadCommittedSnapshot` and, when true,
routes eligible statements down `Statement._iterateConcurrent`, which runs with
no exec mutex and connects every scan with `_readCommitted: true`. Upstream's
obligations are written up in `../quereus/docs/module-authoring.md` § "Committed-
Snapshot Reads (`_readCommitted`)" — **read that section before starting.**

This ticket does the structural work. It deliberately declares only
`concurrencyMode`; `readCommittedSnapshot` stays off until
`committed-read-snapshot-declaration` has *proved* the guarantee. Declaring the
target value and treating the later test as confirmation is the failure mode to
avoid — the declaration is what routes reads onto the concurrent path.

## Problems to fix

### 1. The committed view is assembled from more than one moment

`OptimysticVirtualTable.runQuery` (`optimystic-module.ts:495`) resolves the main
read up front via `resolveMainRead(committed)` → `committedTreeView(collection)`,
but the secondary-index read is resolved *later*, inside `executeIndexScan`
(`:673`, `committedTreeView(indexTree)`). The two are separated by the generator
suspension boundary, so a commit can land between them: the main view pins one
revision and the index view another. An index-driven committed read can then
return index entries whose rows the main view cannot resolve, or miss rows the
main view holds — and an index-driven plan and a full scan of the same nominal
snapshot disagree, which upstream's contract explicitly forbids.

Fix: build every committed view this scan will use — main tree plus the index
tree, if the parsed plan uses one — in **one synchronous block** at the top of
`runQuery`, before any `await` after initialization. `committedTreeView`,
`parsePlanType` and `parseIndexName` are all synchronous, so this is a
restructuring, not new machinery. Pass the pre-built views down rather than
letting `executeIndexScan` construct its own.

### 2. The committed path registers a connection

`runQuery` opens with `await this.ensureConnectionRegistered()` (`:497`) for both
read modes, and `OptimysticModule.resolveConnectedTable` (`:1852`) calls it too
when the table is not yet cached. That method calls
`DatabaseInternal.registerConnection`, putting an `OptimysticVirtualTableConnection`
into the registry the engine walks for `begin` / `commit` / `rollback` /
savepoint broadcasts (`vtab-connection.ts`).

Upstream is explicit: *"A `_readCommitted` connection must not join the writer's
transaction. Do not hand it to `Database.registerConnection`."* Today the
committed path does not create a *distinct* connection — it reuses the base
table's, which the writer already owns — so nothing is mis-enlisted in the normal
case. But the committed path mutating the engine's connection registry at all is
wrong once it runs without the mutex: a first-touch committed read would register
the writer's connection from outside the mutex, mid-transaction.

Fix:
- `runQuery` takes the registration step only on the live path.
- `OptimysticModule.connect` with `_readCommitted: true` resolves the table
  **without** registering a connection. Initialization (`table.initialize()`) may
  still run — it is memoized and idempotent — but the `ensureConnectionRegistered()`
  call must not.
- `OptimysticCommittedTable` overrides `createConnection()` to throw
  (`QuereusError`, `StatusCode.MISUSE`) and `getConnection()` to return
  `undefined`, so nothing can enlist the committed view by accident. Its existing
  no-op `disconnect()` is then correct *because* nothing was registered — say so
  in the comment, since today it is correct only by coincidence.

### 3. Nothing refuses to answer from a known-degraded state

Upstream: *"If the module can enter a state where it cannot serve a coherent
committed snapshot … it must throw from `connect` or from the first `query()`
pull rather than answer."* This plugin has exactly such a state: after
`PartialCommitError` (`txn-bridge.ts:54`) or `CoordinatorPartialCommitError`,
some trees are durably committed and others are not, so no single tree set is a
coherent commit boundary.

Fix: latch a degraded flag on `TransactionBridge` when either error is raised,
expose it (`isDegraded(): boolean`, plus the reason), and have `queryCommitted`
throw from its first pull while it is set. Clear it on the next successful
`commitTransaction`/`rollbackTransaction` — that is the point at which a
reconciled state is back in view. Live reads are unaffected (they already report
whatever the trees hold).

### 4. The single module-global bridge is an undocumented constraint

`OptimysticModule` holds one injected `TransactionBridge` and one `tables` map;
the bridge holds one `currentTransaction`, one `dirtyTrees` map, one `savepoints`
map, and one `collectionRegistry`. What is safe to share and what is not:

| State | Shared across concurrent readers? | Why |
| --- | --- | --- |
| `tables` map | safe | read-mostly; entries are per `schema.table` and only added, never mutated in place |
| `collectionRegistry` | safe to read | keyed by collection id; a concurrent read only reads it |
| `currentTransaction`, `session`, `dirtyTrees`, `savepoints`, `accumulatedStatements` | **one writer at a time** | single-valued; a second concurrent *writer* would overwrite the first's transaction wholesale |

Quereus serializes writers behind the exec mutex, and the concurrent path is
read-only, so the constraint holds today. It cannot be *enforced* here without
breaking SQLite's "BEGIN inside a transaction is a no-op" semantics that
`beginTransaction` (`txn-bridge.ts:243`) implements deliberately. So: state it.
Add a section to `docs/transactions.md` and a `NOTE:` at the `currentTransaction`
field naming the constraint and what breaks if a second writer ever appears.

## Edge cases & interactions

- **First-ever touch of a table is a committed read.** Table not in `tables`,
  catalog possibly not hydrated. Must still work (initialize, no registration),
  or throw a clear error — decide by test, do not leave it to chance.
- **Committed read while the writer's transaction is open on the same table.**
  Pre-stage snapshot present; must return pre-write rows. This is the existing
  `committed-read.spec.ts` guarantee — it must not regress.
- **Committed read of a table the writer has NOT touched.** ALREADY CLOSED by
  ticket 1's review pass — do not redo. It really was an unpinned hole: the
  fall-through returned the raw live tree and a mid-scan external commit pulled in
  by an interleaved live read's `update()` crashed the committed scan with
  `Missing block` (reproduced end-to-end). `committedTreeView` now always builds a
  pinned view, using `tree.snapshot()` when the txn-bridge has no captured
  snapshot; the CLEAN arm is covered in `committed-read-interleave.spec.ts`.
- **Index-driven vs full-scan agreement** across a commit landing between them —
  the direct test for problem 1. Drive it by hand (build both views, mutate the
  live trees, then iterate), not only through SQL.
- **Composite-PK point lookup and range scan on the committed path** —
  `executePointLookup` / `executeRangeQuery` take the already-resolved view, so
  they should need no change; assert that with a test rather than assuming.
- **`disconnect()` on the committed wrapper** must leave the engine's connection
  count unchanged. Assert via `getConnectionsForTable`.
- **Degraded latch and rollback.** A `PartialCommitError` followed by a
  successful later transaction must clear the latch; a committed read in between
  must throw with a message naming the persisted/unpersisted trees.
- **Two committed scans of the same table concurrently** must not share mutable
  state. Each `connect` makes a fresh `OptimysticCommittedTable`; each `query`
  makes fresh views. Assert by interleaving two scans row-by-row.
- **`concurrencyMode: 'reentrant-reads'` audit.** Confirm two concurrent
  `query()` calls on one connected table share no mutable per-scan state. Note
  `runQuery` writes `this.setErrorMessage(...)` on failure (`:551`) — a shared
  field on the table instance. Decide whether that is acceptable under concurrent
  reads (it affects only diagnostics) or must become per-scan, and say which in
  the handoff.

## TODO

- Restructure `runQuery` to build all committed views (main + index) in one
  synchronous block before any post-init `await`; pass them into
  `executeIndexScan` instead of letting it build its own.
- Skip `ensureConnectionRegistered()` on the committed path in both `runQuery`
  and `OptimysticModule.connect`/`resolveConnectedTable`.
- Override `createConnection()` (throw) and `getConnection()` (undefined) on
  `OptimysticCommittedTable`; correct the `disconnect()` comment.
- Add the degraded latch to `TransactionBridge` (set on both partial-commit
  errors, cleared on the next clean commit/rollback) and refuse committed reads
  while set.
- Declare `readonly concurrencyMode = 'reentrant-reads'` on `OptimysticModule`
  after completing the audit above. Do **not** declare `readCommittedSnapshot`.
- Consider `expectedLatencyMs` on the module — this is a network-backed store and
  upstream uses the hint to amortize per-branch latency in parallel fan-out. If
  you set it, justify the number; if you skip it, say why.
- Add tests to `packages/quereus-plugin-optimystic/test/committed-read.spec.ts`
  (or a sibling spec) covering every bullet under *Edge cases & interactions*.
- Update `docs/transactions.md` with the one-writer-at-a-time section and the
  shared/per-transaction table above; add the `NOTE:` at
  `TransactionBridge.currentTransaction`.
- Build then test: `yarn build` at the repo root (plugin specs import
  `../dist/plugin.js`), then `yarn test` in
  `packages/quereus-plugin-optimystic`, streaming output
  (`yarn test 2>&1 | tee /tmp/opt-test.log`).
