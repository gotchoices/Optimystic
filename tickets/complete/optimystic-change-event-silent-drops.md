description: Emit CollectionChangeEvents eagerly on StorageRepo's two recovery paths (get()-driven promotion, failed partial multi-block commit) so a reactive consumer is never left with a missed wake — implemented, reviewed, and shipped.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md
----

# Complete: emit change events on StorageRepo recovery paths (Option A — emit eagerly)

## Summary of shipped work

Two silent-drop paths in `StorageRepo` previously let a durably-committed block produce
**no** `CollectionChangeEvent`, so the Quereus vtab reactive-watch bridge (coarse
whole-table invalidation) could serve a stale view indefinitely. Both now emit eagerly,
per the **Option A** guarantee: a `CollectionChangeEvent` fires once for every block that
becomes durably committed on this node, regardless of whether the enclosing `commit()`
reports `success: false`, and regardless of whether the landing happened on a `commit()`
or a `get()`-driven promotion. Idempotent `alreadyDone` re-landings never re-emit.

- **Path 2 (`commit`)** — the mid-loop `internalCommit` catch now captures `let failure`
  and `break`s instead of `return`ing, so locks release, `emitCollectionChanges` fires
  for whatever landed, and the method returns `failure ? {success:false} : {success:true}`.
- **Path 1 (`get`)** — each read-driven promotion's `(collectionId, blockId, actionId,
  rev)` is collected into a `promotions` array; the new private `emitPromotions` helper
  groups by `(actionId, rev)` and routes each group through `emitCollectionChanges`.
- **Docs** — `docs/internals.md` "Change Notification" section replaced the
  "Known silent-drop paths" / "emitted only on success:true" bullets with the Option-A
  emission guarantee and added the `get() → emitPromotions` arm to the flow diagram.

## Review findings

Adversarial pass over the implement-stage diff (`68163f7`), read with fresh eyes before
the handoff. Scrutinized for SPP/DRY/modularity, control-flow equivalence, type safety,
resource cleanup, error handling, concurrency, and test completeness (happy/edge/error/
regression/interaction).

### Checked and confirmed correct (no change needed)

- **`commit()` control-flow refactor is behavior-equivalent for non-event concerns.**
  The loop now has two exit modes (normal completion vs. `break`) feeding one
  emit+return site. Traced all three non-loop exits: the `missedCommits` early-`return`
  and the `missingPends` `throw` both occur **before** the commit loop, so
  `collectionBlocks` is provably empty there — neither bypasses a needed emission, and
  `finally` still releases locks on both. The `failure`/`break` path returns the same
  `reason` string the old in-loop `return` did. Regression tests `rejects commit for
  non-existent pending action` and `returns failure when commit fails partway` still
  pass.
- **Emission ordering contract preserved.** Both paths emit *after* the critical section
  / parallel reads complete, matching the pre-existing "emit after the work, locks
  released" ordering. The "ordering across concurrent commits not guaranteed" caveat is
  retained in docs.
- **Idempotent re-landings do not double-emit.** `alreadyDone`/stale partitions never
  reach `collectionBlocks`; on the `get()` path an already-promoted block has
  `latest.rev >= c.rev` so it is filtered out of `missing`. Covered by existing
  `does not re-emit on an idempotent re-commit` and the Path-1 "does not re-emit later"
  assertion.
- **Shared `promotions` array across parallel `get()` closures** is safe under Node's
  single-threaded model (synchronous `push` between awaits); documented in a code
  comment. No regression — the old `get()` already called `internalCommit` unlocked.
- **`emitPromotions` `(actionId, rev)` string key** (`` `${actionId} ${rev}` ``) — only
  a collision risk if an actionId contained a space AND aliased another pair; not
  possible with current action-id generation. Defensive choice, acceptable.
- **Delete promotion** (newBlock undefined) routes through `internalCommit`'s
  `priorBlock.header.collectionId` fallback on both paths; existing delete test passes.
- **No other emission producers.** `StorageRepo` is the sole `IBlockChangeNotifier`
  producer and commit funnel; both `internalCommit` call sites now consume its return.
- **Build + tests green.** From `packages/db-p2p`: `yarn build` clean (tsc, exit 0).
  `yarn test` → **497 passing, 8 pending, 0 failing** (~20s). The 8 pending are
  pre-existing env-gated cases; none newly skipped. No pre-existing failures surfaced
  (no `.pre-existing-error.md` written).

### Found and fixed inline (minor)

- **Test-coverage gap in `emitPromotions` grouping.** The helper exists specifically to
  aggregate *multiple* promotions sharing one `(actionId, rev)` into a single event, but
  every Path-1 test promoted exactly one block, so the multi-block aggregation branch was
  never exercised — a bug there (e.g. emitting per-block instead of grouped) would have
  passed CI. Added `aggregates a multi-block same-action get()-promotion into one event`:
  one action inserts two blocks in one collection, pended but never committed; a single
  `get()` with context proving the action committed promotes both and must fire **exactly
  one** event whose `blockIds` covers both. Verified green (497 passing).

### Noted, intentionally not actioned (out of scope / pre-existing)

- **`get()` promotes without the `StorageRepo.commit:<id>` latch** — a read-driven
  promotion can race a concurrent commit on the same block. Pre-existing
  durability/race concern (the old `get()` was already unlocked); this ticket only
  closes the *event* drop, never claims to add locking. Over-emission from such a race
  is harmless to the coarse consumer. If the durability race warrants action it needs
  its own fix/plan ticket — not filing one here, as the source ticket explicitly scoped
  it out and no new risk was introduced.
- **Headerless/malformed block → `internalCommit` returns `undefined` → no event despite
  a durable landing.** A genuine silent-drop *in theory*, but blocks always carry a
  header in practice, and this degenerate case is identical on both the pre-existing
  `commit()` path and the new `get()` path — not a regression. Acceptable.
- **No author-suppression/dedup of eager events** — by Option-A design, over-firing
  costs only a re-query for the coarse whole-table consumer. Accepted.

## Acceptance (from source ticket) — all met

- [x] Emission guarantee decided + documented (Option A — emit eagerly), in code + docs.
- [x] Both paths emit per the guarantee.
- [x] Tests: get()-promotion-emits case; partial-commit-then-successful-retry case;
      cross-collection variant; **plus** multi-block grouping case added in review.
- [x] `docs/internals.md` "Known silent-drop paths" note replaced with the
      eager-emission guarantee.
- [x] Build + lint/tests pass (497 passing, 0 failing).
