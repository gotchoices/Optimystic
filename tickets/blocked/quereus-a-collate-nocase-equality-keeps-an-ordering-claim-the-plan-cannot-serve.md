description: In Quereus, a query that filters a column with `= 'x' collate nocase` and asks for rows in index order comes back mis-ordered, on its own in-memory tables and on Optimystic tables alike, because the planner does not tell a table module which collation an equality compares under and keeps a plan's ordering promise after dropping the index seek that made it.
architecture: packages/quereus-plugin-optimystic/README.md
files: @quereus/quereus/src/planner/rules/access/rule-select-access-path.ts (`classifyCollationCover` and the `useIndex` decline below it, `trySortAbsorbViaIndexOrdering`), @quereus/quereus/src/planner/analysis/constraint-extractor.ts (`equalityConstraintCollationOk`), @quereus/quereus/src/vtab/best-access-plan.ts (`PredicateConstraint`), @quereus/quereus/src/vtab/memory/module.ts (`collectEqualityBoundColumns`), packages/quereus-plugin-optimystic/src/schema/index-walk.ts (`pinnedColumns`)
repro: verified
----

**Filed upstream (2026-11-06)** as Quereus ticket `bug-collated-equality-keeps-an-ordering-claim-the-plan-cannot-serve`, in that repository's `tickets/fix/`.

**Re-checked on Quereus 5.0.0 (2026-11-06): memory table now right, Optimystic not re-measured.** The memory table returns 2, 1, 4, because its plan is now `SORT` over `FILTER` over `SEQSCAN`. No 5.0.0 change touches `classifyCollationCover` or the ordering claim, so the Optimystic case is assumed unchanged until measured.

**Blocked: a dependency outside this repository.** Unblocks when a Quereus release carries the two changes below and this repository's `@quereus/quereus` range moves to it. Nothing here waits on a decision; the proposal is the change itself.

## What goes wrong

Measured on Quereus 4.25.0, with a memory table and an Optimystic table (`default_transactor: 'test'`) holding the same rows:

```sql
create table t (id text primary key, b text, c text);
create index idx_bc on t(b, c);
insert into t values ('1','X','b'), ('2','x','a'), ('3','y','c'), ('4','x','d');
```

| statement | memory table | Optimystic table | returned (both) | correct |
|---|---|---|---|---|
| `select id from t where b = 'x' collate nocase order by c` | `FILTER` over `INDEXSCAN … USING idx_bc`, no `SORT` | `FILTER` over `SEQSCAN`, no `SORT` | 1, 2, 4 | 2, 1, 4 |

The filter keeps rows 1 (`'X'`, c = `'b'`), 2 (`'x'`, c = `'a'`) and 4 (`'x'`, c = `'d'`). Ordered by `c` they are 2, 1, 4. Both tables return the `'X'` group ahead of the `'x'` group, each group in `c` order, and nothing above them sorts.

## Cause

Read from the code and confirmed by the plans above. Two sites, one per module.

**The engine keeps the ordering claim after declining the seek.** The Optimystic module answers the request with a seek on `b` through `idx_bc` that claims the ordering on `c` within the sought prefix. The Sort is removed on that claim (`trySortAbsorbViaIndexOrdering`). Physical selection then runs `classifyCollationCover` over the seek's consumed constraints, finds the comparison NOCASE over a BINARY key column (`MISMATCH_UNSAFE`), and answers with `createSeqScan` plus the residual filter. The Sort is already gone, so the sequential scan's order is what the statement returns. This is also the shape the memory module's seek plan would take; its plan differs only because its ordering-only candidate priced lower here.

**A module cannot see which collation an equality compares under.** `equalityConstraintCollationOk` in the constraint extractor says it: constant folding collapses `'x' collate nocase` into a literal whose type carries the collation, so `b = 'x' collate nocase` reaches `request.filters` as an ordinary `=` constraint. `PredicateConstraint` has no collation field. The memory module's `collectEqualityBoundColumns` and this plugin's `pinnedColumns` therefore treat `b` as pinned, skip it in the index key, and claim that a walk of `idx_bc` delivers `order by c`. It does not: `'X'` and `'x'` sit in separate groups of the index, each ordered by `c` on its own. The engine's cover check never sees the walk's filters, because a walk claims none; `handledFilters` is all false and the check judges consumed constraints only.

## Proposed change

1. **Carry the comparison's effective collation on the constraint.** Add `collation?: string` to `PredicateConstraint` in `@quereus/quereus/src/vtab/best-access-plan.ts`, filled where the request is built (`buildRequest` in `@quereus/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts`) with the value `effectivePredicateCollation` already computes for the cover check. A module then pins an equality only when `collationRefines(constraint.collation ?? 'BINARY', column.collation ?? 'BINARY')`: change `collectEqualityBoundColumns` in the memory module so, and this plugin's `pinnedColumns` does the same once the field exists. An older module ignores the field and behaves as today.

2. **Never absorb a Sort that the physical plan then cannot serve.** Run the collation cover classification for the seek's consumed constraints inside `trySortAbsorbViaIndexOrdering`, before the Sort is removed, and refuse the absorb when it would decline the seek; or, in the `useIndex` decline branch of `rule-select-access-path.ts`, build a Sort over the sequential scan whenever the ordering was load-bearing (`orderingLoadBearing` is already threaded to that point). The first keeps the planner's one rule in one place and is the recommended form.

Add the table above as a logic test over both modules, plus `where b = 'x' order by c` (a BINARY equality, which must keep walking the index) and `where b = 'x' collate nocase order by b, c` (which today also loses its Sort over a `SEQSCAN` on Optimystic; it returns the right rows by accident of insertion order).

## What this repository does once it lands

`pinnedColumns` in `packages/quereus-plugin-optimystic/src/schema/index-walk.ts` gates on the carried collation (the `NOTE:` there), and `packages/quereus-plugin-optimystic/test/index-ordered-walk.spec.ts` gains the differential case above, which the memory table then answers correctly.

## Alternatives rejected

- **Read the collation off the constraint's `sourceExpression` in the module.** The object the planner hands over does carry it, but as planner-internal nodes (`BinaryOpNode`, `LiteralNode` types) and a lattice (`comparison-collation.ts`) the engine does not export. Re-deriving it here would be a second, drifting copy of the engine's rule.
- **Stop pinning through filters here.** That fixes only the walk arm's half: the seek arm, which predates the walk, claims the ordering within a sought prefix and is undone by the engine's own decline. It would also cost `where category = 'x' order by category, name` its walk on an index over `name` alone.

## If nothing is done

A statement that combines an equality compared under a coarser collation than its column's with an `order by` the index could serve returns mis-ordered rows, on Optimystic and on memory tables alike. A plain `=` on a BINARY column, the ordinary shape, is unaffected. The change adds one optional field and one refusal, and is easy to reverse.
