description: A SQL column type that holds a reference to a large stored file now exists, so a table can declare such a column, anything that is not a valid reference is rejected, and a machine whose software does not understand the type refuses to open or alter the table instead of quietly reading the column as something else.
architecture: docs/blobs.md#sql
files: packages/quereus-plugin-optimystic/src/schema/blobref-type.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/schema/index-predicate.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-optimystic/test/blobref-column.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/blobs.md
----

# The `blobref` column type

First part of [docs/blobs.md §SQL](../../docs/blobs.md#sql): the column type and nothing else. No blob service, no reference trees, no pins, no SQL functions — those are `feat-blob-sql-type-and-blob-service` and its successors.

A **blob reference** is the short string that names a large stored file: a content identifier, 59 characters of lowercase base32, with exactly one accepted spelling. `isBlobRef` in `packages/db-core/src/blob/blob-ref.ts` is the one rule for what is and is not one, and the type adds no grammar of its own.

## What shipped

**The type.** `packages/quereus-plugin-optimystic/src/schema/blobref-type.ts` holds `BLOBREF_TYPE_NAME` (`'BLOBREF'`), `BLOBREF_TYPE` (physical TEXT, `isTextual`, `supportedCollations: []`, `validate` delegating to `isBlobRef`, a BINARY `compare`, no `parse`, no `collationAware`, no `semanticOrdering`), `isBlobRefColumn`, and the refusal `assertBlobRefTypeRegistered`. The reasoning behind each flag is in the module's doc comments, and each flag's claimed effect was checked against the Quereus source during review (see *Review findings*).

**Registration.** `register` in `src/plugin.ts` returns `types: [{ name: 'blobref', definition: BLOBREF_TYPE }]` beside `vtables`, `functions` and `collations`; `registerPlugin` (`@quereus/quereus/src/util/plugin-helper.ts`) registers it. `src/index.ts` exports `BLOBREF_TYPE`, `BLOBREF_TYPE_NAME` and `isBlobRefColumn`. `package.json`'s `quereus.provides` block gained `"types": ["blobref"]` (host UI metadata).

**Guard 1 — a stored record whose declared spelling no longer resolves to the type its rows were written under.** `hydratedColumnType` in `src/schema/schema-manager.ts` holds both arms of the hydrated-column type decision: the `declaredType` arm re-infers with `inferType` and refuses when the result's `name` differs from the record's `affinity`; the no-declared-type arm is the existing `registeredStoredType`. One site, so it covers `hydrateCatalog`, the stale-record rebuild, the vtab's hydrate and load arms, and the index manager's partial-index predicates. Review made both messages name the table as well as the column.

**Guard 2 — a declaration naming `blobref` while the type is not registered.** `assertBlobRefTypeRegistered` refuses a column whose declared spelling's base name is `blobref` (case-insensitively, parameter list stripped) while its `affinity` is not `BLOBREF` — the shape a process with `pragma strict_type_names = false` and no registered type produces, where the column becomes a **BLOB** column whose row codec base64-*decodes* every stored string. Review moved its write-side placement from two hand-placed calls in `OptimysticVirtualTable.doInitialize` to the one catalog-write seam, `SchemaManager.storeStoredSchema`, which closed an `ALTER TABLE ADD COLUMN` hole; the open-side call in `doInitialize` stayed.

**Docs.** `docs/blobs.md`'s status paragraph names the type as built and narrows what remains of SQL; §SQL's opening moved from intent to what exists and gained both refusals. The plugin README gained "Large values — the `blobref` column type" under *Data Model*.

## Decisions worth knowing

1. **`compareNulls` is not exported from `@quereus/quereus`'s root entry** (only from `src/types/index.ts`, which the root entry does not re-export). Its three-line null preamble is inlined in `BLOBREF_TYPE.compare`, exactly as the temporal types spell it, with a comment saying why.

2. **Guard 1 is a general rule, not a blobref-specific one.** It refuses any record whose `affinity` and re-inferred `declaredType` disagree, for every type. Its message is direction-neutral — `Type mismatch for column 'x' of table 'main.T' in a stored table description: its rows were written as 'A', but its declared spelling 'a' resolves to 'B' in this process` — because the disagreement runs both ways (a plugin type the writer had and the reader does not, and a record written before a type was registered then read by a process that has it). Review confirmed its quietness for existing data by evidence rather than argument; see *Review findings*.

3. **The remedy sentence is one shared constant**, `REGISTER_TYPES_REMEDY` in `blobref-type.ts`, quoted by every refusal in both files. Review made it type-neutral: the guard-1 arms fire for any unresolvable type including a host's own, so the text must not send a reader after the Optimystic plugin for a type the plugin never owned.

4. **Two of the planned test cases cannot be written as stated, and were not.** Quereus's type registry is process-wide with no un-register (`TypeRegistry` in `@quereus/quereus/src/types/registry.ts`), so no test in a shared mocha process can rely on `BLOBREF` being absent — it would pass or fail on file ordering. Guard 1 is therefore reached by tampering a stored record's declared spelling, and guard 2's rule by a direct call to `assertBlobRefTypeRegistered` (imported from `../src/schema/blobref-type.js`, as a dozen existing specs import plugin internals). It is deliberately **not** exported from `src/index.ts`: a public entry point should not exist only to satisfy a test.

5. **`assertBlobRefTypeRegistered` is reachable through the plugin's own API** at the write seam, so the write-side placement is pinned by a test that goes through `SchemaManager.storeStoredSchema` rather than by a direct call.

## Tests

`packages/quereus-plugin-optimystic/test/blobref-column.spec.ts`, over `create table Attachment (Id text primary key, Content blobref null)` on a shared `local` transactor, with the plugin's `types` registered as `registerPlugin` would:

| Test | What it verifies |
|---|---|
| stores a well-formed reference verbatim, and NULL as nothing referenced | A canonical reference round-trips byte-identical, and a nullable `blobref` column accepts and returns NULL. |
| refuses a value that is not a canonical reference | Two values, one per arm of `validate` — a string the grammar refuses (the upper-cased spelling of a real reference) and a value that is not a string — each refused with `Type mismatch for column 'Content': expected BLOBREF` at `StatusCode.MISMATCH`, and no row written. |
| refuses to hydrate a stored column whose rows were not written under the type | Guard 1: a record whose `affinity` and `declaredType` disagree stops `plugin.hydrate(db)`, naming the table, the column and both type names, and nothing enters the catalog. |
| refuses to write a catalog record declaring blobref whose rows resolve to another type | Guard 2 at the seam that holds it — `SchemaManager.storeStoredSchema` refuses the record a type-less process would persist, so the write never lands. |
| refuses a column declared blobref whose rows resolved to another type | Guard 2's rule: fires for `blobref` / `BlobRef` / `blobref(2)` against a non-`BLOBREF` affinity; quiet when the affinity *is* `BLOBREF`, when the column is a plain `blob`, and when the record names no declared spelling. |

The reference vector is the 1,000-byte file's reference from `packages/db-core/test/blob-builder.spec.ts`, so it is one real IPFS tools produce.

Nothing tests the registration wiring, the type's metadata flags, or that an index on the column still walks — a type, the existing index-walk specs and `yarn check` cover those. Which spellings are and are not references is `isBlobRef`'s rule, pinned over the whole vector set by `packages/db-core/test/blob-ref.spec.ts` and not restated here.

## Review findings

The implement-stage commit reviewed is `ticket(implement): feat-sql-blobref-column-type`.

**Fixed in this pass**

- **`ALTER TABLE ADD COLUMN` bypassed the write-side guard entirely.** `OptimysticModule.addColumn` resolves the column with `columnDefToSchema`, converts it with `columnSchemaToStored` and persists it — never touching either of the two `doInitialize` call sites the implementer placed. So a process missing the type (with `strict_type_names` off) could add a column declared `blobref` to an existing table, persisting `affinity: 'BLOB'` beside `declaredType: 'blobref'`; a process that *does* have the type would then be refused by guard 1 on every hydrate, leaving the table unopenable for the correct readers — the exact hazard the implementer's second call site exists to prevent, through a door that call site does not cover. Rather than add a third hand-placed call, the rule moved to the seam: `SchemaManager.storeStoredSchema` is the single funnel every column a record gains passes through (CREATE TABLE's declaration arm, ADD COLUMN, and the record re-writes), and the three other catalog writers in that file — gravestone, index-subtract, tag-overlay — never add a column. The two `doInitialize` calls collapsed to one (the open side), its one-use `blobRefGuardSubject` helper was inlined, and the new placement is pinned by a test.
- **The shared remedy sentence misdirected readers for types the plugin does not own.** `REGISTER_TYPES_REMEDY` read "load the plugin through registerPlugin, or register its `types` …", but it is quoted by `registeredStoredType` and by guard 1, which fire for *any* type a stored record names and this process cannot resolve — a host's own custom type included. Rewritten type-neutral, leading with `db.registerType` and mentioning `registerPlugin` as the plugin's own route.
- **Neither hydrate refusal named the table.** `hydrateCatalog` walks a whole catalog and calls `storedToTableSchema` per table with no wrapping, so `Type mismatch for column 'Content' …` left an operator to guess which of their tables disagreed. `storedToColumnSchema` now takes the qualified table name as a required argument (all four callers already had it), and both messages name `column 'C' of table 'main.T'`. This also fixes the pre-existing `registeredStoredType` message, which the implement commit had already rewritten. The README's claim that the refusal "names the table and the column" is now true rather than aspirational.
- **Docs claimed less than the code now does.** `docs/blobs.md` §SQL and the README section said a build without the type cannot *open* such a table; both now say it cannot open **or write** one, and say why the write refusal is the one that matters for everyone else.
- **Four of the six refused-value vectors restated `packages/db-core/test/blob-ref.spec.ts`** one layer up: upper case, CIDv0, dag-cbor, whitespace, padding and non-strings are all already pinned there, against a `validate` that is one line of delegation. Cut to two — one per arm of `validate` — with a comment saying where the grammar is pinned.
- **A stale size tripwire.** `schema-manager.ts` carries a `NOTE:` saying "this file is 1532 lines. If it grows again, move them to their own module." It is 2057 lines (`wc -l packages/quereus-plugin-optimystic/src/schema/schema-manager.ts`), so the condition tripped some time ago and the note was quietly misinforming the next reader. Updated in place with the measured count and the fact that the extraction is owed. No ticket: it serves no current-release anchor and names no class-level invariant, so it stays a tripwire at the site.

