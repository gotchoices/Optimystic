description: Quereus works out the rows of a single `values` list before an autocommit insert starts its transaction, so a SQL function that answers from the open transaction (Optimystic's `StampId()`) sees none and returns NULL; Quereus needs to start the statement's transaction first, or let a plugin start it.
architecture: docs/internals.md#the-offline-queue
files: @quereus/quereus/src/core/database.ts (`Database._executeSingleStatement`, `Database._ensureTransaction`), @quereus/quereus/src/core/database-transaction.ts (`TransactionManager.ensureTransaction`), @quereus/quereus/src/runtime/emit/dml-executor.ts (`runInsert`, `runUpdate`, `runDelete` — each starts the implicit transaction), @quereus/quereus/src/core/database-internal.ts (`DatabaseInternal`), packages/quereus-plugin-optimystic/src/functions/transaction-id.ts
----

# Quereus begins a write statement's transaction before evaluating it

**Blocked: external dependency (Quereus).** Unblocks when Quereus ships one of the two capabilities below (the first is recommended). The Optimystic side is the implement ticket `stampid-answers-inside-an-autocommit-write`, which names this ticket as its prereq.

## What happens today

Measured on the Quereus build this repo links (`portal:../quereus/packages/quereus`), with a trace of the scheduler, Quereus's `_ensureTransaction` and the Optimystic connection's `begin`:

```
insert into t (id, body) values (StampId(), 'a')    -- autocommit, table t already connected
  StampId() evaluated  -> null        (stack: scalar-function run ← Scheduler.runSyncLoop ← _executeSingleStatement)
  _ensureTransaction                  (from runInsert)
  connection.begin                    (Optimystic's bridge opens its transaction here)
  -> NOT NULL constraint failed: t.id
```

The rows of a `values` list are evaluated by the scheduler as synchronous instructions that feed the insert instruction, so they run before `runInsert` reaches its "lazy/JIT transaction start" (`await ctx.db._ensureTransaction()`). An `insert … select StampId(), 'a'` works, because its rows are pulled inside `runInsert`, after the transaction began. Shapes checked:

| statement, autocommit | result |
|---|---|
| `insert into t (id, body) values (StampId(), 'a')` | NOT NULL refusal (`id` is NULL) |
| `insert into t (id, body) values (StampId(), 'm1'), ('fixed', 'm2')` | NOT NULL refusal |
| `insert into t (id, body) select StampId(), 'sel'` | stores the stamp |
| the first, inside `begin … commit` | stores the stamp |
| the first, into a nullable column | stores NULL silently |

Any module function that answers from the transaction Quereus has open behaves the same way. In Optimystic that is `StampId()` and `CommitOutlook()`. The plugin README's own example of an assured offline insert, `insert into Note (id, body) values (StampId(), :body)`, fails when it runs on its own.

## Proposed capability (for Quereus)

> **Recommended.** In autocommit mode, a statement that writes (its plan contains an insert, update or delete, or a `returning` form of one) begins its implicit transaction before any of its instructions run, so every expression it evaluates, `values` rows included, runs inside that transaction. The `_ensureTransaction()` calls in the DML emitters stay and become no-ops for such a statement. A read-only statement is unchanged. The implicit transaction still ends when the statement ends, committing or rolling back as today.

The second option, if the first is not wanted:

> `DatabaseInternal.ensureTransaction(): Promise<void>`, added to the interface modules already use for connections (registerConnection, getConnectionsForTable). In autocommit it begins the implicit transaction that the current statement's end will finish; inside a transaction it does nothing. Calling it is valid only while a statement executes (`_isExecuting()`), and an async scalar function may call it. Today `_ensureTransaction` does this but is `@internal`, and Quereus builds with `stripInternal`, so it is missing from the published types.

With the second option Optimystic makes `StampId()` and `CommitOutlook()` async and has them call it when no Optimystic transaction is open. A prototype that called the stripped `_ensureTransaction` through a cast fixed the table above, and a `select StampId()` in autocommit then answered a fresh stamp per statement with `getAutocommit()` true again afterwards. The cost is that every module with such a function has to do the same, and each read-only statement that evaluates one opens and commits an empty transaction.

Alternatives rejected:

- **Optimystic's bridge mints a stamp when `StampId()` finds no transaction, and the next transaction adopts it.** Nothing tells the bridge when a read-only statement ends, so a `select StampId()` would hand its stamp to whatever transaction comes next. In session mode the stamp is minted by the transaction session, which has no way to take one in.
- **Optimystic calls the stripped `_ensureTransaction` through a cast.** It works today, but the method is outside the published types and can be renamed without notice; this repository's rule is not to depend on untyped internals.
- **Document "use an explicit transaction".** That is what happens if nothing is done (below).

If nothing is done: the implement ticket reduces to documentation. README § StampId() Function, § Offline mode and both functions' doc comments say that a single-statement insert that computes a value from `StampId()` must use `insert … select` or `begin … commit`, and the README's `values (StampId(), :body)` example is rewritten. Reversible: either option changes no stored data, and the recommended one changes no Optimystic code.
