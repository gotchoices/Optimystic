description: Re-creating a table with its columns in a different order (without dropping it first) leaves an existing index pointing at the wrong column, after which rows silently disappear from queries that use that index.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Nobody has hit this in practice, and the clean fix changes the on-disk shape of every persisted index descriptor — which needs its own compatibility story (see `debt-optimystic-key-format-migration`), so a maintainer may reasonably prefer to refuse the re-declare outright, or to do nothing until someone actually reorders columns.
----

## What happens

The plugin stores each table's shape as one record in a shared catalog. Inside that
record, an index says which columns it covers **by position** — "column 2" — not by
name. The stored column list and the stored index list are then allowed to change
independently:

- When a session re-declares a table (`CREATE TABLE` on a name that already exists in
  the catalog, no `DROP` in between) with a *different* column layout, the plugin
  deliberately lets the local declaration win on columns — that is the supported way a
  node states its own view of the table's shape.
- Indexes, by contrast, are deliberately **preserved** from the catalog, because a
  `CREATE TABLE` statement never carries its `CREATE INDEX` siblings and dropping them
  would be worse.

Both rules are individually right. Together they write a record whose index positions
refer to the *old* column layout while the column list is the *new* one. Nothing
detects the mismatch, and the index quietly starts covering a different column than its
name and its original declaration say.

## Reproduction (verified 2026-08-13, on the tree at review of `schema-catalog-index-list-is-lossy`)

Two sessions over one shared local storage:

```sql
-- session A
CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT) USING optimystic('tree://cs/t');
CREATE INDEX idx_b ON t(b);
INSERT INTO t VALUES (1, 'aaa', 'bbb');

-- session B: same table, columns b and a swapped, no DROP
CREATE TABLE t (id INTEGER PRIMARY KEY, b TEXT, a TEXT) USING optimystic('tree://cs/t');
```

The catalog record after session B's statement:

```
columns: [id, b, a]
indexes: [{ name: "idx_b", columns: [{ index: 2 }] }]     <-- position 2 is now column `a`
```

`idx_b` is now declared over column `a`. A third session that starts from the persisted
schema (so its planner can actually see `idx_b`) then answers an indexed lookup wrongly:

```
SELECT * FROM t;                  -> [{id:1, b:'bbb', a:'aaa'}, {id:2, b:'B2', a:'A2'}]
SELECT * FROM t WHERE a = 'aaa';  -> []        <-- row 1 exists and matches; it is missed
```

The full scan sees the row; the indexed lookup does not, because row 1's index entry was
built when `idx_b` still meant column `b`.

**Pre-existing, not introduced by the index-durability work.** The rule that preserves
persisted indexes across a re-declare predates it (it was already `{...candidate,
indexes: persisted.indexes}` whenever the incoming declaration listed no indexes), and
that is the path this reproduction takes. The durability work generalised the same rule
to a union without changing what ends up persisted here.

**Un-run, plausibly harsher variant:** if the re-declared table has *fewer* columns than
the original, a preserved index position can point past the end of the column list
entirely. The reproduction above only covers reordering; nobody has run the shrinking
case, so its failure mode (wrong key vs. an outright throw) is unknown.

## Why the fix should be representational, not a patch at the write site

Guarding the one write site ("reject the re-declare when a persisted index's position no
longer names the same column") would close this reproduction and nothing else — the same
positional-drift hazard is latent anywhere a stored index descriptor outlives the column
list it was written against.

The state is better made unrepresentable: **persist index columns by column name**, and
resolve names to positions when a schema is loaded. Then a column layout change either
resolves cleanly (the named column still exists, wherever it now sits) or fails loudly at
load time (the column is gone) — there is no way to express "column 2" and be silently
wrong about which column that is. `StoredIndexSchema.columns[].index` is the field; the
same question applies to `StoredUniqueConstraint.columns` and
`StoredPrimaryKeyColumn.index`, which are re-written from the local declaration on every
open today and so happen to stay consistent — worth deciding deliberately rather than by
accident.

Whatever shape is chosen must state what happens to catalogs already written in the
positional form; `debt-optimystic-key-format-migration` is the existing home for that
kind of "the on-disk bytes changed" question and should be settled alongside.

## Related

- `backlog/more-design/6.5-schema-versioning` — a table re-declared with a different
  shape is a migration, and a real versioning design might subsume this. It is a design
  ticket with no settled answer; this defect does not need to wait for it, since naming
  index columns is independently correct.
