description: Fixed a bug where, if one database node had a transaction open with unsaved changes while another node committed conflicting data, the first node would permanently stop seeing that new data — even after cancelling its own transaction. Fix is a one-line reordering plus regression tests and a docs note.
files: packages/db-core/src/collection/collection.ts, packages/db-core/test/collection.spec.ts, packages/quereus-plugin-optimystic/test/external-commit-visibility-after-rollback.spec.ts, docs/internals.md
difficulty: easy
repro: verified
----

# `Collection.updateInternal` conflict-replay ordering — fixed, tested, reviewed

## What changed

`Collection.updateInternal` (`packages/db-core/src/collection/collection.ts:308-328`)
used to replay conflicting pending actions (`replayActions()`) *before* advancing its
revision cursor (`Collection.advanceContext`). `replayActions` re-reads blocks through
`this.source` (`TransactorSource`), which materializes content at `context.rev` — i.e.
whatever the cursor currently names. With the old order, that re-read landed at the
revision the collection was about to leave, refilling `sourceCache` with pre-commit
content. Nothing ever re-cleared it: cache invalidation for a block is driven by the log
entry that named it, and that entry was already consumed earlier in the same call.
Result: a node with an open, unsynced transaction that conflicted with a concurrent
external commit would permanently stop seeing the committed content for the affected
blocks — surviving even a rollback of its own transaction — until an unrelated future
commit happened to touch the same blocks again.

Fix: swap the two statements so `advanceContext` runs first, then
`if (anyConflicts) { await this.replayActions(); }`. The comment block above
`advanceContext` states the ordering constraint explicitly so it isn't re-swapped later.
No other logic changed — the invalidation handling above both statements reads the
`actionContext` local captured earlier in the method, so it is unaffected by the reorder.

This also answers a semantics question raised during the investigation: in-transaction
invisibility of a concurrent external commit was **not** deliberate snapshot isolation,
it was this bug. Ordinary (live) reads — including the SQL vtab read path, which pulls
via `collection.update()` before serving every row/aggregate shape — always observe the
latest committed state, even mid-transaction. Only the separate `committed.<Table>` /
`queryCommitted()` path is snapshot-pinned (`Collection.createReadTracker`), and that
pinning is untouched by this fix.

## Test coverage

- `packages/db-core/test/collection.spec.ts`, describe "external commit visibility after
  conflict replay" — two tests: the read-path shape (stage locally → external conflicting
  commit → `update()` forces replay → roll back via `restorePending` → fresh read must
  return the committed value) and the write-path corollary (a losing `sync()` retry must
  rebuild its resubmitted transform against the adopted revision, using an `appendShared`
  handler that reads current content so stale-vs-adopted is distinguishable).
- `packages/quereus-plugin-optimystic/test/external-commit-visibility-after-rollback.spec.ts` —
  end-to-end through the real SQL/vtab path: two `Database` instances over one shared
  `StorageRepo`/`MemoryRawStorage` transactor; A stages, B commits, A reads in-transaction
  (forcing the replay), A rolls back, A reads twice and both must show B's value.
- `docs/internals.md` — subsection "Conflict replay must read at the revision it is
  adopting, not the one it is leaving", plus a cross-reference added from "The revision
  context is monotonic" (added this pass).

## Review findings

### Verification performed

- **Read the implement diff (`8540365`, `b80b318`) before the handoff summary.** The
  reorder is correct and minimal. Traced every statement between the two moved lines:
  `sourceCache.clear` (per log entry, line 292) and the invalidation branch (lines
  296-309) both read the `actionContext` local captured at line 271, and cache clearing
  is revision-independent — so nothing else in the method depends on the old ordering.
- **Confirmed the regression tests are not vacuous.** The handoff asserted coverage but
  never showed the tests failing without the fix. Temporarily reverted the reorder in a
  scratch edit, re-ran, and restored (`git diff` clean afterward, verified):
  - db-core: `1345 passing, 2 failing` — `expected 'v1' to equal 'v2-committed'` and
    `expected 'v1+local' to equal 'v2-committed+local'`. Both new tests bite.
  - plugin e2e: after a full `yarn build` on the reverted source,
    `expected [ 'seed' ] to deeply equal [ 'b-committed' ]` — the exact pre-commit-content
    shape of the bug, through the real SQL path. Also not vacuous.
  - Fix restored and rebuilt; `git diff --stat` empty against the fixed source before
    proceeding.
