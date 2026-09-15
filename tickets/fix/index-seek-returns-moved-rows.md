description: When a row's indexed value changes but a leftover entry for the old value stays in the index, looking up that old value hands back the row anyway — a row that plainly does not hold the value asked for. The leftover entry was believed harmless because the engine was re-checking the value; it does not, so the wrong answer reaches the caller.
repro: verified
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-integrity.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/query-helpers.spec.ts, packages/quereus-plugin-optimystic/test/two-node-index-mutation-sweep.spec.ts, docs/debugging.md
difficulty: medium
----

## What was observed

Found during the review of `two-node-index-mutation-sweep`, by seeking the leftover entry's own value — something no test had done before.

A secondary-index equality lookup returns rows whose current value is not the value sought. Two independent reproductions, both on `Token`, indexed by a plain declared index:

- **Single node, staging deliberately broken** (`test/query-helpers.spec.ts`, the `stageNewEntryOnly` case): row 3 moves from `tok-b` to `tok-z` and its `tok-b` entry is left behind. `select Id from Usage where Token = 'tok-b'` returns `[3]`. Row 3 holds `tok-z`.
- **Two nodes, no patching at all** (`test/two-node-index-mutation-sweep.spec.ts`): every racing update-vs-update case and every INSERT OR IGNORE race leaves a leftover entry, and seeking its value returns the row it points at — e.g. `where Token = 'tok-ignored'` returns `(300, 'tok-winner')`.

A leftover entry whose row is *gone* is still skipped correctly and returns nothing. Only the moved-row form leaks.

## Why this is a defect here and not in the engine

`executeIndexScan` in `src/optimystic-module.ts` descends the index tree for the seek key, fetches each entry's row by primary key, and yields the row without checking that the row still carries the value the seek asked for. `getBestAccessPlan` (same file, around the `bestHandledFilters` assignment) reports the matched equality filters as handled, so the engine is entitled to place no filter above the seek — and does not. The plugin promises "these rows match" and then yields rows that do not.

The `NOTE:` already sitting above that loop describes this exact risk and calls it benign, on the strength of an observation that the engine re-applied the predicate and the statement returned no rows. **That observation no longer holds** — whatever once re-checked the value does not now. The NOTE also names the remedy: re-derive the entry's key from the fetched row (`IndexManager.createIndexKey`) and skip entries whose key does not prefix-match the seek key. A second NOTE further up, on the primary-key seek path, asserts in passing that "a secondary index seek keeps one [residual filter]"; that claim is part of the same mistaken picture and needs re-checking rather than trusting.

Either direction closes it: filter in the plugin as the NOTE describes, or stop claiming the filters are handled so the engine keeps a residual filter. The first keeps the plan's efficiency; the second is a one-line honesty fix with a per-row cost. Weigh them; do not do both silently.

## Scope to establish while fixing

- **Composite and multi-column indexes**: the check must be a prefix match on the columns the seek actually constrained, not a whole-key comparison, or a legitimate partial-prefix seek starts dropping rows.
- **The value-less seek**: the code path that frames an empty prefix (an index-served `ORDER BY`) constrains nothing, so there is nothing to re-check — but a leftover entry there means the same row is produced twice, once under each entry. Unverified, inferred from reading the loop; confirm or refute it with a test before claiming either way.
- **NULL and numeric forms**: the index key serializer unifies `5` and `5n`, and NULL sorts under its own tag. A re-derived key must compare equal in exactly the cases the descent already treats as equal.

## Producers of a leftover entry

This ticket does not remove the producers, only the wrong answer. Two producers are known: concurrent same-row writes, which `refuse-concurrent-row-change-loser` is about to close; and a writer that was not maintaining an index updating a row, where a later re-attach adds the new entry and never purges the old one. The second survives that ticket, so this defect stays reachable after it lands.

## Tests that already pin today's behaviour

Both were written to go red the moment this is fixed, and both say so at the site. Flip them as part of the fix, rather than deleting them:

- `test/query-helpers.spec.ts`, in the case named "fails on an entry left behind for a value no row holds any more": the `tok-b` seek is pinned to `[3]` and should become no rows.
- `test/two-node-index-mutation-sweep.spec.ts`, `expectOrphanSeeks`: a stale-value leftover's seek is pinned to the row it points at and should become no rows for every leftover, which collapses the helper to one assertion. Note the sibling ticket `refuse-concurrent-row-change-loser` deletes that whole branch when it lands; whichever goes second inherits a smaller job.

## Documentation asserting the false claim

Each of these states, as settled fact, that a leftover entry can never change a result set. All are wrong today and must be corrected — or made true again — by this ticket:

- `src/optimystic-module.ts`: the stale-entry `NOTE:` above the index-scan loop, and the primary-key seek's residual-filter aside.
- `src/schema/index-integrity.ts`, file header.
- `src/plugin.ts`, the `verifyIndexes` doc comment.
- `docs/debugging.md`, in the index-integrity section.
- `test/query-helpers.ts` already carries the corrected wording, which will need a second pass once the seek is fixed.
