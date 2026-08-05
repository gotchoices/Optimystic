description: The bug where updating a row in place was rejected as a duplicate of itself is fixed and covered by tests; two loose ends remain — an error-recovery path that still mis-reads the row identifier the same way, and a cheap check that would have caught the whole class of mistake immediately.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (the two `oldRow` fallbacks, ~1679 update / ~1782 delete), packages/quereus-plugin-optimystic/src/schema/row-codec.ts (extractPrimaryKey ~88, createPrimaryKey ~105), packages/quereus-plugin-optimystic/test/oldkeyvalues-compact-shape.spec.ts
difficulty: easy
----

# Finish the `oldKeyValues` compact-tuple fix

## What already landed in this working tree (fix stage)

The reported bug is **fixed and verified**. Root cause, in one sentence: the vtab derived an
UPDATE's/DELETE's old primary key with `RowCodec.extractPrimaryKey(oldKeyValues)`, which addresses
`row[primaryKeyDefinition[i].index]` — full-row addressing — but `UpdateArgs.oldKeyValues` is the
**compact key tuple**: exactly one cell per primary-key column, in primary-key order. quereus states
this explicitly in `packages/quereus/src/vtab/table.ts` on `UpdateArgs.oldKeyValues`:

> COMPACT: exactly one cell per `primaryKeyDefinition` entry, in that order — NOT a full row indexed
> by column position. A vtab must address it as `keyValues[i]` for PK column `i`, never
> `row[pkDef[i].index]`; the two agree only when the PK columns happen to be the table's leading
> columns in PK order.

Whenever a table's primary-key columns are *not* its leading columns in key order, the read ran past
the end of the tuple, took `undefined` → `null` for the trailing key parts, and produced a tree key
that matches nothing. Three distinct user-visible failures followed:

| statement | what happened |
| --- | --- |
| UPDATE of a non-key column (PK unchanged) | wrong `oldKey` ≠ `newKey`, so the write looked like a key move onto an occupied slot; `resolvePkMoveDecision` found the row *being updated* at `newKey` and rejected it — `UNIQUE constraint failed: <PK columns>`, the row colliding with itself |
| UPDATE that moves the key | old slot cleared at a key nothing occupies, so the original row survived alongside the moved one — two rows, one logical entity, and orphaned index entries |
| DELETE | cleared a key nothing occupies; the row survived and the statement reported success |

Landed changes:

- `optimystic-module.ts` UPDATE path: `oldKey` now comes from `rowCodec.createPrimaryKey(oldKeyValues)`
  (positional, one value per key column — the method built for this), with a comment stating the
  contract and the failure it caused.
- `optimystic-module.ts` DELETE path: same for `deleteKey`.
- New spec `test/oldkeyvalues-compact-shape.spec.ts` — four cases, all with the primary key off the
  leading positions: in-place non-key UPDATE on a composite key (the `Revocation`-shaped
  `(TableName, RowKey, StampId, ReissuedAt) primary key (TableName, StampId)`), DELETE, key-moving
  UPDATE, and a single-column key that is not the first column. All four fail on the pre-fix code with
  exactly the reported symptoms, and pass after.

Verification already run (no need to repeat the *pre-fix* half):

- `yarn test` in `packages/quereus-plugin-optimystic`: **415 passing, 0 failing, 11 pending.**
- The consuming repro named in the source ticket — `cd C:/projects/sereus/packages/cadre-core &&
  npx vitest run --reporter=verbose control-revocation-reissue control-revocation-replay` — went from
  **39/44 to 43/44**. Every `UNIQUE constraint failed: Revocation.TableName, Revocation.StampId`
  failure is gone. See *Residual, out of this repo* below for the one that remains.
