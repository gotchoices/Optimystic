description: `StampId()` evaluates to NULL inside the `values` of an INSERT run outside an explicit transaction, so an autocommit insert keyed or tagged by it stores NULL (or is refused by a NOT NULL column) and its offline outlook cannot treat the key as fresh.
files: packages/quereus-plugin-optimystic/src/functions/transaction-id.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/README.md
difficulty: medium
----

Seen while implementing `offline-sync-outlook-from-write-description`: its tests use an explicit `begin` / `commit` around every insert keyed by `StampId()`, because without one the value is NULL.

## Reproduction

```sql
create table t (id text primary key, body text) using optimystic(...);
insert into t (id, body) values (StampId(), 'a');   -- no surrounding begin
```

The insert stores NULL in `id`, or fails the NOT NULL default (Quereus columns default to NOT NULL). The same statement inside `begin; … commit;` stores the transaction's stamp id.

## Likely cause (to confirm)

`createStampIdFunction` answers NULL unless `TransactionBridge.getCurrentTransaction()` is active. In autocommit, the bridge's transaction begins when Quereus calls the vtab connection's `begin` hook, which appears to happen when the first row reaches the vtab — after the `values` row, and the `StampId()` inside it, has already been evaluated.

## Questions for the planner

- Should `StampId()` begin the bridge's transaction itself when a statement is executing and none is open? Or should the vtab begin it before the statement's rows are evaluated (an earlier engine hook)? Or is NULL outside a transaction the intended contract, which would then need documenting as "use an explicit transaction"?
- An insert that touches no Optimystic table still has no bridge transaction. Decide what `StampId()` answers there.
- `CommitOutlook()` follows the same rule (see its doc comment), so whatever is decided should apply to it too.

## TODO

- Reproduce in a plugin spec (autocommit insert keyed by `StampId()`).
- Fix, or document the contract, in README § Offline mode and the function's doc comment.
- If fixed, drop the explicit transactions from `test/write-description.spec.ts` / `offline-outlook.spec.ts` where they exist only for this.
