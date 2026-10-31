description: In offline mode, an insert into a table that has a unique column, or a unique column and an index, fails when the offline queue commits earlier inserts into the same table at that moment. A read that was halfway through the tree when the queue rebuilt it either fails its own consistency check or follows a link to a block that no longer exists. Reads that hand back one value must retry instead of failing.
architecture: docs/internals.md#the-offline-queue
files: packages/db-core/src/btree/btree.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/db-core/docs/btree.md, docs/internals.md
repro: verified
----

GitHub [#50](https://github.com/gotchoices/Optimystic/issues/50).

## Reproduced

Plugin level, one `Database`, `default_transactor: 'local'` over a `TestTransactor`, `offline: { allowSoloCommit: true }`, `plugin.offline.enter()`, then 300 autocommit `insert into item (id, name, cat) values (?, ?, ?)`:

| Table | Result |
|---|---|
| `id` primary key only | 300 ok |
| + `index item_cat on item (cat)` | 300 ok |
| + `name text unique` | fails at insert 1–15: `Path is invalid due to mutation of the tree` from `BTree.at` ← `BTree.get` ← `Tree.get` ← `OptimysticVirtualTable.update` (the stack in the report) |
| both | fails at insert ~65: `Missing block (<id>)` from `get` in `packages/db-core/src/blocks/helpers.ts` ← `BTree.getPath` ← `BTree.find` ← `BTree.findFirst` ← `BTree.range` ← `IndexManager.findEntriesIn` ← `findByIndexIn` ← `probeUniqueConstraint` ← `resolveSecondaryUniqueDecision` ← `update` |

A journal is **not** needed. It fails the same with the report's immediate journal (a plain `IKVStore` with no `flush`) and with no journal at all. The real condition is that every `await` on the drain's path settles without real I/O (the `TestTransactor` does that, and so does an immediate journal over a real transactor in the report). The drain then advances one microtask at a time, interleaved with the insert's own microtasks, instead of only between statements. A journal whose flush waits for a disk pushes the drain's steps out to macrotasks, which is why `FileKVStore` and the 1 ms pause never failed.

The script used (adapt it into the plugin spec below):

```ts
class ImmediateKV implements IKVStore {	/* Map-backed get/set/delete/list, no flush */ }
const db = new Database();
const plugin = register(db, { default_transactor: 'local', default_key_network: 'test', enable_cache: false,
	offline: { journal: new ImmediateKV(), allowSoloCommit: true } } as unknown as Record<string, SqlValue>);
plugin.collectionFactory.registerTransactor('local:test', new TestTransactor());
// register vtables + functions as test/mesh-node-harness.ts createMeshDbNode does
await db.exec(`create table item (id integer primary key, name text unique, cat text) using optimystic('tree://r/d')`);
await db.exec('create index item_cat on item (cat)');
plugin.offline.enter();
for (let i = 0; i < 300; i++) await db.exec(`insert into item (id, name, cat) values (${i}, 'n${i}', 'c${i % 7}')`);
await plugin.offline.whenDrained();
```

## Cause

The vtab's write path and the queue's drain share one `Collection` instance per tree. The drain's head commit runs `Collection.commitHead`, and on success it folds the committed head into the cache and **replays** the remaining sealed segments and the open segment (`Collection.replayActions`). That resets the tracker to the replay baseline, then re-runs every remaining action handler. The handlers mint **fresh random ids** for any block they insert (a split's new node), so the tree after the replay is built from different block ids than the one before it. Reads are deliberately not latched (`concurrencyMode = 'reentrant-reads'`), so the insert's point reads and probe scans run during these steps.

Two symptoms from one cause:

- **Torn descent → `Missing block`.** A descent reads a branch before the replay's `tracker.reset`, and the branch names a child that a staged split inserted. The reset drops that insert, and the replay re-creates the split under a new id. The descent then asks for the old id, which exists nowhere. A descent can also tear without throwing: an old branch over a new leaf may report a present key as absent.
- **Stale path → `Path is invalid`.** `BTree.getPath` stamps the `Path` with `_version` at the leaf, after the descent's reads, so only the few microtask hops between the leaf and `BTree.at`'s `validatePath` are exposed. The `replace` handler's `held.btree?.invalidatePaths()` at the end of each replayed action (the "Mutations landed in `trx`" comment in `packages/db-core/src/collections/tree/tree.ts`) lands in those hops.

