description: An Optimystic table accepts a duplicate that its declared uniqueness rule should reject in two cases: when the unique column is declared case-insensitive (the plugin compares exact bytes), and when the rule is a partial unique index (the plugin never checks it at all). Quereus's own in-memory tables reject both, so the same declaration behaves differently depending on which storage backs it.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`buildUniqueEnforcementIndexes` — excludes partial constraints by design comment; the uniqueness probe it feeds; `uniqueEnforcementTreeName` / `indexKeyFromValues` in `packages/quereus-plugin-optimystic/src/schema/index-manager.ts` — key bytes carry no collation), packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts (`expectEveryBehaves` avoids both shapes and names this ticket)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Both shapes are rare in the declarations this plugin serves today (sereus declares neither a case-insensitive unique column nor a partial unique index), and collation-aware keys touch the index key encoding, which other tickets already want to change for ordering; a maintainer may reasonably defer until a declaration actually needs one of the two.
----

# What was observed (2026-09-16, while implementing the warm-restart fidelity fix)

One freshly declared table, no restart involved, via the `local` transactor over a `MemoryRawStorage`:

```sql
declare schema app {
  table Every {
    Id integer primary key,
    Name text not null collate nocase,
    Note text null,
    Qty integer not null,
    unique (Name)
  }
  unique index ByNote on Every (Note) where Note is not null
}
apply schema app;
insert into app.Every (Id, Name, Qty, Note) values (1, 'alpha', 3, 'n1');
```

| Insert | Optimystic table | Quereus memory table |
| --- | --- | --- |
| `(6, 'ALPHA', 1, 'n6')` — case variant of an existing `Name` | accepted | `UNIQUE constraint failed: Every (Name)` |
| `(7, 'alpha', 1, 'n7')` — exact duplicate `Name` | `UNIQUE constraint failed: Every.Name` | rejected |
| `(8, 'eta', 1, 'n1')` — duplicate `Note` inside the partial index's scope | accepted | `UNIQUE constraint failed: Every (Note)` |

The memory column was produced by running the identical declaration on a plain `new Database()`.

# Why (from reading the code, not yet traced in a debugger)

- **Collation.** The plugin enforces a secondary UNIQUE with a synthesized enforcement tree keyed by the column values' encoded bytes (`indexKeyFromValues`), and its probe looks the incoming key up in that tree. Nothing in that path consults the column's `collation`, so `'alpha'` and `'ALPHA'` are two keys. The index descriptors do carry a `collation` field per column, so the information is available where the key is built.
- **Partial predicate.** `buildUniqueEnforcementIndexes` excludes any constraint with a `predicate` ("never point-enforced here, matching the probe's own filter"), and no other path enforces it: the `ByNote` index tree is maintained, but no probe consults it before a write. Quereus's memory module enforces the derived constraint by evaluating the predicate and checking the index.

# Expected

A declaration enforces the same uniqueness rule whichever module backs the table: a case-insensitive unique column rejects case variants, and a partial unique index rejects duplicates among rows its predicate admits (rows outside the scope — `Note is null` here — stay free).

# Notes for whoever picks this up

- Both arms resolve at one site — the uniqueness probe and the enforcement descriptors that feed it — so treat this as one change with two arms, not two tickets.
- Row-level enforcement of a partial constraint needs the predicate evaluated against the candidate row; the descriptors already persist the predicate AST, and the vtab evaluates partial-index predicates for index maintenance, so the evaluator exists.
- A collation-aware enforcement key changes the bytes in the synthesized `_uniq_` trees; existing trees would need the one-time rebuild `ensureUniquePopulated` already performs when a tree is renamed. `tickets/backlog/debt-optimystic-true-key-ordering` wants collation-aware key ordering for a different reason; the two should agree on one encoding.
- The warm-restart spec (`hydrate-restores-declared-table.spec.ts`, `expectEveryBehaves`) deliberately inserts an exact-case duplicate and never a duplicate under the partial index; once this lands, those two assertions can be strengthened to the memory-table behaviour above.
