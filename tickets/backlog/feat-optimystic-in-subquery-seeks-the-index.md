description: A filter such as `where x in (select …)` on an indexed Optimystic column still reads the whole table, because the planner's offer to look up each subquery result in the index is declined. Accepting the offer would let these queries read only the matching rows, as they already do on Quereus's own tables.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`getBestAccessPlan`), @quereus/quereus/src/planner/rules/access/rule-key-set-seek.ts
tradeoffs: No reported query needs it yet, and the engine only rewrites a semi join at all after probing the module's costs, so the benefit on this module's prices is unmeasured and may be small on un-analyzed tables.
----

`an-in-list-on-an-indexed-column-seeks-the-index` serves a written list (`in (?, ?, …)`) as one seek per value and leaves subquery lists alone. Quereus asks about them through a `runtimeSet` filter (`RuntimeSetSpec` in `@quereus/quereus/src/vtab/best-access-plan.ts`, sent by `rule-key-set-seek`) and delivers an ordinary `plan=5` multi-seek at run time, so the run-time half that ticket builds needs no change. Declining is always correct, and only the speed-up is lost.

What accepting takes, from "Runtime-valued `IN` sets" in the Quereus repository's `docs/module-authoring.md`:

- Never answer a request carrying `runtimeSet` with a scan: the engine probes at 2 keys and at `maxCount` (1000 today), reads an answer that names no index as a refusal, and does the scan comparison itself from the two costs. The request must therefore skip this module's comparison with `tableScanCost`, and the cost must vary close to linearly with the key count. This module's `K * seek + rowTerm` is linear until a measured row term saturates, so check the interpolation against it.
- Apply the safety gates against `maxCount`, the worst case. The seek-trust predicate that ticket adds already covers collation and semantically compared types.
- Claim no ordering over the column.

Expected behaviour: `where x in (select …)` on an indexed BINARY column plans a key-set semi join whose seek branch runs when the set is small enough, with results identical to the scan.
