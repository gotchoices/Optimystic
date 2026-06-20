description: Wiring Optimystic's session/consensus mode used to hang the first transaction forever after a schema change; the engine now fails fast with a clear, actionable error instead of deadlocking, and the contract is documented.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
difficulty: medium
----

# Review: session-mode schema-hash re-entrancy (deadlock → fail-fast)

## What the problem was (confirmed)

In session/consensus mode `TransactionBridge.beginTransaction` `await`s a
`schemaHashProvider`, and `begin` runs INSIDE a statement's exec while the host's
`db.exec(...)` holds Quereus's exec mutex. The natural provider
`() => engine.getSchemaHash()` computed a cold hash by running
`db.eval('select … from schema()')`, which re-acquires that SAME mutex → circular
wait → **permanent hang** on the first transaction after any schema change (or the
first transaction ever, with a never-warmed cache).

Empirically reconfirmed during implementation, with two findings the original
ticket did not capture (both verified by throwaway probe scripts against the
installed `@quereus/quereus`):

- **DDL also calls the provider.** Not just DML — `create table` and
  `create index` open a vtab transaction and call the provider at `begin` too
  (observed `_isExecuting() === true` during both). So "keep the hash warm" must
  hold before *any* statement once session mode is wired, not just before DML.
- **`onSchemaChange` fires while the mutex is held** (it runs inside the
  statement's implicit-commit `flushBatch`, before `releaseMutex`), and `db.eval`
  defers its mutex acquisition one microtask via `wrapAsyncIterator`.

## What was implemented

The fix makes `QuereusEngine.getSchemaHash()` **never re-enter the db**:

1. Warm cache → return it (common path; no db access, no re-entrancy).
2. Cold cache while `db._isExecuting()` (Quereus's sanctioned re-entrancy signal,
   `execMutexDepth > 0`) → **THROW** an actionable error naming the fix. A loud,
   immediate throw replaces the silent deadlock.
3. Cold cache while idle → compute, cache (version-guarded), return.

The cache is invalidated on every schema change (unchanged). Prominent contract
docs were added to `getSchemaHash` and `TransactionBridge.configureTransactionMode`:
the provider must be non-re-entrant, and the host must keep the hash warm OUT OF
BAND (call `getSchemaHash()` once outside any statement after DDL — exactly what
`enableSessionMode` already does).

### Deliberate deviation from the ticket's chosen design (please scrutinise)

The ticket prescribed three layers; **layer 2 (eager background re-warm on schema
change) and the `lastKnownHash` in-`begin` fallback were dropped**, because
implementing them as specified **broke existing tests** and is unsafe. Evidence:

- A background `db.eval` re-warm flips `db._isExecuting()` true at unpredictable
  times. With it in place, `quereus-engine.spec.ts`'s DDL auto-invalidation tests
  ("different hash after schema change", "auto-invalidate cache after DDL",
  "auto-invalidate across multiple DDL operations") FAILED — a direct
  `getSchemaHash()` landing during the background re-warm took the in-statement
  branch and returned the **stale** hash, so `hash2 === hash1`. The
  schema-mismatch **validator** test also threw (its `getSchemaHash` ran while the
  re-warm was mid-flight with nothing warmed). These are real callers, not
  contrived.
- A stale `lastKnownHash` fallback silently signs a transaction with the WRONG
  schema hash after a schema change — downstream validators (which compute fresh)
  reject it, turning a clear "warm me" signal into a confusing late rejection.

Net: `_isExecuting()` is too coarse to tell "a host statement is awaiting me
(deadlock risk)" from "my own re-warm is running (safe)", so any background
recompute derails honest callers. Fail-fast + out-of-band warm keeps the
re-entrancy signal honest and the hash correct. **The PRIMARY ticket goal — "fix
the engine so begin can never deadlock" — is fully met** (begin now returns a
cached hash or throws; it never re-enters the db).

### What is NOT delivered (known gap)

