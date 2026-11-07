description: In Quereus, `order by s nulls last` returns the NULLs first when an index serves the ordering, even on its plain in-memory tables, because the planner drops the sort without looking at the requested NULL placement. Optimystic avoids it by not reading a nullable column in index order, which stays correct but leaves those queries sorting the whole table.
architecture: packages/quereus-plugin-optimystic/README.md
files: @quereus/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts (the `PlanNodeType.Sort` arm that calls `extractOrderingFromSortKeys`), @quereus/quereus/src/planner/framework/physical-utils.ts (`extractOrderingFromSortKeys`), packages/quereus-plugin-optimystic/src/schema/index-walk.ts (`walkDelivering`)
repro: verified
----

**Filed upstream (2026-11-06)** as Quereus ticket `bug-explicit-nulls-placement-is-lost-when-a-module-serves-order-by`, in that repository's `tickets/fix/`.

**Re-checked on Quereus 5.0.0 (2026-11-06): not fixed, now hidden on memory tables.** `order by s nulls last` on the memory table returns a, b, null, but only because the plan now keeps a `SORT` above the `INDEXSCAN`. The `PlanNodeType.Sort` arm in `rule-grow-retrieve.ts` is unchanged from 4.25.0 and still builds `requiredOrdering` without `nulls`, so a module that claims the ordering still loses the placement.

**Blocked: a dependency outside this repository.** Unblocks when a Quereus release carries the fix below and this repository's `@quereus/quereus` range moves to it. Nothing here is waiting on a decision; the proposal is the change itself.

## What goes wrong

Measured on Quereus 4.25.0 with a plain memory table:

```sql
create table t (id text primary key, s text null);
create index t_s on t (s);
insert into t values ('1','b'), ('2',null), ('3','a');
```

| statement | plan | returned | correct |
|---|---|---|---|
| `select s from t order by s nulls last` | `INDEXSCAN` | null, a, b | a, b, null |
| `select s from t order by s nulls first` | `INDEXSCAN` | null, a, b | null, a, b |
| `select s from t order by s` | `INDEXSCAN` | null, a, b | null, a, b |

## Cause

Read from the code, and not confirmed by applying the change. `trySortAbsorbViaIndexOrdering` refuses a sort key with explicit `nulls` ("Explicit NULLS FIRST/LAST is not currently propagated to the access plan — refuse to absorb"). The other route to the same outcome does not: the `PlanNodeType.Sort` arm of the index-style fallback in `rule-grow-retrieve.ts` builds `request.requiredOrdering` from `extractOrderingFromSortKeys`, whose parameter type has no `nulls` field. The module then answers with an ordering that matches, and the Sort goes.

## Proposed change

In that Sort arm, refuse as the absorb path does, before extracting the ordering:

```ts
if (sort.getSortKeys().some(key => key.nulls)) {
	log('Sort key has explicit NULLS; cannot translate to an ordering spec');
	return undefined;
}
```

Add the table above as a logic test, plus `desc nulls last` on a NOT NULL column to confirm a placement that cannot matter still plans correctly either way. The engine could later drop an explicit placement on a NOT NULL column before planning, so such a query still gets the index. That is an optimization and not part of this fix.

## What this repository does once it lands

`walkDelivering` requires that no NULL can reach an ordered column, in both directions, because a module cannot see the requested placement. After the fix, a request reaching the module has the engine's default placement (NULLs first in both directions, `orderByNullResult` in `@quereus/quereus/src/util/comparison.ts`), so the rule narrows to descending only: an ascending walk already emits NULLs first. A nullable column's `order by s` then walks the index.

## Alternatives rejected

- **Claim nullable ascending orderings here now.** A query that sorts correctly on Optimystic today would start returning NULLs in the wrong place.
- **Detect the placement in the module.** The request carries `OrderingSpec.nullsFirst`, but nothing in the planner fills it, so there is nothing to read.

## If nothing is done

Optimystic stays correct: a nullable ordered column sorts in the engine as it does today, which costs a full read but never a wrong order. Columns are NOT NULL by default, so the common case is unaffected. The wrong results remain for Quereus's own memory tables, and for any module that claims an ordering over a nullable column.

The change is small and easy to reverse: it only declines a plan.
