description: When a node receives a block by churn re-replication, a local consumer watching that data on the new node is not woken because no change event is fired; emit one so reactive watchers see the newly-arrived data.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-core/src/transactor/change-notifier.ts, packages/db-p2p/src/cohort-topic/change-bridge.ts
difficulty: easy
----

# Emit CollectionChangeEvent on the replica-persist landing path

## Background (resolved design)

Per-collection change notification originates today **only** at the `StorageRepo.commit`
funnel (and the read-driven `StorageRepo.get` promotion path). The churn re-replication
landing path is a *distinct* origin:

```
BlockTransferService.handlePush
  → StorageRepo.saveReplicatedBlock(blockId, block, source?)   ← emit point (owns changeListeners)
      → BlockStorage.saveReplica(block, source?): Promise<ActionRev>   ← advances `latest`, returns effective rev
```

`saveReplica` advances `latest` and makes the block servable **without going through
`commit`**, so no `CollectionChangeEvent` fires. A reactive consumer (`Database.watch` via
the Quereus vtab bridge → `NetworkTransactor.localChangeNotifier` →
`StorageRepo.onCollectionChange`) subscribed on the *new owner* is therefore never woken
when that node gains a block by churn replication.

### Design decisions (settled — do not re-litigate)

1. **Emit, yes.** Change listeners are a **node-local** registry. The authoring node
   notified *its* consumers; the new owner has its own, distinct `onCollectionChange`
   subscribers that would otherwise stay permanently un-woken for a collection this node
   can now serve. There is no cross-node double-fire — the registries are per-node. Wake
   semantics: "this node can now serve collection X."

2. **`tailId` is omitted (undefined).** A replica-persist has no `CommitRequest` and no
   commit certificate, so it carries no `tailId`. This is the **same shape as a read-driven
   promotion** and is exactly the contract we want: the cohort-topic origination bridge
   (`packages/db-p2p/src/cohort-topic/change-bridge.ts`) gates origination on
   `selfIsCohortMember(event)`, whose documented behavior is *"A tail-less event (a
   read-driven promotion) is never a member."* So a tail-less replica event reaches local
   `onCollectionChange` / catch-all subscribers (waking `Database.watch`) but is
   **cert-gated out of cohort-topic re-origination** — the replica node is not the
   committer and must not re-originate a signed notification. Reuse `emitCollectionChanges`
   (which fires both the per-collection and catch-all feeds); the bridge safely drops the
   tail-less event on the catch-all feed via its membership gate.

3. **Emit only on a genuine advance.** `saveReplica` is a monotonic no-op when an
   equal-or-newer revision is already held (`meta.latest.rev >= rev` → returns the existing
   `latest` unchanged). Nothing changed locally in that case, so **no event must fire**.
   `saveReplicatedBlock` already holds the `StorageRepo.commit:<blockId>` latch across the
   whole read-modify-write, so it can read `latest` *before* `saveReplica`, compare against
   the returned effective `ActionRev`, and decide advancement atomically.

4. **Ordering.** Match the commit path: capture the emit decision inside the latch, emit
   **after** `release()`.

### Implementation shape

In `StorageRepo.saveReplicatedBlock` (currently `storage-repo.ts:466-475`):

```ts
async saveReplicatedBlock(blockId: BlockId, block: IBlock, source?: ActionRev): Promise<void> {
  log('saveReplicatedBlock blockId=%s rev=%s', blockId, source?.rev);
  const storage = this.createBlockStorage(blockId);
  const release = await Latches.acquire(`StorageRepo.commit:${blockId}`);
  // Captured under the latch; emitted after release to match commit's ordering.
  let landed: { collectionId: CollectionId, actionId: ActionId, rev: number } | undefined;
  try {
    const priorLatest = await storage.getLatest();
    const effective = await storage.saveReplica(block, source);
    // Advanced iff there was no prior revision or the effective rev moved past it. On the
    // monotonic no-op, saveReplica returns the held latest unchanged → effective.rev === priorLatest.rev.
    const advanced = priorLatest === undefined || effective.rev > priorLatest.rev;
    const collectionId = block.header?.collectionId;
    if (advanced && collectionId !== undefined) {
      landed = { collectionId, actionId: effective.actionId, rev: effective.rev };
    }
  } finally {
    release();
  }
  // Replica-persist has no CommitRequest, hence no tailId — like a read-driven promotion,
  // this wakes local onCollectionChange watchers but is cert-gated out of cohort-topic
  // re-origination downstream (change-bridge selfIsCohortMember treats a tail-less event as
  // never a member).
  if (landed) {
    this.emitCollectionChanges(
      new Map([[landed.collectionId, [blockId]]]),
      landed.actionId,
      landed.rev,
    );
  }
}
```

Notes:
- `CollectionId` is already imported in `storage-repo.ts`; `emitCollectionChanges` already
  defaults `tailId` to `undefined` when the arg is omitted.
