description: In Quereus, a lookup on a two-column key that combines a bound `=` with an `in (…)` list silently returns no rows, even on its plain in-memory tables. Optimystic avoids the form by seeking on only one column, which stays correct but reads more than it needs to, and the fix is a one-line change in the Quereus repository.
architecture: packages/quereus-plugin-optimystic/README.md
files: @quereus/quereus/src/planner/rules/access/rule-select-access-path.ts (the composite arm of `selectPhysicalNodeFromPlan`, `equalitySeekKey`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`getBestAccessPlan`, `runQuery`)
repro: verified
----

**Filed upstream (2026-11-06)** as Quereus ticket `bug-composite-in-seek-drops-a-bound-equality`, in that repository's `tickets/fix/`.

**Re-checked on Quereus 5.0.0 (2026-11-06): still broken.** The two parameterised forms in the table above still return no rows on a memory table.

**Blocked: a dependency outside this repository.** Unblocks when a Quereus release carries the fix below and this repository's `@quereus/quereus` range moves to it. Nothing here is waiting on a decision; the proposal is the change itself.

## What goes wrong

Any module, measured on Quereus 4.25.0 with a plain memory table:

```sql
create table t (id text primary key, a text, b text);
create index t_ab on t(a, b);
insert into t values ('1','x','p'), ('2','x','q'), ('3','y','p'), ('4','x','r');
```

| statement | parameters | returned | correct |
|---|---|---|---|
| `select id from t where a = ? and b in ('p','q')` | `'x'` | none | 1, 2 |
| `select id from t where a = ? and b in (?,?)` | `'x','p','q'` | none | 1, 2 |
| `select id from t where a in (?,?) and b = ?` | `'x','y','p'` | none | 1, 3 |
| `select id from t where a in ('x','y') and b = 'p'` | | 1, 3 | 1, 3 |

The same three parameterised forms also return nothing on a table with `primary key (a, b)` (measured with rows `('x','p')`, `('x','q')`, `('y','p')`). The all-literal form is right on both because it takes a different path.

## Cause

In the composite multi-seek arm of `selectPhysicalNodeFromPlan`, the branch for a column with a single equality value keeps a dynamic value expression only when it is an array:

```ts
columnValues.push({
	colIdx,
	values: [val],
	exprs: Array.isArray(c.valueExpr) ? c.valueExpr : undefined,
});
```

A single-element `in (?)` carries an array, which is what the comment above that code describes. A plain `= ?` carries one scalar expression, so `exprs` is `undefined`, the seek key becomes `Literal(undefined)`, and the runtime's NULL-key skip drops every tuple. `equalitySeekKey`, the non-composite arm's equivalent, handles both shapes.

## Proposed change, in the Quereus repository

```ts
exprs: c.valueExpr === undefined ? undefined : Array.isArray(c.valueExpr) ? c.valueExpr : [c.valueExpr],
```

`allLiteral` already reads false for a constraint with a `valueExpr`, so this falls through to the existing dynamic cross-product. Add the table above as a logic test, on both a composite secondary index and a composite primary key.

## What this repository does once it lands

`an-in-list-on-an-indexed-column-seeks-the-index` limits a multi-value `in` to being the only seek column because of this defect, with a `NOTE:` at that rule in `getBestAccessPlan` that names this ticket. After the Quereus fix:

- Let the match continue through a multi-value `in`, with `K` as the product of the columns' key counts, so `a = ? and b in (…)` over `(a, b)` and an `in` on a composite primary key seek all their columns.
- Add a cap on the product, since it is no longer just the list the statement's author wrote. Quereus's store module uses 1000 (`MAX_MULTI_SEEK_KEYS` in `@quereus/quereus-store/src/common/store-module-access-plan.ts`).
- Read `seekWidth` in `runQuery` and split `args` into tuples, replacing the check that refuses a width other than 1.

## Alternatives rejected

- **Claim composite seeks here when no bound `=` is involved**, since the module can tell a bound `=` by its undefined `value`. It would work today, but it builds a rule around an engine defect into this module's planner, and the single-column limit is simpler. A later list of the same shape is no slower than it is now.
- **Fix it around the engine in `query()`.** By then the seek key is already NULL, so the module cannot recover the bound value.

## If nothing is done

Optimystic stays correct: the `in` beside the bound `=` remains a residual filter on the rows the `=` finds, and a composite primary key's `in` remains a scan. Its only cost is reading more rows than necessary. The wrong results remain for Quereus's own memory and store tables, which is the larger reason to fix it there. The change is one line and easy to reverse.
