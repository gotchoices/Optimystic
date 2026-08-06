description: The last two loose ends from a bug where updating a row in place got wrongly rejected as a duplicate of itself are now closed — an error-recovery path that misread the row identifier the same way, and a cheap check that would have caught the whole mistake immediately.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (UPDATE ~1671-1691, DELETE ~1769-1789), packages/quereus-plugin-optimystic/src/schema/row-codec.ts (extractPrimaryKey ~88-104), packages/quereus-plugin-optimystic/test/oldkeyvalues-compact-shape.spec.ts
----

# `oldKeyValues` compact-tuple hardening — arms 1 & 2 closed

Follow-on to `bug-same-key-update-reports-unique-collision-with-itself`, whose core fix
(landed earlier, already reviewed/merged into `main` before this ticket) is **not** part of
this diff. This ticket closes the two loose ends that fix left open. Background — quereus's
contract for `UpdateArgs.oldKeyValues` (`packages/quereus/src/vtab/table.ts`):

> COMPACT: exactly one cell per `primaryKeyDefinition` entry, in that order — NOT a full row
> indexed by column position. A vtab must address it as `keyValues[i]` for PK column `i`,
> never `row[pkDef[i].index]`; the two agree only when the PK columns happen to be the
> table's leading columns in PK order.

## Arm 1 — `oldRow` fallback removed, replaced with a throw

Both the UPDATE and DELETE paths in `optimystic-module.ts` fetch the pre-write row image
from `this.collection.get(oldKey)` before staging any change (needed so `indexManager`'s
`updateIndexEntries`/`deleteIndexEntries` can compute the correct old index-tree keys). Both
used to fall back to `oldKeyValues as Row` when that fetch missed — the same category error
the core fix removed: a compact key tuple (one cell per PK column) cast to a full,
column-indexed row. Feeding that into index maintenance would silently corrupt secondary
index entries rather than fail loudly.

Changed in both paths: a missing pre-write row image now throws a `QuereusError` naming the
key and table, instead of fabricating a fake row. Rationale in the code comment at each site.
This is a **behavior change** worth flagging to the reviewer explicitly: any caller that was
silently tolerating a fetch-miss (there should be none in valid DML — see below) now sees a
hard failure instead of silent corruption or a no-op.

```ts
const oldEntry = await this.collection.get(oldKey) as [string, EncodedRow] | undefined;
if (!oldEntry) {
  throw new QuereusError(
    `UPDATE could not find the pre-write row at key ${oldKey} for table ` +
    `${this.tableSchema.name} — the engine and the collection disagree about what exists.`,
    StatusCode.ERROR,
  );
}
const oldRow: Row = this.rowCodec.decodeRow(oldEntry[1]);
```
(DELETE mirrors this with `deleteKey`/`delEntry`.)

**Known caller that can legitimately hit this today:** the ticket's prior-arm note flagged a
composite-key point lookup that can come back empty on a networked strand
(`debt-composite-pk-point-lookup-unreliable-untracked`, tracked in the Sereus repo, not this
one) — that is exactly a fetch-miss shape. If/when that surfaces here, the throw is the
intended, correct behavior (loud failure over silent corruption), not a new bug — but it is
worth knowing the throw is reachable in production, not just synthetic-test-only.

**Test coverage** — two new cases in `test/oldkeyvalues-compact-shape.spec.ts`
("UPDATE throws…when the pre-write row is missing", "DELETE throws…"). Each drives the
scenario by hand: INSERT + DELETE a row via normal SQL (so it's genuinely gone from the
collection), then calls the vtab's `update()` method **directly** (bypassing the SQL engine,
via `module.connect(...)` returning the same cached table instance the engine itself writes
through) with the now-stale compact key tuple — simulating a caller that still believes the
row exists. Driving `update()` by hand needs the connection's transaction lifecycle replicated
manually (`ensureConnectionRegistered()` → `conn.begin()` → `table.update(...)` →
`conn.commit()`), since going around `db.exec()` skips the engine's normal begin/commit
orchestration. This hand-driven-connect pattern already existed in
`test/committed-read-isolation.spec.ts` for query-path testing; this ticket is (as far as I
found) the first to use it for the write path — worth a second pair of eyes on whether it's
faithfully replicating what the real engine does around a write, or just happens to make the
assertion pass.