- The `collectionId !== undefined` guard mirrors `internalCommit`'s headerless-block
  defense (skip rather than emit a bogus event). `handlePush` already rejects header-less
  payloads upstream, but `saveReplicatedBlock` is a public method, so keep the guard local.
- Do **not** change `BlockStorage.saveReplica`'s signature — its existing
  `Promise<ActionRev>` return already carries everything needed; advancement is derived in
  the caller from the pre-read.

## Edge cases & interactions

- **Monotonic no-op (equal rev held).** Re-push of the same `(rev, actionId)` → `saveReplica`
  skip path returns the held `latest` (same rev) → `advanced` false → **no event**.
- **Older-rev re-push after a newer replica.** `source.rev < latest.rev` → skip path → **no event**.
- **First replica for a brand-new block (`priorLatest === undefined`).** `advanced` true →
  **exactly one event**, with the effective `actionId`/`rev` from `saveReplica` (which is the
  deterministic hash + rev-1 fallback when `source` is absent).
- **Header-less / collectionId-undefined block.** Guarded out (no emit), matching
  `internalCommit`. Upstream `handlePush` also rejects these as `missing`.
- **Concurrent commit vs. replica on the same block.** Both hold `StorageRepo.commit:<blockId>`;
  the pre-read of `latest` + `saveReplica` + advancement decision are all inside that latch,
  so the advance/no-op verdict can't race a commit that moved `latest` in between.
- **tailId contract downstream.** The emitted event has `tailId === undefined`. Confirm via the
  cohort-topic bridge gate semantics that this never originates a signed cohort-topic
  notification (it must only wake local watchers). Do not fabricate a `tailId`.
- **Catch-all feed.** `emitCollectionChanges` also fans out to `onAnyCollectionChange`
  (the bridge). That is intended and safe — the bridge's `selfIsCohortMember` drops the
  tail-less event. No special-casing.
- **Listener isolation / fire-and-forget.** Reusing `emitCollectionChanges` inherits the
  commit path's throw-isolation and post-write ordering; a throwing listener must not break
  `saveReplicatedBlock` or the push response.

## Tests (add to `packages/db-p2p/test/storage-repo.spec.ts`)

Add a `describe('change notification on replica-persist', ...)` block (or extend the
existing `change notification (IBlockChangeNotifier)` block). `saveReplicatedBlock` is a
public method on `StorageRepo`, so it can be driven directly — no `BlockTransferService`
needed.

- **fresh replica fires exactly one event.**
  ```ts
  const events: CollectionChangeEvent[] = [];
  repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));
  await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
    { actionId: 'a1' as ActionId, rev: 5 });
  expect(events.length).to.equal(1);
  expect(events[0]!.collectionId).to.equal('collection-1');
  expect(events[0]!.blockIds).to.deep.equal(['block-1']);
  expect(events[0]!.actionId).to.equal('a1');
  expect(events[0]!.rev).to.equal(5);
  expect(events[0]!.tailId).to.equal(undefined);   // seam: no commit tail on the replica path
  ```
- **idempotent re-push fires none** (same `{ actionId, rev }` again → events still length 1).
- **older-rev re-push fires none** (after rev 5 held, push `{ rev: 3 }` → events still length 1).
- **distinct collection routing** (optional): a `collection-2` subscriber stays silent when a
  `collection-1` block is replicated; reuse `makeBlockInCollection`.
- **no event when block already current via commit** (optional interaction): commit `block-1`@1
  through the normal path, subscribe, then `saveReplicatedBlock` at rev 1 (equal) → no event.
- **catch-all also fires once** (optional): `onAnyCollectionChange` receives the fresh-replica
  event exactly once (documents that the bridge feed sees it, even though it is gated out of
  origination).

## Validation

From `packages/db-p2p`:

```
yarn build 2>&1 | tee /tmp/db-p2p-build.log
yarn test 2>&1 | tee /tmp/db-p2p-test.log
```

(Stream with `tee`, never silent-redirect — runner idle-timeout.) The change is additive and
confined to `saveReplicatedBlock`; the existing commit/get/notification suites must stay green.

## Out of scope

- The end-to-end multi-node integration proof is tracked by
  `optimystic-network-reactive-watch-integration-test` (in `tickets/backlog/enhancements/`).
- No change to `BlockTransferService.handlePush` or the wire protocol — the emit is entirely
  inside `StorageRepo`.

## TODO

- [ ] Edit `StorageRepo.saveReplicatedBlock` to read `latest` before `saveReplica`, derive
  `advanced`, and emit one tail-less `CollectionChangeEvent` (via `emitCollectionChanges`)
  only on a genuine advance, after the latch releases. Keep the `collectionId !== undefined`
  guard.
- [ ] Do not modify `BlockStorage.saveReplica`'s signature.
- [ ] Add the replica-persist notification tests above to `storage-repo.spec.ts`.
- [ ] `yarn build` + `yarn test` in `packages/db-p2p`, streamed with `tee`; confirm the full
  suite stays green.
