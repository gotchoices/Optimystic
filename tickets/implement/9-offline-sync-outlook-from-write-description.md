description: Make the offline "will this change go through?" prediction recognize a generated id — one from StampId() or a wide random source — as something no other machine can collide with, using the description of each write that Quereus now hands the table.
architecture: docs/offline-sync.md#judging-each-guard
files: packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/write-description.ts (new), packages/quereus-plugin-optimystic/src/optimystic-adapter/commit-outlook.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-mode.ts, packages/quereus-plugin-optimystic/test/offline-outlook.spec.ts, packages/quereus-plugin-optimystic/test/write-description.spec.ts (new), packages/quereus-plugin-optimystic/README.md, docs/offline-sync.md, docs/internals.md
difficulty: hard
----

First of three tickets for stage 9 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages). This one builds the plumbing that carries facts from the write description Quereus hands the virtual table into the outlook judgement, and uses it for one thing: fresh-value detection from provenance. `offline-sync-outlook-unchecked-decisions` adds the `unchecked` decisions and the dependencies they create on the same plumbing; `offline-sync-outlook-facts-survive-a-restart` journals the facts so a restored transaction is judged with them.

## What Quereus shipped (4.21.0), and what it means for the design

Read `../quereus/docs/write-scope.md` (sibling checkout; the contract is `@quereus/quereus/src/planner/analysis/write-scope.ts`, the provenance classifier `@quereus/quereus/src/planner/analysis/value-provenance.ts`). The parts this ticket uses:

