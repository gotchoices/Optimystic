description: A secondary-index helper used to serialize whole numbers (as BigInt) and plain numbers inconsistently, which could orphan stale index rows; the three duplicate copies were merged into one type-insensitive function and reviewed.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/index-serialize-value.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts
difficulty: medium
----

## Summary of shipped work

Three byte-identical secondary-index value serializers were consolidated into one
exported `serializeIndexValue(value: SqlValue): string` in
`src/schema/index-manager.ts`. The only behavioral change vs. the old copies: the
`bigint` branch now returns `Number(value).toExponential(15)` (was `value.toString()`),
so a `bigint` and the equal `number` produce a byte-identical index key. All three
callers were repointed at the shared function:
- `IndexManager.createIndexKey` (insert/update/delete index staging),
- `OptimysticVTab.executeIndexScan` (equality-seek key builder),
- `OptimysticVTab.uniqueKeyFor` (secondary-UNIQUE probe; now
  `serializeIndexValue(row[ci] ?? null)`).

The premise the implement ticket asserted as fact — that integer INSERTs arrive as
`bigint` and become `number` after a storage round-trip, producing a live orphan — is
**not true for the pinned `@quereus/quereus`**: integer literals reach the serializer
as `number` on every SQL path. The bug is therefore **latent hardening + a genuine
de-duplication**, not a fix for a currently-reproducible corruption. Graded as such.

## Review findings

**Reviewed:** the full implement diff (commit `ffcd645`), the current state of all four
touched files, the three call sites, the `RowCodec.normalizeValue`/`denormalizeValue`
round-trip the doc comment relies on, and both new tests. Build, typecheck, and the
full package suite were run.

- **Consolidation completeness — checked, clean.** Searched the package for
  `serializeValue` / `serializeValueForIndex`: both private copies are gone, no dangling
  references remain, and all three callers route through the single exported function.
  The `{@link serializeIndexValue}` doc reference in `uniqueKeyFor` resolves. No 4th
  index-key builder exists (`RowCodec.serializeKeyPart` is the separate PK encoder and
  correctly uses `.toString()` for both numeric types — it never had this bug).

- **Unification correctness — checked, sound.** `Number(bigint).toExponential(15)`
  equals `number.toExponential(15)` for every case where the two represent the same
  logical value, including negatives (`-42n` → `"-4.200000000000000e+1"`) and the
  large-integer path: a value stored as a tagged `{$bigint}` decodes back to `bigint`,
  and both the insert-side and decoded-old-side collapse through `Number(...)` to the
  same (possibly lossy) string — so no case reintroduces an orphan.

- **Null/undefined handling — checked, correct.** `createIndexKey` and `uniqueKeyFor`
  use `value ?? null` (not `||`), so `0`/`''`/`false` pass through unchanged; the seek
  path passes the raw arg, and `serializeIndexValue` maps both `null` and `undefined`
  to the same `'\x01'` marker, so all three paths agree.

- **Docs — checked, accurate.** The serializer's doc comment claims (small bigint →
  `Number` on encode, large bigint → tagged `{$bigint}` object, decode restoring type)
  were verified against `src/schema/row-codec.ts:189-223`. The rejected-alternatives
  rationale (don't route through `normalizeValue`; don't emit a plain integer string) is
  correct and matches the code. No stale docs were found that should have been updated.

- **Tests — checked, adequate; fail-before/pass-after honest.** The unit spec
  `test/index-serialize-value.spec.ts` is the real reproduction (bigint↔number parity,
  which fails on the old `.toString()` branch); the integration case in
  `index-support.spec.ts` is correctly labelled a black-box behavioral guard, not a
  reproduction, since numbers-on-both-sides means it never failed on old code. Covered:
  happy path, null/undefined, string passthrough, self-consistency, integer end-to-end
  (index-tree scan + equality seek), and the UNIQUE path via the existing
  secondary-unique specs. Result: **262 passing, 11 pending, 0 failing**; build + `tsc
  --noEmit` clean.

- **Minor fixes applied inline:** none — nothing required correction.

- **Major findings (new tickets):** none. The consolidation is complete and the fix is
  correct; no follow-up work rises to a ticket.

- **Tripwires (parked, not tickets):**
  - **Large-integer precision ceiling** — already parked by the implementer as a
    `NOTE:` at the serializer site and in its doc comment: `Number(bigint).toExponential(15)`
    is lossy beyond `Number.MAX_SAFE_INTEGER`, so two distinct huge integers can collide
    onto one index key. Stays self-consistent (never orphans); same ceiling REAL columns
    already have. No action.
  - **Bound-`BigInt`-parameter path is the latent trigger and is untested.** A bound
    `BigInt` parameter (or a future Quereus emitting integer literals as `bigint`) is the
    one surface that could push a `bigint` into the write/seek path and make the old bug
    *live*. This fix makes it correct either way, so it is genuinely conditional, not a
    dormant defect — recorded here rather than filed. If a future change starts binding
    `BigInt` params through this table, add an integration test exercising it.

## Validation commands

From `packages/quereus-plugin-optimystic` (build must precede test — integration specs
import the compiled `dist/plugin.js`; the unit spec imports source):
`npm run build` → `npm run typecheck` → `npm test`.
