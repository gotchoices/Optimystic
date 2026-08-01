---
description: Reading a stored dataset that could not be found used to hand back a brand-new empty one, so "I couldn't find it" looked exactly like "it's empty". Reads now report absence; only writes create.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collection/collection-type-registry.ts, packages/db-core/src/btree/btree.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/tree.spec.ts, packages/db-core/test/diary.spec.ts, packages/db-core/test/btree.spec.ts, packages/db-core/test/collection-type-registry.spec.ts, packages/quereus-plugin-optimystic/test/schema-catalog-open-semantics.spec.ts, packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts, packages/db-core/docs/collections.md, docs/internals.md, docs/optimystic.md, docs/debugging.md
---

# Complete: open vs createOrOpen for collections

## What shipped

A *collection* is one logical dataset (a table, an append-only log), reached through a single
**header block** whose id is the collection name. Previously `Collection.createOrOpen` was the only
entry point, and on a header-probe miss it fabricated a header in the local tracker — so a pure read
through a collection this node could not resolve answered "empty" rather than "absent".

There are now two entry points, differing only in the miss branch:

```ts
Collection.open<TAction>(transactor, id, init): Promise<Collection<TAction> | undefined>
Collection.createOrOpen<TAction>(transactor, id, init): Promise<Collection<TAction>>
```

Mirrored on `Tree.open` / `Tree.createOrOpen` and `Diary.open` / `Diary.createOrOpen`.

### db-core

- `collection.ts` — `probeHeader` (read-dependency collector + `TransactorSource` + `CacheSource`
  + `Tracker` + header probe) and `attachToLog` (bootstrap + `Log.open` + action context) are
  private statics; `open` and `createOrOpen` are thin wrappers over them, so the two cannot drift.
- `open` returns `undefined` **before** anything is staged. The tracker is discarded with empty
  transforms, so a caller that ignores the `undefined` cannot later sync a phantom collection.
- `createOrOpen`'s create branch logs `collection:invented` through `createLogger('collection')`
  (namespace `optimystic:db-core:collection`). Uses `debug`, not `console.warn` — db-core stays
  console-free for browser/RN hosts. Three local variables named `log` were renamed to
  `collectionLog` so they no longer shadow the module-level logger.
- `tree.ts` — `buildInit` builds the shared `CollectionInitOptions`; `attach` binds the opened
  collection to its read `BTree`. On the create path `createHeaderBlock` builds the btree (it needs
  the root id for the header); on the open path it never runs, so `attach` builds it over the
  existing tracker. Both write into a `BTreeHolder` so the `replace` handler's path-invalidation
  always targets the instance reads go through.
- `diary.ts` — `Diary.create` renamed to `Diary.createOrOpen` (which is what it always did);
  `Diary.open` added; init options factored into a module-level `diaryInit()`.
- `collection-type-registry.ts` — `CollectionTypeDescriptor.open` renamed to `createOrOpen`.
- `btree.ts` — `BTree.create`'s `compare` default annotated `as number` to match the constructor's,
  which already had it. Widens what `create` accepts to what the constructor already accepted.

### Plugin call sites

- `CollectionFactory.getCollection(options, txnState)` — open-only sibling of
  `createOrGetCollection`; shared body in `resolveTreeArgs` / `getCachedCollection` /
  `cacheCollection`. **A miss is not cached**, so a collection created later in the same
  transaction stays visible.
- `SchemaManager`'s injected accessor widened to `(transactor?, create?) => Promise<Tree | undefined>`.
  `getSchema` and `listTables` call it open-only and return `undefined` / `[]` on a miss;
  `storeStoredSchema` and `deleteSchema` go through `requireSchemaTree` (passes `create: true`).
  The negative-result path never writes to `schemaCache`.
- `optimystic-module.ts` — the schema-tree lambda dispatches on the flag. `NOTE:` comments at the
  data-tree and both index-tree call sites record why they keep create-on-missing: a table or index
  declared but never written has no committed header at all, so at the block layer "absent" and
  "empty" are genuinely the same state there.
