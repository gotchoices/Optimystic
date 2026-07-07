description: A crash-repair routine that fixes a block left half-committed is only ever called by tests, so in production a badly-timed crash wedges the block forever. Make the commit path detect that state and repair itself.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts
difficulty: medium
----

# Wire `recover()` into `commit()` so the Crash-D3 wedge self-heals

## Problem

`StorageRepo.recoverBlock` (`storage-repo.ts:477`) → `IBlockStorage.recover()`
(`block-storage.ts:116`) reconciles a block's `meta.latest` with the highest contiguous
fully-promoted revision in durable storage. It exists to repair one specific crash state, but
**nothing in production calls it** — only `mid-ddl-crash.spec.ts` and `block-storage.spec.ts`
do. So the state it repairs stays broken until a human intervenes.

### The unrepaired state (called "Crash-D3" in the tests)

`internalCommit` (`storage-repo.ts:526`) writes durable state in this order:

1. `saveMaterializedBlock`
2. `saveRevision(rev, actionId)`
3. `promotePendingTransaction(actionId)` — the pending record is now gone; the action is in the committed log
4. `setLatest({ actionId, rev })` — advances `meta.latest`

If the process crashes **between step 3 and step 4**, the block is left with:

- revision `request.rev → request.actionId` durable (`getRevision` / `listRevisions` see it),
- the action durably in the committed log (`getTransaction(request.actionId)` returns it),
- **but** `meta.latest` still at the prior rev (or `undefined`) — the `setLatest` write was lost,
- **and** the pending record gone (`getPendingTransaction(request.actionId)` → `undefined`).

### Why a retry-commit can't clear it

On retry with the same `(actionId, rev)`, `commit()` (`storage-repo.ts:350`) partitions the block:

- Not `alreadyDone`: that partition requires `latest.rev === request.rev`, but `latest.rev < request.rev` here (lost `setLatest`).
- Not `missedCommits`: that requires `latest.rev >= request.rev`.
- So it lands in **`toCommit`** (`storage-repo.ts:410`).

Then the missing-pend guard (`storage-repo.ts:424-434`) calls
`getPendingTransaction(request.actionId)`, gets `undefined`, and **throws**
`Pending action <id> not found for block(s): ...`. Every retry re-hits the same throw. Wedged.

(Contrast **Crash-D2** — crash between step 2 and step 3: the pending record is still present,
so `getPendingTransaction` returns it and `internalCommit` rolls the block forward normally.
Retry-commit — not recovery — owns that advance, and `recover()` deliberately stops at that
boundary. This ticket must not disturb D2.)

## Fix

Self-heal inside `commit()`. When a `toCommit` block's pending record is absent, distinguish the
two cases before throwing:

- **Action durably promoted** (`getTransaction(request.actionId)` returns a transform) → this is
  Crash-D3. Call `storage.recover()`. Recovery redoes the lost `setLatest` (advancing `meta.latest`
  to the highest contiguous promoted rev, `>= request.rev`) and re-merges the coverage range. The
  block is now committed at `request.rev`; drop it from `toCommit` so the internalCommit loop skips
  it (its pending is gone — internalCommit would throw).
- **Action not promoted** (`getTransaction` → `undefined`) → the pend is genuinely missing; throw
  exactly as today.

`recover()` is idempotent and monotonic (`block-storage.ts:137-152`), so calling it under the
already-held commit latch is safe. Call it on the `storage` instance already in hand rather than via
`recoverBlock` (which spins up a fresh `IBlockStorage`).

### Detection is sufficient and precise

- Crash-D2 never reaches this branch: its pending record is still present, so the block never enters
  the missing-pend set.
- `getTransaction(request.actionId)` present ⟺ the action was promoted (step 3 ran). Combined with
  pending-absent and `latest.rev < request.rev`, that is exactly the D3 signature.
