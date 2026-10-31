description: In offline mode, an insert into a table that has a unique column or an index can fail with "Path is invalid due to mutation of the tree" when the offline queue is committing earlier inserts into the same table at that moment. A point read must not fail because the tree changed under it.
architecture: docs/internals.md#the-offline-queue
files: packages/db-core/src/btree/btree.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
----

GitHub [#50](https://github.com/gotchoices/Optimystic/issues/50).

## Report

Optimystic 1.20.1 (through cadre-core 1.19.1's `strandOffline`), Quereus 4.21.1, Node 24, one machine, offline mode. 300 autocommit inserts into one table, each `insert into item (id, name, cat) values (?, ?, ?)`:

| Table | journal writes resolve immediately | journal `flush` pauses 1 ms |
|---|---|---|
| `id` primary key only | 300 ok | — |
| + `name text unique` | fails at insert 15 | — |
| + `index item_cat on item (cat)` | fails at insert 12 | — |
| both | fails at insert 8 (2 of 2 runs) | 300 ok |

```
Error: insert failed: Path is invalid due to mutation of the tree
  at OptimysticVirtualTable.update (quereus-plugin-optimystic)
  [cause] at BTree.validatePath ← BTree.at ← BTree.get ← Tree.get ← OptimysticVirtualTable.update
```

The "immediate" journal is a plain object implementing `IKVStore` with no `flush`, which the interface allows ("every write is already durable"). A `FileKVStore` journal never failed, because its flush waits for the disk. A phone's React Native LevelDB journal cannot sync, so a phone may be close to the failing case. The full repro script is in the issue.

## What appears to happen

`BTree.get` is `this.at(await this.find(key, true))`. `find` awaits block reads; `at` then checks that the path's version still equals the tree's version. While `find` is suspended, the queue's drain commits an earlier entry into the same collection, and the replay that follows (`Collection.replayActions`, through the tree's action handler) calls `invalidatePaths()` on the read-side B-tree, from the "held.btree?.invalidatePaths()" site in `packages/db-core/src/collections/tree/tree.ts`. When `find` resumes, its path is stale and `at` throws. A journal whose writes never yield is what lets the drain's steps land inside the insert's `await`s instead of between statements. Confirm this before fixing it.

The extra trees matter because a unique column or index adds more point reads per insert (the pre-stage probes, the index maintenance), each of which can be cut in two by a drain step.

## Expected

- A point read (`BTree.get`, and so `Tree.get` and `Collection.get`) returns the entry for the key as of some moment, or undefined; it never throws because the tree was changed by something else while it was reading. Range scans keep their documented "mutation during iteration will result in an exception" contract; this ticket is about reads that hand back no path.
- The repro's both-structures table, with the immediate journal, completes 300 inserts.
- Check the other `find`-then-use sites the vtab's write path runs during `update()` (the probes in `optimystic-module.ts` that call `collection.get`, and `IndexManager`'s lookups) for the same exposure, and say in the ticket which were affected.

## Test

A db-core spec that suspends a `Tree.get` inside its descent, commits or replays into the same collection meanwhile, and asserts the read completes. A plugin spec in the shape of the report: offline mode, a journal with no `flush` whose writes resolve without yielding, a table with a unique column and an index, a few hundred autocommit inserts, all succeed and the queue drains.

## Not this ticket

The report also measured offline mode costing about 5× a synchronous transaction on one machine (68 ms against 14 ms per row) and the queue draining at about 80 ms per transaction. That is a cost question, not this bug.
