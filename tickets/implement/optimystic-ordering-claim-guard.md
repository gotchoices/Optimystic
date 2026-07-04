description: Fix mis-ordered query results by making the query planner only promise "already sorted" for the cases the storage tree can actually deliver, instead of also promising descending and numeric orderings it can't.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/README.md
difficulty: medium
----

## The bug (reproduced by analysis)

The Optimystic virtual-table planner (`OptimysticModule.getBestAccessPlan`,
`optimystic-module.ts:1696`) tells the Quereus engine, via
`providesOrdering`, when a chosen access path already returns rows in the
`ORDER BY` order — so the engine can skip its own sort. The underlying B+tree,
however, is opened with a **raw lexicographic string comparator**
(`collection-factory.ts:46`, `a < b ? -1 : a > b ? 1 : 0`) and is only ever
iterated **ascending**. When the planner promises an ordering the tree does not
actually deliver, the engine trusts the promise, skips the sort, and the result
set comes out genuinely mis-ordered — wrong results, not just slow.

State of each path that sets `providesOrdering` (after
`optimystic-pk-range-filter-not-applied` landed):

- **Full-PK equality point lookup** (`optimystic-module.ts:1746`) — returns a
  single row, so any `ORDER BY` is trivially satisfied. **Safe, leave as-is.**
- **PK range** (`optimystic-module.ts:1761`) — already sets no ordering and is
  not pushed down as a seek. **Safe.**
- **Secondary-index equality seek** (`optimystic-module.ts:1832`, via
  `orderingMatchesIndex`) — **this is the live defect.** `orderingMatchesIndex`
  (`optimystic-module.ts:1881`) matches the required ordering against the index
  columns *positionally* and checks only that the `desc` flags are equal — it
  never checks that the tree can actually produce that order. So it promises:
  - **DESC orderings** — the tree iterates ascending only, so a declared-DESC
    index (`CREATE INDEX ... (col DESC)`) with `ORDER BY col DESC` is promised
    but delivered ascending. Always wrong.
  - **Numeric suffix columns** — for `WHERE a = ? ORDER BY a, b` on index
    `(a, b)` where `b` is INTEGER/REAL, the tree orders `b` by its
    `toExponential(15)` payload lexicographically. That breaks for exponents
    ≥ 10 and for negatives (e.g. prices `2, 5, 10, 100` come back
    `10, 100, 2, 5`). Promised as ordered; delivered mis-ordered.
  - **Non-BINARY collations** — the tree compares raw code units, ignoring any
    `COLLATE NOCASE` etc. on the ordered column. Promised; delivered by BINARY.

### Deterministic proof of the underlying non-order-preservation

No build needed to confirm the encoding half:

- PK: `RowCodec.serializeKeyPart` (`row-codec.ts:159-163`) returns
  `value.toString()`, so `10 -> "10"`, `2 -> "2"`, and lexicographically
  `"10" < "2"`. Numeric PK order is `1, 10, 2`.
- Index: `serializeIndexValue` (`index-manager.ts:59-63`) returns
  `value.toExponential(15)`; `10 -> "1.0…e+1"`, `100 -> "1.0…e+2"`,
  `2 -> "2.0…e+0"` sort as `10, 100, 2` — wrong for exponents ≥ 10.
- The order-aware comparator `RowCodec.createPrimaryKeyComparator`
  (`row-codec.ts:238`) exists but is **dead code** — never passed to
  `Tree.createOrOpen` (`collection-factory.ts:54`). It also has a documented
  type-sniff bug: `deserializeKeyPart` (`row-codec.ts:304-313`) runs
  `Number(serialized)` first, so on a TEXT column `'123'` deserializes to number
  `123`, `' '` to `0`, `'1e2'` to `100`. See the passing "known bug" tests in
  `row-codec.spec.ts:266`, `:352`, `:375`.

## Why the guard, not the "true fix," resolves this ticket

The ticket floated two long-term options — wire the real comparator into the
tree, or move to an order-preserving key encoding. **Both change the order in
which keys sit in the B+tree**, which means an existing persisted tree written
under today's lexicographic order becomes internally inconsistent after the
change (node binary-searches break; rows silently vanish/duplicate). That is
exactly the migration hazard already recorded in
`debt-optimystic-key-format-migration`, and it is a product decision a human owns
— not something to bundle into a bug fix.

Crucially, **neither option removes the need for this guard**: a B+tree iterated
forward is ascending, so DESC can never be "already provided" without reverse
iteration, and arbitrary collations can never be provided by a BINARY tree. So
the guard is the foundational, must-land fix; true numeric/DESC/collated
ordering is separate, gated work (`debt-optimystic-true-key-ordering`).

We also **reject the ticket's "at minimum, reject non-TEXT / DESC / collated PKs
at `create()`" fallback.** Hard-rejecting would break existing behaviour (the
numeric-PK round-trip tests at `row-codec.spec.ts:43` and real numeric-PK usage)
and is user-hostile. With the guard in place a numeric PK is *correct* (the
engine re-sorts) — just not pushed down. Correct-but-slower beats rejected.

## What to build

### Phase 1 — Guard the ordering claims (the fix)

Tighten the secondary-index ordering promise so it is made **only** for
orderings the raw lexicographic ascending tree genuinely delivers: every ordered
column must be **ASC**, **BINARY collation**, and **TEXT affinity**.

