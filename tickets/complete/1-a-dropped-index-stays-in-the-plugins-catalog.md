description: Dropping an index on an Optimystic table now removes it from the record on disk as well as from the running database, so the next process no longer brings it back; the same hook is what Quereus 4.20's migration rollback uses to take back a created index, and the plugin's ranges now declare 4.20.
architecture: docs/transactions.md#apply-schema-coalesces-catalog-writes
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`OptimysticVirtualTable.removeIndex`, `reassignUniqueEnforcement`, `populateUniqueTree`; `OptimysticModule.dropIndex`; the `endSchemaBatch` doc comment; NOTEs on `createIndex`, `endSchemaBatch` and `reconcileMaintainedIndexes`)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`withoutIndex`, `SchemaManager.removeIndex`, `removeIndexInBatch`)
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (`removedIndexes`, `excludeIndexAtCommit`, `withoutRemovedIndexes`; checkpoint and restore carry the set)
  - packages/quereus-plugin-optimystic/src/schema/index-manager.ts (`unregisterIndex`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`forgetTree`)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (four rewritten cases, four new ones under `DROP INDEX`, helpers `engineCatalog` / `expectCatalogsAgree` / `catalogManagerOf`)
  - packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json (seven ranges to `^4.20.0`)
  - docs/transactions.md, section "APPLY SCHEMA coalesces catalog writes" (buffer-not-transaction paragraph rewritten for 4.20; "DROP INDEX subtracts by name" paragraph; end-commit-failure paragraph amended, including a DROP INDEX lost with the commit)
  - packages/quereus-plugin-optimystic/README.md (the record paragraph and the leftover-tree bullet under Limitations)
  - tickets/backlog/bug-stale-index-entry-causes-false-unique-refusal.md (one arm appended: DROP INDEX then re-create is a fourth producer of leftover entries)
difficulty: hard
repro: verified
----
# A dropped index stays in the plugin's catalog — complete

## What landed

**The hook.** `OptimysticModule.dropIndex` resolves the table the way `createIndex` does and runs `OptimysticVirtualTable.removeIndex` under the statement's batch checkpoint, so an open `APPLY SCHEMA` batch coalesces the write and a throw withdraws it. After the drop succeeds it removes the index's tree from the batch's deferred flush, so a `CREATE INDEX` that Quereus 4.20's undo journal takes back never lands its tree as an unlisted orphan.

**The removal.** The catalog write goes first (a refused write leaves the instance as it was), then the descriptor and tree leave the `IndexManager`, the tree leaves the transaction bridge (dirty set, and the shared registry a session-mode coordinator commits from), and the index plus its derived UNIQUE constraint leave the instance's own `tableSchema`. Names match case-insensitively throughout. Last, a UNIQUE constraint the dropped index was enforcing gets a synthesized `_uniq_` tree, rebuilt from the table (added in review, below).

**The catalog write that shrinks.** `SchemaManager.removeIndex` reads the latest live record and writes it back with the index moved from `indexes` to `orphanedIndexes`, never through the write-time union of `storeStoredSchema`. Inside a batch the subtracted record is staged and the index is named to the batch, so the commit-time re-merge against the latest committed record strips it from the committed side before the union. The exclusion set is snapshotted and restored with the batch's pending writes.

**Ranges, docs, README** as the implement handoff described: `@quereus/quereus` is `^4.20.0` in all four manifests; `docs/transactions.md` explains commit-on-error against the undo journal and why DROP INDEX subtracts by name; the README says what a drop leaves in storage and what a re-create over it means.

## Review findings

### What was checked

The implement diff was read first, file by file, before the handoff. Beyond the diff: the Quereus 4.20 caller (`dropIndex` in `@quereus/quereus/src/schema/manager.ts` passes the stored casing, calls the hook before removing the index from its own catalog, and short-circuits `IF EXISTS` on a missing index before reaching the hook); how session mode shares the bridge's collection registry with the coordinator by reference, so `forgetTree` reaches it; the coordinator's rollback, which restores from its own snapshot map and is unaffected by a collection leaving the registry; `storedToUniqueConstraints`, which gives a hydrated table's derived constraints their `derivedFromIndex`, so the drop's filter takes a UNIQUE index's constraint with it on both the live and the hydrate path; drop-then-re-create of one index inside one batch (the exclusion strips only the committed copy, and the pending record carries the re-created index through the union); the checkpoint restore of the exclusion set; the end-of-batch failure path for a table whose index was dropped in the batch; every failure-shape test's assertions against what the code does.