- A virtual table that sets `wantWriteScope = true` gets `UpdateArgs.writeScope`, a `TableWrite`, on every `update()` call of the statement's own write: the same object for every row of one execution, parameters already bound. It is **absent** on the engine's FK cascade child writes. The upsert `DO UPDATE` arm receives the INSERT's object.
- `TableWrite.columns` lists each written column with a `ValueProvenance`: `literal`, `input` (parameters and context variables), `fresh` (a call to a function flagged `FunctionFlags.FRESH`, or `randomblob(n)` with literal `n ≥ 16`, or an injective wrapper over exactly one such call: `hex`, `lower`, `upper`, `cast`, `||` against a literal; only `hex` keeps a blob fresh), `volatile`, `self`, `other`. INSERT lists every table column in schema order; UPDATE lists the assigned columns; DELETE lists none.
- A function says it is fresh by carrying `FunctionFlags.FRESH` (`fresh: true` in `createScalarFunction`'s options; in a raw function schema, the flag bit). No builtin carries it.

Where [§What the analysis needs from Quereus](../../docs/offline-sync.md#what-the-analysis-needs-from-quereus) assumed something else, the doc is rewritten in this ticket to describe what shipped (see the doc list below). The differences that matter for the judgement:

- "A deterministic function of a fresh value counts as fresh" is narrower in what shipped: only the injective wrappers above keep a value fresh. `substr(StampId(), 1, 8)` is `other`. The plugin trusts the label and does no reasoning of its own.
- `random_bytes(16)` in the doc's test plan is the crypto plugin's `random_bytes(bits, encoding)`, whose first argument is a bit count with a default of 256, so it cannot be flagged fresh (the flag is a promise regardless of arguments). The fresh random source available today is the builtin `randomblob(16)`, as `hex(randomblob(16))` for a text key. The test plan is corrected to that; a dedicated fresh id function for the crypto plugin is parked in backlog `feat-crypto-plugin-offers-a-fresh-id-function`.

## Design

### `StampId()` is a fresh source

Register `StampId` with `flags: FunctionFlags.UTF8 | FunctionFlags.FRESH` (import the value `FunctionFlags` from `@quereus/quereus`, replacing the `1 as FunctionFlags` literal; `CommitOutlook` keeps UTF8 alone). `StampId()` answers the same value for every call inside one transaction, which is narrower than Quereus's "unique per call" wording: what the outlook needs is that no **other** writer can produce the value, and that holds (16 random bytes beside a hash of this peer's id). Two rows inserted under `StampId()` in one transaction collide with each other sequentially, which the pre-stage probe refuses before anything is queued. State this in the plugin README beside the function.

### The table records facts as it stages

`OptimysticVirtualTable` sets `wantWriteScope = true`. A new pure module, `src/optimystic-adapter/write-description.ts`, holds everything that reads a `TableWrite`:

```typescript
/** A staged element whose value came from a fresh source: the primary key of a main-tree entry, the
 *  unique value of a unique-index entry (docs/offline-sync.md §Judging each guard). */
export type WriteFact = { readonly kind: 'fresh'; readonly collectionId: CollectionId; readonly key: string };

/** The fresh elements one row's write stages, from the provenance of the columns the statement wrote. */
export function freshElementsOf(write: TableWrite | undefined, row: {
  readonly mainCollectionId: CollectionId;
  readonly key: string;                       // the framed primary key the row is staged under
  readonly keyColumns: readonly string[];     // primary-key column names
  readonly uniqueEntries: readonly { collectionId: CollectionId; key: string; columns: readonly string[] }[];
}): WriteFact[];
```

Rules of `freshElementsOf`, with column names compared lowercased (Quereus lowercases `WrittenColumn.column`):

- `write` undefined (a cascade write), or `write.operation === 'insert'` reaching an UPDATE arm (the upsert `DO UPDATE` arm): nothing is fresh.
- A column is fresh when its `WrittenColumn.provenance.kind === 'fresh'`. Columns the statement did not write (an UPDATE's unassigned columns) are not fresh.
- The main-tree element at `key` is fresh when **any** primary-key column is fresh — the composite rule of §Judging each guard.
- A unique entry is fresh when any of its constraint's columns is fresh.

The vtab calls it once per `update()` arm, after the arm's last `stage`, and hands the result to the bridge:

- INSERT arm: `key = insertKey`, `uniqueEntries` = one per constraint `guardedUniqueIndexes(values)` names, with `collectionId` from `resolveEnforcingIndex(uc).tree.getCollection().id` and `key = indexEntryKey(indexManager.createIndexKey(descriptor, values), insertKey)` — the same formula `IndexManager.insertIndexEntries` stages under, so the fact and the guarded element share one key by construction. Factor the "guarded unique constraints with their enforcing index" walk out of `guardedUniqueIndexes` so both callers read one list.
- UPDATE arm: `key = newKey` (its `absent` insert half is what a fresh key assures; a same-key update records a main-tree fact only if an assigned primary-key column is fresh, which with `oldKey === newKey` cannot happen, so nothing wrong is recorded); `uniqueEntries` as for INSERT over the post-update `values`, keyed `indexEntryKey(createIndexKey(descriptor, values), newKey)`.
- DELETE arm and the eviction path: nothing to record.

### The bridge keeps the facts with the transaction, savepoint-aware

`TransactionState` (in `src/types.ts`) gains `writeFacts: { records: WriteFact[]; marks: Map<number, number> }`, fresh per transaction. `TransactionBridge`:

- `noteWriteFacts(facts: readonly WriteFact[])` appends to the current transaction's records; a no-op with no active transaction.
- `createSavepoint(depth)` records `marks.set(depth, records.length)` when the depth has no mark, **ahead of** the session-mode early return (session mode records facts too, for `CommitOutlook()`). `rollbackToSavepoint(depth)` truncates `records` to the mark and drops marks above `depth`, ahead of the snapshot check (which returns early in session mode). `releaseSavepoint(depth)` drops marks at and above `depth`. Quereus wraps every non-FAIL DML statement in a statement-level savepoint, so a statement that fails mid-way leaves no fact behind.
- `openWriteFacts(): EntryFacts` folds the current transaction's records (`foldWriteFacts` in write-description.ts); `sealIntoQueue` folds them and passes them to `OfflineMode.enqueue(collections, transactionId, facts)`.

The fold merges by `(collectionId, key)` with OR: a key written twice in one transaction is fresh if either write produced it fresh, since freshness is a property of where the value came from, and a value minted fresh inside this uncommitted transaction cannot be known to another machine however later statements refer to it. A rolled-back statement's fact is gone by the truncation above, so this never credits a key a surviving statement supplied from a parameter.

### The judgement reads the facts

In `commit-outlook.ts`:

```typescript
/** What the write descriptions of a transaction's statements said about its staged elements. `undefined`
 *  where the judgement has none: a transaction restored after a restart, until the facts are journaled. */
export type EntryFacts = {
  /** Per collection, the keys of the elements whose value came from a fresh source. */
  readonly fresh: ReadonlyMap<CollectionId, ReadonlySet<string>>;
};
```

- `JudgedTransaction`, `EarlierEntry` and `FollowedEntry` gain `facts: EntryFacts | undefined`.
- `CollectionJudge`: `absent` is not exposed when `description.freshKey` **or** the facts list the key; `absentRange` is not exposed when `description.freshValue` or the facts list the element's key (the index entry key, which is what `replaceElements` reads as `key`).
- The `unchanged` rule's "inserted by an earlier entry under a fresh key": `WriteIndex` records, per collection, the keys an earlier entry inserted under `absent` **and** the facts of the entry that inserted them, exposing `insertedFresh(collectionId, key, description)` = inserted under `absent` and (the table's key is tagged fresh or that entry's facts list the key). Replace the current `insertedAbsent` check with it. The same-transaction case is already handled by covering and needs no fact.
- `unchecked` stays `'not-computed'` in this ticket; the next ticket computes it.

`OfflineMode` holds `entryFacts: Map<string, EntryFacts>`: set by `enqueue` **before** `queue.enqueue` runs (the `queued` status, and so `judgeQueued`, fires inside it), deleted again when the enqueue rejects, and deleted with the judgement on a terminal status. `queueAhead` and `followedEntry` read it for each earlier entry; `openTransactionOutlook` reads `bridge.openWriteFacts()`. A restored entry has none (next-but-one ticket).

## Edge cases & interactions

- **Savepoint rollback discards facts** — pinned by a test: inside one transaction, `select StampId()` to learn the id, then `savepoint s; insert … values (StampId(), …); rollback to s;`, then insert the same id again as a literal — the entry is exposed on that key, because the rolled-back statement's fresh fact was truncated and the surviving statement supplied the key as a literal. Verified by test (the truncation is silent if wrong).
- **A failed statement leaves no fact** — Quereus's statement-level savepoint; by inspection of the mark/truncate order.
- **Cascade child writes carry no description** — nothing fresh from them; by inspection (`freshElementsOf` with `undefined`).
- **Upsert `DO UPDATE` arm** receives the INSERT's `TableWrite`: treated as undescribed for freshness (nothing fresh), the conservative side; by inspection, and the `operation` guard in `freshElementsOf` is unit-tested.
- **Primary-key move**: the insert half under `newKey` is fresh when an assigned key column is fresh; the delete half's `unchanged` needs nothing. Covered by inspection (SQL rarely assigns a fresh key in UPDATE).
- **REPLACE over an occupied key and secondary-UNIQUE evictions** carry `unchanged` guards; no fact applies; unchanged.
- **Tag or provenance**: `optimystic.fresh` keeps working alone (the stage 7 tests), and provenance works without the tag (new tests).
- **A fresh blob written to a text column** is `other` by Quereus's rule; the plugin trusts the label. A test that keys a text column by `randomblob(16)` without `hex` must be exposed; pin it in the unit spec, since it is the one shape an application is likely to write by mistake.
- **An earlier entry's facts after it settles**: dropped with its judgement. A later entry that depended on it was judged while the facts were held, and its own judgement is frozen (§The outlook), so nothing re-reads them.
- **`CommitOutlook()` inside a statement that also writes** sees the facts recorded by the arms that completed before it, as it sees their staged elements. By inspection.
- **Session mode**: facts are recorded and marks kept so `CommitOutlook()` is right there too; offline mode still refuses session mode. By inspection.
- **Two tables over one URI**: the registry caveat recorded at `sealedWrites` is unchanged; facts are keyed by collection id and inherit it.
- **Cost of `wantWriteScope`**: Quereus analyzes a write site once per plan and binds once per execution; a plan built by `db.exec` of a new string is analyzed each time. Leave a tripwire `NOTE:` at the property: if the analysis ever shows in a profile, gate it on the offline controller having been entered, or on a plugin option.
- **The suite-wide prediction check** (`test/outlook-predictions.ts`) now also catches a wrong `fresh` label end to end: an entry assured by provenance that fails with `constraint` fails the run.

## Tests

`test/write-description.spec.ts` (new, no network: a plain `Database` with the plugin's `StampId` registered, or a memory table where the plugin is not needed): prepare statements and feed `stmt.getWriteScope().writes[0]` to `freshElementsOf` with a hand-built row description — `StampId()` key fresh; `hex(randomblob(16))` key fresh; `randomblob(16)` into a text key not fresh; a parameter key not fresh; a composite key with one fresh column fresh; a unique entry fresh through one of its columns; the upsert arm (`operation: 'insert'` reaching an update) nothing fresh; `undefined` nothing fresh. One `it` per rule.

`test/offline-outlook.spec.ts`: a `Notes2`-style table **without** the fresh tag (`id text primary key`): an insert under `StampId()` is assured, and one under `hex(randomblob(16))` is assured (the doc's test-plan case, corrected); the savepoint case above; an update of a row an earlier entry inserted under `StampId()` (no tag) is assured with that entry in `dependsOn` (the `insertedFresh` rule through facts). Update the `assured` helper only if its shape changes (it does not here).

## Docs

- `docs/offline-sync.md`: rewrite [§What the analysis needs from Quereus](../../docs/offline-sync.md#what-the-analysis-needs-from-quereus) as a description of what shipped — `getWriteScope()`, the `wantWriteScope` hook, provenance kinds, the injective-wrapper rule, the `FRESH` flag, `selfIndependent` (stage 10 reads it), the cascade and upsert-arm gaps — keeping the section anchor (the two plan tickets cite it) and noting the change-scope vocabulary it shares. In [§Judging each guard](../../docs/offline-sync.md#judging-each-guard): the fresh bullets to match (StampId and injective wrappers; `randomblob(16)` and `hex` of it; `random_bytes` not fresh; "any one column"), and a sentence on where the facts come from and the savepoint rule. Stage 8 of the stage list: shipped in Quereus 4.21.0. Test plan: `random_bytes(16)` → `hex(randomblob(16))`, and the stage 9 paragraph listing this ticket's cases.
- `README.md` § Offline mode: drop the "No fresh-value detection" bullet and the "No value counts as fresh unless a tag says so" sentence; say what counts as fresh now and that `StampId()` is registered fresh (and the same-transaction note above).
- `docs/internals.md`: one sentence in the plugin-offline paragraph: the vtab opts into Quereus's write scope and records fresh elements through the bridge.

## TODO

- Register `StampId` with `FunctionFlags.UTF8 | FunctionFlags.FRESH` in `plugin.ts`; keep `adapter-integration.spec.ts`'s registration expectation green.
- Add `write-description.ts` with `WriteFact`, `freshElementsOf`, `foldWriteFacts`; unit spec.
- `TransactionState.writeFacts`; bridge `noteWriteFacts`, `openWriteFacts`, savepoint marks in `createSavepoint`, `rollbackToSavepoint`, `releaseSavepoint`.
- Vtab: `wantWriteScope = true` with the tripwire `NOTE:`; factor the guarded-unique-constraint walk; record facts in the INSERT and UPDATE arms.
- `commit-outlook.ts`: `EntryFacts`; facts on `JudgedTransaction`, `EarlierEntry`, `FollowedEntry`; `absent`/`absentRange` consult facts; `insertedFresh`.
- `OfflineMode`: `entryFacts`, `enqueue(collections, id, facts)`, `queueAhead`, `followedEntry`, `openTransactionOutlook`; clear with the judgement.
- Bridge `sealIntoQueue` passes the folded facts.
- SQL-level tests in `offline-outlook.spec.ts`; docs and README as listed.
- Validate: plugin `yarn build`, `yarn typecheck`, full plugin `yarn test` (foreground), `yarn lint:docs`, eslint over the changed files.
