description: When a table declares that duplicate rows should be quietly skipped (or should overwrite the row already there), the optimystic-backed table ignores that instruction and raises an error instead.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique-hydrate.spec.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
difficulty: hard
repro: verified
----

## Background

SQL lets a uniqueness rule say, where it is declared, what should happen when a
later row violates it:

```sql
create table I (Id integer primary key, Stamp text not null unique on conflict ignore)
  using optimystic('tree://…');
```

`on conflict ignore` means "a row repeating an existing `Stamp` is silently
dropped — do not fail the statement". There are two spellings of the same
intent: this **constraint-level** one, and the **statement-level** one
(`insert or ignore into I …`). The optimystic-backed virtual table honours only
the statement-level spelling. Every constraint-level declaration is discarded and
the write fails with `UNIQUE constraint failed`.

Reproduced against the current tree (see *Reproduction*, below). Not introduced
by the recent hydrate fix — that fix only made the gap visible, by starting to
persist the declared action that nothing reads.

## Where the responsibility lies

This was the open question in the incoming fix ticket, and the engine settles it:
the **virtual table** applies the declared action. Quereus deliberately hands the
vtab `undefined` when the statement declared nothing, precisely so the vtab can
fall back to its own schema. From `runtime/emit/dml-executor.ts` (`processInsertRow`,
in the `@quereus/quereus` package — the workspace checkout is symlinked at
`packages/quereus-plugin-optimystic/node_modules/@quereus/quereus`):

```ts
// Pass undefined when there's no statement-level OR clause so the vtab
// can fall back to per-constraint defaultConflict directives. The memory
// module treats undefined as ABORT when no constraint default is set.
onConflict: plan.onConflict,
```

The engine's own in-memory table is the reference implementation, in
`src/vtab/memory/layer/manager.ts`:

| what collides | how memory resolves the action | line |
| --- | --- | --- |
| primary key | `onConflict ?? resolvePkDefaultConflict(schema) ?? ABORT` | 1092, 1179 |
| secondary UNIQUE | `onConflict ?? uc.defaultConflict ?? ABORT` | 1333 |

Precedence, in one sentence: **statement-level `or <action>` wins; else the
action declared on the rule itself; else abort.** The engine states the same rule
once more as `pickAction` in `src/runtime/row-constraints.ts:94`, which it uses
for NOT NULL and CHECK.

## What the optimystic table does today

Every conflict site in `src/optimystic-module.ts` resolves the action as
`args.onConflict ?? ConflictResolution.ABORT` and never looks at the schema:

- PK collision on INSERT — line ~1373 (`update()`, `case 'insert'`)
- secondary UNIQUE on INSERT — line ~1411, via `resolveUniqueConflict`
- secondary UNIQUE on UPDATE — line ~1462, via `resolveUniqueConflict`
- PK collision on a PK-moving UPDATE — line ~1486

Three of those four carry a comment asserting "No per-constraint default in
optimystic" — that assertion is what this ticket retires. `resolveUniqueConflict`
(line ~1301) takes a single already-resolved action for the whole table, so even
once a default is available it cannot apply a *different* action per constraint;
it needs to resolve per-constraint, inside the loop.

The metadata itself is available and correct on the fresh-`create table` path —
confirmed at runtime:

- secondary UNIQUE → `tableSchema.uniqueConstraints[i].defaultConflict` = `4` (IGNORE)
- table-level `primary key (Id) on conflict ignore` → `tableSchema.primaryKeyDefaultConflict` = `4`
- column-level `Id integer primary key on conflict ignore` → `tableSchema.columns[0].defaultConflict` = `4`
  (and `primaryKeyDefaultConflict` stays `undefined` — hence the two-step PK rule)

`ConflictResolution` is `ROLLBACK=1, ABORT=2, FAIL=3, IGNORE=4, REPLACE=5`
(`src/common/constants.ts`).

## Two gaps behind the one symptom

**Gap 1 — the action is never read.** The four sites above. Fixing this alone
makes every constraint-level declaration work on the fresh-`create table` path.

