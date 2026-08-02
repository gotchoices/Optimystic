description: A node that asked storage "does this collection exist?" and got back "no" used to quietly forget the revision number it already knew, then spend twenty seconds re-requesting revision 1 and failing. It now keeps what it knew, and reports the contradiction immediately by name.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/absent-header-wedges-revision.spec.ts, docs/internals.md
difficulty: medium

# Review: `Collection` no longer drops a known-good revision

## What changed

Three edits in `db-core`, one new error type, one docs section.

### 1. A monotonic-context rule, in one place

New private helper `Collection.advanceContext(source, id, next)`
([collection.ts:154-173](../../packages/db-core/src/collection/collection.ts#L154-L173)). It adopts
a freshly-read `ActionContext` only when doing so does not lower the revision already held:

- `next === undefined` → keep what we hold (return).
- `next.rev < current.rev` → keep what we hold, and log `collection:context-not-lowered`.
- otherwise (including equal revs, whose `committed` list may be more complete) → adopt `next`.

Both read sites now route through it instead of assigning directly:

- `attachToLog` — was `source.actionContext = await collectionLog.getActionContext()`. That call
  resolves `undefined` for a chain with no tail or an entries-empty tail, which previously erased
  the revision `bootstrapContext` had just read off the committed log tail.
- `updateInternal` — was `this.source.actionContext = latest?.context` (the line the fix ticket
  named). `latest` is `undefined` when the log will not open, and its `context` is an *older*
  revision when the log read was served by a replica that lags.

`createOrOpen`'s invent branch still assigns `source.actionContext = undefined` directly. That is an
explicit reset for a collection being brought into existence, not a read, so it is deliberately not
routed through the helper.

### 2. A contradiction now throws instead of no-opping

`updateInternal` ([collection.ts:218-236](../../packages/db-core/src/collection/collection.ts#L218-L236)):
when the header block reads as authoritatively absent **and** `this.source.actionContext` holds a
committed revision, it throws the new `CollectionHeaderVanishedError` naming the collection id and
the held revision. The genuinely-absent case (no revision held) is untouched — it still falls
through and no-ops, which is what keeps `createOrOpen`'s invent path working.

New error in [struct.ts:50-75](../../packages/db-core/src/collection/struct.ts#L50-L75), exported
from the package root. Fields: `collectionId`, `heldRev`. It is a plain `Error`, not a
`StaleFailure`, so `syncInternal`'s retry loop does not absorb it — the throw aborts the sync
immediately rather than burning the retry budget.

### 3. Docs

`docs/internals.md` § Collection Header Blocks gained a subsection **"The revision context is
monotonic"** stating the rule, why it exists, and the contradiction case.

## Use cases to exercise

The spec is `packages/db-core/test/absent-header-wedges-revision.spec.ts` — rewritten, 6 tests, all
passing. It keeps the `HeaderHidingTransactor` harness from the fix ticket (rewrites reads of one
block id into `{ state: {} }` — present entry, no `block`, no `unavailable` flag = authoritative
absent) and adds `StaleViewTransactor` (answers every read as of a pinned revision, modelling a
replica that lags; per-block `state.latest` stays current, as it would on a real lagging peer).

| Test | Asserts |
| --- | --- |
| header reads absent on `update()` | throws `CollectionHeaderVanishedError` with `collectionId` and `heldRev === 3`; `getNextRev()` still 4 |
| header vanishes mid-`sync()` after losing a race | throws `CollectionHeaderVanishedError`, NOT `SyncRetryExhaustedError`; `pendRevs` is exactly `[4]` — one attempt, not ten at rev 1 |
| lagging peer during `update()` | `getNextRev()` stays 4 though the log read reports rev 1 |
| lagging peer during open | `getNextRev()` is 4 though `getActionContext()` reports rev 1 |
| never-committed collection | `update()` no-ops silently, `getNextRev()` stays 1 |
| collection invented against a hidden header | still exhausts retries at rev 1 (see *Known gaps*) |

**Each of the four behaviour-change tests was verified to fail with its own guard removed** — I
temporarily disabled `advanceContext`'s two early returns (the two lagging-peer tests failed, rev
dropping 3→1) and separately disabled the throw (the two contradiction tests failed, the second one
degrading to exactly the original `SyncRetryExhaustedError` signature), then restored both. None of
the new tests is vacuous.

## Validation run

| Command | Result |
| --- | --- |
| `yarn build` (root, all packages) | clean |
| `yarn lint` (root) | clean |
| `yarn test` (root, all packages) | db-core **1319 passing** (1315 before + 4 net new tests); db-p2p 1479 passing / 44 pending; quereus-plugin-optimystic 336 passing / 11 pending; all other packages green; **0 failing** |
| `yarn test:integration` (db-p2p) | 30 passing / 2 pending |
| `yarn test:integration` (quereus-plugin-optimystic) | 339 passing / 8 pending |

`two-node-convergence.integration.spec.ts` (3 tests, including "a joiner writes into a collection
another node already advanced") passes. No pre-existing failures surfaced, so no
`tickets/.pre-existing-error.md` was written. None of the six tests the fix ticket asked to preserve
were deleted or modified.

## Known gaps — read these before signing off

- **The invented-collection arm is NOT fixed, by design.** A node that cannot see the header of a
  collection it has *never* committed to invents a rival empty collection, holds no revision, and so
  has no contradiction to detect: it still re-requests rev 1 on every retry and dies with
  `SyncRetryExhaustedError`. The last test pins this and names the two tickets that own it
  (`cluster-read-consult-cannot-report-unreachable` — make the read answer correctly;
  `stale-failure-carries-coordinator-revision` — give the client a revision to rebase onto). This
  ticket only stops a client from discarding a revision it already had.
- **The `attachToLog` arm is tested via a lagging replica, not via an entries-empty tail.** The fix
  ticket flagged that arm `repro: static`. `getActionContext()` returns `undefined` for a tailless
  or entries-empty chain, but every commit path appends an entry, so constructing a *committed*
  entries-empty tail needs contrived chain surgery — I did not invent one, as the ticket asked. What
  I tested instead is the other way that call lowers the context: a replica serving an older view,
  where it returns a real-but-older rev. The `undefined` branch of `advanceContext` is exercised by
  the `updateInternal` path, not by `attachToLog`. A reviewer who wants that specific branch covered
  at `attachToLog` would need a hand-built chain fixture.
- **Blast radius of the new throw.** Any caller of `Collection.update()` can now throw where it
  previously no-opped. The one worth a second look is `TransactionCoordinator`
  ([coordinator.ts:188-190](../../packages/db-core/src/transaction/coordinator.ts#L188-L190)), which
  refreshes **every registered collection** between commit retries, not just the transaction's
  participants — so a non-participant whose header momentarily reads absent now aborts the whole
  retry. That is the intended loud failure, and the full suite plus both integration suites are
  green, but it is the change most likely to surface somewhere I did not think to look.
- **`advanceContext` compares `rev` only.** Two contexts at the same rev with different `committed`
  lists resolve to the newer read. That is intentional (a later read's list may be more complete)
  but it is a policy choice, not a forced one.

## Tripwires parked in code

- `collection.ts` `updateInternal`, at the throw — a `NOTE:` recording the coordinator blast radius
  above, and pointing at narrowing the coordinator's blanket refresh to participants (rather than
  softening the throw) if it ever costs otherwise-healthy transactions.

## Suggested review focus

- Is "never lower the revision" right *unconditionally*? I could not find a legitimate path where a
  collection must move backwards (invalidations take a new monotonic rev slot rather than rewinding),
  but that is the load-bearing assumption of the whole change.
- Does throwing from `updateInternal` reach any caller that would rather degrade? `Tree.update`,
  `Diary.update`, the plugin's schema/index managers, and the coordinator all call it.
- Whether the last test — which pins a defect rather than a fix — earns its place, or should be a
  comment in the sibling ticket instead.
