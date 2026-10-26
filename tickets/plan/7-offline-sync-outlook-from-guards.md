description: Tell the application, the moment it commits offline, whether anything another user does could make that change fail, so it can show most pending changes as simple progress and reserve warnings for the few that might not go through.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#predicting-whether-an-entry-will-commit
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/db-core/src/collections/tree/struct.ts, packages/quereus-plugin-optimystic/README.md, docs/offline-sync.md
----

Stage 7 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages). Needs no Quereus change.

## What is wanted

`CommitOutlook` ([§The outlook](../../docs/offline-sync.md#the-outlook)) computed from the staged actions' guards and the queue alone:

- every `absent` and `absentRange` guard is an exposure unless its column carries `"optimystic.fresh" = true`;
- every `unchanged` guard is an exposure unless its row was inserted by an unsettled entry of this queue under a tagged-fresh key, or the table carries `"optimystic.single_writer" = true` ([§Declared hints](../../docs/offline-sync.md#declared-hints));
- `dependsOn` with `via: 'guard'` for an `unchanged` guard over a row an earlier unsettled entry wrote ([§Dependencies between entries](../../docs/offline-sync.md#dependencies-between-entries));
- `unchecked` left empty and reported as not computed (the type needs a way to say so — settle it);
- delivered on `queued`; `outlook-changed` when an entry exposed only through `dependsOn` becomes assured because those entries committed;
- the `CommitOutlook()` SQL function, mirroring `StampId()`: the outlook the current transaction would get if committed now, `NULL` outside a transaction ([§Using the outlook before committing](../../docs/offline-sync.md#using-the-outlook-before-committing));
- the `offline:assured-entry-failed` log when an assured entry fails for a reason other than expiry, discard or validator rejection.

Conservative by construction: anything not provably assured is exposed ([§Conservative by construction](../../docs/offline-sync.md#conservative-by-construction)).

`StampId()` and wide random sources are not detectable without the Quereus write description (blocked `offline-sync-quereus-write-description`); in this stage only tagged columns count as fresh.

## Edge cases the plan must cover

From the doc's test plan, the cases that need no write description: an insert under a tagged-fresh key is assured; an insert under a natural key is exposed with that key; an update of a row created offline under a tagged-fresh key is assured; an update of an existing shared row is exposed; `outlook-changed` on dependency commit; a false fresh hint produces an assured entry that fails with `constraint` and logs. Every assured prediction in the offline-mode scenario suite that ends `failed` (other than expiry, discard, rejection) fails the test.

## Done when

The README documents the outlook and the two tags, and docs/offline-sync.md marks the stage implemented.