- `Diary.create` → `Diary.createOrOpen` renamed across `reference-peer/src/cli.ts`,
  `packages/demo/src/message-app.ts`, and four test files.

### Docs

`docs/internals.md` §"Collection Header Blocks", `docs/optimystic.md`, `docs/debugging.md`
(`collection` sub-namespace row), `packages/db-core/README.md`, and — added during review —
`packages/db-core/docs/collections.md`.

## Review findings

### Checked

Read the implement diff (`fb52c98`) in full before the handoff summary. Covered: `collection.ts`
(`open` / `createOrOpen` / `probeHeader` / `attachToLog` / the `updateInternal` NOTE), `tree.ts`
(`buildInit` / `attach` / `BTreeHolder` lifetime on both paths), `diary.ts`,
`collection-type-registry.ts`, the `btree.ts` widening; on the plugin side `collection-factory.ts`
(`getCollection`, `resolveTreeArgs`, both cache helpers), all four `getSchemaTree` call sites in
`schema-manager.ts`, and the schema lambda plus three NOTE sites in `optimystic-module.ts`. Read
every doc the change touched and searched for ones it should have. Ran `yarn lint`, `yarn build`,
`yarn test` from the repo root.

### Found and fixed in this pass (minor)

- **`attachToLog` failed with a `TypeError`, not an error.** `(await Log.open(...))!` is a
  compile-time assertion only; when `Log.open` returned `undefined` the next line threw
  "Cannot read properties of undefined (reading 'getActionContext')". Reachable: the probe reads
  the header through `TransactorSource`, then `Log.open` re-reads it through the tracker/cache, so
  storage going unavailable between the two lands here. Now throws
  `Log not found for collection <id>`, matching the message `updateInternal` and `selectLog`
  already use. `packages/db-core/src/collection/collection.ts`.
- **Doc comments asserted behaviour that does not exist yet.** `Collection.open`'s JSDoc,
  `docs/internals.md`, and `getSchema`'s comment all stated as fact that a header which could not
  be *retrieved* "throws from the transactor layer and is never reported as `undefined`". That is
  the contract `repo-reports-unavailable-vs-absent` will install; it has not landed. All three now
  state the dependency and the current caveat, so a reader does not trust a guarantee that is only
  half-installed.
- **`packages/db-core/docs/collections.md` was missed entirely.** It still documented
  `Diary.create<...>` (two places) — a method that no longer exists — and the registry's `open:`
  field under its old name. Fixed both, and added an "Opening a collection: `open` vs
  `createOrOpen`" subsection under "Collection Types" with links to `debugging.md` and
  `internals.md`.
- **`docs/optimystic.md` read example named a `Tree<string, User>` `readers`.** Renamed
  `usersView`.

### Tests added (4; db-core went 1295 → 1299 passing)

- `collection.spec.ts` — an opened collection picks up another instance's committed actions via
  `update()`. Pins that `open` leaves the source's action context in a state an *incremental*
  refresh can resume from, not merely one where a full re-open happens to work. Nothing covered
  this; every prior test re-opened fresh.
- `collection.spec.ts` — `open` throws rather than reading empty when a probed header's log will
  not open, driven by a transactor that serves the header once and hides it afterwards. Closes the
  handoff's "no test covers a `Tree.open` against a header whose log is broken" gap, at the
  `Collection` layer where the `!` actually lived.
