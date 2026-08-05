description: When the database asks this plugin for a read of only already-committed data, that read now gets its own clean, single-moment view — it no longer touches the writer's connection, refuses to answer when storage is in a half-committed state, and the module declares that concurrent reads on one connection are safe.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, docs/transactions.md
difficulty: medium
----

# Review: committed-read connection isolation

Implementation of implement ticket `committed-read-connection-isolation`
(prereq `committed-read-pinned-snapshot`, complete). Sibling
`committed-read-snapshot-declaration` (implement, seq 3) builds on this and
must NOT be pre-empted here: `readCommittedSnapshot` deliberately stays
undeclared until that ticket's stall-overlap proof.

## What was built

**Single-moment committed views** (`optimystic-module.ts`, `runQuery`): the
access-strategy parse (plan type, index name, legacy `idxNum >= 10` arm) now
runs first, synchronously; then, for a committed read, the main-tree view AND
the index-tree view (when the plan drives one) are built in one synchronous
block — no `await` between them, so no commit can land between the two
pins. `executeIndexScan` now RECEIVES its index read view instead of building
its own; a new sync helper `resolveIndexTree` does the schema/tree lookup.
The live path is behaviorally unchanged (same `update()` calls, same order,
same dispatch).

**No connection-registry mutation on the committed path**:
- `runQuery` calls `ensureConnectionRegistered()` only for live reads.
- `OptimysticModule.connect` with `_readCommitted: true` resolves + initializes
  the table but passes `registerConnection: false` to `resolveConnectedTable`.
- `OptimysticCommittedTable` overrides `createConnection()` (throws
  `QuereusError`/`MISUSE`) and `getConnection()` (returns `undefined`);
  `disconnect()` comment now states it is a no-op BECAUSE nothing was
  registered. (Verified upstream: the only engine caller of
  `createConnection`, `getVTableConnection`, currently has no callers and
  itself throws on committed reads — so the throwing override cannot be hit by
  the engine's normal paths.)

**Degraded latch** (`txn-bridge.ts`): `degradedReason` is set from the error
message when `commitTransaction` surfaces `PartialCommitError` (legacy) or
`CoordinatorPartialCommitError` (session mode), and cleared at the end of a
successful commit AND a successful rollback (per the implement ticket's spec).
Exposed as `isDegraded()` / `getDegradedReason()`. `runQuery`'s committed arm
throws at first pull while latched, embedding the persisted/unpersisted tree
lists. Live reads are unaffected.

**Declarations** (`OptimysticModule`): `concurrencyMode = 'reentrant-reads'`,
declared after the audit below. `expectedLatencyMs` deliberately NOT declared:
the module fronts transactors from in-memory (µs) to libp2p cohorts (100s of
ms) and the hint is static per module — any one number misestimates most
deployments; rationale is in the code comment. `readCommittedSnapshot` NOT
declared (belongs to ticket 3).

**Docs**: `docs/transactions.md` gained § "One writer at a time on the shared
TransactionBridge" (shared-vs-single-writer state table, why it can't be
enforced in-bridge, what breaks with two writers) and § "Committed reads
refuse a degraded (partially-committed) store". Matching `NOTE:` at
`TransactionBridge.currentTransaction`.

## Concurrency audit (behind the `reentrant-reads` declaration)

Per-scan state is all generator-local; committed scans use per-scan pinned
views; a live scan's `collection.update()` serializes behind db-core's
per-collection latch (`Latches.acquire` in `Collection.update`), and mid-scan
tree mutation was already tolerated via the path-invalidation retry (external
replicated commits impose the same interleaving with or without concurrent
reads). **Decision to review**: the one shared field a failing scan writes is
`setErrorMessage(...)` on the table instance — kept shared (diagnostics only,
last writer wins) rather than made per-scan. Writes still serialize under this
mode, so the bridge's single-writer state is not exposed by the declaration.

## Validation

`yarn build` at root, then full plugin suite: **345 passing, 11 pending, 0
failing** + smoke. New spec `test/committed-read-isolation.spec.ts` covers:

- committed connect/scan/disconnect leave `getConnectionsForTable` unchanged;
  `createConnection` throws; `getConnection` undefined;
- first-EVER touch of a table as a committed read (fresh hydrated Database,
  empty module table cache): works, registers nothing; a subsequent live read
  registers — the contrast pins which path skipped registration;
- hand-driven (module `connect` + `query` with hand-built `FilterInfo`)
  index-driven scan vs full scan, interleaved row-by-row, with a mid-scan
  external commit (insert + delete) from a second Database over shared
  storage, a staged in-flight row on the writer, and an interleaved live read
  to run `collection.update()`: both scans return exactly the committed
  snapshot and agree row-for-row (also serves as the two-concurrent-scans /
  shared-state probe);
- composite-PK point lookup (`plan=2`) and range (`plan=3`) on the committed
  view: staged row invisible, committed rows returned;
- degraded latch end-to-end (legacy mode, injected second-tree commit failure
  over `FileRawStorage`, mirroring `legacy-commit-atomicity.spec.ts`):
  committed read throws naming `Persisted`/`Not persisted`, live read still
  answers, a later clean COMMIT clears the latch; separate test: a clean
  ROLLBACK also clears it;
- module declarations: `getModuleConcurrencyMode` = `reentrant-reads`,
  `getModuleReadCommittedSnapshot` = `false` (ticket 3 flips that assertion
  together with its proof).

Existing regressions intact: `committed-read.spec.ts` (committed read under an
open writer txn) and `committed-read-interleave.spec.ts` (pinning under
cache-clearing, staged AND clean arms) both pass unchanged.

## Known gaps / honest notes for the reviewer

- **The "commit lands between the two view builds" window is proven closed by
  structure, not by injection**: there is no await to interleave on anymore, so
  the direct race cannot be scripted without artificial seams. The tests
  instead pin mid-scan-commit agreement. If you want a stronger guarantee,
  review the sync block in `runQuery` by eye — that block is the fix.
- **Session-mode degraded arm is code-shared but not e2e-tested**: the latch is
  set on `CoordinatorPartialCommitError` in the same catch structure as the
  legacy arm, but only the legacy arm is driven end-to-end (staging a genuine
  session-mode partial commit needs the stall harness ticket 3 builds).
- **Legacy `idxNum >= 10` index-scan arm** was restructured (condition hoisted
  into `scanIndexName` selection). No current planner emits it (modern plans
  carry `idx=<name>;plan=N`), so it has no test coverage — worth an eyeball
  that the hoisted condition mirrors the old dispatch order.
- **Vtab-level rows are positional** (`SqlValue[]`); the new spec documents
  this. If a reviewer expects named-column rows from hand-driven `query()`,
  that's `db.eval`'s mapping, not the vtab's.
- **Found while testing, filed separately**: with an open local transaction
  holding staged rows, an external writer's commit can become permanently
  invisible to the local node's live reads — even after rollback. Not caused
  by (or touched by) this ticket's changes; verified by hand and filed as
  `fix/bug-external-commit-invisible-after-staged-txn`. The new spec
  deliberately does not assert the live in-transaction count for this reason.
- **One earlier full-suite run showed 6 timeout failures in unrelated specs**
  (`savepoint-rollback`, `update-pk-move-uniqueness`, `read-pull-mechanism`)
  under machine load (9-minute run); all pass in isolation and in the final
  2-minute full run. Treated as load flakiness, not filed.
