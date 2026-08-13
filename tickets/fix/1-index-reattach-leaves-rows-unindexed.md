----
description: When a connection reconnects to an index it had been ignoring, rows it wrote while it was ignoring the index stay missing from that index forever — lookups by that column never find them, and nothing reports an error.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/index-maintenance-invariant.spec.ts
repro: static
difficulty: medium
----

# Re-attaching a secondary index does not backfill the rows written while it was detached

## Background

An Optimystic table keeps its secondary indexes as separate trees. Each database
connection holds its own copy of "which indexes this table maintains" — the set that
INSERT/UPDATE/DELETE stage entries into. A connection whose copy is missing an index
writes rows without ever touching that index's tree.

The just-landed ticket `index-maintenance-must-track-the-declared-index-set` closed the
one known way a connection ended up with a short list: re-running `CREATE INDEX` now
**reconciles** — it folds the index descriptor back in, opens its tree and registers it, so
the connection maintains the index from then on
(`OptimysticVirtualTable.reconcileMaintainedIndexes`).

## The gap

Reconciliation repairs the *wiring* but not the *contents*. When it attaches an index the
connection was not previously maintaining, it does not add index entries for the rows that
connection already wrote while detached. Those rows are in the table and replicate normally,
but the index has no entry pointing at them, so any query served by that index skips them.

Nothing reports this. The maintained-index guard added by the same ticket only fires when a
connection is asked to read through an index it does **not** maintain — after reconciliation
it does maintain it, so the guard passes and the incomplete index answers as if it were
complete. This is the same user-visible symptom the original report
(`fix/secondary-index-update-never-reaches-the-sibling`) described: the row is there, the
index-driven lookup returns nothing, and no error is raised anywhere.

Contrast the first-time build path in the same method (`addIndex`, the branch taken when the
index is *not* yet in the persisted schema): after opening and registering the tree, it walks
every existing row and stages an index entry for each, then flushes. Reconciliation performs
the first three of those four steps and stops.

## Reproduction recipe (static — read from the code, not yet driven to a failing test)

Two connections, A and B, over the same storage:

1. A and B both declare the table. Neither declares the index yet, so A maintains no index.
2. B declares the index. B's build path populates it from the rows that exist at that moment.
3. A inserts a row. A is still detached from the index, so the row lands in the table but
   not in the index. (No error — this is the silent write-side skip.)
4. A re-runs `CREATE INDEX`. Reconciliation attaches the index to A.
5. From here on both connections consider the index healthy, and a lookup on the indexed
   column never finds the row from step 3 — permanently, on either connection.

The existing spec `test/index-maintenance-invariant.spec.ts` already builds steps 1, 2 and 4;
it does not insert at step 3, which is the whole gap.

## What needs deciding

There is a real fork here, and it is why this is a ticket rather than a one-line change:

- **Backfill.** Reconciliation runs the same populate walk the first-time build path runs,
  for the indexes it newly attached. Index tree keys are `indexColumns‖primaryKey`, so
  re-staging an entry that already exists writes the identical key and value — the walk is
  idempotent and safe to repeat. Cost is one full table scan, paid only on a re-declare that
  actually attaches something; the non-divergent warm re-declare stays a no-op. Note that
  `CREATE INDEX` can run inside a transaction, and the build path's flush already carries a
  documented caveat about that — whatever is chosen has to hold there too.
- **Refuse.** Reconciliation declines to attach an index it cannot vouch for and fails with a
  named error, leaving the operator to rebuild the index explicitly. Loud, but it turns a
  currently-succeeding statement into a failure.
- **Attach and warn.** Attach as today, but log that the index may be incomplete. Cheapest,
  and leaves the wrong results in place.

Backfill is the option that actually restores the invariant "every committed row has an entry
in every index the table declares"; the other two only change how visible the violation is.

## Expected behaviour

After any interleaving of table declaration, index declaration and writes across connections
sharing one collection, a lookup routed through a secondary index returns exactly the rows a
full scan with the same predicate returns.

## Coverage worth having beyond the point fix

The class here is "an index tree that does not account for every committed row", and this is
its second instance (the first being the write-side skip the previous ticket fixed). A single
generalized assertion would catch the whole class rather than this one path: for a table and
an index, assert that seeking every distinct indexed value through the index yields the same
row set as filtering a full scan on it — then call that helper at the end of the existing
index specs (`index-maintenance-invariant`, `two-node-secondary-index-convergence`,
`index-support`, `secondary-unique`). That is more valuable than one more bespoke spec, and it
keeps future index work honest.
