description: When a column is declared unique and an ordinary index is later created on the same column, machines that opened the table before the index keep maintaining a private uniqueness tree that machines opening afterwards never create or update, so that tree silently goes stale on the first machine.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/index-integrity.ts, packages/quereus-plugin-optimystic/test/concurrent-row-change-refusal.spec.ts
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The stale tree is never read while the declared index exists, because the declared index is preferred for enforcement, so nothing is wrong today unless that index is later dropped; a maintainer may reasonably wait until the enforcing-tree set is persisted in the catalog rather than derived per handle.
----

## What was observed (implement stage of `refuse-concurrent-row-change-loser`, 2026-09-15)

Two `Database` handles over one `FileRawStorage` directory. Both run, in this order: `create table T (id integer primary key, v text unique on conflict replace) using optimystic('…')` then `create index T_by_v on T(v)`. Handle A runs both statements first, then handle B.

- Handle A's `verifyIndexes` lists two trees: the declared `T_by_v` and the synthesized unique-enforcement tree `_uniq_1.v`.
- Handle B's `verifyIndexes` lists only `T_by_v`.
- After B runs `update T set v = 'moved-B' where id = 1`, A's report for `_uniq_1.v` shows the old entry `seed-1 ‖ 1` as a `stale-value` orphan and `moved-B ‖ 1` as missing. `T_by_v` is correct on both handles.

## Why

`buildUniqueEnforcementIndexes` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` decides at table open whether to synthesize a `_uniq_` tree for each unique constraint, skipping the constraint when the stored schema already lists a declared index over the same columns. A opened before any index existed and synthesized the tree; B opened after `T_by_v` was in the catalog and did not. The synthesized set is per handle and is not recorded anywhere the other handle can see. Every write on A maintains both trees; every write on B maintains only `T_by_v`; A's tree drifts.

The note on `resolveEnforcingIndex` says a redundant pair "can only arise from `CREATE UNIQUE INDEX` over columns already carrying a plain UNIQUE". A plain `CREATE INDEX` produces it too, and across handles rather than within one.

## Impact

None on query results today: `resolveEnforcingIndex` prefers the declared index, so A's probes never read `_uniq_1.v`. The stale tree is visible to `verifyIndexes` (which is how it was found) and would become the enforcing tree on A if `T_by_v` were dropped, at which point A's uniqueness decisions come from stale data. The regression spec for the concurrent-row-change refusal avoids the shape by declaring no index on its `unique` column table and says so in a comment naming this ticket.

## Expected

Every handle maintains the same set of index trees for a table, or a synthesized tree is retired (and its collection left to age out) the moment a declared index subsumes it, on every handle that holds it. Either fix should make the two handles' `verifyIndexes` reports list the same trees, and the note on `resolveEnforcingIndex` should describe the real producers.
