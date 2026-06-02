description: Review the eager change-event emission added to StorageRepo's two recovery paths (get()-driven promotion, failed partial multi-block commit) so a reactive consumer is never left with a missed wake
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md
----

# Review: emit change events on StorageRepo recovery paths (Option A — emit eagerly)

## What shipped

Two silent-drop paths in `StorageRepo` previously let a durable block landing produce
**no** `CollectionChangeEvent`, so a reactive consumer (the Quereus vtab reactive-watch
bridge — coarse whole-table invalidation) could serve a stale view indefinitely until an
unrelated later commit on the same collection happened to re-wake it. Both now emit
eagerly, per the **Option A** guarantee adopted by the source ticket:

> A `CollectionChangeEvent` fires once for every block that becomes **durably
> committed** on this node, regardless of whether the enclosing `commit()` reports
> `success: false`, and regardless of whether the landing happened on a `commit()` or on
> a `get()`-driven promotion. Idempotent `alreadyDone` re-landings do **not** re-emit —
> each `pending → committed` transition emits exactly once.

### Path 2 — `commit()` (storage-repo.ts ~289–404)

The `internalCommit` `catch` used to `return { success: false }` from **inside** the
commit loop, before `emitCollectionChanges`. Blocks `1..N-1` that had already landed
durably in that same loop were therefore never emitted; on retry they fall into the
`alreadyDone` partition and `continue`, so their event was **permanently lost**.

**Fix.** The catch now captures the failure into a `let failure` and `break`s instead of
returning. `finally` releases the locks, `emitCollectionChanges(collectionBlocks, …)`
fires for whatever landed, and the method returns `failure ? {success:false,…} :
{success:true}`. Emission still happens **after** locks release (ordering contract
unchanged). The `missedCommits` early-return and the `missingPends` throw are untouched —
both occur before any `internalCommit`, so `collectionBlocks` is empty there.

### Path 1 — `get()` (storage-repo.ts ~84–138, new `emitPromotions` helper)

`internalCommit`'s return value was ignored on the read-driven promotion path, so a
`get()` that promoted a pending action (because `context` proved it committed) fired no
event.

**Fix.** Each promotion's `(collectionId, blockId, actionId, rev)` is pushed onto a
`promotions` array shared across the parallel-map closures (safe: pushes are synchronous
between awaits, single-threaded). After `Promise.all`, the new private `emitPromotions`
helper groups by `(actionId, rev)` — a single `get()` can promote multiple distinct
actions — and routes each group through the existing `emitCollectionChanges` emitter.

### Docs

`docs/internals.md` "Change Notification" section: replaced the "Known silent-drop paths"
bullet and the old "emitted only on `success: true`" bullet with the Option-A emission
guarantee, and added the `get() → emitPromotions` arm to the flow diagram. The
"ordering not guaranteed" caveat is retained.

## Validation

- From `packages/db-p2p`: `yarn build` clean (tsc, silent).
- `yarn test` → **496 passing, 8 pending, 0 failing** (~20s). The 8 pending are
  pre-existing env-gated cases; nothing new was skipped.
- **Tests proven to catch the bug.** Before handing off, I reverted `storage-repo.ts` to
  HEAD, rebuilt, and ran the 3 new tests: all 3 failed with exactly the expected mode
  (`expected +0 to equal 1` — zero events emitted). Restored the fix; all green again.

### New tests (in `storage-repo.spec.ts` → `change notification` describe)

- **Path 1** — `emits one event on a get()-driven promotion and does not re-emit later`:
  pend an insert, `get()` with `context.committed = [{actionId, rev:1}]`, assert exactly
  one event with the right `collectionId`/`blockIds`/`actionId`/`rev`; then a contextless
  `get()` (already promoted, no new landing) asserts **no** re-emit.
- **Path 2** — `emits per durable landing across a failed partial commit and its
  successful retry`: two same-collection blocks at rev 1; pend an update to both; a
  factory wraps `block-2`'s storage so its `saveRevision` throws **exactly once** (forces
  a real mid-loop `internalCommit` throw — the existing TEST-5.4.2 only hits the stale
  early-return). Attempt 1 → `success:false` + one event for the landed block; retry →
  `success:true` + one event for the remaining block; the woken set across both attempts
  covers both blocks exactly once.
- **Path 2 variant** — `wakes the landed collection on a failed partial commit spanning
  two collections`: `block-a`(collection-A) lands, `block-b`(collection-B) throws;
  asserts collection-A is woken on attempt 1 even though the overall commit failed and
  collection-B never landed. This is the "narrow-but-real permanent miss" the fix closes.

## Where to look hard (gaps / things to verify, not a finish line)

- **`commit()` control-flow refactor.** Confirm the `failure`/`break` rewrite is
  behavior-equivalent for *non-event* concerns: the same `reason` string is returned, the
  `missedCommits` early-`return` inside the `try` still returns directly (locks released
  by `finally`, no emit — `collectionBlocks` is empty there), and the `missingPends`
  `throw` still propagates out (test `rejects commit for non-existent pending action`
  asserts this). I believe all three hold, but the loop now has two exit modes (normal
  completion vs. `break`) feeding one emit+return site — worth a careful read.
- **Test fault-injection realism.** Path-2 tests monkeypatch `storage.saveRevision` on a
  `BlockStorage` *instance* (the call site is `storage.saveRevision(...)`, and
  `BlockStorage` never calls its own `this.saveRevision` internally, so only
  `internalCommit` is affected). The throw lands **after** `saveMaterializedBlock` and
  **before** `promotePendingTransaction`/`setLatest` — i.e. pending survives, latest stays
  at the old rev, so the retry genuinely re-commits. Verify this matches a plausible real
  crash/IO-failure point and that the "throw once" closure state is what makes the retry
  succeed (not some other artifact).
- **`emitPromotions` grouping key.** Uses `` `${actionId} ${rev}` `` as the map key. Fine
  for current action ids; only a concern if an `actionId` could contain a space AND
  collide with another `(actionId, rev)` pair — extremely unlikely, but flagging the
  string-keying choice. In practice one action commits all its blocks at one rev, so
  grouping by actionId alone would also suffice; the `(actionId, rev)` key is the more
  defensive choice the source ticket specified.
- **Shared `promotions` array across parallel closures.** Relies on Node's
  single-threaded model (synchronous `push` between awaits). Correct for the current
  runtime; noted in a code comment. No locking added (consistent with the out-of-scope
  note below).

## Known gaps / out of scope (do NOT fix here)

- **`get()` promotes without the `StorageRepo.commit:<id>` latch.** A read-driven
  promotion can race a concurrent commit on the same block — a pre-existing
  durability/race concern the source ticket explicitly scoped out. This ticket only stops
  the **event** drop; it does not add locking to `get()`. If that race warrants action,
  it needs its own fix/plan ticket.
- **No author-suppression / dedup of the eager events.** By design (Option A), over-firing
  is harmless for the coarse whole-table consumer; a `get()`-driven promotion plus a later
  observation could both fire. Accepted.
- **Other repos.** Only `StorageRepo` is the commit funnel and the only `IBlockChangeNotifier`
  producer touched; no other emission sites were in scope.

## Acceptance (from source ticket) — status

- [x] Emission guarantee decided + documented (Option A — emit eagerly), in code + `docs/internals.md`.
- [x] Both paths emit per the guarantee.
- [x] Tests: get()-promotion-emits case; partial-commit-then-successful-retry case; cross-collection variant.
- [x] `docs/internals.md` "Known silent-drop paths" note replaced with the eager-emission guarantee.

## End
