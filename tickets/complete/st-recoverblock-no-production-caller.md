description: A crash-repair routine that fixed a half-committed block was only ever run by tests; now the commit path detects that half-committed state and repairs itself so a badly-timed crash no longer wedges the block forever.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts
difficulty: medium
----

# Complete: wire `recover()` into `commit()` so the Crash-D3 wedge self-heals

## What shipped

`BlockStorage.recover()` (`block-storage.ts:116`) repairs the "Crash-D3" state — a commit that
crashed after `promotePendingTransaction` but before `setLatest`, leaving the revision + committed-log
entry durable while `meta.latest` stayed stale and the pending record was gone. Before this change it
had no production caller, so the state stayed wedged until a human ran it.

`StorageRepo.commit()` now self-heals that state: for each `toCommit` block whose pending is absent, it
probes `getTransaction(request.actionId)`. If the action was durably promoted → Crash-D3 → call
`storage.recover()` (idempotent + monotonic, safe under the held commit latch); if `recover()`
advances `latest` to `>= request.rev`, mark the block *recovered*, exclude it from the internalCommit
loop, and emit a collection change event the original crashed commit never sent. If the action was not
promoted → genuine missing pend → throw exactly as before. The read path is left as a documented
soft-wedge (stale read that heals on the next commit-retry) via a `NOTE:` tripwire at the `get()` site.

## Review findings

Reviewed the implement-stage diff (commit `7f43054`) with fresh eyes, then the handoff. Checked
detection precision, latch safety, resource/error paths, the read-path decision, docs, and test
coverage across happy/edge/error paths.

- **Detection precision — CONFIRMED correct.** Crash-D2 (pending still present) never enters the
  missing-pend branch, so its retry-commit rolls forward untouched. The D3 signature (pending absent +
  `getTransaction(actionId)` present + `latest.rev < request.rev`) is exact. The torn-state guard
  (recover didn't reach `request.rev` → treat as genuine missing-pend) is present. D2 tests still pass.
- **`recover()` under the commit latch — CONFIRMED safe.** `recover()` (`block-storage.ts:116-153`)
  reads/writes raw storage directly (`getMetadata`/`getRevision`/`getTransaction`/`saveMetadata`) with
  no `Latches.acquire`, so it cannot deadlock against the held `StorageRepo.commit:<id>` latch.
- **BUG FOUND + FIXED inline (minor): recovered-delete emit was silently dropped.** The emit-resolve
  loop resolved the collectionId only from `getBlock(request.rev)`. A delete materializes to a
  tombstone, so `getBlock(request.rev)` returns `undefined` → the collectionId was unresolved → **no
  change event** for a D3-recovered delete, even though a normal delete commit emits (internalCommit
  falls back to the prior block's header). The implementer's comment claimed "the same fallback
  internalCommit uses," but the code did **not** implement that fallback. Fixed by adding the
  prior-block-header fallback (`getBlock(request.rev - 1)`) mirroring `internalCommit`, and corrected
  the comment. Added regression test *"retry-commit fires a change event when the self-healed block is
  a delete (tombstone)"* — it fails without the fallback (0 events) and passes with it.
- **Mixed-batch emit gap — recorded as a tripwire, not a ticket.** If one batch held both a
  D3-recoverable block and a genuinely-missing-pend block, the throw after `recover()` would skip the
  recovered block's emit. Judged unreachable in production (a single mid-`internalCommit` crash leaves
  exactly one D3 block; the rest are alreadyDone or pending-present — a never-pended block cannot
  coexist). Parked as a `NOTE:` at the throw site in `storage-repo.ts` (with the escape hatch to emit
  before throwing if a path ever produces that mix). No test.
- **Read-path soft-wedge — CONFIRMED appropriate.** A D3 block reads stale (not a hard error) and the
  next commit-retry heals it; a lazy recover in `get()` would need its own latching (get holds no
  commit latch) — scope creep for a self-healing stale read. Left as the `NOTE:` tripwire.
- **Performance — no concern.** The extra `getTransaction` probe and `getBlock` calls run only on the
  rare pending-absent / D3-recovery path; the hot path (pending present) `continue`s before paying
  either. Not flagged.
- **Docs — checked, no update needed.** `docs/internals.md:273` ("a *behind* member missing the prior
  pend → `StorageRepo.commit` throws") remains accurate: a behind member never promoted the action, so
  it still hits the genuine-missing-pend throw; the self-heal fires only when the action was durably
  promoted locally. `docs/review.html:516` is the historical review artifact that spawned this ticket
  (a generated record, not living docs) — left as-is.

## Tests

`packages/db-p2p/test/mid-ddl-crash.spec.ts`:
- Kept the implementer's *"retry-commit self-heals the D3 wedge and succeeds"* and *"fires a collection
  change event for the self-healed block"* tests, the D2 tests, and the direct `recoverBlock` tests.
- **Added** the delete-tombstone emit regression test (see findings above).

Results: `mid-ddl-crash.spec.ts` 16/16 pass (was 15); full `yarn test` **1156 passing, 36 pending, 0
failing** (was 1155, +1 for the new test); `yarn build` (tsc) clean; `eslint` clean on the changed
files.
