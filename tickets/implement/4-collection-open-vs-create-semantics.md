----
description: Opening a stored table currently creates a brand-new empty one when it cannot be found, so callers that only meant to read get a plausible-looking empty result. Add a read-only "open" that reports "not there" instead, and use it everywhere that reading — not creating — is what was meant.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/collection-type-registry.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/logger.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/tree.spec.ts, packages/db-core/test/collection-type-registry.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/reference-peer/src/cli.ts, docs/internals.md, docs/optimystic.md, docs/debugging.md
difficulty: medium
----

# Separate "open an existing collection" from "create one if it isn't there"

## Background

A *collection* is one logical dataset (a table, an append-only log). Its entry point is a single
**header block** whose block id is the collection name, so every node in the network resolves the
same collection to the same header block id.

`Collection.createOrOpen` (`packages/db-core/src/collection/collection.ts:60-85`) probes for that
header:

```ts
const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;
if (header) { /* … open the existing log … */ }
else {        // comment says: "Collection does not exist"
    const headerBlock = init.createHeaderBlock(id, tracker);
    tracker.insert(headerBlock);
    …
}
```

The `else` branch fabricates a header in the local tracker. Nothing is written to storage until a
write is synced, so the fabrication is *cheap* — but reads through that collection then observe a
brand-new empty dataset. Every caller in the tree uses this one entry point, including pure read
paths, so a node that could not retrieve a header answers reads with "this collection is empty"
rather than with an error. That is indistinguishable from a legitimately empty collection, and an
application cannot defend against it.

This ticket adds the missing read-only entry point and moves the read paths onto it. A companion
ticket (`repo-reports-unavailable-vs-absent`) makes the *storage* layers stop reporting "absent"
when what they really mean is "I could not find out" — the two together are what make an
unfetchable collection fail loudly instead of reading empty.

## Why not a three-way `open` / `create` / `createOrOpen` split

The originating plan proposed three operations. Two is the right number here, because **no call
site in the repository wants create-only semantics**:

- Every DDL path that creates a collection must also tolerate re-running against one that already
  exists. `optimystic-module.ts` explicitly supports re-declaring an existing table with a new
  shape (see the comment at `optimystic-module.ts:176-181`), so a `create` that rejected an
  existing collection would break it.
- A collection registered in the schema catalog but never written to has **no committed header at
  all** — the header is only committed on the first write. So "the catalog says this table exists"
  does not imply "its header block exists", and its data tree legitimately needs create-on-missing
  on the read path too.

Adding an unused `create` would be speculative API. If a create-only path ever appears, it is
`open()` plus an explicit throw.

## Interfaces

```ts
class Collection<TAction> {
    /** Open an EXISTING collection. Resolves to undefined when the header block is
     *  authoritatively absent — i.e. the transactor confirmed nothing has ever been
     *  committed under this id. A header that could not be RETRIEVED (unreachable peers,
     *  a revision this node cannot reconstruct) throws from the transactor layer and is
     *  never reported as undefined. */
    static open<TAction>(transactor: ITransactor, id: CollectionId,
                         init: CollectionInitOptions<TAction>): Promise<Collection<TAction> | undefined>;

    /** Open an existing collection, or stage a fresh empty one in the local tracker when
     *  the header is authoritatively absent. Nothing is written to storage until sync().
     *  Correct only where inventing a collection is genuinely intended — a first write, a
     *  bootstrap path. Logs `collection:invented` on the create branch. */
    static createOrOpen<TAction>(transactor: ITransactor, id: CollectionId,
                                 init: CollectionInitOptions<TAction>): Promise<Collection<TAction>>;
}
```

`Tree.open` and `Diary.open` mirror this (`Promise<Tree<TKey,TEntry> | undefined>` /
`Promise<Diary<TEntry> | undefined>`), keeping their existing `createOrOpen` alongside.
`Diary.create` is renamed to `Diary.createOrOpen`, which is what it has always done.