**Checked and sound — no change**

- **Guard 1's blast radius, which the handoff flagged as its largest open question.** The structural argument was verified at the source, not taken on trust: `columnDefToSchema` (`@quereus/quereus/src/schema/table.ts`) sets `logicalType = inferType(def.dataType)` and `declaredType = def.dataType` from the same string, and `columnSchemaToStored` stores `logicalType.name` as `affinity` — and `git log -S` shows that line has never been anything else. So the two names agree for every spelling a process can resolve, aliasing spellings included (`varchar(20)` → `TEXT`, `int` → `INTEGER`, `decimal(10,2)` → `NUMERIC`, `interval` → `TIMESPAN`). Three pieces of evidence beyond the argument: all 20 `@optimystic/upgrade-check` release fixtures carry canonical upper-case affinities, and the oldest (`1.0.0-beta.3`) carries no `declaredType` at all, so both arms of the decision are exercised against real persisted data from every past release; the plugin suite creates `timespan` and `boolean` columns; and a throwaway probe (written, run, deleted — not committed) created and hydrated a table of `varchar(20)`/`int`/`decimal(10,2)`/`interval`/`bool` columns across two sessions and hydrated clean. That answers the handoff's "worth confirming which other declared spellings are created-then-hydrated" with data: the aliasing class is not covered by a committed test, and does not need one, because both sides of the comparison are `inferType` of the same string.
- **The double guard-2 call the implementer flagged as their main judgment call.** The hazard was real and the ordering argument correct — `storeStoredSchema` runs before the settled-schema check, so one call would have persisted the bad record and only then refused. Superseded rather than reverted: the seam placement gets the same ordering for free and covers the ALTER door too.
- **The type's metadata flags.** `supportedCollations: []` does refuse a non-BINARY `collate` rather than permitting everything — both branches of `validateCollationForType` (`@quereus/quereus/src/schema/table.ts`) throw on an empty list, and `resolveDefaultCollation` falls an empty list back to BINARY under a non-BINARY session default. Unset `collationAware` and `semanticOrdering` behave as the comments claim.
- **No `parse` is safe.** `parseValue` passes a value through unchanged when a type has none, and `validateValue` then refuses it at the INSERT/UPDATE boundary — which is what the refusal test observes. `cast(… as blobref)` yields an unvalidated value typed BLOBREF, but no such value can reach a column.
- **`compare`'s `a as string` cast** is the house pattern: `TEXT_TYPE` and all five temporal types cast identically.
- **`db.registerType(name, definition)` compares the two names case-insensitively** (`src/core/database.ts`), so registering `'blobref'` against a definition named `'BLOBREF'` is accepted — the README snippet and `registerPlugin`'s loop are both correct.
- **`isBlobRefColumn` being exported with no in-tree consumer beyond the guard and the spec**, and its `logicalType` arm being unexercised in `src/`. Left as is: the next ticket in this series has to find blobref columns on engine-shaped (`ColumnSchema`) input, so the arm has a near-certain consumer, and structural typing means a caller never needs `BlobRefColumnShape` by name — exporting the interface too would widen the surface for nothing.
- **Resource cleanup and error handling.** Both guards are pure, synchronous and allocate nothing; every added test closes its `Database` in a `finally`.

**Parked as tripwires, not tickets**

- The implementer's existing `NOTE:` on `declaresBlobRef`, which reimplements Quereus's unexported `declaredTypeBase`. Verified the two agree today (text before the first `(`, trimmed) and left the note.
- The stale size note on `schema-manager.ts`, updated in place as above.

**Empty categories** — no ticket was filed and none is owed: every finding was either fixable inside this ticket or genuinely conditional. Nothing was deferred to a later release, nothing was blocked on a decision outside this repo, and no accepted-tradeoff `NOTE:` at any of the sites touched had its revisit condition trip.

## Commands run

Everything below passed, on the final tree.

- `yarn typecheck` and `yarn build` in `packages/quereus-plugin-optimystic`
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 1399 passing, 14 pending, 0 failing (4m), plus `smoke ok quereus@5.6.1`
- `yarn workspace @optimystic/upgrade-check test` — 323 passing (56s), over all 20 release fixtures
- `yarn lint`, `yarn lint:docs` (49 documents, 822 citations, all resolve), `yarn lint:deps`
- `yarn check:rn` — passed (Metro bundle, Hermes compile)
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/blobref-column.spec.ts` — 5 passing

`yarn test:integration` was not run: the change touches no networking, cohort assembly, reactivity or matchmaking code.
