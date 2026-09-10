----
description: When two writers insert a row with the same primary key at the same moment, both are told they succeeded and only one row survives. Make the losing insert fail with the ordinary duplicate-key error so applications find out and can retry.
files: packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/collection.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transaction/session.ts
difficulty: hard
----

# Refuse a concurrent insert whose key a rival writer already committed

## Reproduced on current `main` (commit `5ecbd060`, 2026-09-10)

The fix-stage repro used the cheap one-node-two-handles shape from the Sereus record (its experiment 2): two `Database` handles over one `FileRawStorage` directory and one `tree://` URI, both running `insert into T (id, v) values (1, …)` in the same tick via `Promise.allSettled`.

- Same key: **both promises fulfilled**, exactly one row survived on both handles' views, and the survivor was the *second* (losing-then-retrying) writer's row — `RESULTS: [fulfilled, fulfilled]`, `COUNT: 1`, `SURVIVOR: from-B` on both handles.
- Different keys (discriminator, Sereus experiment 3): both rows survived, count 2 on both handles.

So neither the fork guard nor the pend-refusal fix closed this. The full scratch spec is reproduced at the bottom of this ticket; recreate it as the regression spec (with assertions inverted to demand the refusal) rather than re-deriving it.

## Root cause — where the uniqueness decision is lost

The SQL layer enforces PK uniqueness only by a **pre-stage probe**: the vtab's insert arm does `collection.get(insertKey)` against its own snapshot and returns a structured constraint result on a hit ("Staging is an upsert, so a pre-stage get() is the only thing that notices a duplicate key" — the insert case in `handleUpdate`, `packages/quereus-plugin-optimystic/src/optimystic-module.ts`). Under concurrency both writers' probes pass, because neither snapshot holds the other's row.

The staged mutation itself is a `TreeReplaceAction` (`packages/db-core/src/collections/tree/struct.ts`) — a bare `[key, entry?]` list with **upsert** semantics and no memory that the SQL statement was an INSERT expecting absence.