- `orderingMatchesIndex` (`optimystic-module.ts:1881`) currently receives only
  the index column list (`{ index, desc }`). Thread the table's column metadata
  in (it has `tableInfo` in scope at the call site, `optimystic-module.ts:1832`)
  so that, per required-ordering column, it can also require:
  - `orderSpec.desc === false` (already partly there — but must reject any DESC,
    even when the index column is declared DESC),
  - the column's collation resolves to `BINARY` (default),
  - the column's affinity is `TEXT` (not INTEGER/REAL/NUMERIC/BLOB).
  If any ordered column fails, return `false` → `bestOrdering` stays undefined →
  the engine sorts → correct output.
- Leave the point-lookup branch (`optimystic-module.ts:1746`) unchanged (single
  row).
- Note the currently-dead `orderingMatchesPrimaryKey` helper
  (`optimystic-module.ts:1856`) has no caller — either delete it or, if kept for
  a future ordered-PK-scan path, give it the same TEXT/BINARY/ASC guard so it is
  never wired up unsafely. Do not leave an un-guarded ordering helper lying
  around as a foot-gun.

### Phase 2 — Fix the dead comparator's type-sniff (prep, low risk)

This does not change any live behaviour (the comparator is still dead code after
this ticket), but the ticket explicitly calls it out and it de-risks the future
true-ordering work, so fix it now while the context is loaded:

- Make `deserializeKeyPart` / `keyElementToValue` (`row-codec.ts:292-313`)
  **affinity-driven** instead of sniffing with `Number()`. The comparator
  already has `this.schema` and each `pkDef` entry's column index, so it can look
  up `this.schema.columns[def.index].affinity`: TEXT → keep the string,
  INTEGER/REAL/NUMERIC → parse number, BLOB → keep as-is/decode. This removes the
  `'123'`/`' '`/`'1e2'`/`'0xff'` mis-classification.
- Flip the three "known bug" tests in `row-codec.spec.ts` (`:266`, `:352`,
  `:375`) from asserting the buggy numeric behaviour to asserting correct
  affinity-driven behaviour.
- The comparator stays dead (not wired into the tree) — wiring it is
  `debt-optimystic-true-key-ordering`'s job, because that flips storage order and
  triggers the migration hazard. Update the `NOTE:` at `row-codec.ts:249-252`
  and the raw-fallback `NOTE:` at `row-codec.ts:280-289` to point at
  `debt-optimystic-true-key-ordering` (they currently say "sq-2").

### Phase 3 — Reproducing tests

Add SQL-level regression tests (harness: `db.exec` / `db.eval` / `collectRows`,
see `index-support.spec.ts`). Each must **fail before Phase 1 and pass after**:

- **Numeric suffix**: index `(category, price)`, rows with prices spanning an
  exponent-10 boundary (e.g. `2, 5, 10, 100` in one category),
  `SELECT price FROM products WHERE category = ? ORDER BY category, price` must
  return ascending numeric order.
- **DESC index**: index `(category, price DESC)`,
  `... WHERE category = ? ORDER BY category, price DESC` must return descending
  numeric order.
- **Collation** (if the harness supports `COLLATE`): case-insensitive ordering
  must not be silently served as BINARY.

Confirm the planner actually selects the index seek for the query (add rows /
check the `EXPLAIN`/plan if the optimizer otherwise prefers a scan — a scan makes
the engine sort and would mask the bug). If shaping the plan proves fragile,
document it and fall back to asserting the fix at the `orderingMatchesIndex`
level with a direct unit test plus the deterministic encoding facts above.

### Phase 4 — Docs

`README.md` currently says "Primary keys must be TEXT" (lines 82, 229). With the
guard, non-TEXT PKs are *correct*, just not order-optimised. Soften to
"Primary keys should be TEXT for ordered/range performance; other types work
correctly but are not pushed down / order-provided." Keep it honest and short.

## Handoff notes for the reviewer

- The wrong-results defect is fully resolved by Phase 1 alone; Phases 2/4 are
  prep + docs, Phase 3 is the guard rail.
- True numeric/DESC/collated ordering is **out of scope** and intentionally
  deferred to `debt-optimystic-true-key-ordering`, which is gated on the
  `debt-optimystic-key-format-migration` product decision.
- `debt-optimystic-pk-range-seek`'s premise ("sq-2 fixed the comparator and
  encoding so tree order matches SQL order") is **not** satisfied by this ticket
  — its real gate is `debt-optimystic-true-key-ordering`. Its `prereq:` has been
  repointed accordingly.

## TODO

- [ ] Phase 1: thread column affinity/collation into `orderingMatchesIndex`;
      only promise ordering for ASC + BINARY + TEXT columns; reject all DESC.
- [ ] Phase 1: guard or delete the unused `orderingMatchesPrimaryKey`.
- [ ] Phase 2: make `deserializeKeyPart`/`keyElementToValue` affinity-driven;
      flip the three "known bug" comparator tests; update the two `NOTE:`s to
      cite `debt-optimystic-true-key-ordering`.
- [ ] Phase 3: add failing→passing SQL tests for numeric-suffix, DESC-index, and
      (if supported) collation orderings; verify the index seek is chosen.
- [ ] Phase 4: soften the README "must be TEXT" claim.
- [ ] Run `yarn build`, `yarn typecheck`, `yarn test` from
      `packages/quereus-plugin-optimystic` (stream with `tee`); all green.