The version counter cannot catch the torn descent today, for two reasons. It is bumped at the **end** of each handler, after the reset the descent already read across. And it is not bumped at all by changes made without a handler running: a replay with nothing left to stage (the reset alone), the success fold (`foldOwnCommit` / `sourceCache.transformCache`), a refresh's `forgetAndAdopt` cache clears, or `restorePending`'s reset arms.

## Sites on the write path (`update()`), and which were affected

- `Tree.get` → `BTree.get`: **affected, observed.** The callers are the primary-key probe in the INSERT arm (the `collection.get(insertKey)` near `insertGuard`), `requirePreWriteRow` (`collection.get(key)`), the displacement probe (`collection.get(newKey)`), and the per-hit row fetch inside `probeUniqueConstraint`. A unique column adds one point read per insert. That is why "unique" fails and "pk only" does not: the PK probe also runs for pk-only, but the unique probe's extra awaits widen the window.
- `IndexManager.findByIndexIn` → `findEntriesIn` → `BTree.range`, from `probeUniqueConstraint`: **affected, observed** (the `Missing block` arm). `range` does `findFirst`, then `findLast`, then `internalAscending(startPath)`, which validates `startPath`. A torn descent in either find throws `Missing block`, and a bump between them throws `Path is invalid`, all before the first entry is yielded. After a hit the loop awaits `collection.get(pk)` before the next `moveNext`, which can also throw. That is mid-iteration, under the documented scan contract, but this is a write probe.
- `IndexManager` maintenance (`insertIndexEntries` / `updateIndexEntries` / `deleteIndexEntries`): **not affected.** They only `stage`, and staging goes through the latched `act`, where the handler descends its own Atomic-backed `actionTree`.
- `readRowAt` in `optimystic-module.ts` (read path, not `update()`): **same exposure, silent.** It does `find` + `isValid`, and on an invalid path it returns `undefined`, so a point lookup or an index-driven seek that races a drain step drops a row from its result without an error. It should use `get` once `get` retries.
- `walkDecodedRows`, `findEntriesIn`, `allEntriesIn`, `scanIndexRange` skip a path on `!isValid(path)` (`continue`) and then throw at the next `moveNext`. That is range-scan behaviour under the documented contract, so it is out of scope here; note it in the handoff.

## Fix

**1. One signal for "what this tree reads may have changed".** `Collection` gets an optional `CollectionInitOptions.onViewChanged?: () => void` (`packages/db-core/src/collection/struct.ts`). One private `Collection.viewChanged()` calls it, synchronously, at every site that replaces the tracker's transforms or changes what the read cache serves for this collection: before `tracker.reset` in `replayActions`, `unstage` and `restorePending` (both arms); at the end of `stageInto` (the `act` path); after the success folds (`foldOwnCommit`, the `transformCache` in the sync path); inside `forgetAndAdopt` (keep it await-free, since a counter bump is synchronous); and in `dropSealed` / `restoreSealed` if they reach the tracker other than through `replayActions`. The bump goes **before** the reset, not after the handler, so a descent that read anything from the old state sees the version move. `Tree.buildInit` supplies `onViewChanged: () => held.btree?.invalidatePaths()` and drops the bump at the end of the `replace` handler, which `stageInto` now covers. A private read view (`Tree.readView`) has its own tracker and gets no signal, correctly.

**2. A point read retries; it never throws for a concurrent change.** `BTree.get(key)` captures `_version` before descending. If the descent finishes with the version unchanged, it returns the entry read at the leaf. If the version moved, it descends again. If the descent **throws** while the version moved, it also descends again: the throw (a `Missing block` from a torn descent) is a symptom of the change, not a fault. If the version did not move, the throw is rethrown unchanged. This is exception-as-control-flow, but gated on a detected concurrent change; say so in a comment. Do not validate the path in `get` (no `at`). Re-recording the descent's reads on a retry is harmless, since the collector keeps the highest revision and the stronger purpose. Whether to bound the retries: each retry needs a new change to land inside a descent of a few block reads, and every source of change (a drain step, a refresh) is finite work, so an unbounded loop is defensible. Recommended: loop without a bound, log each retry at debug level, and add a `NOTE:` tripwire to bound it and report contention if a retry storm is ever seen.