Factor the shared wiring — the `ReadDependencyCollector`, `TransactorSource`, `CacheSource`,
`Tracker`, the header probe — into one private helper so `open` and `createOrOpen` cannot drift.
`Tree` needs care: its `createHeaderBlock` callback assigns the `btree` closure variable during
creation, and `Tree.open` must build the read `BTree` over the *existing* tracker instead (the
path at `tree.ts:98`).

`CollectionTypeDescriptor.open` (`collection-type-registry.ts:12`) is renamed to `createOrOpen`,
because that is precisely what the registered `Diary` factory does. Renaming rather than changing
behaviour: the registry is only reached once a header block type has been observed, but the
existing spec at `collection-type-registry.spec.ts:91-105` uses it to bring a collection into
existence, and that is a legitimate use.

## Logging the invention

`createOrOpen`'s create branch logs through `createLogger('collection')`
(`packages/db-core/src/logger.ts`) with a fixed, greppable marker:

```
log('collection:invented id=%s — no committed header found; staging a fresh empty collection', id);
```

Use the `debug` logger rather than `console.warn`: db-core has no console output anywhere and
must stay usable in browser and React Native hosts. The point of the marker is that
`DEBUG='optimystic:db-core:collection'` and a single grep for `collection:invented` both land on
it. Add the namespace to the table in `docs/debugging.md`.

## Call-site audit

| Call site | Wants | Why |
|---|---|---|
| `SchemaManager.getSchema`, `.listTables` (`schema-manager.ts:163,204`) | **open** | Pure reads of the plugin-global catalog `tree://optimystic/schema`. An invented catalog reports "this database has no tables". |
| `SchemaManager.storeStoredSchema`, `.deleteSchema` (`schema-manager.ts:147,194`) | **createOrOpen** | First `CREATE TABLE` on a fresh network legitimately brings the catalog into existence. |
| `OptimysticModule.doInitialize` data tree (`optimystic-module.ts:171`) | **createOrOpen** | A table registered in the catalog but never written has no committed header; inventing it in the tracker is the correct representation of "empty table". |
| `IndexManager` index trees (`optimystic-module.ts:272,1504`) | **createOrOpen** | Same reason — an index with no rows yet has no header. |
| `Diary.create` in `reference-peer/src/cli.ts:191-193` | **createOrOpen** | Attach-or-create is the documented intent of the CLI command. |
| `MessageApp.create` in `packages/demo/src/message-app.ts:24` | **createOrOpen** | Demo bootstrap. |

The honest summary for the two that keep create-on-missing: **they want it, but only because an
un-written collection is indistinguishable from a missing one at the block layer.** Leave a
`NOTE:` at each so the next reader does not "fix" it.

To route the schema manager, widen its injected accessor:

```ts
constructor(
    private readonly getSchemaTree:
        (transactor?: ITransactor, create?: boolean) => Promise<Tree<string, any> | undefined>
) {}
```

Read paths call it with `create` falsy and return `undefined` / `[]` when it resolves to
`undefined`; write paths pass `true`. The module's lambda (`optimystic-module.ts:1680-1694`)
dispatches to `CollectionFactory.getCollection` or `.createOrGetCollection` accordingly.

`CollectionFactory` gains `getCollection(options, txnState): Promise<Tree<string, RowData> | undefined>`
— the same body as `createOrGetCollection` but calling `Tree.open`, and **not** populating the
transaction cache on a miss.

## Edge cases & interactions

- **A genuinely empty network.** `listTables` on a fresh install must return `[]`, not throw and
  not error. Cover with a spec.
- **A table created but never written.** `select` from it must return zero rows through the
  create-on-missing data-tree path — this is the case that keeps `createOrOpen` there. Cover it.
- **Two `createOrOpen` calls racing to create the same collection.** Unchanged: both stage a
  header insert, and `TransactorSource.transact` orders the header block first (`isNew`) so the
  cluster resolves one winner. The existing specs at `collection.spec.ts:217-300` must stay green.