**Gap 2 — the primary key's action is never persisted**, so it is missing on the
warm-restart (`hydrate`) path even after Gap 1 is closed.
`StoredTableSchema` (`src/schema/schema-manager.ts:52`) has no
`primaryKeyDefaultConflict`, and `StoredColumnSchema` has no `defaultConflict`.
On a hydrate-only open, `doInitialize` rebuilds `tableSchema.columns` and
`primaryKeyDefinition` from the persisted schema (`optimystic-module.ts:346-366`),
so whatever the placeholder held is replaced by values that never carried the
action.

The **secondary** UNIQUE action is already persisted and restored — pinned by the
passing test `round-trips a constraint-level 'on conflict' action through
persistence and hydrate` in `test/secondary-unique-hydrate.spec.ts`. Only the PK
side needs new persistence.

Both new fields must be **omitted** when absent, not written as `undefined`/`null`
— `schemasEqual` compares the stored forms and a spurious key costs every existing
table one re-write on its next open. `StoredTableSchema.uniqueConstraints` already
documents that discipline; follow it.

## A third defect found while reproducing

`insert or replace` colliding with a **secondary** UNIQUE (not the PK) fails today
under the *statement*-level spelling too:

```sql
create table S (Id integer primary key, Stamp text not null unique) using optimystic('tree://…');
insert into S (Id, Stamp) values (1, 'a');
insert or replace into S (Id, Stamp) values (2, 'a');   -- ConstraintError: UNIQUE constraint failed: S.Stamp
```

`resolveUniqueConflict` special-cases only IGNORE; REPLACE falls through to the
constraint result. REPLACE against a secondary UNIQUE means evicting the
conflicting row **at a different primary key** — a strictly bigger operation than
the same-PK overwrite the PK path does. Quereus already has the channel for it:
`UpdateResult.evictedRows` (`src/common/types.ts:183`), documented as "rows at
*other* PKs fully removed because REPLACE resolved a non-PK UNIQUE conflict for
this same `update()` call". The DML executor runs a full delete pipeline for each
(change-tracking, row-time maintenance, FK cascade, delete auto-events) before the
new row's own bookkeeping. The memory module's `checkUniqueViaIndex` (line ~1513)
is the model: delete the conflicting row, push it onto `evicted`, **continue
scanning** for further duplicates rather than returning.

The same site fixes this and the constraint-level `on conflict replace`, so it
belongs here rather than in its own ticket.

## Known limit — FAIL and ROLLBACK cannot be fully honoured from the vtab

`fail` and `rollback` differ from `abort` only in how much is undone (FAIL keeps
earlier rows of the statement; ROLLBACK aborts the whole transaction). The engine
picks that branch from the **error subclass** — `FailConflictError` /
`RollbackConflictError` — and `translateConflictError`
(`dml-executor.ts:827`) only ever synthesizes them from the *statement-level*
clause. A vtab returning `{status: 'constraint'}` always lands on plain `ABORT`.
Neither subclass is exported from `@quereus/quereus`'s public entry point, so the
plugin cannot throw one.

**The engine's own memory module has exactly the same limitation** — it resolves
`effective` and then returns a plain constraint result for FAIL/ROLLBACK alike. So
parity with the memory module is the achievable bar, and this ticket takes it:
resolve the action for all five, apply IGNORE and REPLACE, and let ABORT / FAIL /
ROLLBACK all produce the structured constraint result. Record the residue as a
`NOTE:` at the resolver so the next reader does not re-derive it, and say so in
the review handoff. Do **not** file a follow-up ticket for it — it is an upstream
API gap, not optimystic's.

## Reproduction

All verified against the current tree with a scratch spec using
`test/secondary-unique.spec.ts`'s harness (in-memory `test` transactor), plus the
`hydrate` harness from `test/secondary-unique-hydrate.spec.ts`. Every one raised
`ConstraintError: UNIQUE constraint failed` where it should have been a silent
skip or an overwrite:

- secondary UNIQUE `on conflict ignore`, fresh `create table`
- secondary UNIQUE `on conflict ignore`, reached through `hydrate` with no DDL replay
- secondary UNIQUE `on conflict replace`
- table-level `primary key (Id) on conflict ignore`
- column-level `Id integer primary key on conflict ignore`
- an `update` moving a row onto a value held by another row, under a secondary
  UNIQUE declared `on conflict ignore`
- statement-level `insert or replace` colliding with a secondary UNIQUE (the third
  defect above)

