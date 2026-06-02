description: Review per-collection change notification originated at the StorageRepo commit funnel (db-core contract + db-p2p origination/routing + NetworkTransactor delegation)
files: packages/db-core/src/transactor/change-notifier.ts, packages/db-core/src/transactor/index.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/test/storage-repo.spec.ts
----

# Review: block/collection change notification at the storage commit funnel

## What was built

A lowest-level "this collection changed" signal so reactive consumers (the Quereus
vtab bridge, a downstream prereq ticket) can be woken on remote/local commits
without polling. This ticket delivered **only** the db-core contract + db-p2p
origination/routing + the `NetworkTransactor` delegation option. It deliberately
does **not** touch Quereus or the plugin.

### Changes (all build clean; db-p2p suite green)

1. **db-core contract** — new `packages/db-core/src/transactor/change-notifier.ts`:
   - `CollectionChangeEvent { collectionId, blockIds, actionId, rev }`
   - `CollectionChangeListener`, `IBlockChangeNotifier.onCollectionChange(...)`
   - `isBlockChangeNotifier(x)` type guard.
   - Re-exported via `transactor/index.ts` → `@optimystic/db-core`. Kept separate
     from `ITransactor`/`IRepo` so it's opt-in / feature-detected.

2. **db-p2p origination** — `StorageRepo` now `implements IRepo, IBlockChangeNotifier`:
   - Per-collection listener registry (`Map<CollectionId, Set<listener>>`),
     `onCollectionChange` adds/removes and prunes empty sets; unsubscribe is idempotent.
   - `internalCommit` now returns the affected `CollectionId` (from
     `newBlock.header.collectionId`, falling back to `priorBlock.header.collectionId`
     for deletes; `undefined` → skipped).
   - `commit` aggregates `{collectionId → blockIds[]}` across the `toCommit` loop and
     emits **one** event per distinct collection **after** the lock `finally`, only on
     `success: true`, only for newly-committed blocks (idempotent `alreadyDone` and
     stale partitions never reach the map). Each listener call is try/caught + logged.

3. **Node exposure** — `libp2p-node-base.ts` sets `(node as any).blockChangeNotifier = storageRepo`
   (the same StorageRepo both the coordinated and direct commit paths land in).

4. **Transactor delegation** — `NetworkTransactor` now `implements IBlockChangeNotifier`,
   with an optional `localChangeNotifier?: IBlockChangeNotifier` ctor option; its
   `onCollectionChange` passes through when present, else a logged no-op with inert
   unsubscribe. Backward-compatible (option is optional; no existing caller changed).

5. **Breadcrumb** — `// TODO: emit CollectionChangeEvent here once replicas persist`
   left in `BlockTransferService.handlePush` (the replication landing path is a
   distinct origin, explicitly out of scope here).

## How to validate

- Build: `cd packages/db-core && yarn build` then `cd packages/db-p2p && yarn build` (both clean).
- Tests (streamed): `cd packages/db-p2p && yarn test 2>&1 | tee /tmp/db-p2p-test.log`.
- Focused new tests live in `packages/db-p2p/test/storage-repo.spec.ts` under
  `describe('change notification (IBlockChangeNotifier)')` — 7 cases:
  feature-detect, fires-once-with-correct-payload, collection scoping, per-collection
  routing on one repo (models remote author), idempotent re-commit no re-emit,
  unsubscribe stops + idempotent, throwing-listener isolation + commit still succeeds.

## Honest gaps / where the reviewer should dig (tests are a floor)

- **`get()`-path promotions do NOT emit.** `StorageRepo.get` also calls
  `internalCommit` for context-driven promotion of stranded non-tail blocks
  (`storage-repo.ts` ~line 47); that return value is intentionally ignored, so a
  block promoted during a *read* fires no change event. The cadre use case lands via
  the cluster-consensus `commit` path (which does emit), so this is an edge/recovery
  path — but confirm it's acceptable that a context-driven promotion is silent. If a
  reviewer judges it should emit, that's a follow-up fix ticket, not an inline change.
- **No end-to-end consumer yet.** `NetworkTransactor.onCollectionChange` is a no-op
  unless `localChangeNotifier` is supplied, and **no caller supplies it yet** — the
  plugin wiring (`CollectionFactory.createNetworkTransactor` passing
  `node.blockChangeNotifier`) belongs to the downstream plugin/vtab prereq ticket.
  So this ticket delivers the contract + origination + the option, not a wired path
  through the transactor. Verify the option's shape actually slots into that wiring.
- **Remote-author path is unit-modeled, not cluster-tested.** The "two collections,
  one repo" test models the remote author by committing *directly* through the repo
  (the same funnel cluster consensus uses), not via a live multi-node cluster. There
  is no integration test asserting that an actual `ClusterMember.handleConsensus →
  StorageRepo.commit` fires the event. Consider whether that warrants an integration test.
- **Delete path emission untested.** `internalCommit`'s `priorBlock` fallback for
  deletes is covered by code but not by a dedicated test (all 7 tests insert/update).
  A delete-emits-with-priorBlock-collectionId test would close this.
- **Fire-and-forget, synchronous, unordered across collections.** Listeners run
  synchronously in commit order on the commit thread after locks release; we never
  `await` them. A slow/async listener must schedule its own work. Confirm no listener
  contract expectation (ordering across collections, async completion) is implied
  elsewhere.
- **`(node as any).blockChangeNotifier`** uses the same untyped escape hatch as the
  existing `coordinatedRepo`/`storageRepo` exposure. Fine for consistency, but there's
  no typed node surface; the consumer must `isBlockChangeNotifier`-guard it.

## Pre-existing flaky failure (already flagged)

`tickets/.pre-existing-error.md` documents `fresh-node-ddl-multi.spec.ts` Scenario B
("5-node cold-start with one peer down"): failed once under full-suite load, passed on
immediate re-run and always passes in isolation. It's a timing-sensitive multi-node test
entirely outside this diff. Not addressed here per ticket policy.
