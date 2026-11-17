description: A materialized view defined over an Optimystic table is kept up to date only for writes made on the same machine; rows other machines commit never reach it, and because the query engine answers matching queries from the view, even ordinary totals over the source table silently leave those rows out.
architecture: docs/internals.md#reactive-watch-bridge-quereus-vtab
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`OptimysticVirtualTable.handleCollectionChange`, the collection-change subscription), packages/quereus-plugin-optimystic/src/optimystic-adapter/external-change.ts (`announceExternalChange`), packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-mode.ts, @quereus/quereus/src/core/database.ts (`Database.notifyExternalChange`, `Database.ingestExternalRowChanges`, `Database.refreshAllMaterializedViews`), Quereus docs/mv-ingestion.md
repro: static
----

**Blocked: the specification is silent.** Nothing says how a materialized view over a networked table should behave when other machines write the table. Unblocks when a maintainer accepts or edits the proposal below; the ticket then goes to `plan/`.

## Proposal (recommended default)

A materialized view over an Optimystic table is refreshed after another machine's commit reaches this machine, and is never used to answer a query while it is known to be behind.

- On an external change to a table a materialized view reads, the plugin marks each such view stale and schedules its refresh outside the change callback (after the engine's exec lock is free), coalescing changes that arrive while a refresh is pending.
- While a view is stale, the planner must not rewrite queries to read it, and a direct `select` from the view either waits for the refresh or reads the source. If Quereus has no way for a module to mark a view stale, that is an ask to file on Quereus's board, and the plugin refreshes eagerly in the meantime.
- Cost: a whole-view refresh per batch of remote commits, which is proportional to the source table. Acceptable for the reported migration ("expand") use and small rollups; revisit if a large view is refreshed often.

## Alternatives rejected

- **Maintain the view row by row for remote rows** (Quereus `ingestExternalRowChanges`). Needs the before and after image of every changed row. A log entry carries the new row of an upsert, and the old row only where the action's guard records it (`unchanged`-family guards carry `expected`); index-tree actions and unguarded writes carry no old row, so aggregates cannot be maintained from the log alone in every case without reading the prior state. Best long-term result, but a larger change; it can replace the refresh later without changing what a reader sees.
- **Refuse to create a materialized view over a networked Optimystic table.** Simplest and honest, but breaks the "expand" phase of Quereus `docs/migration.md`, which is how the reporter (Sereus) upgrades schemas.

## If nothing is done

Queries on a machine silently omit other machines' rows whenever a materialized view (or a rollup the engine rewrites to read one) covers them. That is a wrong result with no error.

## Reversibility

High. The refresh is internal to the plugin; switching to row-by-row maintenance later changes cost, not results.

# A materialized view misses rows other members commit

Reported as GitHub #58 (Sereus; optimystic 1.26.0 and 1.27.0, quereus 5.0.0 and 5.4.0).

## What happens

On machine A, `create materialized view ChitTotal as select Side, sum(Units) … from Chit group by Side` over an Optimystic table. Machine B commits a row to the same collection. A's `select * from Chit` shows B's row, but `ChitTotal` does not, and neither does the view's body run as a plain query nor a rollup that never names the view (`select sum(Units) from Chit`): Quereus rewrites both to read the view. A's next local insert adds its own row on top of the stale total. Only `refresh materialized view` corrects it. The reporter's Optimystic-only repro (comment on the issue) uses two `Database`s over one shared `StorageRepo` transactor, the shape `packages/quereus-plugin-optimystic/test/external-commit-visibility-after-rollback.spec.ts` builds; the original report breaks the "expand" phase of Quereus `docs/migration.md`, where an upgraded peer derives a new table from rows older peers write.

## Read from the code

The vtab's change listener, `OptimysticVirtualTable.handleCollectionChange`, calls only `announceExternalChange`, i.e. `Database.notifyExternalChange` — a coarse whole-table watcher invalidation. Per Quereus `docs/mv-ingestion.md` and the doc comment on `notifyExternalChange`, that runs no materialized-view maintenance; maintenance for externally applied rows goes through `Database.ingestExternalRowChanges`, which needs the row images the listener does not have. The same holds for the network-watch wake and for the offline-mode announcement of a failed entry, which use the same helper. Not run here; the reporter's script is small enough for the fix stage to turn into the reproducing test.

## Expected

No read on a machine may return results that omit another member's committed rows because a materialized view over the source is behind. The issue offers three acceptable shapes, in order of preference:

- maintain the view for rows arriving from other members (needs row images, or a full rebuild);
- on an external change to a table a materialized view reads, mark that view stale or refresh it (`refreshAllMaterializedViews` / the single-view refresh path), so the planner stops answering from it — the reporter's suggested stopgap;
- refuse to create a materialized view over a networked Optimystic table, loudly, until one of the above exists.

Whichever is chosen, note that `refreshAllMaterializedViews` and `ingestExternalRowChanges` serialize on the exec mutex and must not be called from inside a vtab callback (the change listener runs from a storage commit callback), and that the change event can arrive before the index collections of the same commit have landed (see *A collection's wake waits for the action's other collections pending here* in docs/internals.md).
