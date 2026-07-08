description: A UNIQUE column used to re-read the whole table for every row written (quadratic on bulk inserts); it now checks each value with a fast index lookup instead. Reviewed and accepted.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique-migration.spec.ts
----

## Summary

Replaced the full-table scan that enforced every secondary UNIQUE constraint on the
optimystic virtual table with an index-backed point probe. Each point-enforceable UNIQUE
constraint now has a backing index tree — a reused declared index, or a synthesized
`_uniq_<cols>` tree kept out of the persisted schema and out of query planning — probed
in ~O(log n) per constraint per row instead of an O(rows) scan per DML row. A one-time
backfill populates a synthesized tree from pre-existing rows on first probe (migration
from an older build that never maintained the tree). `CREATE UNIQUE INDEX`'s derived
constraint is now mirrored onto the cached vtab schema so it is actually enforced.

Conflict resolution (`resolveUniqueConflict`) and the INSERT/UPDATE call sites are
unchanged — the probe returns the same `{ row, columns } | null`, preserving
IGNORE/REPLACE/ABORT + ON CONFLICT semantics.

## Review findings

**Verdict: accepted.** Build, typecheck (exit 0), and the full test suite
(313 passing, 11 pending, 0 failing; smoke ok) all pass at review.

### Checked — correctness
- **Key-framing parity** across the three write/read paths (maintenance
  `insertIndexEntries`, backfill `ensureUniquePopulated`, probe `checkUniqueConstraints`):
  all route through `IndexManager.createIndexKey(descriptor, row)` on the SAME descriptor
  and concatenate the framed pk identically, so probe keys and stored tree keys agree
  byte-for-byte. The probe's `findByIndexIn(tree, probeKey)` uses the proven
  framed-prefix range `[probeKey, probeKey+KEY_PREFIX_END)`. Verified consistent.
- **`excludeKey` semantics**: the probe compares the yielded primary key against
  `excludeKey` (= the updated row's own pk from `extractPrimaryKey`); both are framed pk
  strings. Self-update does not self-collide. Covered by the UPDATE-move test.
- **Set-based column matching** (`columnSetKey`) correctly treats `(a,b)`/`(b,a)` as one
  constraint and reuses a declared index (unique or plain) covering the same set; probe
  and maintenance both frame in the descriptor's column order, so order divergence between
  a constraint and its reused index is harmless.
- **Rollback atomicity**: synthesized trees are opened before `registerCollections`, so
  the bridge snapshots them; `markDirtyTrees` (post-backfill) snapshots them for per-DML
  rollback. Backfill `sync()` commits before that snapshot, so a rollback does not undo
  the backfill. Covered by the rollback test.
- **Partial UNIQUE** (`CREATE UNIQUE INDEX … WHERE`) is skipped by the `active` filter and
  by `buildUniqueEnforcementIndexes`; `addIndex` mirrors the predicate onto the derived
  constraint so it stays skipped. Correct.

### Checked — tests
Coverage is a reasonable floor: basic reject, NULL-exemption, or-ignore, in-one-txn
staged visibility, composite `(a,b)`, bulk-insert (N=300) correctness, UPDATE-move +
self + free, rollback frees the value, `CREATE UNIQUE INDEX` reuse, and a real
`local`-transactor + `FileRawStorage` migration test proving the backfill runs over an
empty tree on a populated collection. Gap acknowledged by the implementer and left as-is:
the bulk test asserts correctness, not a bounded probe-count — deliberate floor.

### Found — filed as a ticket (major)
- **Pure-hydrate reopen enforces no secondary UNIQUE** — `StoredTableSchema` does not
  persist `uniqueConstraints` and `storedToTableSchema` does not reconstruct them, so a
  table reached only through `hydrateCatalog` (no re-`CREATE TABLE`) has an empty
  constraint list → no enforcement, including the control DB's single-use anti-replay
  columns. Pre-existing (the old scan had the identical dependency) and path-conditional
  (the common node path re-CREATEs). Surfaced by the implementer; filed
  `backlog/bug-optimystic-hydrate-unique-not-enforced.md` because it needs a human
  decision (is pure-hydrate enforcement required?) and schema-persistence work.

### Found — recorded as tripwires (not tickets)
- **`CREATE UNIQUE INDEX` on pre-existing duplicate data succeeds silently** then blocks
  future duplicates — diverges from SQLite (which fails the CREATE). Consequence of this
  ticket activating enforcement for that path. Recorded as a `NOTE:` at the `addIndex`
  populate site (`optimystic-module.ts`, before the populate loop). Conditional: only
  matters if a caller builds a unique index over already-duplicate rows.
- **Double-maintenance** when a `CREATE UNIQUE INDEX` lands on columns already carrying a
  synthesized `_uniq_` tree — already `NOTE:`d by the implementer in
  `resolveEnforcingIndex`. Probe correctness preserved (declared index wins). Conditional.
- **All-NULL table re-scans backfill each cold start** — already `NOTE:`d in
  `ensureUniquePopulated`. Cheap no-op. Conditional.
- **Session-mode + backfill `sync()`** is untested (migration test uses `local`). The
  direct-`sync` pattern mirrors `addIndex`, which already does it, so no new risk beyond
  what that path carries. Noted here only; no code change.

### Not found
- No correctness defect in the framing, probe range, backfill emptiness check
  (`tree.at(await tree.first()) === undefined`, the right on-entry signal vs. `isValid`),
  or rollback wiring. No type-safety regressions (typecheck clean). No resource-cleanup
  issues (no new handles beyond the trees, which the existing dirty/bridge machinery
  already flushes/discards).

## Validation

```
cd packages/quereus-plugin-optimystic
yarn build            # success
yarn typecheck        # exit 0
yarn test             # 313 passing, 11 pending, 0 failing; smoke ok
```

Only change made in this review pass: added the `CREATE UNIQUE INDEX`-on-existing-dups
tripwire `NOTE:` at the `addIndex` populate site. No behavior change.
