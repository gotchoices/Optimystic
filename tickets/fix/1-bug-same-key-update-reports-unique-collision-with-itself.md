----
description: An UPDATE that changes a non-key column and leaves the primary key alone is rejected as a duplicate-row violation — the row is reported as colliding with itself. Any table whose rows are updated in place is affected.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (uniqueConstraintMessage ~1066, resolvePkMoveDecision ~1378-1408, the insert-collision return ~1596-1611), ../quereus/packages/quereus/src/runtime/emit/dml-executor.ts (processUpdateRow, the update args at 789 / 1394 / 1563)
difficulty: medium
repro: verified
----

# A counter-only UPDATE fails with `UNIQUE constraint failed` on its own primary key

Filed from the Sereus repo, where this blocks a shipped feature. Measured 2026-08-05 against
`@optimystic/*` **0.21.0** and `@quereus/quereus` **4.8.0** — both current published releases, both
freshly built.

## Symptom

An UPDATE that modifies only a non-key column, leaving the composite primary key untouched, fails at
statement time:

```
ConstraintError: UNIQUE constraint failed: Revocation.TableName, Revocation.StampId
  at processUpdateRow ../quereus/packages/quereus/src/runtime/emit/dml-executor.ts:1158
```

`(TableName, StampId)` is that table's primary key, and the statement does not change either column.
The engine is reporting the row as colliding with itself.

## Repro

From the Sereus checkout:

```
cd packages/cadre-core
npx vitest run --reporter=verbose control-revocation-reissue control-revocation-replay
```

5 of 44 fail. The split is the diagnostic, and it is sharp:

- **Every failing test executes an update that leaves the composite PK unchanged** — including the
  happy path and the batch operation. Rejection probes (wrong digest, non-owner signer) also die
  here, *before* their deferred CHECK can fire, so the constraint machinery never gets a say.
- **The tests that pass are the ones whose updates DO change a primary-key column.** Those reach the
  deferred CHECK correctly.

So the failure is specific to same-key updates, which is the ordinary case for updating a row in
place.

A standalone repro should be reachable without Sereus: create a table with a composite primary key
and one ordinary column, insert a row, then `update t set counter = counter + 1 where <full PK>`.

## Where the message comes from

Not from quereus. `processUpdateRow` relays a constraint result the vtab returned; the wording is
this package's:

`packages/quereus-plugin-optimystic/src/optimystic-module.ts:1066`, `uniqueConstraintMessage()`.
Its own doc says: *"With no argument it names the PRIMARY KEY columns (the tree-key collision)"* —
and the observed message names exactly the PK columns. So the emitting call is one of the
**no-argument** sites, not the `uc.columns` secondary-index one at ~1482:

- **`resolvePkMoveDecision` (~1404)** — the strongest lead. Its own contract comment says the
  *"caller only calls this when `oldKey !== newKey`"*. If a same-key update reaches it, that
  invariant is being violated by the caller, and the "existing row at newKey" it finds is the very
  row being updated. That is exactly the observed self-collision.
- **the insert-collision return (~1609)** — reached if a same-key update is being routed down the
  insert path, where finding an existing row at that PK is a legitimate collision for a real insert
  but wrong for an update.

The cheap discriminator is a log line at each of the two sites plus the `oldKey`/`newKey` pair; one
run of the repro says which.

## The quereus side looks correct

Checked before filing, so this is not a boundary dispute: `dml-executor.ts` sends
`operation: 'update'` with `oldKeyValues` populated at lines 789, 1394 and 1563. The
`operation: 'insert'` at 1159 belongs to a different path — the one that emits a `'delete'` auto
data event for the old key just above it, i.e. a PK-changing update expressed as delete+insert.

If it turns out quereus is routing a same-key update through that insert path, that is worth raising
there — but nothing observed so far says it is, and the constraint message is unambiguously this
package's.

## Why it matters

It blocks `blocked/10-revocation-reissue-same-pk-update-unique-collision` in Sereus, and through it
`implement/10-control-revocation-reissue-test-fixes`. The affected operation rewrites a tombstone
row *without* changing its key, and the schema forbids delete-and-reinsert (retirement must be
permanent), so there is no SQL-side workaround in the consuming repo.

The wider blast radius is the reason to treat it as more than one feature's problem: **any** table
whose rows are updated in place hits this. The Sereus suite only surfaces it in one place because
most of its control-table writes are inserts.

Possibly related, and worth a look while in here: Sereus tracks
`backlog/debt-composite-pk-point-lookup-unreliable-untracked` — a composite-PK point lookup that can
come back empty on a networked strand. If the same-key update path derives its "existing row" from
that lookup, the two may share a cause.

## TODO

- [ ] Instrument the two no-argument `uniqueConstraintMessage()` sites and identify which fires
- [ ] Establish whether `resolvePkMoveDecision` is being called with `oldKey === newKey`, against its
      documented contract
- [ ] Fix so a same-key update updates in place rather than colliding with itself
- [ ] Add a regression test for an in-place update of a non-key column on a composite-PK table
- [ ] Verify with the Sereus repro above (expect 44/44), not only with unit coverage here