**3. A range scan's setup retries the same way.** The work in `range` (and `first` / `last` when they seed a scan) before the first yield hands back no path yet. Wrap `findFirst` + `findLast` + the start validation in the same retry-while-version-moved loop, so a scan that has yielded nothing never fails for a concurrent change. Once it has yielded, the documented "mutation during iteration will result in an exception" contract stands.

**4. Plugin.** `readRowAt` uses `read.get(primaryKey)` instead of `find` + `isValid`. `probeUniqueConstraint` collects the range's primary keys into an array first, then point-gets each row, so the scan does not stay open across another tree's reads. The residual, a hit range spanning a leaf boundary with a drain step landing on the `moveNext` between leaves, still throws under the scan contract. Record it as a `NOTE:` at the probe, since a unique value prefix holds one entry in normal use.

Known limit to record (a `NOTE:` at `BTree.get` or in the btree doc): "as of some moment" relies on every view change reaching `onViewChanged`. A tree used outside `Tree`, over a store something else mutates, gets only the btree's own version bumps.

## Tests

- **db-core, at the tree layer** (new `packages/db-core/test/tree-point-read-under-mutation.spec.ts`, or in `tree.spec.ts`): the deterministic shape is the torn descent. Build a tree with a small `nodeCapacity` (4) and **stage** (do not sync) enough entries that a split inserts a new node, so the root names a staged-inserted child. Start a `get` of a key under that child. Park it in a transactor read gap after the root is read (a subclass in the shape of `HeaderReadGapTransactor` in `tree.spec.ts`; use a fresh handle or a read the cache does not hold, so the read reaches the transactor). In the gap, force a replay on the same instance, e.g. a rival handle commits to the collection and then `reader.update()`, whose refresh replays the open segment. Assert the `get` returns the entry. Before the fix this throws `Missing block`; confirm that first. A gap placed during the descent does **not** reproduce `Path is invalid`, because the path is stamped at the leaf; an earlier attempt that staged during the root read passed for that reason. One test per behaviour, so add a second only for the range-setup retry (a `range` started over the same parked descent).
- **Plugin** (new spec, in the shape of the report and the script above): offline mode over a `TestTransactor`, a table with a unique column and an index, 300 autocommit inserts all succeed, `whenDrained()` resolves, and the table holds 300 rows (`expectIndexAgreesWithScan` in `test/query-helpers.ts` checks the index too). Keep it quick, since `yarn test` pays for it every run: the pk-only and index-only rows of the table above add nothing and should not be separate cases.

## TODO

- Add `onViewChanged` to `CollectionInitOptions` and `Collection.viewChanged()`, and call it at every tracker-replace and cache-change site listed in Fix 1. Grep `this.tracker.reset(` and `sourceCache.transformCache` / `forgetAndAdopt` so none is missed.
- In `Tree.buildInit`, wire `onViewChanged` to `held.btree?.invalidatePaths()` and remove the end-of-handler bump.
- Add the retry loop to `BTree.get`, with debug logging and the `NOTE:`.
- Add the same retry to `BTree.range`'s setup.
- Plugin: switch `readRowAt` to `get`; make `probeUniqueConstraint` collect primary keys before fetching rows; add the residual `NOTE:`.
- Write the db-core test (confirm it fails first) and the plugin test.
- Update `packages/db-core/docs/btree.md` with the point-read contract: `get` never throws for a concurrent change, scans keep theirs. Add one or two sentences to `docs/internals.md` §The offline queue on the drain's replay changing a tree beneath unlatched readers and how reads cope. Run `yarn lint:docs`.
- Run `yarn build`, then the db-core and plugin suites (`yarn test` in each package). Note in the handoff that the `continue`-on-invalid scan sites were left as they are.
