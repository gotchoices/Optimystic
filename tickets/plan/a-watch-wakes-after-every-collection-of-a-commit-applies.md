description: When another machine's write reaches this machine, apps watching the table are woken as soon as the table's own data arrives, before the table's indexes have caught up, and nothing wakes them again; a lookup through an index at that moment misses the new row. Wake watchers only once the whole write, indexes included, is readable here.
files: packages/db-p2p/src/storage/storage-repo.ts (`emitCollectionChanges`, `onAnyCollectionChange`), packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/src/reactivity/collection-watch.ts
----
# A watch wakes after every collection of a commit has applied

GitHub [#47](https://github.com/gotchoices/Optimystic/issues/47) (kjeib, Sereus repro). Read the issue in full (`gh issue view 47`); it includes a Sereus integration scenario and a timeline.

A table and each of its indexes are separate collections. A replicated commit applies them one at a time on the receiving member. The table's collection applies first, and its `CollectionChangeEvent` wakes `Database.watch` through `notifyExternalChange`. A query the planner serves from an index (`where K = ?`), run at that wake, does not see the row: the index collection applies a few hundred ms later, and index collections are not watched (docs/internals.md §Reactive Watch Bridge), so no second wake comes. The app sees the row only at its next poll or the 30 s reactivity tick (Taleus: forming a tally waits 15–16 s at one step).

Check whether the network-watch path (`node.reactivityWatch`) has the same shape: can its wake precede the index landing locally?

## Expected

- A watcher woken for another machine's commit, querying at the wake, sees that commit through every index of the table. Table and indexes agree at the wake.
- Candidate directions (the planner chooses and records why): fire a table's wakes once all of that action's collections have applied on this node; or have an index collection's apply also wake its parent table's watchers (simpler, but leaves a window where a reader at the first wake sees the row by scan and not by index). A consensus record can now carry several collections of one action (`a-consensus-record-carries-several-collections-of-one-action`), and the collections of one action can also arrive in separate records or replication pushes.
- Over-waking is cheap (whole-table invalidation); a missed wake is not.

## Test

A two-node spec (the in-process mesh is fine) with a watched table plus an index: at each wake, a lookup through the index finds the row the wake announced.
