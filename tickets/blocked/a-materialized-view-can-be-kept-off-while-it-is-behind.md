description: Quereus needs a public way for a storage plugin to mark a materialized view as behind its source tables, so no query answers from it until it is refreshed; until Quereus offers that, Optimystic can only rebuild such views, not keep them off.
prereq: a-materialized-view-follows-rows-other-members-commit
architecture: docs/internals.md#reactive-watch-bridge-quereus-vtab
files: @quereus/quereus/src/core/database.ts (`Database.markMaterializedViewStale`, internal), @quereus/quereus/src/core/database-materialized-views.ts (`MaterializedViewManager.markMaterializedViewStale`), @quereus/quereus/src/planner/building/select.ts (the stale re-validation guard), @quereus/quereus/src/planner/analysis/query-rewrite-matcher.ts (`stale` gates), packages/quereus-plugin-optimystic/src/optimystic-adapter/materialized-view-follower.ts
----

# A materialized view can be kept off while it is behind

**Blocked: external dependency (Quereus).** Unblocks when Quereus publishes an API with the capability below; then this becomes an implement ticket for the Optimystic side, whose design is at the end.

## Why

GitHub #58. The maintainer's decision (2026-11-17) gives a materialized view over an Optimystic table two behaviours when another machine's commit reaches this one, chosen by configuration: **refresh** (rebuild it, after the engine's exec lock is free) or **invalidate** (mark it stale and use it to answer no query — neither read directly nor substituted by the planner for its body or a rollup — until it is next refreshed). Refresh lands in `a-materialized-view-follows-rows-other-members-commit`. Refresh leaves a window between the signal and the rebuild's commit in which reads still answer from the old rows, and a rebuild per burst of remote commits costs a full re-read of the source; invalidate is the mode for a view that is expensive to rebuild or must never answer behind.

What Quereus has today does not do it:

- `Database.markMaterializedViewStale` is marked `@internal`, and Quereus builds with `stripInternal`, so it is not in the published types.
- Its `stale` flag is about **schema** changes. The rewrite matcher declines a stale view (good), and row-time maintenance detaches (good), but a direct reference only re-plans the body to check it still compiles and then **serves the stored rows** (`building/select.ts`). So `select * from ChitTotal` would still answer behind.

## Proposed capability (for Quereus)

> A host or module may mark a materialized view **behind its sources** (`Database.markMaterializedViewBehind(schemaName, name)`, public). While behind:
>
> - the query rewrite never substitutes it for its body or a rollup (as for `stale`);
> - a direct reference does not read its stored rows: it is answered by planning the view's body against the sources, as a plain view would be (the "materialized view is a faster view" reading `mv-schema-change.md` already uses for rename propagation);
> - row-time maintenance is detached, and cached plans that read the backing are invalidated (as `markMaterializedViewStale` does);
> - `refresh materialized view` and `refreshAllMaterializedViews` clear it, re-registering maintenance;
> - marking is idempotent, synchronous, takes no exec lock, and is safe to call from a module callback (it only sets state and emits the backing invalidation);
> - it is distinct from schema-change `stale`: it never produces the "a source changed in an incompatible way" error, and a body that no longer plans reports that error as it does today.
>
> A `materialized_view_behind` schema event (or the existing `materialized_view_modified`) announces the transition so watchers of the view re-query.

Alternatives rejected:

- **A direct reference refuses with a typed error** instead of planning the body. Simpler in Quereus, but every application query over the view then fails while a remote commit is unrebuilt, which reads as an outage; answering through the body is slower but correct.
- **Publish `markMaterializedViewStale` as is.** Leaves the direct-read hole above, so invalidate mode would still answer behind on direct reads.
- **Optimystic drops and recreates the view.** Loses the definition's identity, its watchers and dependents; not a host's call to make.

If nothing is done: refresh stays the only mode. Every view over an Optimystic table is rebuilt after each burst of remote commits, and answers behind for the length of a rebuild. Reversible: adding the API and the mode later changes no stored data.

## Optimystic side, once the API exists

- **Setting.** Plugin config `materialized_views` = `'refresh'` (default) | `'invalidate'`, overridable per view with the tag `"optimystic.external_change" = 'refresh' | 'invalidate'` on the materialized view (`alter materialized view … set tags`, read `=== 'invalidate'` at signal time, unknown values treated as the plugin default with one WARN). Per view because one view may be cheap to rebuild and another not; the plugin default because most applications choose once. Default refresh: it keeps the planner's speedup and is correct after each rebuild.
- **Behaviour.** In `MaterializedViewFollower`, a view in invalidate mode is marked behind synchronously when its source table turns dirty (signal 1 or 3, or after a hint's pull adopts foreign commits) — no exec lock needed — instead of being queued for rebuild. It stays behind until `refresh materialized view` (by the application, or a later refresh by policy).
- **Tests.** Invalidate mode: B inserts, A's `select sum(Units) from Chit` and `select * from ChitTotal` both include B's row before any refresh; after `refresh materialized view ChitTotal` the view answers from stored rows again.