- Building this package requires `@quereus/quereus` to be built first: it resolves through a symlink
  to `C:/projects/quereus/packages/quereus`, whose `dist/` is not checked in. Run `yarn build` there
  if `tsup`'s DTS step reports `Cannot find module '@quereus/quereus'`. Likewise `yarn workspace
  @optimystic/db-core build` before the Sereus suites — their harness refuses to run against a stale
  `dist`.

## What is left

### Arm 1 — the `oldRow` fallbacks still read the compact tuple as a full row

Both DML paths fetch the pre-write row image and fall back to `oldKeyValues` when the fetch misses:

```ts
const oldEntry = await this.collection.get(oldKey) as [string, EncodedRow] | undefined;
const oldRow: Row = oldEntry ? this.rowCodec.decodeRow(oldEntry[1]) : (oldKeyValues as Row);
```

`oldKeyValues as Row` is the same category error the fix removed — a compact tuple cast to a
column-indexed row. `oldRow` is then handed to `indexManager.updateIndexEntries` /
`deleteIndexEntries`, which read it by *column index* to compute each secondary-index tree key. For a
table whose key columns are not leading, those keys are built from the wrong cells, so the index
entries deleted are not the ones the row actually owns: stale entries survive and live ones are left
behind. That is silent index corruption, not a rejected statement.

It is dormant today — with `oldKey` correct, the fetch should always hit for valid DML. It is not
merely theoretical either: the source ticket flags a composite-key point lookup that can come back
empty on a networked strand (`debt-composite-pk-point-lookup-unreliable-untracked`, tracked in the
Sereus repo), which is exactly a fetch miss.

Preferred correction: **remove the fallback and throw.** A missing pre-write row image means the
engine and the collection disagree about what exists; continuing with a fabricated old image trades a
loud failure for quiet corruption, and AGENTS.md is explicit that exceptions should be exceptional
rather than control flow. If a fallback must stay for a reason discovered while implementing, it must
scatter the tuple into its key columns' positions (`row[pkDef[i].index] = oldKeyValues[i]`, other
cells `null`) and say in a comment that the non-key cells are unknown, so index maintenance derived
from it is best-effort.

Either way the choice needs coverage: a test that drives the update/delete path with the row absent
from the collection and asserts the chosen behaviour (throw, or index state after a scattered
fallback).

### Arm 2 — a length check on `extractPrimaryKey` so this class fails loudly

`RowCodec.extractPrimaryKey(row: Row)` and `RowCodec.createPrimaryKey(values: SqlValue[])` both accept
a plain array, so handing either method the other's argument type-checks and silently produces a wrong
key. `createPrimaryKey` already rejects a wrong-length input; `extractPrimaryKey` has no equivalent
and reads past the end instead.

Add the mirror check: assert `row.length === schema.columns.length` and throw naming both lengths.
Every legitimate caller passes a full row — `decodeRow` output (always `columns.length`) or the
engine's `values` — so nothing valid is affected, and the very first mis-call becomes an immediate,
self-describing error instead of a wrong key. This is the same mistake shape already fixed once
before at a different site (`executePointLookup` used only the first seek arg — see
`test/composite-pk-point-lookup.spec.ts`), so the class has now cost two bug hunts.

The stronger, type-level version of this guard — a nominal/branded type that makes a compact key
tuple and a full row non-interchangeable — is deliberately **not** in this ticket; it is filed as
`backlog/debt-nominal-key-tuple-vs-row-types`.

## Residual, out of this repo

One Sereus test still fails, and it is a *different* defect the fix unmasked — previously the UNIQUE
error fired before the constraint could be reached at all:

```
FAIL test/control-revocation-replay.spec.ts > … (NoDelete / ReissueOnly / AuthorizedReissue)
AssertionError: expected [Function] to throw error matching /CHECK constraint failed: (AuthorizedR…/
  but got 'context.OwnerKey isn't a column'
```

`context.OwnerKey isn't a column` is a quereus planner resolution error
(`packages/quereus/src/planner/resolve.ts`), raised because that particular statement reaches the
`AuthorizedReissue` check without the table's declared `with context (OwnerKey text, Signature text)`
values bound. Sibling tests that pass the context resolve it fine, so it is a Sereus test/statement
shape question or a quereus context-binding gap — nothing in this package. Do not chase it here;
report it in the handoff so the Sereus side (`blocked/10-revocation-reissue-same-pk-update-unique-collision`)
knows the UNIQUE half is cleared and this is what remains.

## TODO

- [ ] Resolve the `oldRow` fallback in the UPDATE path — throw on a missing pre-write image, or
      scatter the compact tuple into key-column positions with a comment on what is unknown
- [ ] Same for the DELETE path
- [ ] Add coverage for the chosen fallback behaviour (row absent from the collection)
- [ ] Add the `row.length === schema.columns.length` assertion to `RowCodec.extractPrimaryKey`
- [ ] `yarn build` then `yarn test` in `packages/quereus-plugin-optimystic` — expect no regression
      against the 415-passing / 11-pending baseline, plus the new fallback test
- [ ] Re-run the Sereus repro (`control-revocation-reissue control-revocation-replay`); expect 43/44,
      with only the `context.OwnerKey` failure above