When the two commits meet, the loser's commit attempt returns a stale failure, and `Collection.syncAttempts` (`packages/db-core/src/collection/collection.ts`) refreshes via `updateInternal`: the rival's log entry conflicts at the block level (both touched the same leaf, plus header/log tail), so `replayActions` re-runs the pending action's handler against the adopted revision. `Tree`'s `replace` handler (`buildInit` in `packages/db-core/src/collections/tree/tree.ts`) calls `actionTree.upsert(entry)` — which **overwrites the winner's row** — and the retry then commits cleanly. Both writers fulfil; the loser's replay silently displaced the winner. (This matches the observed survivor: the second writer's row.)

Tree supplies no `filterConflict` hook, so `filterAgainstEntry` keeps the pending action verbatim. The same replay runs on the coordinator path: `TransactionCoordinator.commit`'s inter-attempt blanket `update()` goes through the same `updateInternal`/`replayActions`, so the session-mode (two-real-nodes) shape loses the decision at the same seam.

**The replay is a reliable choke point**: any concurrent commit on the same collection touches the header and log tail, so the loser always gets a stale failure and always replays through the action handlers before it can commit. That is where the uniqueness decision must be re-made.

## Fix design — guard-carrying tree actions

Give the tree action entry a serializable **guard** stating the intent the SQL layer currently discards, and enforce it inside the `replace` handler every time the handler runs — at initial staging AND at every conflict replay, so the check is always made against the newest adopted committed state.

### db-core

Extend the entry tuple in `TreeReplaceAction` with an optional third slot:

```ts
export type TreeEntryGuard<TKey> =
	| { kind: 'absent' }                              // INSERT: key must not exist; violation throws
	| { kind: 'keepExisting' }                        // INSERT OR IGNORE: if key exists, skip this entry silently
	| { kind: 'absentRange', range: KeyRange<TKey> }; // reserved for secondary-unique (next ticket): no OTHER entry in range

export type TreeReplaceAction<TKey, TEntry> = [key: TKey, entry?: TEntry, guard?: TreeEntryGuard<TKey>][];
```

- A missing guard keeps today's upsert semantics, so existing callers and previously committed log entries deserialize and replay unchanged.
- In the `replace` handler, before `upsert`: `find(key)`; on `path.on` with guard `absent`, throw a new structured error — suggest `TreeKeyTakenError` in `packages/db-core/src/collections/tree/struct.ts` carrying `collectionId` and the offending `key`. With `keepExisting`, skip the entry. The handler runs inside `internalTransact`'s `Atomic` wrapper, so a throw discards the whole action's staged writes.
- The throw propagates: `replayActions` → `updateInternal` → out of `syncAttempts` (it is not a `StaleFailure` return, so the retry loop does not absorb it) → out of `sync()`/`updateAndSync()`; on the coordinator path, out of the inter-attempt `update()` → the commit attempt fails → session rollback. Verify both exits with tests; do not let any catch site downgrade it to a retryable condition.
- `absentRange` is DEFINED here but wired up only by the follow-up secondary-unique ticket (`prereq` chains it); implementing the handler arm now (range scan, excluding the action's own key) is fine if convenient, but its vtab wiring is out of scope for this ticket.

### quereus-plugin-optimystic

Set guards where the vtab lowers DML into `collection.stage(...)` / index staging in `optimystic-module.ts`, keyed off the ALREADY-resolved conflict action (`resolveConflictAction`):

- Plain INSERT (resolved ABORT / FAIL / ROLLBACK): guard `absent` on the main-tree entry.
- INSERT OR IGNORE that probed clear: guard `keepExisting`. NOTE the index-entry anomaly this leaves (below).
- INSERT OR REPLACE: no guard (overwrite is the declared semantics).
- UPDATE that moves the PK (default conflict handling): guard `absent` on the insert-half entry at `newKey`; a REPLACE-resolved displacing move stays unguarded.
- ON CONFLICT (pk) DO UPDATE whose probe found no row: stage as guarded insert. Under concurrency this REFUSES rather than performing the upsert the sequential path would have — safe (never silent), and the application-level retry re-runs the statement, which then takes the update arm. Document this in the vtab comment; do not try to re-run SQL semantics inside the replay.

Map the structured error to the SQL error shape clients already classify. The loser must see the exact message `uniqueConstraintMessage()` renders — `UNIQUE constraint failed: <table>.<col>[, …]` — because Sereus classifies by message: `control-database.ts` matches `/UNIQUE constraint failed: Strand\.Id\b/i`, and `control-write-retry.ts` treats any `UNIQUE constraint failed:` / `CHECK constraint failed:` message as a permanent refusal (zero retries), distinct from its transport-failure matchers. Reusing the existing message shape means no new arm is needed downstream, and the refusal is automatically distinguishable from a transport failure. Concretely:

- Catch `TreeKeyTakenError` at the commit boundaries in `txn-bridge.ts` (`commitTransaction`, both modes) — the bridge knows which tree/table the collection id belongs to — and rethrow as an error whose message is `uniqueConstraintMessage()` for that table's PK columns (keep the structured error as `cause`).
- Legacy mode: the throw comes out of `tree.sync()` inside `commitDirtyTreesLegacy`. First-tree failure rolls back cleanly today; a mid-sweep refusal becomes a `PartialCommitError` — acceptable for now (that atomicity gap is `feat-optimystic-legacy-commit-two-phase`'s scope), but the refusal must remain visible as the cause.
- Session mode: verify the error survives `TransactionCoordinator.commit` → `TransactionSession.commit` → the bridge. Today the bridge does `throw new Error(result.error || …)` off a `{ success, error }` result — make sure the coordinator/session surface the refusal (message and ideally the structured cause) rather than flattening it into a generic commit failure. Adjust `session.ts`/`coordinator.ts` result plumbing if needed.

## Edge cases — decided dispositions

- **More than two writers on one key**: each loser replays independently and each replay re-checks against adopted state — exactly one wins, every other writer gets the refusal. Test with three.
- **Writer several revisions behind** proposing an already-committed key: its refresh may lag for a round, in which case the replay guard passes, the re-transact fails stale again, and a later refresh adopts the committed row and refuses. Eventual refusal is bounded by the existing retry/stall budget. Test by pre-committing the key, then writing through a stale handle.
- **Delete then re-insert** by different writers: the guard checks the adopted committed state at replay time, so a key whose row the winner deleted reads absent and the re-insert proceeds. Test it — a legitimate re-use must not be refused.
- **Fork guard** (`storage-repo.ts`): a refused writer never commits — its sync aborts and the transaction rolls back — so nothing registers as divergence. Add an assertion (e.g. no `collection:lineage-divergence` line, or fork-guard state inspection) to the concurrent test.
- **Pend-refusal channel** (`coordinator-repo.ts`): the refusal in this design originates locally, in the loser's own replay, not from a remote answer — so it cannot be lost on a transport exit. No change needed there; keep the error type disjoint from transport failures.
- **Multi-collection transactions** (session mode): a refusal thrown from any collection's replay during the coordinator's inter-attempt refresh fails the whole commit attempt; verify the coordinator's existing failure handling cancels the other collections' pends and the transaction reports failure atomically. Test with a two-table transaction where one table's insert collides.
- **INSERT OR IGNORE under concurrency**: `keepExisting` skips the main-tree entry at replay, but the INDEX tree actions for the skipped row replay independently and cannot see the skip — a stale index entry (indexKey‖pk pointing at values the surviving row does not have) can result. Do not solve cross-collection coordination here: file this instance as an arm on `6-debt-index-sweep-misses-update-delete-and-orphans` (it already owns index-orphan detection) and leave a `NOTE:` at the IGNORE staging site.
- **Mixed versions**: an old-version peer replaying a guarded action destructures `[key, entry]` and ignores the guard — it reverts to today's silent overwrite. Note this in the guard type's doc comment and reference `debt-mixed-version-identify-incompatibility`; no gating mechanism exists yet.
- **Validator path**: validating peers re-executing statements (`packages/db-core/src/transaction/validator.ts`) would catch this class server-side, but no deployment wires a validator (`feat-no-deployment-validates-transactions-at-pend`). This guard is the client-side fix and stands on its own; the two are complementary, not alternatives.

## Sereus follow-up (for the reviewer's awareness, not this repo's work)

`../sereus/tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md` unblocks on this landing: rebuild `../optimystic`, re-run its measurement. Because the refusal reuses the existing `UNIQUE constraint failed:` message shape, no new classification arm should be needed in `cadre-core` — verify rather than assume.

## TODO

- [ ] Add `TreeEntryGuard` + third tuple slot to `TreeReplaceAction`; enforce `absent`/`keepExisting` in the `replace` handler; add `TreeKeyTakenError`.
- [ ] db-core tests: raw two-`Tree`-instances race over `TestTransactor` (sync path) and a `CompetingWriterTransactor`-driven coordinator retry (session path — reuse the harness in `packages/db-core/test/transaction.spec.ts`); loser throws, winner's row survives; delete-then-reinsert allowed; three-writer case.
- [ ] Vtab: set guards per resolved conflict action (insert, IGNORE, REPLACE, PK-move update, DO-UPDATE-probe-miss); leave the `NOTE:` at the IGNORE site and append the index-anomaly arm to `6-debt-index-sweep-misses-update-delete-and-orphans`.
- [ ] Bridge/session: map `TreeKeyTakenError` to `uniqueConstraintMessage()` at both commit modes; ensure session/coordinator plumbing preserves the message and cause.
- [ ] Plugin regression spec from the repro below, assertions inverted: same key → exactly one fulfilled, one rejected with `UNIQUE constraint failed: T.id`, one row (the winner's) on both handles; different keys → both fulfil, two rows. Add three-writer and delete-reinsert SQL-level cases.
- [ ] Multi-collection session-mode test: one colliding insert fails the whole transaction.
- [ ] Keep `insert-pk-uniqueness.spec.ts` (sequential suite) green; run `yarn test` in db-core and quereus-plugin-optimystic, plus `yarn typecheck` after build.

## Appendix — fix-stage scratch repro (verified failing-shape on `5ecbd060`)

```ts
// two handles, one FileRawStorage dir, legacy/local transactor
function createDb(dir: string) {
	const db = new Database();
	const config = {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => new FileRawStorage(dir),
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	return { db, plugin };
}

// same tick, same PK — measured: both fulfilled, COUNT 1, survivor 'from-B' (the retrying loser)
const a = createDb(dir), b = createDb(dir);
await a.db.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
await b.db.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
const results = await Promise.allSettled([
	a.db.exec(`insert into T (id, v) values (1, 'from-A')`),
	b.db.exec(`insert into T (id, v) values (1, 'from-B')`),
]);
// post-fix expectation: exactly one fulfilled; the rejection's message matches
// /UNIQUE constraint failed: T\.id/; count(*) = 1 on BOTH handles; survivor is the winner's row.
// Discriminator (different keys 1 and 2): both fulfil, count(*) = 2 on both handles — unchanged.
// Dispose: db.close() + await plugin.dispose() on both, else the shared per-dir read cache leaks.
```
