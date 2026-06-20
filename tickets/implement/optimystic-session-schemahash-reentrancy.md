description: Make session/consensus mode safe to wire up — right now the natural way a host plugs in the schema-hash provider causes the very first transaction after a schema change to hang forever. Fix the engine so begin can never deadlock, and document the contract.
prereq:
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
difficulty: medium
----

# Session-mode schema-hash provider must not re-enter the Database during begin

## Problem (confirmed root cause)

Wiring session mode the obvious way —

```ts
plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
```

— deadlocks on the first transaction after any schema change (or on the very
first transaction if the cache was never warmed).

Mechanism, traced through the installed `@quereus/quereus`:

1. `db.exec('insert …')` (or `db.exec('begin')`) acquires the **exec mutex**.
   Quereus serializes ALL statement execution through this mutex
   (`Database._acquireExecMutex`, `execMutexDepth`). See
   `packages/quereus-plugin-optimystic/node_modules/@quereus/quereus/dist/src/core/database.js`
   lines ~369–408.
2. While the mutex is held, Quereus's transaction manager opens the (implicit or
   explicit) transaction and calls `connection.begin()` →
   `OptimysticVirtualTableConnection.begin()` (`vtab-connection.ts:30`) →
   `TransactionBridge.beginTransaction()` (`txn-bridge.ts:139`).
3. `beginTransaction` does `const schemaHash = await this.schemaHashProvider();`
   (`txn-bridge.ts:154`).
4. With a cold cache, `QuereusEngine.getSchemaHash()` runs
   `for await (… of this.db.eval("select type,name,sql from schema() …"))`
   (`quereus-engine.ts:148`). `db.eval` tries to acquire the **same** exec mutex,
   which the in-flight `exec` still holds and cannot release until `begin`
   returns — circular wait → **hang**.

Quereus anticipates exactly this re-entrancy and exposes a public signal for it:
`Database._isExecuting(): boolean` (typed in
`…/@quereus/quereus/dist/src/core/database.d.ts:144`; returns `execMutexDepth > 0`).
Its doc-comment says a caller that would re-enter the engine from inside a
statement "MUST check this and defer that work … re-entering synchronously
deadlocks on the chained mutex." `getSchemaHash` is that caller and currently
does not check it.

## Current state

- `QuereusEngine` already caches the hash (`schemaHashCache`) and invalidates it
  on `db.onSchemaChange` (`quereus-engine.ts:50`, `invalidateSchemaCache`).
- The only thing that makes session mode work today is the host pre-warming the
  cache out of band: `enableSessionMode` in `session-mode-commit.spec.ts`
  (line ~102) calls `await engine.getSchemaHash()` once, AFTER all DDL and
  OUTSIDE any statement, then wires the provider. This is an implicit,
  easy-to-miss contract — the landmine the ticket is about.
- Not reachable in shipped product yet (no shipped code calls
  `configureTransactionMode`; the session path is dormant), but it fires the
  moment any host wires it.

## Chosen approach

Make the engine the easy/default safe path, with three layers (do all three):

1. **Re-entrancy guard in `getSchemaHash()`** — never run a re-entrant query.
   - If `schemaHashCache` is set → return it (unchanged).
   - Else if `this.db._isExecuting()` is true → we are inside a statement and a
     `db.eval` would deadlock. Return the last successfully-computed hash
     (`lastKnownHash`) if we have one. If we have neither cache nor last-known,
     **throw a clear, actionable error** (fail-fast) instead of hanging — e.g.
     "schema hash not warmed: call `getSchemaHash()` once after DDL and before
     the first transaction (outside any statement), or rely on the auto
     re-warm". A loud throw is strictly better than a silent deadlock.
   - Else (idle) → compute, cache, store as `lastKnownHash`, return.

