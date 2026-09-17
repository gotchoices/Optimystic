description: In the separate quereus engine repository, re-applying an unchanged schema that spells a column type with an alias (like "int" or "varchar(20)") asks to change that column's type, because the engine compares the written type name against its internal name ("INTEGER", "TEXT"). Optimystic tables cannot change a column's type, so a downstream application cannot restart; someone needs to decide on and land the fix in quereus.
files: ../quereus/packages/quereus/src/schema/schema-differ.ts (`computeColumnAttributeChange` ~2698, the data-type comparison ~2714), ../quereus/packages/quereus/src/schema/catalog.ts (`tableSchemaToCatalog` ~283 puts `logicalType.name` in `type`), ../quereus/packages/quereus/src/schema/column.ts (`declaredType`)
repro: verified
----

# Why this is in your inbox

The defect is in the **quereus engine repository** (checked at `ff1c619c6`), which this repo consumes. Nothing in Optimystic can fix it. It blocks sereus: nine of its eleven failing restart tests are this error, and they stay red after Optimystic's own part (`implement/warm-restart-restores-a-table-that-disagrees-with-its-declared-schema`) lands.

# What happens

Plain Quereus, memory tables, no Optimystic:

```js
const db = new Database();
await db.exec(`declare schema cc { table T ( id text primary key, U int not null, V varchar(20), W timestamp, X integer ) } apply schema cc;`);
for await (const r of db.eval(`diff schema cc`)) console.log(r);
// { ddl: 'ALTER TABLE cc.T ALTER COLUMN U SET DATA TYPE int' }
// { ddl: 'ALTER TABLE cc.T ALTER COLUMN V SET DATA TYPE varchar(20)' }
```

The declaration was just applied, so the diff should be empty. `computeColumnAttributeChange` compares `declared.dataType` (`int`) case-insensitively against the catalog's `type`, which is `logicalType.name` (`INTEGER`). Memory tables accept the retype, so every re-apply silently runs a no-op `SET DATA TYPE` (which rewrites column values). Optimystic tables have no `alterTable`, so the apply throws `Module for table 'CadrePeer' does not support ALTER COLUMN` — on a warm restart after hydrate, and also on a second `apply schema` in the same process.

# Options

- Compare logical types: `inferType(declared.dataType).name` against `actual.type`. Simple; a spelling change between aliases of one logical type (`int` → `bigint`) becomes no change, which matches storage. `declaredType` then goes stale on such a change (it is documented as informational only).
- Carry `declaredType` into the catalog table and compare it when present, falling back to the logical type. Keeps the spelling exact, but an `int` → `bigint` edit would still emit a retype a module like Optimystic cannot run.

Recommendation: the first. Add a differ test that re-applying a declaration using alias types yields an empty diff.

# Status (2026-09-16 evening): fixed in quereus's working tree, NOT committed

The quereus session (`quereus-08`) reports the fix done but uncommitted, pending its user:
`computeColumnAttributeChange` now resolves the declared spelling through `inferType()` before comparing
to the catalog's canonical `logicalType.name` (the same approach `extractDeclaredCollation` already uses
nearby), so `int`/`INTEGER` and `varchar(20)`/`TEXT` compare equal. Verified against the repro above
(two spurious rows before, empty diff after), regression spec in `differ-alter-column.spec.ts`, quereus
`yarn test` 10399 passing, lint clean. Length/precision is not tracked by the catalog at all — a separate,
absent feature, not a regression.

Unblock this ticket when the fix is **committed** in quereus, and note the commit here. Delete it once a
quereus release carrying the fix is consumed by the plugin's `@quereus/quereus` dependency range, since
npm consumers do not see the portal-linked working tree.

# Status (2026-09-17): committed in quereus, not yet released

Committed as quereus `561195502` ("Schema diff fix", 08:33): `schema-differ.ts` plus a regression case in `differ-alter-column.spec.ts`. **That commit came after the `v4.19.2` release tag** (`a244949f8`), and no tag contains it. The maintainer's uncommitted bump of the plugin's `@quereus/quereus` range to `^4.19.2` therefore does **not** carry the fix for npm consumers. Optimystic's own tests see it now, because they resolve quereus through the portal to `../quereus`.

Keep this ticket in `blocked/` until a quereus release containing `561195502` (4.19.3 or later) exists. Then raise the plugin's range to that version and delete this ticket.

# Resolved (2026-09-17)

Quereus `v4.19.4` contains the fix commit `561195502` (checked with `git merge-base --is-ancestor`). The maintainer raised both plugins' `@quereus/quereus` dev range to `^4.19.4` (`9060cdc0`), so npm consumers now get it too.
