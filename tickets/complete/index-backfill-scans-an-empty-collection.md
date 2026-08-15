----
description: Attaching a secondary index to a table that holds no rows used to read the table's whole change log to copy nothing across. It now checks for rows first and skips the work.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/index-backfill-cost.spec.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/README.md
difficulty: medium
----

# Index backfill skips the scan when there is nothing to copy

## What shipped

`backfillIndexTrees` — the single populate path shared by `CREATE INDEX`'s build and by
re-attaching to an index this connection was detached from — used to unconditionally
refresh the main collection, walk every row, and flush every target index tree. On a table
with no rows the walk stages nothing, but both refreshes still ran, and both are
deliberately cache-bypassing log walks.

Three edits:

**Skip the refresh + scan when the table has no rows.** `backfillIndexTrees` asks
`hasNoRowsToBackfill()` *before* `collection.update()`. The check reads the LIVE tree
(`collection.at(await collection.first()) === undefined`), so it sees this connection's
committed rows *and* anything staged in an open transaction. Decided once per call, not
per index — one scan serves every newly attached tree.

**Flush only the trees that have something to flush.** `Tree.sync()` is
`collection.updateAndSync()`, so syncing a tree with an empty change set pays a full log
walk before discovering it has nothing to commit. `flushDirtyTrees()` skips those, keyed on
a new `Collection.hasUnsyncedChanges()` (and its `Tree` delegate). A newly *invented* index
tree still flushes — its header/root sit uncommitted in the tracker and count as unsynced.

**The same guard on the adjacent site.** `ensureUniquePopulated` had the identical shape
and the identical waste. It returns early on the same check, *without* marking the tree
populated, so a later probe over a by-then-populated table still gets its one backfill.

## Numbers (raw-storage operations, `IRawStorage` proxy in `index-backfill-cost.spec.ts`)

Re-measured during review; reproduces the implement-stage figures exactly.

| scenario | before | after |
|---|---|---|
| `CREATE INDEX` on a table with committed history, zero live rows | 301 | **255** |
| Re-attach to an index on an empty table (both refreshes wasted) | 184 | **98** |
| `CREATE INDEX` on a 20-row table (control) | 301 | **301** |