Note the UPDATE case is reachable *only* through the constraint-level spelling:
Quereus has no `update or ignore` grammar and its planner hard-codes
`onConflict = undefined` for every UPDATE (see the long comment above
`describe('UPDATE PK-move conflict resolution …')` in
`test/insert-pk-uniqueness.spec.ts`). So this work makes IGNORE and REPLACE
reachable on the UPDATE path for the first time; those branches were previously
unreachable-by-construction and are now genuinely exercised.

## Shape of the fix

One private resolver, used by all four sites — no second spelling of the
precedence rule anywhere in the plugin:

```ts
/** statement-level OR > the rule's own declared action > ABORT. */
private resolveConflictAction(
  stmt: ConflictResolution | undefined,
  declared: ConflictResolution | undefined,
): ConflictResolution;

/** The PK's declared action: table-level `primary key (…) on conflict X` first,
 *  else the column-level action on ANY pk column. */
private pkDeclaredConflict(): ConflictResolution | undefined;
```

`pkDeclaredConflict` mirrors `resolvePkDefaultConflict`
(`src/schema/table.ts:1114`), which quereus does **not** export — the same
duplication its own doc comment notes for the `quereus-store` and
`quereus-isolation` packages. Keep it to those few lines and `NOTE:` the upstream
site it tracks.

`resolveUniqueConflict` moves the action resolution *inside* the per-constraint
loop, so `checkUniqueConstraints` must surface which constraint was hit (it
already returns `columns`; it needs the `defaultConflict` too, or the whole `uc`).

## TODO

### Phase 1 — read the declared action

- Add `resolveConflictAction` and `pkDeclaredConflict` to the vtab; `NOTE:` the
  upstream `resolvePkDefaultConflict` this mirrors.
- Route the PK INSERT collision and the PK-moving UPDATE collision through them;
  delete the three "No per-constraint default in optimystic" comments they falsify.
- Make `checkUniqueConstraints` surface the violated constraint (not just its
  columns) so per-constraint actions are distinguishable.
- Resolve the action per constraint inside `resolveUniqueConflict`.
- Tests, table-driven over `{ignore, replace, abort, fail, rollback}` ×
  `{statement-level, constraint-level}` × `{primary key, secondary unique}`, so a
  future edit cannot silently drop one cell. Cover both PK spellings (table-level
  and column-level). Put them with the existing conflict coverage in
  `test/secondary-unique.spec.ts` and `test/insert-pk-uniqueness.spec.ts`.
- One UPDATE test per the newly-reachable action (IGNORE, REPLACE) against a
  secondary UNIQUE.

### Phase 2 — REPLACE against a secondary UNIQUE

- Evict the conflicting row at its own PK (`collection.stage([[pk, undefined]])`
  plus `indexManager.deleteIndexEntries`, as the `case 'delete'` arm does) and
  report it in `UpdateResult.evictedRows`.
- Keep scanning the remaining constraints after an eviction; several constraints
  can each displace a different row in one write.
- Cover the statement-level `insert or replace` case *and* the constraint-level
  `on conflict replace` case, and assert the evicted row is really gone from the
  table **and** from every index tree (query through the indexed column, not just
  `count(*)`).

### Phase 3 — persist the primary key's declared action

- Add `primaryKeyDefaultConflict?` to `StoredTableSchema` and `defaultConflict?`
  to `StoredColumnSchema`; write them from `tableSchemaToStored` and restore them
  in `doInitialize`'s hydrate branch.
- **Omit both keys when the action is absent**, so a table that declares nothing
  still compares byte-equal in `schemasEqual` and keeps its no-write
  short-circuit on reopen. A table that *does* declare one re-writes its schema
  exactly once, then short-circuits again — assert that, mirroring the existing
  stabilization tests in `test/secondary-unique-hydrate.spec.ts`.
- Extend the hydrate spec so each cell of the Phase 1 matrix also passes when
  reached through `hydrate` with no DDL replay.

### Phase 4 — validate

- `yarn build` then `yarn test` from `packages/quereus-plugin-optimystic`
  (the specs import `../dist/plugin.js`, so a stale `dist` silently tests old code).
- `yarn typecheck` in the same package.
- Run the root `yarn test` for the cross-package effect of the schema-format
  change; stream the output (`2>&1 | tee`), never a silent redirect.
- Update `docs/` if any page states that optimystic honours only statement-level
  conflict clauses.