The ticket's aspiration that the *obvious* wiring "just works WITHOUT a manual
pre-warm" is **not** achieved. With this fix, naive wiring (no out-of-band warm)
**throws** on the first statement instead of completing — loudly, with the fix in
the message, but it still requires the host to warm the cache. The
`enableSessionMode` pre-warm is therefore **load-bearing again** (its doc was
updated to say so).

The only way to make truly naive wiring complete without a pre-warm is to compute
the schema hash **without the exec mutex at all** — i.e. read `db.schemaManager`
directly instead of routing through `db.eval` (the `schema()` TVF itself just
iterates `schemaManager._getAllSchemas()` synchronously). That eliminates the
deadlock at the root and removes the need for cache/guard/warm entirely, but:
duplicates ~100 lines of Quereus-internal SQL formatting, leans on
underscore-prefixed internal APIs (`_getAllSchemas`, `_getAllFunctions`) via casts,
and is a larger redesign than even the ticket's chosen approach. **Recommend the
reviewer decide whether to file a follow-up `plan/` ticket for this** if seamless
naive wiring is wanted; it was judged out of scope for this fix.

## Use cases / validation to check

Run from `packages/quereus-plugin-optimystic` (tests import from `../dist`, so
**build first**):

```
npm run build && npm run typecheck && npm test 2>&1 | tee /tmp/qpo-test.log
```

Result on this branch: **typecheck clean; 246 passing, 4 pending, 0 failing**
(full suite ~3m). The previously-failing engine tests pass with the re-warm
removed.

Key tests to focus a review on:

- `test/session-mode-commit.spec.ts` →
  **"naive wiring without an out-of-band warm-up fails fast (no deadlock)"** (NEW).
  Wires `() => engine.getSchemaHash()` with NO pre-warm after creating a table +
  index, then runs DML and asserts it **rejects** with the actionable message
  (`/schema hash is cold|warm the hash out of band/i`) — not a hang, not a silent
  success. Guarded by the suite's `this.timeout(20000)`, so a regression to the
  deadlock surfaces as a **test timeout**, not a pass. The test then warms out of
  band and drives the SAME wiring to a durable 2-row commit (proves the throw is a
  missing-warm-up signal, not a dead path).
- The five existing session-mode commit/rollback tests (insert-only across
  main+index; insert+update+delete; sequential txns; deferred-CHECK rollback;
  explicit ROLLBACK) — all still green, confirming the warm path is unaffected.
- `test/quereus-engine.spec.ts` schema-hash + DDL-auto-invalidation + determinism
  + validator suites — all green; these are the direct-`getSchemaHash` callers the
  dropped re-warm would have broken.

### Suggested adversarial angles for the reviewer

- Is fail-fast-instead-of-seamless an acceptable resolution of the ticket, or
  should the mutex-free-compute follow-up be filed/blocking? (Judgement call.)
- The naive test exercises the throw on a real db; the "warm then works" tail runs
  in the SAME db after a thrown insert. Confirm there's no lingering bridge/txn
  state from the failed `begin` that masks correctness (it passed here — the
  provider throws before `currentTransaction` is set — but worth a second look).
- `getSchemaHash` idle path now version-guards the cache write (`if (version ===
  this.schemaVersion)`). Confirm this doesn't mask a needed recompute in any flow.
- Multi-node: all participants compute the hash the same way (still via `schema()`),
  so cross-node consistency is unchanged by this fix.

## Files touched

- `src/transaction/quereus-engine.ts` — re-entrancy guard + fail-fast throw in
  `getSchemaHash`; constructor reverted to invalidate-only (no background re-warm);
  contract docs. `invalidateSchemaCache` / `getSchemaVersion` / `computeSchemaHash`
  semantics intact.
- `src/optimystic-adapter/txn-bridge.ts` — non-re-entrancy + keep-warm contract
  docs on `configureTransactionMode`.
- `test/session-mode-commit.spec.ts` — new naive-wiring fail-fast test; updated
  `enableSessionMode` + file-header docs (pre-warm is required, engine fails fast).
