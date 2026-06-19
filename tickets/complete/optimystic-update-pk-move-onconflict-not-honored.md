description: A primary-key-changing UPDATE that lands on a key another row already holds now reports the clash through the engine's normal channel instead of throwing its own error, matching how INSERT already behaves.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
----

## Summary of landed work

`OptimysticVirtualTable.update`'s PK-move branch (`oldKey !== newKey` in
`case 'update'`, `src/optimystic-module.ts:838`) no longer throws an ad-hoc
`ConstraintError` when the moving row collides with a row already at `newKey`.
It now decodes the displaced row once and switches on
`args.onConflict ?? ConflictResolution.ABORT`, returning a structured
`UpdateResult` byte-for-byte parallel with the INSERT path (L760–L802):

- **IGNORE** (L854) — stage nothing, no `markDirtyTrees()`, `return { status: 'ok' }`.
- **REPLACE** (L861) — `markDirtyTrees()`; stage `[[oldKey, undefined],
  [newKey, [newKey, encodedRow]]]`; then, in order, `deleteIndexEntries(existingRow,
  newKey)` followed by `updateIndexEntries(oldKeyValues, values, oldKey, newKey)`;
  `decrementRowCount()`; `return { status: 'ok', row: values, replacedRow: existingRow }`.
- **ABORT / FAIL / ROLLBACK** (default, L900) — `return { status: 'constraint',
  constraint: 'unique', message: this.uniqueConstraintMessage(), existingRow }`.
  No trees touched.

The non-collision PK-move and the in-place `oldKey === newKey` update are
unchanged. Dead `ConstraintError` / `StatusCode` imports were dropped.

The single externally-observable change: a default-mode PK-move collision is
still rejected, but the message changed from the hand-rolled
`UNIQUE constraint failed: <table> primary key '<key>'` to the SQLite-style,
column-qualified `UNIQUE constraint failed: T.id` (shared
`uniqueConstraintMessage()` helper), matching INSERT.

## Review findings

### What was checked

- **Implement diff read first, fresh eyes** (`git show 86092be`) before the
  handoff summary, then the full surrounding `update()` method, the parallel
  INSERT path, `index-manager.ts`, `markDirtyTrees()`, and
  `uniqueConstraintMessage()`.
- **REPLACE index-staging ORDER** (the handoff's flagged "subtlest unverified
  bit") — read `index-manager.ts:103–178` against `optimystic-module.ts:861–897`
  and traced every collision shape by hand:
  - shared indexed value (B.cat == A.cat, both touch `<idx>\x00<newKey>`):
    delete-displaced → delete-old-moving → insert-new-moving leaves the
    surviving moving-row entry in place. **Correct.**
  - A's *new* indexed value equals B's value at the shared PK
    (`<idx>\x00<newKey>` deleted by step 1, re-inserted by step 2): survives as
    A's entry. **Correct.**
  - disjoint indexed values: three distinct tree keys, no interference.
    **Correct.**
  The reverse order (update-then-delete) would wrongly drop the surviving entry;
  the chosen order is right. The comment at L874–882 accurately describes it.
- **`decrementRowCount()` placement** — present only on REPLACE (the one
  count-reducing update: a displaced row vanishes), absent from IGNORE, ABORT,
  and the non-collision path; mirrors the DELETE path (L957). **Correct.**
- **`markDirtyTrees()` coverage** — marks the main collection *and* every index
  tree (L671–680), so REPLACE's single call before staging covers index trees,
  consistent with the non-collision path. **Correct.**
- **Removed imports** — `grep ConstraintError|StatusCode` over `src/` returns no
  dangling reference; the catch block rethrows `QuereusError` (separate, kept).
  **Clean.**
- **Message change blast radius** — no test or doc asserts the old `primary key
  '<key>'` wording; the package's `.md` files mention neither the message nor
  conflict behavior, so no docs went stale.
- **Build / typecheck / tests** — in `packages/quereus-plugin-optimystic`:
  `npm run build` clean, `npm run typecheck` clean, `npm test` →
  **236 passing, 5 pending, 0 failing**. No pre-existing failures; no
  `.pre-existing-error.md` filed.

### Findings and disposition

- **Major — REPLACE/IGNORE branches are unreachable from SQL today (KEPT, no
  ticket).** Confirmed independently: Quereus has no `UPDATE OR <conflict>`
  grammar and its planner hard-codes `onConflict = undefined` for UPDATE, and
  optimystic reads no per-constraint `ON CONFLICT` default — so a PK-moving
  UPDATE always arrives as ABORT. The REPLACE/IGNORE code is therefore currently
  dead. **Disposition: keep as-is.** Collapsing to ABORT-only would create an
  INSERT/UPDATE asymmetry (INSERT keeps the same three branches and *is*
  reachable via `INSERT OR …`), and the branch would have to be re-added the
  moment the engine supplies a non-ABORT onConflict for updates. The branch
  reuses only primitives already exercised by passing tests, and I verified its
  index ordering and row-count accounting above, so it is correct-by-
  construction. The only enabler — `UPDATE OR REPLACE` grammar or per-constraint
  `ON CONFLICT` resolution — lives in the external **quereus** engine, not this
  repo, so there is nothing actionable to file here. This is a documented,
  deliberate parity decision, not a defect.

- **Minor — none requiring an inline fix.** The collision branch, the unchanged
  non-collision/in-place paths, error handling, resource cleanup
  (stage/markDirty atomicity), and type safety all held up under inspection.

### Coverage assessment

The three added tests cover the entire **SQL-reachable** surface (ABORT only):
rejection with the column-qualified message + both rows intact across reopen
(the genuine regression guard — pre-fix the message lacked `T.id`); a
non-colliding PK-move still succeeding; and an ABORT collision leaving a
secondary index intact. The four originally-drafted `UPDATE OR REPLACE/IGNORE`
tests were correctly removed (they fail at parse time).

Acknowledged residual gaps, accepted as out of reach this pass (not regressions):
- REPLACE/IGNORE have no executed test — unreachable from SQL, and a direct
  `table.update({onConflict})` call would test the method outside the
  commit/rollback lifecycle it depends on. Their correctness rests on the
  inspection above. Will become testable only alongside the engine change that
  makes them reachable.
- A *successful* PK-move alongside a secondary index exercises the unchanged
  shared `updateIndexEntries` path; not newly covered here, but untouched by
  this diff.

### Verdict

Implementation is correct, consistent with the INSERT path, and green on build,
typecheck, and the full suite. No inline fixes were needed and no follow-up
ticket is warranted — the lone major item is an external-engine limitation the
implementer handled with a sound, well-documented parity decision.
