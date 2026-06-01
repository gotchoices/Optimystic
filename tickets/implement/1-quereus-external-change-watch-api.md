----
description: Add a Quereus Database API to fire watchers for a table on an externally-originated (out-of-band) change, so a vtab can translate a remote storage commit into a watch invalidation
files: ../quereus/packages/quereus/src/core/database.ts, ../quereus/packages/quereus/src/core/database-watchers.ts, ../quereus/packages/quereus/src/runtime/delta-executor.ts, ../quereus/packages/quereus/src/index.ts
----

# Quereus: external/remote change → watch invalidation API

> **Cross-repo notice.** This ticket modifies the **sibling Quereus repo**, not
> optimystic. Quereus is consumed by the plugin via the portal resolution
> `@quereus/quereus: portal:../quereus/packages/quereus` (root `package.json`
> `resolutions`), checked out at `C:\projects\quereus`. The change is additive and
> backward-compatible. After implementing, build Quereus so the portal-linked
> package the optimystic plugin imports picks it up. Coordinate a Quereus version
> bump per that repo's own conventions; the dependent plugin ticket
> (`optimystic-vtab-reactive-watch-bridge`) consumes this API.

## Problem

Quereus watchers (`Database.watch`, `packages/quereus/src/core/database.ts:1716`)
fire **only** from the post-commit path
(`runPostCommitWatchers` → `WatcherManager.runPostCommit`,
`core/database-watchers.ts:156-169`), which is driven entirely by the local
transaction's change log (`DeltaExecutor.runAll` reads
`ctx.getChangedBaseTables()` / `getChangedTuples()`,
`runtime/delta-executor.ts:150-167`). That change log is populated only by DML
executed through this `Database`'s `TransactionManager`
(`core/database-transaction.ts:575` etc.).

A row committed to an optimystic-backed table by a **remote peer** never touches
this `Database`'s change log, so its watchers never fire. There is currently **no**
public API to inject an externally-originated change (confirmed: the only
`notifyChange` calls in Quereus are schema-change events via
`schema/change-events.ts`, unrelated). The optimystic vtab needs one.

## Design

Add a coarse, table-granular invalidation that fires every active watcher whose
scope includes a given base table, treating the table as **globally changed** (no
per-row tuple deltas are available from the storage layer — see "Why coarse").

### Public API on `Database`

```ts
/**
 * Fire all active watchers whose scope includes `schema.table`, as if the
 * whole table changed, WITHOUT a local commit. For hosts whose tables are
 * backed by an external/replicated store (e.g. the optimystic vtab) that learns
 * of remote writes out-of-band. Coarse by design: handlers receive a global
 * (whole-table) WatchEvent — `full` watches fire with empty `hits`; `rows`
 * watches surface all their registered literal values as possibly-changed.
 * Idempotent w.r.t. no matching subscriptions (no-op). Async to mirror
 * runPostCommitWatchers (handlers may be async).
 */
notifyExternalChange(tableName: string, schemaName?: string): Promise<void>;
```

`schemaName` defaults to the current schema (`schemaManager.getCurrentSchemaName()`).
Lowercase + join to the `schema.table` key used everywhere
(`core/database-watchers.ts:89,111`).

### `WatcherManager.notifyExternalTableChange(fqName)`

Implement in `core/database-watchers.ts`. The manager already tracks
`ActiveSubscription { id, tables, ... }` (`database-watchers.ts:48-58`) and matches
on the lowercased `schema.table` set (`invalidateForTable`,
`database-watchers.ts:193-202`). Reuse that matching, but instead of disposing,
**fire** the matching subscriptions globally:

Recommended seam — give `WatcherManager` direct access to each subscription's
`DeltaSubscription` so it can synthesize a global apply, bypassing the change-log
dependency entirely:

1. Capture the `subscription` returned by `subscriptionFromChangeScope`
   (`runtime/delta-executor.ts:350`, already destructured at
   `database-watchers.ts:127`) onto `ActiveSubscription` (add a
   `readonly delta: DeltaSubscription` field).
2. `notifyExternalTableChange(fqName)`:
   - mint a fresh txn id (`this.currentTxnId = this.mintTxnId()`), in a
     try/finally that resets it (mirror `runPostCommit`,
     `database-watchers.ts:156-169`);
   - for each active subscription whose `tables.has(fqName)`, build a
     `DeltaApplyInput` (`runtime/delta-executor.ts:62-68`) where **every** relKey
     in `delta.relationToBase` that maps to `fqName` is in `globalRelations` and
     `perRelationTuples` is empty, then `await delta.apply(input)`.
   - swallow/log per-subscription errors (watchers never throw into the caller —
     same contract as `runPostCommit`).

This reuses the existing `apply` logic in `subscriptionFromChangeScope`
(`runtime/delta-executor.ts:440-508`): for a `full` watch, `isGlobal` ⇒
`observable` (fires, empty hits); for a `rows` watch, `isGlobal` ⇒ surfaces all
`literalValues`; `groups`/`rowsByGroup` behave per their global branches. No new
matching logic needed.

Expose `notifyExternalChange` on `Database` as a thin wrapper (mirror
`runPostCommitWatchers`, `database.ts:1721-1725`) calling
`this.watcherManager.notifyExternalTableChange(fqName)` after `this.checkOpen()`.

### Why coarse (whole-table), not per-row

The optimystic storage notification is keyed by **block id**, and an optimystic
tree block holds many tree entries — it does not decode to SQL primary keys
without materializing and diffing the block, which is expensive and complex.
Whole-table (global) invalidation is **sound**: over-firing only costs an extra
re-query on the consumer; it never misses a change. This mirrors how Quereus
already handles materialized-view sources via `buildSourceUnionScope` —
`{kind:'full'}` per source table (`change-scope.ts:773-786`). A precise
key-scoped variant (`notifyExternalChange(table, changedKeys)`) is a future
refinement; design the signature so an optional 3rd `changedKeys` arg can be added
later without breaking callers, but do NOT implement it now.

## Key tests (Quereus repo test suite)

- Register a `watch` over `select * from t` (full scope) on a (memory-table is
  fine) table `t`; call `db.notifyExternalChange('t')`; assert the handler fired
  once with a `WatchEvent` whose `matched` covers `t` and `txnId` is set.
- A `rows`-scoped watch (`select * from t where id = 'x'`) fires on
  `notifyExternalChange('t')` and surfaces the literal `'x'` in `hits`.
- A watch on a **different** table `u` does NOT fire.
- No active watchers ⇒ `notifyExternalChange` is a no-op (no throw).
- A throwing handler is isolated and does not reject the returned promise.
- Schema name resolution: explicit `notifyExternalChange('t','main')` matches a
  watch registered without qualification.

Follow the Quereus repo's own test command/layout.

## TODO

- [ ] Add `readonly delta: DeltaSubscription` to `ActiveSubscription` and capture
      it in `watch()` (`database-watchers.ts`).
- [ ] Implement `WatcherManager.notifyExternalTableChange(fqName)` (global
      synthetic apply over matching subscriptions; txnId mint/reset; per-sub
      error isolation).
- [ ] Add `Database.notifyExternalChange(tableName, schemaName?)` wrapper; export
      any new public types from `packages/quereus/src/index.ts` if needed.
- [ ] Tests per "Key tests".
- [ ] Build Quereus so the portal-linked package updates; note the version bump
      needed for the plugin ticket to consume.
