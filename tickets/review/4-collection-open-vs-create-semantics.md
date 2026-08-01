---
description: Reading a stored dataset that cannot be found used to hand back a brand-new empty one, so "I couldn't find it" looked exactly like "it's empty". Reads now report absence; only writes create.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collection/collection-type-registry.ts, packages/db-core/src/btree/btree.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/tree.spec.ts, packages/db-core/test/diary.spec.ts, packages/db-core/test/collection-type-registry.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-open-semantics.spec.ts, packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts, docs/internals.md, docs/optimystic.md, docs/debugging.md
difficulty: medium
---

# Review: open vs createOrOpen for collections

## What shipped

A *collection* is one logical dataset (a table, an append-only log), reached through a single
**header block** whose id is the collection name. `Collection.createOrOpen` was the only entry
point, and on a header-probe miss it fabricated a header in the local tracker — so a pure read
through a collection this node could not resolve answered "empty" rather than "absent".

Now there are two entry points, differing only in the miss branch:

```ts
Collection.open<TAction>(transactor, id, init): Promise<Collection<TAction> | undefined>
Collection.createOrOpen<TAction>(transactor, id, init): Promise<Collection<TAction>>
```

Mirrored on `Tree.open` / `Tree.createOrOpen` and `Diary.open` / `Diary.createOrOpen`.

### db-core

- `collection.ts` — extracted `probeHeader` (the read-dependency collector + `TransactorSource` +
  `CacheSource` + `Tracker` + header probe) and `attachToLog` (bootstrap + `Log.open` + action
  context) as private statics; `open` and `createOrOpen` are both thin wrappers over them, so the
  two cannot drift.
- `open` returns `undefined` **before** anything is staged. The tracker is discarded with empty
  transforms, so a caller that ignores the `undefined` cannot later sync a phantom collection.
- `createOrOpen`'s create branch logs `collection:invented id=%s …` through
  `createLogger('collection')` (namespace `optimystic:db-core:collection`). Verified live: the
  line fires exactly once per invention. Uses `debug`, not `console.warn` — db-core stays
  console-free for browser/RN hosts.
- Three local variables named `log` (in `updateInternal`, `syncInternal`, `selectLog`) were renamed
  to `collectionLog` so they no longer shadow the new module-level logger.
- `tree.ts` — `buildInit` builds the shared `CollectionInitOptions`; `attach` binds the opened
  collection to its read `BTree`. On the create path `createHeaderBlock` builds the btree (it needs
  the root id for the header); on the open path it never runs, so `attach` builds it over the
  existing tracker. Both write back into a small `BTreeHolder` so the `replace` handler's
  path-invalidation always targets the instance reads go through.
- `diary.ts` — `Diary.create` renamed to `Diary.createOrOpen` (which is what it always did);
  `Diary.open` added. Init options factored into a module-level `diaryInit()` shared with the
  registry registration.
- `collection-type-registry.ts` — `CollectionTypeDescriptor.open` renamed to `createOrOpen`.
- `btree.ts` — **one-line type widening not in the original ticket.** `BTree.create`'s `compare`
  default inferred as `(a, b) => -1 | 0 | 1`, while the constructor's is `(a, b) => number`. Once
  `Tree`'s shared helper annotated `compare` explicitly, `BTree.create` rejected it. Added
  `as number` to match the constructor. Behaviourally inert; it only widens what `create` accepts
  to what the constructor already accepted.

### Plugin call sites

- `CollectionFactory.getCollection(options, txnState)` — open-only sibling of
  `createOrGetCollection`. Shared body extracted into `resolveTreeArgs` /
  `getCachedCollection` / `cacheCollection`. **A miss is not cached**, so a collection created
  later in the same transaction stays visible.
- `SchemaManager`'s injected accessor widened to `(transactor?, create?) => Promise<Tree | undefined>`.
  `getSchema` and `listTables` call it open-only and return `undefined` / `[]` on a miss;
  `storeStoredSchema` and `deleteSchema` go through a `requireSchemaTree` helper that passes
  `create: true`. The negative-result path never writes to `schemaCache`.
- `optimystic-module.ts` — the schema-tree lambda dispatches on the flag. `NOTE:` comments added at
  the data-tree (`doInitialize`) and both index-tree call sites recording **why** they keep
  create-on-missing: a table/index declared but never written has no committed header at all, so
  at the block layer "absent" and "empty" are genuinely the same state there.
- `Diary.create` → `Diary.createOrOpen` renamed across `reference-peer/src/cli.ts` (2 sites),
  `packages/demo/src/message-app.ts`, and four test files.

### Docs

