description: A failed transaction commit was being retried backwards — hammering permanent failures that can never succeed while giving up on temporary ones that would, all while a lower layer tore down the very thing being retried. This fixes the retry rule and makes cleanup happen once.
files:
  - packages/db-core/src/transaction/coordinator.ts (commitCollection retry loop, ~lines 865-885)
  - packages/db-core/src/transactor/network-transactor.ts (commitBlock, ~line 619-635 — auto-cancel removed)
  - packages/db-core/src/transactor/transactor-source.ts (transact — unchanged, self-cancels on both branches)
  - packages/db-core/test/coordinator.spec.ts (InstrumentedTransactor commit-throw mode; split commit-retry test)
  - packages/db-core/test/transaction.spec.ts (3 2PC tests recalibrated to the corrected policy)
----

# Review: commitPhase retry rule inverted + double cancel — fixed

## What changed (and why)

Two coupled defects in the commit path, both fixed:

**1. The retry rule was inverted.** `TransactionCoordinator.commitCollection`
(coordinator.ts) is the only place that retries a commit. `transactor.commit` has two
failure modes:
- **Stale** (permanent) — someone committed a newer revision; our identical request can
  never win. Surfaces as a **returned** `{ success:false }`.
- **Transient** (temporary) — unreachable peers, timeout. Surfaces as a **throw**.

The old loop had no try/catch: it retried the returned stale failure 3× (futile) and let
the thrown transient failure escape uncaught (retried 0×). Exactly backwards. Now the
loop retries **only** the `catch` (transient) path and returns immediately on a returned
stale failure, carrying the last transient error into the give-up result.

**2. The transactor auto-cancelled underneath the retry.** `NetworkTransactor.commitBlock`
fired a fire-and-forget `this.cancel(...)` on any tail-commit failure — tearing down the
exact pend the coordinator's retry loop was working against, and double-cancelling since
both real callers already own cancellation (`coordinator.cancelPhase`,
`TransactorSource.transact`). That line is **removed**; a comment now documents that
cancellation is the caller's responsibility. Net effect: a failed pend is cancelled
**exactly once**.

`commit` is now a pure primitive: succeed → `{success:true}`; permanent loss →
`{success:false}`; transient → throw. Retry and cancel policy live in the caller.

## The linchpin contract (review this first)

The whole fix keys off one contract: **`commit` returns `{success:false}` ONLY for
permanent stale losses, and throws for everything transient.** If any commit
implementation ever *returns* a failure for a transient condition, the new policy
misclassifies it as permanent and skips the retry that would have recovered it.

- `NetworkTransactor.commitBlock` (network-transactor.ts:619-635) is the production
  implementation: it returns `{success:false, missing}` for active stale failures and
  `throw tailError` otherwise. Confirm this branching still holds — it is the signal the
  coordinator now depends on.
- Worth a skim: any other `ITransactor` in the tree, to ensure none returns a failure for
  a transient/network error.

## How to validate

Build + full suite (from `packages/db-core`), both green as of this handoff:

```
yarn build 2>&1 | tee /tmp/build.log        # tsc, 0 errors
yarn test  2>&1 | tee /tmp/test.log         # 1168 passing, 0 failing
```

Targeted specs that exercise this change directly:
`vitest`-equivalent via mocha —
`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/coordinator.spec.ts" "test/network-transactor.spec.ts" "test/transactor-source.spec.ts" "test/transaction.spec.ts"`

### Use cases the tests now pin down

- **Returned stale failure → attempted once, no retry.**
  `coordinator.spec.ts` → "partitions committed vs failed and does NOT retry a returned
  stale failure": `commitAttemptsByCollection.get(failing) === 1`, failing collection lands
  in `failedCollections`, siblings in `committedCollections`.
- **Transient (thrown) failure → retried the full 3 attempts.**
  `coordinator.spec.ts` → "retries a transient (thrown) commit failure the full 3 attempts
  before giving up": `=== 3`. `InstrumentedTransactor` gained a 4th constructor arg
  (`throwCommitCollections`) so a thrown commit is distinct from a returned stale one.
- **Full-transaction forward recovery + targeted cancel (stale, no retry).**
  `transaction.spec.ts` → "should do forward recovery and targeted cancel on partial
  commit failure": 1 collection commits durably, the other's stale failure is attempted
  once, only the non-committed collection is cancelled, no orphaned pending. Asserts
  `commitCallCount === 2`.
- **Full-transaction retry-and-succeed (transient/thrown).**
  `transaction.spec.ts` → "should retry and succeed when commit transiently fails": the
  failing collection now **throws** once then succeeds on retry; `commitCallCount === 3`,
  no cancel calls.
- **Failed commit leaves tracker/pending pristine, retry doesn't double-log.**
  `transaction.spec.ts` → "session.commit failure leaves tracker + pending unchanged…":
  `FlakyCommitTransactor(inner, 1)` (was 3) — one stale failure, then the retry succeeds.
- **Reason-only stale commit does not crash** (sibling prereq, still passes):
  `network-transactor.spec.ts` → "does not crash when a commit fails with only a reason".
- **Collection-level sync retry still recovers stale** (unaffected):
  `collection.spec.ts` "bounded sync retry" — `collection.sync()` owns a *separate*
  retry loop that re-pends fresh state each attempt, so retrying stale there is
  productive. Distinct from commitPhase; left as-is.

## Known gaps — where the reviewer should push

- **The auto-cancel removal has no direct NetworkTransactor-layer test.** All
  cancel-count assertions run against `TestTransactor`/`InstrumentedTransactor`, which
  never had the auto-cancel — so "cancel exactly once" is proven at the coordinator layer
  but not at the `NetworkTransactor.commitBlock` layer where the line was actually
  deleted. `network-transactor.spec.ts`'s reason-only test asserts result *shape*, not
  cancel behavior. A test that drives `commitBlock` to a tail failure and counts cancels
  would close this. Consider whether it's worth adding.
- **No end-to-end test drives a real `NetworkTransactor.commit` throw → coordinator
  retry.** The coordinator's retry-on-throw is proven only with fakes. If the production
  throw path ever changes shape (e.g. wraps the error), the fake wouldn't catch it.
- **Concurrency of the retry-count assertions.** `commitPhase` fans out
  `commitCollection` per collection via `Promise.allSettled`; the tests rely on
  `commitCallCount` incrementing deterministically enough across concurrent calls. It held
  across runs here, but if these ever flake, that ordering assumption is the suspect.
- **Prereq merge order.** `txn-network-transactor-commit-cancel-crashes` (Part A) had
  added a `.catch(...)` to the same line this ticket deletes; the line is now gone, so its
  `.catch` is moot — but that ticket's pend-path `cancelBatch` guard and its Part B
  (reason-only `missing` fix, network-transactor.ts:625-631) are untouched and still
  present. `txn-pendphase-leaks-on-pend-throw` (pend-path cancel-on-throw) is
  complementary — together they hold "cancel exactly once per pend" on both the
  pend-failure and commit-failure paths.

## Tripwires

None newly introduced. Pre-existing `NOTE:` comments in the touched files (unbounded
per-collection fan-out in `pendPhase`/`commitPhase`; reason-only `StaleFailure` dropping
its `reason` string in `commitBlock`) are unchanged and out of scope here.
