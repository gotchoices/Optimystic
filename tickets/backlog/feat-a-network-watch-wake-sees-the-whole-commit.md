description: A machine that watches a table over the network without storing it can be woken for another machine's write before that write's indexes are readable, and is not woken again, so a lookup through an index at that wake misses the new row.
files: packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch`), packages/db-p2p/src/cohort-topic/change-bridge.ts (`makeCohortTopicChangeNotifier`, `selfAppliedTail`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`openNetworkWatch`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`watchCollectionOverNetwork`)
prereq: a-watch-wakes-after-every-collection-of-a-commit-applies
tradeoffs: Only a watcher that stores none of the table's blocks is affected (in groups no larger than one cohort every machine stores everything, and its local wake is already consistent), and each fix either adds a network watch per index or delays every announcement.
----
# A network-watch wake sees the whole commit

Follow-up to GitHub [#47](https://github.com/gotchoices/Optimystic/issues/47). `a-watch-wakes-after-every-collection-of-a-commit-applies` makes a machine's local storage hold a table's wake until the same write's other collections pending on that machine have landed. That covers every watcher that stores the table. It does not cover a watcher that hears the write only through `node.reactivityWatch`:

- Origination fires on a member of the table tail's storage group when the TABLE's commit applies there (`selfAppliedTail` over the catch-all feed), so the notification can arrive before the index's commit has applied anywhere.
- The watcher's re-query pulls the index through whichever machine answers its read, which may not have the index commit yet.
- The watch service's backstop tick compares only the table's tail revision, which this write already moved, so it never wakes again for it.

## Expected

A watcher that stores none of the table, woken over the network for another machine's commit, either sees that commit through every index at the wake, or is woken again once it can. Candidate directions, to be chosen in planning:

- The vtab also opens network watches on its index collections (one per index) and wakes the table on any of them: simple, more registrations and renewals per table, and an early wake can still see the table and index disagree.
- Origination waits for the action's other collections on the originating machine (needs `bug-a-commit-cert-is-looked-up-by-action-alone` first, since a delayed table event would otherwise resolve the index record's certificate), which helps only where the reader's coordinator is the originator.
- The watch tick also compares index tails for a table's watch.