- **Full suites green** (all run this pass, not carried over from the handoff):
  `yarn lint` at repo root — clean, exit 0. Root `yarn test` across all workspaces —
  1347 (db-core) + 1515 + 52 + 49 + 44 + 43 + 12 + 125 + 359 (plugin) + 6 + 258 passing,
  56 pending, **0 failing**. Plugin pending count is 11, matching the pre-existing
  baseline. Re-ran lint + db-core after this pass's inline edits — still clean, 1347.

### Findings and disposition

- **The handoff's one flagged gap is already closed — no test or ticket needed.** It
  worried that `updateInternal`'s *other* `anyConflicts` source (a durable invalidation
  with pending work, lines 303-309) never gets driven post-fix. It does:
  `packages/db-core/test/invalidation-client.spec.ts` has "replays pending work against
  the reverted base and resubmits successfully" (drives invalidation → replay → resubmit,
  asserts on post-replay content and on a distinct durably-committed action) and, just
  above it, a test asserting the reverted block is dropped from the read cache with
  `equal('v0')` rather than merely `!= 'v2'`. Both branches into `replayActions` are
  therefore exercised. Closing the gap, not deferring it.
- **Stale comment at the replay site — fixed inline.** It read "clear related caching and
  block-tracking and replay logical operations", but `replayActions` only does
  `tracker.reset()` plus the replay; the cache clearing happens earlier, per log entry and
  per invalidation. Rewritten to say what the call actually does and where the cache drop
  came from.
- **Docs cross-reference — added inline.** The new subsection explains the ordering, but
  the pre-existing "The revision context is monotonic" section discusses
  `advanceContext` in `updateInternal` without mentioning that its *position* is
  load-bearing — an editor working from that section could reintroduce the bug. Added a
  pointer there. The `b80b318` file-reference correction (docs cited
  `committed-read-interleave.spec.ts`, the file the new spec's wiring was copied from,
  instead of the new spec) is verified correct as landed.
- **Tripwire recorded, not ticketed** — `collection.ts`, `NOTE:` at the `replayActions`
  call site: a throw out of `replayActions` leaves the tracker holding only the transforms
  replayed so far while `pending` still lists them all. Pre-existing under both orderings,
  not introduced here, and the caller is expected to abort rather than keep staging.
  Parked as a code comment naming the fix (rebuild into a scratch tracker, swap on
  success) if replay ever gains a routinely-throwing read path.
- **Not re-reported: db-core single-spec import cycle.** Running
  `test/collection.spec.ts` alone fails with
  `ReferenceError: Cannot access 'collectionTypes' before initialization` (load-order
  dependent; the full suite is fine). Already tracked as
  `backlog/debt-db-core-single-spec-import-cycle`.
- **Not filed: test-helper duplication in the plugin suite.** `collectRows` is redefined
  in 10 spec files and a `StorageRepo`-over-`MemoryRawStorage` transactor builder in 13;
  the new spec adds one more of each (counts from `grep -rn` over
  `packages/quereus-plugin-optimystic/test/`). This is the package's established house
  style and entirely pre-existing — the new file matching it is the right call, and
  deduplicating would touch a dozen unrelated files. Out of scope for this diff; noting
  the measurement here rather than opening a low-value debt ticket.
- **No major findings.** Nothing in the diff warranted a new `fix/`, `plan/`, or
  `backlog/` ticket — the change is a two-statement reorder with genuine, verified
  regression coverage at both the unit and end-to-end level, and correct docs.
- **Nothing left half-done from the prior interrupted run.** The handoff asked for this
  check specifically. Reviewed both implement commits and the working tree: source, both
  db-core tests, the e2e spec, and the docs subsection are all present and coherent, and
  the tree was clean at review start.

### Sibling work (unaffected)

`tickets/implement/2-bug-pinned-get-reports-latest-revision` covers a different bug found
during the same investigation — a block materialized at a pinned revision reports the
node's newest revision instead of the pinned one. No shared code with this fix; neither
ticket blocks the other. Left untouched.