- Guard against a torn/partial state: if `recover()` returns without advancing `latest` to
  `>= request.rev` (e.g. metadata absent, or revision entry missing despite the promoted
  transaction), fall back to treating the block as a genuine missing-pend error rather than silently
  succeeding.

### Change-event emission

The original commit crashed before `setLatest`, so it also never emitted a `CollectionChangeEvent`
for the recovered block. After a successful recover, add the block to `collectionBlocks` (keyed by
its collectionId) so downstream watchers wake — mirroring how `internalCommit` reports the affected
collection. Resolve the collectionId from the now-materialized block
(`storage.getBlock(request.rev)?.block.header.collectionId`); if it can't be resolved (e.g. a
tombstone with no materialized block), skip the emit — same fallback `internalCommit` uses when the
collectionId is absent (`storage-repo.ts:566`).

### Read path (secondary, note only — do not over-build)

A default `get()` on a D3 block does not throw — it returns empty/stale state because `meta.latest`
is stale (`storage-repo.ts:196-207`), and a context-driven `get()` skips promotion because the
pending record is gone (`storage-repo.ts:166-172`). So reads are *soft-wedged* (stale), not
hard-wedged. The commit-path fix is the definite hard-wedge and is the required deliverable. If
adding a lazy `recover()` to the read path is cheap and clean, do it; otherwise record it as a
`NOTE:` tripwire at the `get()` site (stale-until-a-commit-retry-heals-it) and call it out in the
review handoff rather than expanding scope.

## Tests

`mid-ddl-crash.spec.ts` already builds the exact D3 raw state via `buildCrashingMesh` with the
`saveMetadata`-when-`latest!==undefined` fault trigger (`mid-ddl-crash.spec.ts:562-587`), and today
asserts that a bare retry-commit **throws** `Pending action ... not found`
(`mid-ddl-crash.spec.ts:604-623`). That assertion encodes the *old* wedged behavior — update it (or
add a sibling test) to assert the retry now **succeeds** and materializes the block.

Reuse the existing helpers (`seedPending`, `crashTrigger`, `rebuildCleanMesh`) — the D3 fixture is
already there; only the post-crash expectation changes.

## TODO

- [ ] In `commit()` (`storage-repo.ts:424-434`), replace the missing-pend loop: for each `toCommit`
      block whose `getPendingTransaction(request.actionId)` is absent, probe
      `getTransaction(request.actionId)`. Promoted → `await storage.recover()`; if it advanced
      `latest` to `>= request.rev`, mark the block recovered; else push to `missingPends`. Not
      promoted → push to `missingPends`.
- [ ] Throw the existing `Pending action ... not found` error only for genuinely-missing pends.
- [ ] Exclude recovered blocks from the internalCommit loop (`storage-repo.ts:438`) so it does not
      re-run internalCommit on a block whose pending is gone.
- [ ] For each recovered block, resolve its collectionId (`storage.getBlock(request.rev)`) and add it
      to `collectionBlocks` so `emitCollectionChanges` (`storage-repo.ts:465`) wakes watchers; skip
      emit when the collectionId can't be resolved.
- [ ] Update `mid-ddl-crash.spec.ts` Crash-D3 block: the "retry-commit throws" test becomes
      "retry-commit self-heals and succeeds"; assert `meta.latest.rev === request.rev`, the pending
      is gone, and a subsequent `get()` materializes the block.
- [ ] Add/keep a test asserting Crash-D2 is unaffected (retry-commit still rolls it forward; the new
      recover branch does not fire because the pending record is present).
- [ ] Decide the read-path handling: either a cheap lazy `recover()` in `get()`, or a `NOTE:`
      tripwire at the `get()` site — record the choice in the review handoff.
- [ ] Build + tests: `cd packages/db-p2p && yarn build 2>&1 | tee /tmp/build.log` then
      `yarn test 2>&1 | tee /tmp/test.log` (stream output — do not silently redirect).
