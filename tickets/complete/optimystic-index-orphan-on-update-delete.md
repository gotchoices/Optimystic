description: Committed UPDATE or DELETE of an indexed-column value left a stale secondary-index entry behind; fixed by fetching the real old row before staging so index keys are computed from the actual old values. Reviewed and verified.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts
----

## Summary

Secondary-index entries were orphaned after a committed UPDATE (of an indexed
column) or DELETE. Root cause: `UpdateArgs.oldKeyValues` is a PK-only array,
but `IndexManager.createIndexKey` reads `row[indexCol.index]` at the column's
**full-schema** position — so any non-PK indexed column read back `undefined`,
producing a NULL-marker index key that never matched the real entry. The
stale-entry delete became a no-op and the orphan survived.

The implement stage fixed all three index-maintenance call sites in
`OptimysticVirtualTable.update()` by fetching the real old row
(`collection.get(oldKey)` + `rowCodec.decodeRow()`) **before** any
`collection.stage()` call, and passing the decoded full row (instead of the
PK-only `oldKeyValues`) into `updateIndexEntries` / `deleteIndexEntries`:

- simple + key-change UPDATE (non-collision)
- UPDATE OR REPLACE collision branch (moving row's old entries)
- DELETE

A defensive fallback to `oldKeyValues as Row` guards the should-never-happen
case of a missing row so valid DML is never broken by index maintenance.

## Review findings

### What was checked

- **Diff, read fresh first.** Re-derived the root cause from `createIndexKey`
  (`index-manager.ts`) and the three patched call sites before reading the
  handoff. Confirmed the PK-only-vs-full-schema-position mismatch is the real
  defect and the fetch-before-stage ordering is the correct remedy.
- **All call sites.** Searched every `oldKeyValues` reference. The only
  remaining uses are `extractPrimaryKey(oldKeyValues)` (correct — PK extraction)
  and the intentional fallback. No index-maintenance site was missed.
- **Ordering constraint.** Verified each `collection.get(...)` precedes every
  `collection.stage(...)` in its branch — staging is an upsert that would
  clobber the old slot, so a fetch-after would read the wrong image.
- **Staged-read correctness.** The fix relies on `collection.get` returning
  staged-this-tx state (for chained updates). This is the same mechanism the
  already-heavily-tested PK-move collision detection (`get(newKey)`) depends on,
  so the reliance is sound by construction.
- **Build / typecheck / tests.** `npm run build`, `npm run typecheck`, and the
  full mocha suite all pass. (No real lint is configured — root `lint` is a
  no-op echo.) Tests: **245 passing, 4 pending, 0 failing**.
- **Docs.** Grepped all `*.md` and source/test comments for the old
  "retains an orphan / tracked by backlog" language. The only stale reference
  (in `session-mode-commit.spec.ts`) was already corrected by the implementer;
  no markdown doc described the bug. Documentation reflects the new reality.

### What was found

- **Correctness — confirmed correct.** Fix is right at all three sites; the
  regression tests are genuine guards (pre-fix the UPDATE test would have seen 4
  index entries, not 3, because the stale `b` entry was never deleted).
- **UPDATE OR REPLACE branch has no end-to-end test — *not* a gap.** That branch
  is unreachable from Quereus SQL today: the parser has no `UPDATE OR REPLACE`
  grammar and the planner hard-codes `onConflict = undefined` for UPDATEs, so a
  PK-moving UPDATE always arrives as ABORT (documented at length in
  `insert-pk-uniqueness.spec.ts`). The `oldKeyValues → oldRow` change there is
  correct-by-construction and cannot be driven from SQL. The implementer's note
  is accurate.
- **Extra read per mutation — accepted, by design.** Every UPDATE/DELETE now
  performs one additional `collection.get(oldKey)`. This is necessary because
  the engine passes only the PK in `oldKeyValues`; the cheaper fix (have Quereus
  pass the full old row) lives in the external `@quereus/quereus` engine and is
  out of scope here.
- **Latent, pre-existing, out of scope — non-leading / composite PK.**
  `extractPrimaryKey(oldKeyValues)` reads PK values at full-schema positions. If
  the engine supplies `oldKeyValues` as a compact PK-only array for a table
  whose PK is *not* at leading schema positions, the derived `oldKey` could
  mis-key. This predates the fix, is not exercised by any test (all tests use a
  single INTEGER PK at position 0), and — if real — would break the delete/get
  key itself far more broadly than index maintenance. Flagged as an observation;
  not filed, because confirming it requires investigating the Quereus
  `xUpdate`/key-marshalling contract, which is beyond this ticket's scope.

### What was done

- **Minor (fixed inline):** added two edge-case regression guards to
  `index-support.spec.ts`, both passing:
  - *no-op-index UPDATE* — changing only a non-indexed column keeps the index at
    exactly N entries with both keys intact (exercises `updateIndexEntries`'s
    early-return *after* the new fetch/restage, guarding against an accidental
    drop or duplicate).
  - *non-unique index sibling* — when two rows share an indexed value, moving one
    removes only that row's composite key (`b\x002`) and leaves the sibling's
    (`b\x001`) in place.
- **Major:** none filed — no major findings.

### Test results

`npm run build && npm run typecheck && npm test` — **245 passing, 4 pending,
0 failing** (up from 243; the two added guards account for the delta).

## Notes for future work (not blocking)

- The `scanIndexKeys` helper (`index-support.spec.ts`) and `countTreeEntries`
  (`session-mode-commit.spec.ts` / `deferred-constraint-rollback.spec.ts`) are
  near-duplicate fresh-tree scanners. Extracting a shared test utility would cut
  the duplication; deferred as a cleanup, not a correctness issue.
