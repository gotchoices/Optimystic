description: A crash-repair routine that fixed a half-committed block was only ever run by tests; now the commit path detects that half-committed state and repairs itself so a badly-timed crash no longer wedges the block forever.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts
difficulty: medium
----

# Review: wire `recover()` into `commit()` so the Crash-D3 wedge self-heals

## What was wrong

`BlockStorage.recover()` (`block-storage.ts:116`) repairs one specific crash state but had **no
production caller** — only tests. So the state it repairs stayed broken until a human ran it.

**The wedge (called "Crash-D3" in the tests).** `internalCommit` (`storage-repo.ts:526`) writes
durable state in order: (1) `saveMaterializedBlock`, (2) `saveRevision`, (3)
`promotePendingTransaction` — the pending record is now gone and the action is in the committed log,
(4) `setLatest` — advances `meta.latest`. A crash **between steps 3 and 4** leaves: revision +
committed-log entry durable, but `meta.latest` still at the prior rev (or undefined), and the pending
record gone. On retry, `commit()` puts the block in `toCommit` (its `latest.rev < request.rev`), then
the missing-pend guard calls `getPendingTransaction`, gets `undefined`, and **throws**. Every retry
re-throws. Wedged.

## What changed

**`commit()` self-heals the D3 state** (`storage-repo.ts`, the missing-pend section ~line 424). For
each `toCommit` block whose pending is absent, it now probes `getTransaction(request.actionId)`:

- **Action durably promoted** → Crash-D3. Call `storage.recover()` (idempotent + monotonic, safe
  under the already-held commit latch). If it advanced `latest` to `>= request.rev`, mark the block
  *recovered*; otherwise (torn/partial state) fall back to the genuine-missing-pend error.
- **Action not promoted** → genuine missing pend → throw exactly as before.

Recovered blocks are **excluded from the internalCommit loop** (their pending is gone; internalCommit
would throw) and get a **change event emitted** — the original commit crashed before `setLatest` so it
never emitted one. CollectionId is resolved from the now-materialized block via
`storage.getBlock(request.rev)`; emit is skipped if it can't be resolved (same fallback internalCommit
uses).

**Read path:** left as a documented soft-wedge — see *Read-path decision* below.

## Why detection is precise (verify this claim)

- **Crash-D2** (crash between steps 2 and 3: revision durable, pending *still present*, action NOT
  yet in committed log) never reaches the recover branch — its `getPendingTransaction` returns the
  record, so the block never enters the missing-pend set. The new branch fires only on
  pending-absent. Confirm D2's retry-commit still rolls forward untouched (existing test at
  `mid-ddl-crash.spec.ts:485` still passes).
- `getTransaction(request.actionId)` present ⟺ the action was promoted (step 3 ran). Combined with
  pending-absent and `latest.rev < request.rev`, that is exactly the D3 signature.
- Torn-state guard: if `recover()` returns without advancing `latest` to `>= request.rev`, the block
  is treated as a genuine missing-pend error rather than silently succeeding.

## Read-path decision (recorded per ticket)

Chose the **`NOTE:` tripwire**, not a lazy `recover()` in `get()`. A default `get()` on a D3 block
does not throw — it returns empty/stale because `meta.latest` is stale, and a context-driven `get()`
skips promotion (pending gone). So reads are *soft-wedged* (stale), not hard-wedged, and the next
commit-retry self-heals them. A lazy recover on the read path was rejected because `get()` holds no
commit latch (unlike `commit()`), so adding a mutating recover there would need its own latching —
scope creep for a stale-read that heals on the next write. The `NOTE:` lives at the `get()` site in
`storage-repo.ts` (just above `const blockRev = await blockStorage.getBlock(context?.rev)`).

## Tests

`packages/db-p2p/test/mid-ddl-crash.spec.ts`:

- **Replaced** the old "retry-commit fails without recovery" test (which asserted the throw — the old
  wedged behavior) with **"retry-commit self-heals the D3 wedge and succeeds"**: asserts
  `meta.latest.rev === 1`, actionId matches, pending stays gone, and a subsequent `get()`
  materializes the block.
- **Added** "retry-commit fires a collection change event for the self-healed block": subscribes via
  `onAnyCollectionChange`, asserts exactly one event with the right collectionId / blockIds / rev.
- **Kept** the D2 tests (retry-commit at `:485`, recoverBlock-stops-at-D2-boundary at `:701`) and the
  direct `recoverBlock` tests — `recoverBlock` still exists and is still exercised.

Results: `mid-ddl-crash.spec.ts` 15/15 pass; full `yarn test` **1155 passing, 36 pending, 0 failing**;
`yarn build` (tsc) clean.

## Where a reviewer should push

- **Mixed batch edge case (known gap).** If one commit's `toCommit` held *both* a D3-recoverable
  block *and* a genuinely-missing-pend block, the code recovers the D3 block, then throws on the
  missing one — so the recovered block's change event is **not** emitted (the throw skips the
  post-critical-section `emitCollectionChanges`). This is judged pathological: within one action, a
  block is either fully done (alreadyDone on retry), still-pending, or the single D3 block from a
  mid-`internalCommit` crash — a D3 block and a never-pended block coexisting in one retry is not a
  reachable production state. On retry the recovered block is `alreadyDone` and skipped, so it never
  re-emits, but the durable state is correct. Not covered by a test. Worth a reviewer's eye on
  whether that reachability argument holds.
- **`recover()` under the commit latch.** Confirm `recover()` (`block-storage.ts:116`) takes no lock
  that could deadlock against the held `StorageRepo.commit:<id>` latch. It reads/writes raw storage
  directly (getMetadata/getRevision/getTransaction/saveMetadata) with no `Latches.acquire`, so it
  should be safe, but verify.
- **`getBlock(request.rev)` cost.** The emit-resolve loop does one extra `getBlock` per recovered
  block to fetch the collectionId. Only runs on the rare D3 recovery path, so not hot — but confirm
  the materialization it triggers is acceptable there.
- **Second `getTransaction` probe.** The missing-pend loop now does an extra `getTransaction` read
  per pending-absent block. Only pending-absent blocks pay it (the common case has pending present
  and `continue`s), so no cost on the hot path.
