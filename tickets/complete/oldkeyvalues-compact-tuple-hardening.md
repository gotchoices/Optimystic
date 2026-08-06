description: The last two loose ends from a bug where updating a row in place got wrongly rejected as a duplicate of itself are now closed — an error-recovery path that misread the row identifier the same way, and a cheap check that would have caught the whole mistake immediately.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/test/oldkeyvalues-compact-shape.spec.ts, packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/README.md
----

# `oldKeyValues` compact-tuple hardening — complete

Follow-on to `bug-same-key-update-reports-unique-collision-with-itself`. That fix landed
earlier and is not part of this work; this ticket closed its two remaining arms.

## Background

quereus's contract for `UpdateArgs.oldKeyValues` (`packages/quereus/src/vtab/table.ts`):
it is a **compact key tuple** — exactly one cell per `primaryKeyDefinition` entry, in that
order — **not** a full row indexed by column position. A vtab must address it as
`keyValues[i]` for PK column `i`, never `row[pkDef[i].index]`. The two forms agree only
when the PK columns happen to be the table's leading columns in PK order; anywhere else,
reading the tuple as a row runs off its end and silently produces a wrong key.

## What shipped

**Arm 1 — no more fabricated pre-write row.** Both the UPDATE and DELETE paths fetch the
pre-write row image before staging (index maintenance needs it to compute the old
index-tree keys). Both used to fall back to `oldKeyValues as Row` when that fetch missed —
the same compact-tuple-as-row category error the core fix removed. A miss now throws a
`QuereusError` naming the operation, table, and key values.

This is a behavior change: a caller that was silently tolerating a fetch-miss now sees a
hard failure. That is the intended tradeoff — the fallback did not merely fail to help, it
actively corrupted. Feeding a compact tuple to `updateIndexEntries`/`deleteIndexEntries`
means the non-PK columns read as `null`, so index maintenance deletes entries keyed on
`null` (which do not exist) and orphans the real ones. Loud failure beats silent index
corruption. The throw is reachable in production, not just in synthetic tests: a networked
composite-PK point lookup can come back empty (tracked in the Sereus repo as
`debt-composite-pk-point-lookup-unreliable-untracked`).

**Arm 2 — length guard on `RowCodec.extractPrimaryKey`.** `extractPrimaryKey(row)` and
`createPrimaryKey(values)` both accept a plain array, so passing either the other's
argument type-checked and silently produced a wrong key — the root cause of the original
bug. `createPrimaryKey` already rejected a wrong-length input; `extractPrimaryKey` now
mirrors it.

The stronger type-level fix (a branded type making a compact tuple and a full row
non-interchangeable at compile time) is deliberately out of scope and already filed as
`backlog/debt-nominal-key-tuple-vs-row-types`.

## Review findings

### Checked

Read the implement diff first, with fresh eyes, before the handoff summary. Scrutinised the
throw-vs-fallback tradeoff, the guard's width claim, every `extractPrimaryKey` call site,
the fidelity of the hand-driven `update()` test pattern against the real engine lifecycle,
source hygiene (duplication, comment density, function length), docs, and cross-repo
message dependencies. Ran typecheck, build, and the full suite.

**Independently verified the guard's central claim** rather than taking the handoff's word:
`row.length === schema.columns.length` cannot reject a legitimate caller because
`StoredTableSchema.columns` is a 1:1, index-preserving map of quereus's
`TableSchema.columns` (`schema-manager.ts` `columnSchemaToStored` / `storedToTableSchema`),
generated columns included — and `encodeRow` has always depended on that same width. All
four call sites re-confirmed to pass a full row: `optimystic-module.ts` unique-descriptor
backfill and index-populate (both `decodeRow` output), INSERT and UPDATE (both the engine's
`values`). The claim holds.

**Confirmed arm 1's tradeoff is the right call** (the ticket asked for a second opinion on
it). The alternative — scattering `oldKeyValues` into their PK column positions in an
otherwise-null row — is strictly worse than throwing, for the orphaned-index-entry reason
spelled out under *What shipped* above.

### Found and fixed in this pass (minor)

- **Error messages reported the encoded tree key.** `encodeKeyTuple` frames every element
  with `\x00`/`\x02`/`\xff` control units, so the key landed in logs as unreadable,
  unsearchable control characters — precisely useless in the diagnostic whose whole job is
  telling an operator *which row*. Now reports the caller's logical key values through a new
  `formatKeyValues` helper, which is bigint- and blob-safe (`JSON.stringify` throws on
  bigint, which would have turned a diagnostic into a second, worse failure).
