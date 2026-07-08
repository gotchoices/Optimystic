description: When an optimystic table is reopened without re-running its CREATE TABLE statement, its UNIQUE constraints (other than the primary key) stop being enforced, so duplicate values can slip in — including the single-use anti-replay values the control database relies on.
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: hard
----

## What is wrong

The optimystic virtual table enforces every non-primary-key UNIQUE constraint in
application code (the B-tree only structurally guarantees the primary key). That
enforcement reads the constraint list from the live table schema object
(`this.tableSchema.uniqueConstraints`).

That list is only populated when the table is (re-)declared with a local `CREATE TABLE`
statement (`hasLocalColumns` in `optimystic-module.ts:186`). It is the common optimystic
path, because nodes typically re-CREATE their tables on open. But:

- `StoredTableSchema` (the persisted schema form) does **not** store `uniqueConstraints`.
- `SchemaManager.storedToTableSchema` (`schema-manager.ts:185`) does **not** reconstruct
  them — the returned `TableSchema` has `uniqueConstraints === undefined`.

So a table reached **only** through catalog hydration (`hydrateCatalog`, wired as the
plugin's `hydrate` hook in `plugin.ts`) — i.e. reopened without a fresh `CREATE TABLE` —
has no unique constraints in memory. Result: `checkUniqueConstraints` sees an empty list
and enforces **nothing** beyond the primary key. `buildUniqueEnforcementIndexes` likewise
synthesizes no trees.

## Why it matters

The CadreControl schema uses single-use UNIQUE columns (`StampId`, and a nullable
`MemberPrivateKey`) as an anti-replay guard: a given stamp may be written at most once.
On a pure-hydrate reopen that guarantee is silently absent — a replayed stamp would be
accepted. This is a correctness/security gap, not just a performance one.

## Scope / history

- This is **pre-existing** — the old full-table-scan enforcement had the identical
  dependency on `this.tableSchema.uniqueConstraints`; the recently-landed index-backed
  probe (`optimystic-unique-probe-index-backed`) did not regress it, only surfaced it.
- It is **path-conditional**: the common node path re-CREATEs tables and is unaffected.
  It bites only a reopen that hydrates the catalog and then does DML without re-declaring
  the table.

## What a fix needs to decide (human input)

1. Is pure-hydrate enforcement actually required, or is re-CREATE-on-open a guaranteed
   invariant for every deployment that cares about the anti-replay guard? If the latter,
   this may downgrade to a documented invariant + an assertion rather than code.
2. If enforcement is required: persist `uniqueConstraints` (columns + predicate +
   `derivedFromIndex`) in `StoredTableSchema` and reconstruct them in
   `storedToTableSchema`, so the hydrate path carries them. Verify the synthesized
   `_uniq_` trees and backfill then behave identically on a hydrate-only open (the
   migration backfill already covers an empty tree over populated rows).

## Acceptance

- A table opened via hydrate-only (no re-CREATE) rejects a duplicate of a secondary
  UNIQUE value, matching the re-CREATE path.
- A regression test that opens a persisted collection through the hydrate path (not a
  fresh `CREATE TABLE … unique`) and asserts the duplicate is rejected.