Run, all green: the plugin suite (1001 passing, 13 pending, smoke on quereus@4.20.0), `tsc --noEmit` in the plugin, `yarn lint`, `yarn lint:docs`. Not rerun: the whole-repo `yarn test`, `yarn test:integration`, `yarn build` and `yarn check:rn`, and the plugin's env-gated integration specs, none of whose inputs this review changed (the implement handoff ran the plugin's integration specs, `yarn lint:deps`, `yarn test:harness` and `yarn check:rn` at the implement commit).

### Found and fixed in this pass

- **A real defect, reproduced before the fix (minor by scope, fixed at the site).** `buildUniqueEnforcementIndexes` synthesizes no `_uniq_` tree for a UNIQUE constraint a declared index covers at initialization, and `resolveEnforcingIndex` prefers the declared index. Dropping that index left the constraint with no enforcing tree in the live instance (probe falling back to a full scan, staged entries carrying no concurrency guard) until it re-initialized, and a fresh Database over the subtracted record synthesized the tree and trusted it non-empty, while it had stopped being maintained the moment the index took over. Sequence: `email text unique`, rows, `create index on (email)`, restart, more rows, `drop index`, then a fresh Database admitted a duplicate of a post-restart row. `OptimysticVirtualTable.removeIndex` now ends in `reassignUniqueEnforcement`: the synthesized descriptors are recomputed against the manager's declared indexes, the missing ones are opened, registered with the bridge and rebuilt from the table (the populate loop extracted from `ensureUniquePopulated` into `populateUniqueTree`), and a tree is recorded on the instance only once its rebuild landed, so a retried drop redoes exactly what a failed attempt did not. The new spec case in `schema-batch.spec.ts` ("dropping the declared index that enforced an explicit UNIQUE constraint…") failed at the fresh-Database duplicate on the implement commit and passes now.
- `withoutIndex` had been inserted between the doc comment of `mergePersistedSchemas` and that function, orphaning it. Moved above it.
- `removeIndex` returned the withdrawn tree, which its only caller discarded. Now `void`.
- `docs/transactions.md`, end-commit failure: a `DROP INDEX` inside a batch whose one commit fails is lost the same way a gravestone is, and the next touch's re-persist puts the index back under the instance's maintenance while the engine no longer lists it. One sentence added; the code was left as is, since it is the batch's documented failure direction.
- The NOTE on `reconcileMaintainedIndexes` said a sibling's drop is harmless until this instance re-initializes; that is no longer true when the dropped index was enforcing a UNIQUE constraint, whose synthesized tree misses this instance's rows meanwhile. Widened, naming the existing stale-sibling producer in `bug-stale-index-entry-causes-false-unique-refusal`.

### Tests

The seven implement cases were kept: each pins a contract (both catalogs after every failure shape, the commit budget, no orphan tree, the record's `orphanedIndexes`, adoption on re-create), none restates the implementation or verifies a mock. One case was added for the defect above; it asserts through behaviour (refused duplicates on the live and on a fresh Database, one of them a row written while the tree was unmaintained and one written after the drop) rather than through the tree's name.

### Tickets filed

None. The one defect found was closed at its site, so no site-claim search was needed.

### Tripwires

- Amended: the NOTE on `reconcileMaintainedIndexes` (sibling drop of an enforcing index; the name-keyed union it suggests is still the remedy).
- Standing from the implement pass: the NOTE on `removeIndex` (the tree stays in storage; entries for rows deleted between a drop and a re-create survive, owned by the arm on `bug-stale-index-entry-causes-false-unique-refusal`) and the NOTE on `excludeIndexAtCommit` (a sibling's drop-then-re-create during the batch is stripped at commit).

### Considered and declined

- Deferring the rebuilt `_uniq_` tree's flush to the end of a batch, the way `createIndex` defers a populated index tree. A synthesized tree is never listed in the catalog, so an eager flush is harmless under every batch outcome, and deferring it would teach the withheld-index bookkeeping about `_uniq_` names for nothing.
- The O(rows) rebuild on a `DROP INDEX`. It is paid only when a constraint actually loses its backing tree, is the same cost the `CREATE INDEX` that took over enforcement paid, and is what makes the tree current for every process that opens it afterwards; a first-probe backfill cannot tell a stale non-empty tree from a current one.
- Making `removeIndex` refuse a drop that would leave a constraint without a declared tree. A user may drop such an index; a fresh Database synthesizes the tree anyway, so the live instance should too.

### Residuals the implement handoff named, unchanged

The description of an unwound index always moves to `orphanedIndexes`; a drop by a sibling narrows the record while this manager keeps maintaining the tree until it re-initializes; a DROP INDEX inside an open user transaction commits its catalog write immediately, as CREATE INDEX does, and abandons DML already staged into the dropped tree; no test drops a UNIQUE index or a case-divergent name (straight-line code, and Quereus hands the stored casing); the session-mode shape of the unwound case was probed by hand at implement time, not committed as a test.