- **`Tree.open` on an absent header must not construct a `BTree`** over an invented trunk — it
  returns `undefined` before any btree is built. Assert that no header insert lands in the tracker
  (the transforms stay empty), so a caller that ignores the `undefined` cannot later sync a
  phantom collection.
- **A header that exists but whose log is unreadable.** `Log.open` is dereferenced with `!` at
  `collection.ts:75`; `open` inherits that. Do not soften it — an existing header with a broken
  log is a fault, not an absence.
- **`Collection.update()` on a vanished header** (`collection.ts:132-135`) silently no-ops today:
  no header means no bootstrap and `Log.open` yields nothing, so the collection keeps serving its
  stale in-memory state. Leave the behaviour to the companion ticket (where the read will throw)
  but add a `NOTE:` at the site recording it.
- **Transaction-scoped collection cache.** `createOrGetCollection` caches per transaction
  (`collection-factory.ts:39-41,63-65`). `getCollection` must not cache an `undefined` result, or
  a collection created later in the same transaction stays invisible.
- **`SchemaManager.schemaCache`.** A read that finds no tree must not poison the per-table cache
  with a negative entry — the current code only caches hits; keep it that way.
- **Registry rename fan-out.** `CollectionTypeDescriptor.open` → `createOrOpen` touches
  `collection-type-registry.ts`, `diary.ts`, and `collection-type-registry.spec.ts:93,95,109-110`.

## Key tests

- `Collection.open` on an id with no committed header resolves to `undefined`, and the tracker
  transforms are empty afterwards.
- `Collection.open` on a synced collection returns it with the same contents `createOrOpen` gives.
- `createOrOpen` on an absent header still creates, syncs, and reads back — every existing spec in
  `collection.spec.ts` stays green unchanged.
- `Tree.open` / `Diary.open` round-trip: `createOrOpen` + write + sync, then `open` from a second
  instance over the same transactor sees the rows.
- Plugin: `listTables()` against a fresh transactor returns `[]`; after `CREATE TABLE t(...)` it
  returns `['t']`; `select` from a created-but-never-written table returns zero rows.

## TODO

### Phase 1 — db-core

- Extract the shared open wiring in `collection.ts` into a private helper returning the probe
  result plus the source/cache/tracker triple.
- Add `Collection.open`; reimplement `Collection.createOrOpen` on top of it.
- Add the `collection:invented` log line via `createLogger('collection')`.
- Add `Tree.open`; keep `Tree.createOrOpen`. Make sure the `btree` closure assignment still only
  runs on the create path.
- Add `Diary.open`; rename `Diary.create` → `Diary.createOrOpen`.
- Rename `CollectionTypeDescriptor.open` → `createOrOpen`; update `diary.ts`'s registration.
- Specs in `collection.spec.ts`, `tree.spec.ts`, `collection-type-registry.spec.ts` per *Key
  tests* and *Edge cases* above.

### Phase 2 — call sites

- `CollectionFactory.getCollection` (open-only, no negative caching).
- Widen `SchemaManager`'s injected `getSchemaTree` to `(transactor?, create?)`; route read paths
  open-only and write paths create-or-open; handle `undefined` in `getSchema`/`listTables`.
- Update the module's schema-tree lambda to dispatch on the new flag.
- `NOTE:` comments at the data-tree and index-tree call sites recording *why* they keep
  create-on-missing.
- Update `reference-peer/src/cli.ts` for the `Diary.createOrOpen` rename (its comment at
  `cli.ts:191-192` already describes the semantics correctly).

### Phase 3 — docs and validation

- `docs/internals.md` §"Collection Header Blocks" (line 374-377): replace the single
  `Collection.createOrOpen()` bullet with the open-vs-create-or-open distinction and the rule for
  which callers get which.
- `docs/optimystic.md:78,83,140` — the prose already says "`createOrOpen` (or `create`)"; correct
  it to the two real operations and show `open` in the read example.
- `docs/debugging.md` — add `optimystic:db-core:collection` to the namespace list.
- `yarn lint`, `yarn build`, `yarn test` from root; stream output with `tee`.