2. **Eager background re-warm on schema change** — keep `lastKnownHash`/cache
   fresh so step 1's "inside a statement" branch virtually always has a current
   value, and the provider never needs an in-begin query.
   - In the `onSchemaChange` handler: invalidate (as today) AND kick a
     fire-and-forget re-warm that is NOT awaited by the firing exec.
   - The re-warm calls `computeSchemaHash()`, which issues `db.eval`. Because the
     re-warm is not awaited by the mutex-holder, that `eval` simply QUEUES behind
     the current statement and resolves once the DDL exec releases the mutex
     (normal serialization, not a deadlock — the deadlock only happens when the
     mutex-holder awaits the nested query). By the time the next statement's
     `begin` runs, the cache is warm.
   - Guard against overlap / stale writes with the existing `schemaVersion`:
     capture the version before computing and only store the result if the
     version is unchanged when it completes (a later invalidation wins). Swallow
     errors (leave dirty; the next idle `getSchemaHash` recomputes).

3. **Document the contract prominently** on `configureTransactionMode`
   (`txn-bridge.ts:89`) and `getSchemaHash` (`quereus-engine.ts:110`): the
   provider must be non-re-entrant; the engine keeps its hash warm out of band
   and will throw (not hang) if asked for a cold hash mid-statement. Note that
   `_isExecuting` is the Quereus-sanctioned re-entrancy signal.

### Why not the alternatives

- "`beginTransaction` uses last-known and recomputes off the begin path" — moves
  the same logic into the bridge and still needs a warm value at begin; the
  engine is the right owner of its own cache. Keep the bridge dumb.
- "Just document it" — leaves the silent-deadlock landmine. Documentation is
  layer 3 here, not the whole fix.

## Implementation notes

- `Database` is already imported in `quereus-engine.ts`; `_isExecuting()` is on
  the public type, so `this.db._isExecuting()` typechecks with no cast.
- Add a `private lastKnownHash: string | undefined`. `schemaHashCache` stays the
  authoritative "fresh" cache; `lastKnownHash` is the most recent successfully
  computed value, only used as the in-statement fallback.
- The re-warm helper must not throw out of the (synchronous) `onSchemaChange`
  callback — wrap the kick as `void this.rewarm()` with internal try/catch.
- Keep `invalidateSchemaCache()` / `getSchemaVersion()` behaviour intact
  (existing `quereus-engine.spec.ts` asserts version increments and
  recompute-after-invalidate).

## Validation

Build first (tests import from `../dist`): from
`packages/quereus-plugin-optimystic`, `npm run build` then `npm test` — stream
output with `2>&1 | tee /tmp/qpo-test.log`, never silent-redirect (idle-timeout).
Also `npm run typecheck`.

Regression coverage to add (in `session-mode-commit.spec.ts`, or a focused new
spec): wire session mode the NAIVE way (provider `() => engine.getSchemaHash()`)
WITHOUT the manual pre-warm, after creating a table + index, then run a DML
statement and assert it completes (proves no deadlock) and persists correctly.
Guard with the suite's existing `this.timeout(20000)` so a regression surfaces as
a test timeout, not an agent-killing hang. If practical, also assert the
fail-fast throw path: a freshly-constructed engine asked for its hash while a
statement is mid-flight with no prior warm should reject with the actionable
message rather than hang — but do this only if it can be exercised without
risking a real hang (e.g. by checking `getSchemaHash` against a stub/`_isExecuting`
true state); otherwise rely on the no-deadlock DML test and skip the throw
assertion.

Existing `enableSessionMode` pre-warm can stay (it's harmless and still correct),
but its header comment should be updated to note the engine now self-warms and
fails fast rather than deadlocking.

## TODO

- Add `lastKnownHash` field and the `_isExecuting()` re-entrancy guard +
  fail-fast throw to `QuereusEngine.getSchemaHash()`.
- Add the eager background re-warm (`schemaVersion`-guarded, error-swallowing)
  triggered from the `onSchemaChange` handler; keep `invalidateSchemaCache`
  semantics.
- Add prominent non-re-entrancy / self-warm contract docs to `getSchemaHash` and
  `TransactionBridge.configureTransactionMode`.
- Add a regression test that wires the naive (non-pre-warmed) provider and runs
  real DML in session mode without deadlocking, under the suite timeout.
- Update the `enableSessionMode` header comment in `session-mode-commit.spec.ts`
  to reflect the engine now self-warms / fails fast.
- `npm run build`, `npm test`, `npm run typecheck` (streamed) from
  `packages/quereus-plugin-optimystic`; confirm green.