- **Duplication.** Two 18-line near-identical fetch-or-throw blocks, carrying the same
  rationale comment twice, collapsed into one `requirePreWriteRow(operation, key, keyValues)`
  private method. The UPDATE and DELETE sites are two lines each; the rationale lives once,
  on the method.
- **Test: `expect.fail()` was swallowed by its own `catch`.** Both new integration tests put
  `expect.fail(...)` inside a `try` whose `catch` then asserted on the message. A regression
  where `update()` *stopped* throwing would have reported "expected 'Should have thrown…' to
  match /could not find…/" instead of the actual problem. Restructured to capture-then-assert.
- **Test: committed a transaction whose DML had thrown.** The `finally` block called
  `conn.commit()` after a failed write. The engine never does that — it aborts — so the test
  was baking in an unfaithful lifecycle, and specifically the one hazardous shape flagged in
  the tripwire below. Now `conn.rollback()`.
- **Test: no assertion that the rejected write left nothing behind.** Added a post-throw
  `count(*) = 0` check, plus an assertion that the message carries the logical key values.
- **Test duplication.** The two integration cases were 35 near-identical lines each; factored
  into one `expectMissingPreWriteRowThrow` helper with two six-line cases.
- **Arm 2's acknowledged test gap, closed.** The handoff correctly flagged that the new
  `extractPrimaryKey` guard had no direct test. Added three to the existing
  `test/row-codec.spec.ts`: a compact tuple rejected, an over-long row rejected, and a
  positive case proving a full row and `createPrimaryKey` agree on a *non-leading* PK — the
  shape where the two would otherwise silently diverge.
- **Docs were out of date.** The plugin README's `## Limitations` said nothing about the new
  hard failure, which is user-visible and reachable on a networked transactor. Added an entry
  naming the error text and why it fails rather than half-writing the row.

### Tripwire (parked, not filed)

`txnBridge.addStatement` runs before every throw in `update()`, so a DML that fails leaves
its statement in the session's replication record. Harmless today — the engine aborts the
transaction on a DML error and the record is discarded — but it becomes a real defect if a
caller ever swallows the error and commits anyway. Parked as a `NOTE:` at the
`addStatement` call site in `optimystic-module.ts`, naming both fixes (move recording below
the guards, or give the bridge a drop-last-statement on failure).

### Major findings

**None.** The one architectural finding this review would otherwise have filed — nominal /
branded types so a compact key tuple and a full row cannot be interchanged at compile time,
retiring the whole class rather than guarding instances — was already filed by the
implementer as `backlog/debt-nominal-key-tuple-vs-row-types`. Confirmed present; filing
again would only duplicate it.

### Observed, deliberately not actioned

- `test/README.md` lists 3 of 46 spec files under "Unit Tests". Pre-existing rot in a file
  this diff neither touched nor worsened, and a hand-maintained index of 46 filenames is the
  same class as the already-open `debt-doc-code-citations-rot-silently`. Filing a point
  ticket to append one filename is not worth the queue slot.
- `createDb` is duplicated verbatim across `oldkeyvalues-compact-shape.spec.ts` and
  `composite-pk-point-lookup.spec.ts` (and likely more). Pre-existing test-harness
  duplication, outside this diff.
- The Sereus-side residual (`context.OwnerKey isn't a column`, a quereus planner resolution
  error, tracked at Sereus `blocked/10-revocation-reissue-same-pk-update-unique-collision`)
  was not re-chased, per the ticket. I did **not** re-run that harness. Instead I confirmed
  by grep that nothing in `C:/projects/sereus` asserts on the error-message text this review
  reformatted, so no cross-repo assertion could have been broken by it.

## Verification

Run from `packages/quereus-plugin-optimystic`:

- `yarn typecheck` — clean, exit 0.
- `yarn build` — clean, no type errors.
- `yarn test` — **420 passing, 0 failing, 11 pending**, plus the `test:smoke` entry-point
  check. The implement handoff's baseline was 417 passing; the +3 are the new
  `extractPrimaryKey` guard tests. The two integration cases were refactored in place, not
  added, so the count moved by exactly the three new ones. No regressions, no pre-existing
  failures surfaced (`tickets/.pre-existing-error.md` not written).