- `tree.spec.ts` — a tree staged by `createOrOpen` but never synced is absent to `open`. This is
  the exact premise the three `NOTE:` comments in `optimystic-module.ts` rest on ("declared but
  never written has no committed header"), and nothing pinned it.
- `btree.spec.ts` — `BTree.create` accepts `(a, b) => a - b` and orders entries correctly. Closes
  the handoff's "the `btree.ts` widening is untested in isolation" gap.

### Verified, no action needed

- **`resolveTreeArgs` dropped the `isSchemaTree` branch of `keyExtractor`** — a behaviour change
  not called for by the ticket, so checked directly. `extractKeyFromEntry` is `return entry[0]`
  (`collection-factory.ts:436`), identical to the removed branch. Equivalent; the comment claiming
  so is accurate.
- **The companion ticket exists.** `repo-reports-unavailable-vs-absent` — referenced by slug from
  four code comments and `internals.md` — is queued at
  `tickets/implement/4.5-repo-reports-unavailable-vs-absent.md`, so it runs next. The handoff's
  largest stated gap is tracked, not lost.
- **All four `getSchemaTree` call sites audited.** Read paths (`getSchema`, `listTables`) are
  open-only; write paths (`storeStoredSchema`, `deleteSchema`) create. No fifth caller exists.
- **`CollectionTypeDescriptor.createOrOpen` has no non-test callers.** `getCollectionType` is
  unused outside `db-core`'s own tests. Pre-existing dead code, unchanged by this ticket, out of
  scope.
- **`BTree.create`'s `0 as number`** matches the constructor's pre-existing form (`btree.ts:28`) —
  consistent with the file, left alone rather than churned into an explicit annotation.
- **`optimystic-module.ts` is 2241 lines** (`wc -l`). This diff added 14 comment lines to it. The
  size predates the ticket and splitting it is well outside this scope; no ticket filed.

### Tripwire parked

- `schema-manager.ts` `deleteSchema` — `NOTE:` recording that dropping a table on a node that has
  never seen the catalog brings an empty catalog into existence. Harmless while a missing catalog
  really means "fresh database" (the drop targets nothing and commits an empty catalog); it becomes
  a hazard only if missing can also mean *unreachable*, at which point the drop would commit a
  locally-invented catalog over a real remote one. The note says to make the delete a no-op on an
  absent catalog if `repo-reports-unavailable-vs-absent` lands and this site is still
  create-on-missing. This is the "second opinion" the implement handoff asked for: conditional, so
  a tripwire rather than a ticket.
- Pre-existing tripwires from the implement stage verified in place and accurate: three `NOTE:`
  comments in `optimystic-module.ts` (data tree, both index-tree factories) and one in
  `collection.ts` `updateInternal` (silent no-op on a vanished header, owned by 4.5).

### Not covered — stated, not fixed

- **Multi-node / unreachable-peer behaviour is still unexercised.** Every spec runs against
  `TestTransactor` or a single-process `local` transactor, and the distinction this ticket draws
  only *matters* when peers are unreachable. That lives in `yarn test:integration`, which is
  env-gated on real TCP meshes and out of budget for an agent run per AGENTS.md § Testing. Not run
  in the implement stage and not run here.
- **`getCollection` shares the transaction cache with `createOrGetCollection`.** A tree first
  obtained via `createOrGetCollection` will be handed back by a later `getCollection` in the same
  transaction even if it was invented rather than found. Intended (one collection instance per
  transaction), but it means "I got a tree from `getCollection`" does not by itself prove a header
  exists. Documented on the method; left as designed.

### Tickets filed

None. Every finding was minor enough to resolve in this pass, and the one major open item — the
storage layer distinguishing "absent" from "could not retrieve" — already has a ticket queued
immediately after this one.

## Validation

From the repo root, after the review edits:

- `yarn lint` — exit 0, no output.
- `yarn build` — exit 0, all packages.
- `yarn test` — exit 0, **0 failing** across all packages: db-core 1299, db-p2p 1462, plugin 333,
  plus the smaller packages. (db-core was 1295 at the implement handoff; +4 from this review.)
- `yarn test:integration` — **not run** (env-gated, real TCP meshes; see above).

Editor diagnostics reported unresolved `@quereus/quereus` imports and implicit-`any` params in
`schema-manager.ts` at lines this review never touched; `yarn build` compiles that package clean, so
these are language-server module-resolution noise, not a regression.