`docs/internals.md` §"Collection Header Blocks" now states the two operations and the rule for which
callers get which. `docs/optimystic.md` replaces the "`createOrOpen` (or `create`)" prose and shows
`Tree.open` in the read example. `docs/debugging.md` gains the `collection` sub-namespace row.
`packages/db-core/README.md` picked up the `Diary.createOrOpen` rename (two snippets).

## Validation performed

`yarn lint`, `yarn build`, `yarn test` from repo root — all clean. Full suite: **0 failing**
(db-core 1295, db-p2p 1462, plugin 333, plus the smaller packages). `yarn test:integration` was
**not** run (env-gated, real TCP meshes; out of budget for an agent run — see AGENTS.md § Testing).

New specs:

- `collection.spec.ts` § "open vs createOrOpen" — `open` on an id with no committed header resolves
  `undefined` and leaves storage untouched (asserted via `transactor.get`); `open` on a synced
  collection returns identical log contents to `createOrOpen`; a collection reached through `open`
  is still fully writable.
- `tree.spec.ts` § "open vs createOrOpen" — absent id returns `undefined` with no header block in
  storage and no BTree built; createOrOpen→write→sync→`open` round-trip; path invalidation fires on
  a tree reached through `open` (pins that `attach` wired the handler to the right btree instance);
  writes through an opened tree are durable.
- `diary.spec.ts` § "open vs createOrOpen" — absent id, storage untouched, append/read round-trip.
- `schema-catalog-open-semantics.spec.ts` (new file) — `listTables()` on a fresh network returns
  `[]` **and does not commit a catalog header**; `['t']` after `CREATE TABLE`; `select` from a
  created-but-never-written table returns zero rows; a table created after an earlier empty read
  becomes visible (no negative caching); a second session hydrates from the first's catalog.
- `catalog-hydration.spec.ts` — the "walks the schema tree once" spy had to be extended to wrap
  `getCollection` as well as `createOrGetCollection`, since hydrate's reads now take the open-only
  path. Without that change it counted 0 and failed. Assertion value unchanged (still exactly 1).

Live smoke check under `DEBUG='optimystic:db-core:collection'` confirmed the `collection:invented`
marker fires on the create branch and not on either `open` path.

## Known gaps — treat these as the starting point

- **The absence guarantee is only half-installed.** `Collection.open` returning `undefined` means
  "authoritatively absent" *only if the storage layer never reports an unreachable header as an
  absent one*. That second half is the companion ticket `repo-reports-unavailable-vs-absent`, which
  has not landed. Until it does, `open` can still resolve `undefined` for a collection that exists
  but could not be retrieved — the failure mode is now localized to one layer instead of spread
  across every read path, but it is not closed.
- **`Collection.update()` on a vanished header still silently no-ops** (`collection.ts`, in
  `updateInternal`). No bootstrap runs, `Log.open` yields nothing, and the collection keeps serving
  stale in-memory state instead of reporting that it could not refresh. A `NOTE:` marks the site
  and points at the companion ticket. Deliberately unchanged here.
- **`deleteSchema` creates the catalog to write a tombstone into it.** Dropping a table on a node
  that has never seen the catalog will bring the catalog into existence. Per the original ticket's
  call-site audit (it is a write path), but worth a second opinion — arguably a delete against a
  non-existent catalog should be a no-op.
- **No test covers a `Tree.open` against a header whose log is broken.** The ticket calls for that
  to throw rather than read empty; the code inherits `Log.open`'s `!` dereference (documented on
  `attachToLog`), but nothing pins it. Constructing a header-without-usable-log fixture was not
  attempted.
- **The `btree.ts` widening is untested in isolation.** It is exercised only transitively by every
  existing Tree spec. A comparator returning arbitrary numbers (e.g. `(a, b) => a - b`) is now
  accepted by `BTree.create` where it previously was not; no spec passes one.
- **Multi-node behaviour is unexercised.** Every new spec runs against `TestTransactor` or a
  single-process `local` transactor. The distinction this ticket draws only *matters* when peers
  are unreachable, and no spec creates that condition. `yarn test:integration` is where that would
  live.
- **`getCollection` shares the transaction cache with `createOrGetCollection`.** A tree first
  obtained via `createOrGetCollection` (create-on-missing) will be handed back by a later
  `getCollection` in the same transaction, even if it was invented rather than found. That is
  intended — one collection instance per transaction — but it means "I got a tree from
  `getCollection`" does not by itself prove a header exists.

## Tripwires parked in code

- `optimystic-module.ts` — three `NOTE:` comments (data tree, both index-tree factories) recording
  why those sites keep create-on-missing, so a future reader does not "fix" them into `open`.
- `collection.ts` `updateInternal` — `NOTE:` on the silent-no-op-on-absent-header behaviour and its
  owning ticket.