## Arm 2 — length guard on `RowCodec.extractPrimaryKey`

`extractPrimaryKey(row: Row)` and `createPrimaryKey(values: SqlValue[])` both accept a plain
array, so handing either method the other's argument type-checked and silently produced a
wrong key — that mismatch is the root cause of the original bug. `createPrimaryKey` already
rejected a wrong-length input; `extractPrimaryKey` had no equivalent and read past the end of
a short array instead (`row[pkCol.index] ?? null` silently becomes `null` past the end).

Added the mirror check at the top of `extractPrimaryKey`:

```ts
if (row.length !== this.schema.columns.length) {
  throw new Error(
    `extractPrimaryKey requires a full row of ${this.schema.columns.length} columns, got ${row.length} — ` +
    `did you pass a compact key tuple (one cell per primary-key column) instead? Use createPrimaryKey for that.`
  );
}
```

Verified every call site in `src/` passes a full row (either `decodeRow()`'s output, or the
engine's `values` on insert/update — both always exactly `schema.columns.length` long):
`optimystic-module.ts:1224` (unique-descriptor tree-empty backfill, row from `decodeRow`),
`:1561` (INSERT, `values`), `:1668` (UPDATE, `values`), `:1971` (index populate, row from
`decodeRow`). No existing test exercised this new throw path directly — it's covered
indirectly (every passing test would fail loudly if a full row ever went in short), but there
is no test asserting the exact error message/shape. Flagging as a gap rather than papering
over it.

The stronger, type-level fix — a nominal/branded type that makes a compact key tuple and a
full row non-interchangeable at compile time, so this whole mistake shape can't be written
again — is **deliberately out of scope** here; it's filed as
`backlog/debt-nominal-key-tuple-vs-row-types` for separate consideration.

## Verification run

- `yarn build` in `packages/quereus-plugin-optimystic`: clean, no type errors.
- `yarn test` in `packages/quereus-plugin-optimystic`: **417 passing, 0 failing, 11 pending**
  (baseline before this ticket was 415 passing; +2 for the two new fetch-miss tests — no
  regressions).
- Sereus repro (`cd C:/projects/sereus/packages/cadre-core && npx vitest run
  --reporter=verbose control-revocation-reissue control-revocation-replay`): **43/44**, same
  as the prior arm's handoff predicted. The one remaining failure is unchanged and confirmed
  out of scope for this repo — see below.
- `yarn workspace @optimystic/db-core build` was run first per the prior handoff's note (the
  Sereus harness refuses a stale `dist`).

## Residual, out of this repo (unchanged, not touched by this ticket)

```
FAIL test/control-revocation-replay.spec.ts > … (NoDelete / ReissueOnly / AuthorizedReissue)
AssertionError: expected [Function] to throw error matching /CHECK constraint failed: (AuthorizedR…/
  but got 'context.OwnerKey isn't a column'
```

This is a quereus planner resolution error (`packages/quereus/src/planner/resolve.ts`),
raised because this particular statement reaches the `AuthorizedReissue` check without the
table's declared `with context (OwnerKey text, Signature text)` values bound. Nothing in this
package touches context binding. Tracked on the Sereus side at
`blocked/10-revocation-reissue-same-pk-update-unique-collision`; do not re-chase it here.

## Suggested review focus

- Confirm the throw-vs-fallback call in arm 1 is the right tradeoff (ticket's own preferred
  correction, but a reviewer may weigh the "scatter into key positions" alternative
  differently, especially given the known networked-lookup-miss caller above).
- Sanity-check the hand-driven `update()` test pattern (arm 1 tests) — it's copied/adapted
  from `committed-read-isolation.spec.ts`'s query-path pattern but applied to the write path
  for the first time in this suite.
- Arm 2's guard has no direct unit test asserting its exact throw — decide whether that gap is
  acceptable or wants a quick add.
