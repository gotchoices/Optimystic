description: In session/consensus mode, `TransactionBridge.beginTransaction` awaits the host-supplied schema-hash provider, and `QuereusEngine.getSchemaHash()` lazily computes it by running `select … from schema()` against the SAME Database. Because begin runs inside a statement's implicit BEGIN, that nested query deadlocks. A host must supply a non-re-entrant provider (keep the engine's hash cache warm out of band); the engine should make that the easy/default path rather than a lazy in-begin query.
files: ../optimystic/packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts
----

# Session-mode schema-hash provider must not re-enter the Database during begin

## Symptom

Wiring session mode as a host naturally would —

```ts
plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
```

— deadlocks (hangs) on the first transaction after any schema change. `beginTransaction` awaits `schemaHashProvider()`; with a cold cache `QuereusEngine.getSchemaHash()` runs `for await (… of db.eval("select type,name,sql from schema() …"))` against the same `db` while that db is mid-`exec` opening the implicit transaction — a re-entrant query that never resolves.

## Current mitigation (host-side)

`QuereusEngine` already caches the hash and invalidates it via `db.onSchemaChange`. Pre-warming the cache AFTER DDL and BEFORE any DML makes the provider return the cached value without re-entering the db. `session-mode-commit.spec.ts`'s `enableSessionMode` helper does exactly this (`await engine.getSchemaHash()` once after the table/indexes exist) and documents it. But this is an implicit, easy-to-miss host contract.

## Expected behaviour

A host wiring session mode cannot accidentally deadlock begin. Options to weigh in plan/fix:

- Have `QuereusEngine` eagerly (re)compute the hash in its `onSchemaChange` handler when the db is idle, so the cache is always warm and the provider never needs an in-begin query; mark dirty + recompute lazily only when safe.
- Or have `beginTransaction` not block on a freshly-computed hash (use the last-known hash, recompute off the begin path).
- At minimum, document the "provider must be non-re-entrant / keep the hash warm out of band" contract prominently on `configureTransactionMode` and `getSchemaHash`.

## Scope note

Surfaced while adding real-DML session-mode tests. Orthogonal to the commit/rollback composition fix (the disjoint-collections wiring); filed separately so the composition fix stayed focused. Not currently reachable in production because no shipped code calls `configureTransactionMode` (the session path is dormant), but it is a live landmine the moment a host wires it.
