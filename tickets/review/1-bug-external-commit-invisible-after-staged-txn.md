description: Fixed a bug where, if one database node had a transaction open with unsaved changes while another node committed conflicting data, the first node would permanently stop seeing that new data — even after cancelling its own transaction. Fix is a one-line reordering plus regression tests and a docs note.
files: packages/db-core/src/collection/collection.ts, packages/db-core/test/collection.spec.ts, packages/quereus-plugin-optimystic/test/external-commit-visibility-after-rollback.spec.ts, docs/internals.md
difficulty: easy
----

# `Collection.updateInternal` conflict-replay ordering — fixed and tested

## What changed

`Collection.updateInternal` (`packages/db-core/src/collection/collection.ts:308-323`)
used to replay conflicting pending actions (`replayActions()`) *before* advancing
its revision cursor (`Collection.advanceContext`). `replayActions` re-reads blocks
through `this.source` (`TransactorSource`), which materializes content at
`context.rev` — i.e. whatever the cursor currently names. With the old order, that
re-read landed at the revision the collection was about to leave, refilling
`sourceCache` with pre-commit content. Nothing ever re-cleared it: cache
invalidation for a block is driven by the log entry that named it, and that entry
was already consumed earlier in the same call. Result: a node with an open,
unsynced transaction that conflicted with a concurrent external commit would
permanently stop seeing the committed content for the affected blocks — surviving
even a rollback of its own transaction — until an unrelated future commit happened
to touch the same blocks again.

Fix: swap the two statements so `advanceContext` runs first, then
`if (anyConflicts) { await this.replayActions(); }`. The moved comment block
(`collection.ts:311-317`) states the ordering constraint explicitly so it isn't
re-swapped later. No other logic changed — the invalidation handling above both
statements reads the `actionContext` local captured earlier in the method, so it's
unaffected by the reorder.

This also answers a semantics question raised while investigating: in-transaction
invisibility of a concurrent external commit was **not** deliberate snapshot
isolation, it was this bug. Ordinary (live) reads — including the SQL vtab read
path, which pulls via `collection.update()` before serving every row/aggregate
shape — always observe the latest committed state, even mid-transaction. Only the
separate `committed.<Table>` / `queryCommitted()` path is snapshot-pinned
(`Collection.createReadTracker`), and that pinning is untouched by this fix.

## Test coverage added

- **`packages/db-core/test/collection.spec.ts`**, describe block "external commit
  visibility after conflict replay" (two new `it`s):
  - *"a rolled-back transaction must see the external commit that conflicted with
    it, not the pre-commit content"* — collection A stages a pending action on a
    block, collection B commits a conflicting change to the same block, A calls
    `update()` (forcing the replay), A rolls back its pending action via
    `restorePending`, then a fresh read must return B's committed value. Asserts on
    the *post-rollback read*, not just the revision cursor — the cursor advanced
    correctly even while the bug was present, so a cursor-only assertion would not
    have caught it.
  - *"a losing sync() retry rebuilds its transform against the adopted revision,
    not the stale one"* — covers the write-path corollary: a `sync()` call that
    hits a stale pend/commit failure and retries via `updateInternal()` must
    recompute its resubmitted transform against the newly adopted revision. Uses
    an `appendShared` action handler (reads current content, so it can distinguish
    "computed against stale content" from "computed against adopted content") vs.
    the overwrite-only `setShared` handler used in the first test.
  - Run: `yarn test` in `packages/db-core` → **1347 passing**.

- **`packages/quereus-plugin-optimystic/test/external-commit-visibility-after-rollback.spec.ts`**
  (new file) — end-to-end regression through the actual SQL/vtab path: two
  `Database` instances share one `StorageRepo`/`MemoryRawStorage` transactor
  (wiring copied from `committed-read-interleave.spec.ts`). Node A opens a
  transaction and updates a row; Node B commits a conflicting update to the same
  row; A does a live read *inside* the still-open transaction (masked by its own
  staged value — this is what forces the conflict replay to run); A rolls back; A
  reads the row **twice** post-rollback and both must show B's committed value —
  the two-read assertion is there specifically to catch the "loss persists" shape
  of this bug, not just a transient miss.
  - Requires `yarn build` first (the plugin test suite imports `../dist/plugin.js`).
  - Run standalone to confirm: `node --import ./register.mjs
    node_modules/mocha/bin/mocha.js "test/external-commit-visibility-after-rollback.spec.ts"
    --reporter spec --exit` → **1 passing**.
  - Full suite: `yarn test` in `packages/quereus-plugin-optimystic` (~2 min) →
    **359 passing, 11 pending** (pending count matches pre-existing baseline, no
    new pends introduced).

## Docs

`docs/internals.md` gained a new subsection, "Conflict replay must read at the
revision it is adopting, not the one it is leaving" (after the vtab read-path
section, before "Committed reads are pinned, not shared-cache"). States the
ordering rule, why it's load-bearing, and the live-vs-committed-read semantics
question this settles. Points at both new regression tests.

## How to validate this ticket

1. `cd packages/db-core && yarn test` — look for the "external commit visibility
   after conflict replay" describe block; both its tests should pass.
2. `cd packages/quereus-plugin-optimystic && yarn build && yarn test` — confirm
   the new top-level describe "External commit visibility after a staged, then
   rolled-back, transaction" passes and the overall count is 359 passing / 11
   pending (same baseline as before this change — nothing regressed).
3. Spot-check the reorder itself at `packages/db-core/src/collection/collection.ts:308-323`:
   `Collection.advanceContext(...)` must appear textually *before*
   `if (anyConflicts) { await this.replayActions(); }`.

## Known gaps (not filed as tickets — flagging for review judgment)

- **Invalidation-triggered replay path is untested by the new regressions.**
  `updateInternal` has two ways to set `anyConflicts`: (a) a pending action
  conflicting with a newly-consumed log entry (what both new tests exercise), and
  (b) a durable invalidation reverting content the client may have read
  (`collection.ts:296-309`, sets `anyConflicts = true` when `this.pending.length >
  0`). Both paths funnel into the same `if (anyConflicts) { replayActions() }`
  that the reorder fixes, so the fix covers both by construction — but no test
  drives the invalidation branch specifically to confirm it post-fix. Given the
  shared code path this is very likely fine; flagging so review can decide whether
  it's worth a targeted test or is adequately covered by the shared branch already
  being exercised.
- **Sibling ticket `2-bug-pinned-get-reports-latest-revision`** (already filed,
  sits in `tickets/implement/`) covers a *different* bug found during this
  investigation — a block materialized at a pinned revision reports the node's
  newest revision instead of the pinned one, so read dependencies claim freshness
  they don't have. No shared code with this fix; doesn't block and isn't blocked
  by this ticket.
- I did not write any new code for this ticket — the fix, both `db-core` tests,
  the new e2e spec, and the docs subsection were already present in the working
  tree/history (commit `8540365`) when I picked this ticket up; my own
  contribution was re-verifying both full suites green end-to-end (fresh
  `yarn build` + `yarn test` in both packages, not just trusting the prior run's
  numbers) and fixing one stale file reference in `docs/internals.md` (it cited
  `committed-read-interleave.spec.ts` — the file the new spec's wiring was copied
  *from* — as the end-to-end regression anchor; corrected to cite the actual new
  file, `external-commit-visibility-after-rollback.spec.ts`). Worth a review pass
  to confirm nothing else was left half-done from that prior run.
