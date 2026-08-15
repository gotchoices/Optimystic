----
description: Attaching a secondary index to a table that holds no rows used to read the table's whole change log to copy nothing across. It now checks for rows first and skips the work.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/index-backfill-cost.spec.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/README.md
difficulty: medium
----

# Index backfill skips the scan when there is nothing to copy

## What changed

`backfillIndexTrees` (the single populate path shared by `CREATE INDEX`'s build and by
re-attaching to an index this connection was detached from) used to unconditionally do
three things: refresh the main collection, walk every row, then flush every target index
tree. On a table with no rows the walk stages nothing — but the refresh either side of it
still ran, and both are deliberately cache-bypassing log walks.

Three edits:

**1. Skip the refresh + scan when the table has no rows.**
`backfillIndexTrees` now asks `hasNoRowsToBackfill()` *before* `collection.update()`.
The check reads the LIVE tree (`collection.at(await collection.first()) === undefined` —
the same emptiness idiom `ensureUniquePopulated` already used), so it sees this
connection's committed rows *and* anything staged in an open transaction. Decided once
per call, not per index, since one scan serves every newly attached tree.

**2. Flush only the trees that have something to flush.**
`Tree.sync()` is `collection.updateAndSync()`, so syncing a tree with an empty change set
pays a full log walk before discovering it has nothing to commit. `flushDirtyTrees()`
skips those. This is provably behaviour-preserving: the new
`Collection.hasUnsyncedChanges()` is the exact predicate `syncInternal`'s commit loop
iterates on (the loop was rewritten to call it, so the two cannot drift). A newly
*invented* index tree still flushes — its header/root sit uncommitted in the tracker and
count as unsynced — so `CREATE INDEX` on an empty table still gives the index a durable
header.

**3. The same guard on the adjacent site.** `ensureUniquePopulated` had the identical
shape (refresh, scan, flush) and the identical waste. It now returns early on the same
check, *without* marking the tree populated — nothing was verified, so a later probe over
a by-then-populated table still gets its one backfill.

New public API: `Collection.hasUnsyncedChanges()` and its `Tree` delegate.

## Numbers (raw-storage operations, counted with an `IRawStorage` proxy)

Measured with `test/index-backfill-cost.spec.ts`, which wraps the storage the local
transactor is handed and counts every call. Before/after were taken by disabling the two
guards, rebuilding, and re-running.

| scenario | before | after |
|---|---|---|
| `CREATE INDEX` on a table with committed history, zero live rows | 301 | **255** |
| Re-attach to an index on an empty table (both refreshes wasted) | 184 | **98** |
| `CREATE INDEX` on a 20-row table (control) | 301 | **301** |

The control is unchanged in both cost and effect: the spec asserts all 20 rows land in
the new index and that index-routed seeks agree with a full scan.

**Read the ticket's "446 ops" claim with care.** The originating ticket attributes ~446
operations to one backfill over a "brand-new, empty table". That shape could not be
reproduced: a table created and never written to has an *invented* collection whose
header was never committed, so `collection.update()` finds nothing and costs ~2
operations — measured, the whole backfill was 257→255 there. The waste only becomes real
once the collection has a committed log, and it is 46–102 operations per attaching table,
growing slowly with log depth (measured 184 → 200 as an empty table's log grew from 1 to
40 revisions; after the fix it is flat at 98 regardless). So the consumer's 446 across a
whole cold start is plausible as an aggregate over several collections and deeper logs,
but it is *not* one empty-table backfill. Someone should re-measure downstream against
this change rather than assuming ~446 disappears.

## What a reviewer should attack

**The soundness argument is the whole ticket.** A skip that is wrong in the other
direction leaves rows silently unindexed forever, with no error. The claim, spelled out
in the doc comment on `hasNoRowsToBackfill`:

- The bar is "rows THIS connection committed while detached from a now-attached index
  must end up indexed". Those rows are in this collection's own view by construction, so
  an empty live view proves this connection wrote none.
- Staged-but-uncommitted rows count too, because the check reads the live tree.

**What the change deliberately gives up.** The pre-existing `update()`-first order also
covered rows a *sibling* connection committed since this one last pulled, where that
sibling was not maintaining the index. That is now not covered. The argument for
accepting it (in the code comment, and now in the plugin README's Limitations entry) is
that the coverage was never general — a connection that opens the table cold and finds
the index already persisted attaches nothing and never scans, so a divergent writer's
orphans already survive every open that does not re-declare. **There is no test pinning
this narrowing**, deliberately: it is the accepted tradeoff, not a behaviour to lock in.
If a reviewer thinks that tradeoff is wrong, this is the decision to reopen.

**Second thing to attack:** whether skipping `tree.sync()` on a not-dirty tree is really
inert. It rests on `hasUnsyncedChanges()` being the same predicate the commit loop uses.
Check that `syncInternal` genuinely has no side effect worth keeping when that predicate
is false (the update half of `updateAndSync` is what is being dropped).

## Tests

New: `packages/quereus-plugin-optimystic/test/index-backfill-cost.spec.ts` — 7 specs, two
groups.

Cost guards (ceilings with slack, not exact counts):
- `CREATE INDEX` on a committed-but-empty table stays under 280 ops (was 301, now 255).
- Re-attach on an empty table stays under 140 ops (was 184, now 98).
- `CREATE INDEX` on a 20-row table still costs >150 ops and still indexes all 20.

Correctness:
- An index built on an empty table indexes every row written afterwards — and a *second
  session* over the same storage reads that index and appends to it, which is what proves
  skipping the empty flush did not cost the tree its durable header.
- Rows committed while detached are still backfilled when the table is not empty.
- Several indexes attaching in one reconcile all populate (the skip is per scan, not per
  index).
- `CREATE INDEX` inside an open transaction populates from rows staged but not yet
  committed — this is the spec that would fail if the emptiness check were ever moved to a
  committed snapshot.

Pre-existing coverage that must stay green and does:
`test/index-maintenance-invariant.spec.ts` (especially "re-attaching to an index backfills
the rows written while detached from it" — the originating bug),
`test/secondary-unique*.spec.ts` (the `ensureUniquePopulated` arm).

## Validation run

- `yarn lint` — clean.
- `yarn build`, `yarn typecheck` — clean.
- `yarn test` (all packages) — all green, no failures anywhere.
- `@optimystic/db-core` 1368 passing, `@optimystic/quereus-plugin-optimystic` 471 passing
  / 11 pending, re-run after the final restore-and-rebuild.
- `OPTIMYSTIC_INTEGRATION=1` plugin suite (includes the libp2p first-launch spec) — 474
  passing, 8 pending, 0 failing.

No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

## Known gaps

- The cost ceilings are storage-implementation dependent — they count `IRawStorage` calls
  through `MemoryRawStorage`, so a change to the storage layer's per-block call pattern
  will need them re-baselined. They exist to catch a reintroduced log walk, not to pin the
  storage layer.
- The measured wins are on a test harness with shallow logs. The real magnitude on a phone
  against a months-old control database is unmeasured here.
- `hasNoRowsToBackfill()` now runs on `probeUniqueConstraint`'s path while the table is
  empty, once per DML row until the first row lands. That is a cached `first()` read and
  is noted at the site; it was measured only indirectly (the unique specs are unchanged in
  runtime).