The originating ticket's "~446 operations for one backfill on a brand-new empty table"
could not be reproduced and is restated honestly in the implement handoff: a never-written
table has an *invented* collection whose header was never committed, so `update()` costs
~2 operations there. The waste is real only once the collection has a committed log, where
it measures 46–102 operations per attaching table and grows with log depth (184 → 200 as an
empty table's log grew 1 → 40 revisions; flat at 98 after the fix). A downstream consumer
seeing ~446 across a cold start should re-measure rather than assume it all disappears.

## Review findings

**Verified (no change needed).**
- `probeUniqueConstraint` calls `tree.update()` immediately after `ensureUniquePopulated`
  (`optimystic-module.ts:1393`), so the new early return costs the probe no tree freshness
  — the site comment's claim holds.
- `executeIndexScan` refreshes each target tree (`optimystic-module.ts:795`), so skipping a
  not-dirty `tree.sync()` cannot leave a later scan reading a stale tree. This was the
  reviewer's main worry about dropping the update half of `updateAndSync`.
- `Collection.hasUnsyncedChanges()` is *literally* the predicate `syncInternal`'s commit
  loop iterates on (`collection.ts:521` was rewritten to call it), so "skipping a not-dirty
  sync is behaviour-preserving" holds by construction, not by argument. The two cannot
  drift.
- Documentation: the plugin README's Limitations bullet is updated and accurate. `docs/`
  contains no index-backfill content — every `backfill` hit under `docs/` is the unrelated
  reactivity replay-buffer feature. Nothing else needed updating.

**Fixed in this pass (minor).**
- `ensureUniquePopulated`'s early-return comment deferred its soundness argument to
  `hasNoRowsToBackfill`, whose SOUNDNESS section argues only the *index-backfill* failure
  mode (a row left unindexed). The unique arm's failure mode is different — a missed
  populate admits a **duplicate**. Extended the site comment with the unique-specific
  argument: the probe reads the tree after `tree.update()`, so entries any writer running
  this build maintained are visible without a populate at all; populate exists only for
  rows an OLDER build wrote past an unmaintained tree, and those are collidable only
  against rows this connection can see. The residual hole (a stale view missing an
  old-build sibling's rows) is the pre-existing shape of the guard, which already ran once
  per tree per process and never re-checked.
- `backfillIndexTrees` called `flushDirtyTrees(targets)` twice — once on the skip branch
  before an early `return`, once after the scan. Restructured to a conditional scan
  followed by a single flush.

**Test gap closed.**
- Added `a session that never wrote to the table still backfills rows a previous one
  committed`. The skip removed a `collection.update()` that used to run *before* the
  emptiness question was asked, so the check now reads a view established at open. A cold
  session is the shape where that distinction bites: if a freshly-opened collection ever
  read a populated table as empty, `CREATE INDEX` would skip the scan and leave every row
  unindexed, silently. Passes.
- The existing suite otherwise covers this well and was re-read rather than trusted: the
  `ensureUniquePopulated` arm is pinned by `secondary-unique-migration.spec.ts` ("rejects a
  duplicate of a pre-existing value on a fresh instance whose unique tree started empty")
  and `secondary-unique-hydrate.spec.ts` ("hydrate-only open backfills an empty unique tree
  over already-populated rows") — both exercise the `hasNoRowsToBackfill() === false` path
  on a cold instance. The originating re-attach bug stays pinned by
  `index-maintenance-invariant.spec.ts`.

**Considered and not filed.**
- *An INVENTED index tree on an empty table could have empty tracker transforms and be
  skipped by `flushDirtyTrees`, never committing its header.* Benign by construction:
  re-opening invents an identical empty tree, and it is the persisted schema catalog — not
  the tree — that makes the index exist. Nothing can be lost by re-inventing an empty tree.
  Not a ticket.
- *The narrowing itself* — rows a **sibling** connection committed since this one last
  pulled, where that sibling was not maintaining the index, are no longer covered by the
  incidental `update()`-before-scan. Reviewed and agreed with the implementer: the coverage
  was never general (a connection that opens cold and finds the index already persisted
  attaches nothing and never scans, so a divergent writer's orphans already survive every
  open that does not re-declare). The change removes an incidental widening, not a
  guarantee, and it is documented both at the code site and in the README. Deliberately
  untested, since pinning it would lock in a tradeoff rather than a behaviour.
- *`optimystic-module.ts` is 3159 lines* (`wc -l`). Real, but already claimed by
  `backlog/debt-optimystic-vtab-class-is-too-big-to-review` — this diff is evidence, not a
  new ticket. It added two short single-purpose private methods (`hasNoRowsToBackfill`,
  `flushDirtyTrees`, each under 10 lines of body), so it is not a size regression.

**Tripwires recorded (not tickets).**
- `hasNoRowsToBackfill()` re-runs on `probeUniqueConstraint`'s path once per DML row while
  the table is empty, because the tree is deliberately not marked populated. Parked as a
  greppable `NOTE:` at the `ensureUniquePopulated` site, with the remedy (memoize the
  emptiness answer until the first stage) and the trip condition (an empty-table DML burst
  showing up in a profile).
- The cost ceilings count `IRawStorage` calls through `MemoryRawStorage`, so a change to
  the storage layer's per-block call pattern will need them re-baselined. Already parked in
  `index-backfill-cost.spec.ts`'s header comment, which states they are ceilings to catch a
  reintroduced log walk, not a pin on the storage layer.

**Empty categories, stated explicitly.** No major findings, so no new `fix/`, `plan/`, or
`backlog/` tickets were filed — the one architectural decision in the diff (the sibling
narrowing) is an accepted tradeoff already documented at its site, and the two defects found
were both documentation/structure issues fixable inline. No `blocked/` ticket: nothing here
needs a human decision that the implementer did not already make and record.

## Validation

- `yarn lint` — exit 0, clean.
- `yarn build` — exit 0.
- `yarn test` (all packages) — exit 0, all green. `@optimystic/db-core` 1368 passing;
  `@optimystic/quereus-plugin-optimystic` 472 passing / 11 pending (471 at implement, +1 for
  the cold-session spec added in review); no failures in any package.
- Cost spec re-measured under review: 255 / 98 / 301, matching the table above.
- No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

## Known gaps carried forward

- The measured wins are on a test harness with shallow logs. The real magnitude on a phone
  against a months-old control database is unmeasured.
- Backfill only ADDS entries, never purges — an entry a detached writer orphaned survives a
  re-attach. Pre-existing, documented at `executeIndexScan`, untouched by this change.
