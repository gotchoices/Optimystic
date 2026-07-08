description: A failed transaction commit was retried backwards — hammering permanent failures that can never succeed while giving up on temporary ones that would, all while a lower layer tore down the very thing being retried. This fixed the retry rule and made cleanup happen once. Reviewed and confirmed correct.
files:
  - packages/db-core/src/transaction/coordinator.ts (commitCollection retry loop, lines 865-887)
  - packages/db-core/src/transactor/network-transactor.ts (commitBlock, lines 619-638 — auto-cancel removed)
  - packages/db-core/src/transactor/transactor-source.ts (transact — self-cancels on both branches)
  - packages/db-core/test/coordinator.spec.ts (InstrumentedTransactor throwCommitCollections; split commit-retry tests)
  - packages/db-core/test/transaction.spec.ts (2PC tests recalibrated)
----

# Complete: commitPhase retry rule inverted + double cancel — fixed & reviewed

## Summary of the change

Two coupled defects in the commit path, both fixed by the implement stage:

1. **Retry rule was inverted.** `TransactionCoordinator.commitCollection` retried the
   *returned* stale failure (permanent — someone committed a newer rev, our identical
   request can never win) 3× while letting the *thrown* transient failure (unreachable
   peers, timeout) escape uncaught (0 retries). The loop now wraps the attempt in
   try/catch: retries **only** the transient `catch` path, and returns immediately on a
   returned `{success:false}`, carrying the last transient error into the give-up result.

2. **Transactor auto-cancelled underneath the retry.** `NetworkTransactor.commitBlock`
   fired a fire-and-forget `this.cancel(...)` on any tail-commit failure — tearing down
   the pend the coordinator's retry loop was working against, and double-cancelling since
   both real callers already own cancellation. That line was removed; a comment documents
   that cancellation is the caller's responsibility. A failed pend is now cancelled
   **exactly once**.

`commit` is now a pure primitive: succeed → `{success:true}`; permanent loss →
`{success:false}`; transient → throw. Retry and cancel policy live in the caller.

## Review findings

Adversarial pass over commit `d8e67e2`. What was checked, found, and done:

- **Retry inversion (correctness) — CONFIRMED correct.** `coordinator.ts:871-887`: the
  loop retries only the `catch` (transient) path and returns immediately on a returned
  stale `{success:false}`. Matches the intended policy. The `commitCollection` JSDoc
  ("retrying transient failures up to three times") is now accurate.

- **Double-cancel removal (correctness) — CONFIRMED safe.** Enumerated every caller of
  `ITransactor.commit` in `packages/db-core/src`. Only two production callers exist:
  `commitCollection` (whose failure triggers `coordinateTransaction` → `cancelPhase`,
  which excludes already-committed collections) and `TransactorSource.transact` (self-
  cancels on both the returned-failure and thrown branches, lines 78-85). Neither relied
  on the removed self-cancel. `commitBlock` is only reached from `NetworkTransactor.commit`.
  No path leaks a pend from the deletion.

- **Linchpin contract (correctness) — CONFIRMED.** The policy keys off "commit returns
  `{success:false}` ONLY for permanent stale, throws for everything transient."
  `network-transactor.ts:621-635`: a non-success *response* (`isResponse && !success`,
  including reason-only stale) is collected as `stale` and returned as
  `{missing, success:false}`; errors/timeouts (batch `isError`, or the `commitBlocks`
  catch) are *not* in `stale`, so `throw tailError` fires. Every other `ITransactor` in
  the tree (`TestTransactor`, `FlakyCommitTransactor`, `SelectiveCommitFailTransactor`,
  `PartialCommitTransactor`, reference-peer `LocalTransactor`) is in-memory or local —
  no transient network class, none returns-for-transient. The contract holds.

- **Test coverage — adequate, one documented gap.** Coordinator layer pins both classes
  (stale → 1 attempt; thrown → 3 attempts) via the new `throwCommitCollections` ctor arg;
  `transaction.spec.ts` pins full-transaction forward-recovery-and-targeted-cancel (stale,
  `commitCallCount === 2`) and retry-and-succeed (thrown, `commitCallCount === 3`, no
  cancels). **Gap:** the auto-cancel *removal* itself has no direct `NetworkTransactor.
  commitBlock`-layer test — cancel-once is proven at both caller sites, not at the deleted
  line. Judged **minor, no ticket**: the change is a deletion of a fire-and-forget cancel,
  the "caller owns cancel" behavior is covered at both call sites, and the linchpin
  contract is guarded by the in-code comment at `network-transactor.ts:622-625`. A heavy
  NetworkTransactor mock-repo harness for marginal defense-in-depth is not warranted.

- **Docs — checked, no update needed.** `docs/transactions.md:1012-1034` has a
  `commitPhase` pseudocode block, but it is a simplified illustrative snapshot that never
  modeled the retry loop, partition, or forward recovery, and its signatures already
  diverge from the implementation (`commitPhase(transaction, criticalBlocks)` vs the real
  `commitPhase(actionId, criticalBlockIds, pendedBlockIds)`). This change does not make it
  more stale. The honest-reporting callout (`transactions.md:59-74`) concerns session-level
  retry, unaffected. Syncing the illustrative pseudocode is a separate, broader effort —
  out of scope here.

- **Build + tests — green.** From `packages/db-core`: `yarn build` (tsc) 0 errors;
  `yarn test` 1168 passing, 0 failing. Targeted specs (`coordinator.spec.ts`,
  `transaction.spec.ts`, `network-transactor.spec.ts`, `transactor-source.spec.ts`) all
  pass within that run.

- **Tripwires — none newly introduced.** Pre-existing `NOTE:` comments in the touched
  files (unbounded per-collection fan-out in `pendPhase`/`commitPhase`; reason-only
  `StaleFailure` dropping its `reason` in `commitBlock`, `network-transactor.ts:629-632`)
  are unchanged and out of scope. Considered but rejected as tripwire-worthy: the retry
  loop has no inter-attempt backoff — but this is unchanged from the pre-fix loop (which
  also retried 3× immediately) and `commitBlocks` already carries its own expiration/
  timeout, so there is no regression to flag.

- **Empty categories:** No **major** findings (nothing needing a new fix/plan/backlog
  ticket). No **inline fixes** required — the implementation is correct as landed. No new
  tripwires.

## Prereq / neighbor context

- `txn-network-transactor-commit-cancel-crashes` (Part A) had added a `.catch(...)` to the
  same line this ticket deletes; the line is gone, so its `.catch` is moot — but that
  ticket's pend-path `cancelBatch` guard and its Part B (reason-only `missing` fix,
  `network-transactor.ts:629-633`) are untouched and still present.
- `txn-pendphase-leaks-on-pend-throw` (pend-path cancel-on-throw) is complementary —
  together they hold "cancel exactly once per pend" on both the pend-failure and
  commit-failure paths.
