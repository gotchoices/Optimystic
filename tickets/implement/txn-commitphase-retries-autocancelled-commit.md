description: A failed commit is retried in a way that is exactly backwards — it re-tries the permanent failures that can never succeed and gives up on the temporary ones that would, while a lower layer simultaneously tears down the very thing being retried. Fix the retry rule and make cleanup happen once.
prereq: txn-network-transactor-commit-cancel-crashes, txn-pendphase-leaks-on-pend-throw
files:
  - packages/db-core/src/transaction/coordinator.ts (commitCollection retry loop, ~lines 789-796; commitPhase ~707; cancelPhase ~805; coordinateTransaction commit→cancel handoff ~537-552)
  - packages/db-core/src/transactor/network-transactor.ts (commitBlock auto-cancel, ~line 623)
  - packages/db-core/src/transactor/transactor-source.ts (transact self-cancels on failure, ~lines 78-85)
  - packages/db-core/test/coordinator.spec.ts (InstrumentedTransactor.commit ~89; "retries a failing collection 3 times" ~216)
difficulty: medium
----

# commitPhase retries a commit the transactor already auto-cancelled

## What is actually wrong (two coupled defects)

### Defect 1 — the retry rule is inverted

`TransactionCoordinator.commitCollection` (coordinator.ts:789-796) is the only place
that retries a commit:

```js
for (let attempt = 0; attempt < 3; attempt++) {
    const commitResult = await this.transactor.commit(commitRequest);
    if (commitResult.success) {
        return { collectionId, committed: true };
    }
}
return { collectionId, committed: false, error: `Commit failed ... after 3 attempts` };
```

There is **no try/catch**. `NetworkTransactor.commit` has two distinct failure modes
(both surface from `commitBlock`, network-transactor.ts:619-632):

- **Stale failure** — a *permanent* loss (someone else committed a newer rev; our
  request can never win). `commitBlock` **returns** `{ success: false, missing, reason }`.
- **Transient/thrown failure** — peers unreachable, timeout, etc. `commitBlock`
  **throws** (`throw tailError`).

Map that onto the loop:

- Stale (`success:false`, permanent) → loop **retries it 3×**. Re-issuing the identical
  request can never succeed — wasted round-trips against a lost race.
- Transient (thrown) → the throw escapes the loop uncaught, propagates out of
  `commitCollection`, and is swallowed by `Promise.allSettled` in `commitPhase`
  (coordinator.ts:719, 737) as a rejection → **retried 0×**.

So the one class that *should* retry (transient) never does, and the one that *must not*
(permanent stale) is the only one that does. Backwards.

### Defect 2 — the transactor auto-cancels underneath the retry

On any tail-commit failure, `commitBlock` (network-transactor.ts:623) fires a
fire-and-forget cancel of the whole pend:

```js
Promise.resolve().then(() => this.cancel({ blockIds, actionId }));
```

That cancel targets the exact pend the coordinator's retry loop is about to re-commit
against. Every stale "retry" therefore races (or trails) a cancel of its own pend — the
retry is not just futile, it is fighting the cleanup.

And it double-counts. Both real callers of `transactor.commit` already own cancellation:

- `coordinateTransaction` (coordinator.ts:543-549) runs `cancelPhase` after a failed
  `commitPhase` — correctly excluding already-committed collections.
- `TransactorSource.transact` (transactor-source.ts:78-85) calls `this.transactor.cancel`
  itself on both the returned-failure and thrown branches.

So `commitBlock`'s internal cancel is a *third*, untargeted, fire-and-forget cancel on
top of a caller that already cancels. That is the "one layer tears it down while another
retries" — the pend gets cancelled more than once per pend.

## Design: own retry + cancel in one layer each; commit becomes a pure primitive

Make `transactor.commit` a pure attempt: **succeed → `{success:true}`; permanent loss →
return `{success:false}`; transient → throw.** Cancellation is a *policy* decision that
belongs to the caller, which has the full picture (which collections committed, retry
budget) — not to the inner per-block commit.

Concretely:

- **Coordinator owns commit-retry policy.** Retry only thrown/transient errors; return a
  stale `{success:false}` immediately without retrying. `cancelPhase` (already targeted,
  already excludes committed collections) remains the single coordinator-side cancel.
- **`TransactorSource` keeps owning its own cancel** — it already does, on both branches.
- **`NetworkTransactor.commitBlock` stops auto-cancelling.** Remove the fire-and-forget
  `this.cancel(...)` at network-transactor.ts:623. With both callers self-cancelling, the
  pend is then cancelled **exactly once** per failed pend, and never while a retry is
  still in flight.

This is the ticket's "own the retry policy in exactly one layer" realized as removal
rather than suppression — no auto-cancel means nothing to suppress.

### commitCollection, corrected shape

```js
let lastTransientError: string | undefined;
for (let attempt = 0; attempt < 3; attempt++) {
    try {
        const commitResult = await this.transactor.commit(commitRequest);
        if (commitResult.success) {
            return { collectionId, committed: true };
        }
        // Permanent stale failure: the identical request can never succeed, so do not
        // retry. cancelPhase (run by coordinateTransaction on commitPhase failure)
        // releases the pend exactly once.
        return {
            collectionId,
            committed: false,
            error: commitResult.reason ?? `Stale commit for collection ${collectionId}`,
        };
    } catch (e) {
        // Transient/thrown (unreachable peers, timeout): this is the class worth
        // retrying (forward recovery).
        lastTransientError = e instanceof Error ? e.message : String(e);
    }
}
return {
    collectionId,
    committed: false,
    error: `Commit failed for collection ${collectionId} after 3 attempts: ${lastTransientError}`,
};
```

(`StaleFailure.reason` is optional — network/struct.ts:56-64 — hence the fallback string.)

## Coordination with the prereq tickets

Both prereqs touch the same failure region; assume they land first and build on their
result.

- **`txn-network-transactor-commit-cancel-crashes` (was "tx-5").** Its Part A appends a
  `.catch(...)` to the *same* line (network-transactor.ts:623) this ticket **deletes**.
  Once that line is gone, its `.catch` is moot — but that ticket *also* guards the
  pend-path fire-and-forget (`cancelBatch`, ~line 510) and fixes a separate non-null
  `missing!` assertion (Part B, ~line 627), neither of which this ticket touches. Net: we
  remove the commit-path auto-cancel; its pend-path guard and Part B stay. If ordering
  flips, the end state is identical — just delete the line whether or not it has a
  `.catch`. **This is a hint about merge order, not a blocker.**
- **`txn-pendphase-leaks-on-pend-throw` (was "tx-2").** It adds cancel-on-throw to
  `pendPhase`; this ticket removes an auto-cancel in the commit path. Different phases,
  complementary — together they make "cancel exactly once per pend" hold on both the
  pend-failure and commit-failure paths. No file conflict beyond both editing
  coordinator.ts in different methods.

## Test impact — a currently-passing test encodes the bug

`packages/db-core/test/coordinator.spec.ts:216` ("partitions committed vs failed and
retries a failing collection 3 times") asserts
`commitAttemptsByCollection.get(failing) === 3`. Its `InstrumentedTransactor.commit`
(line 89-104) simulates failure by **returning** `{ success: false, reason }` (line 97) —
i.e. a *stale* failure. Under the corrected policy a returned failure is permanent and
must be attempted **once**, not three times. This test asserts the old, inverted
behavior and must change.

The fake also has no way to simulate a *transient* (thrown) failure, so the real retry
path is currently untested. Extend it.

## TODO

- `commitCollection` (coordinator.ts:789-796): wrap the `transactor.commit` call in
  try/catch per the shape above — retry only on `catch` (transient/thrown); on a returned
  `{success:false}` return immediately with `committed:false` and no retry; carry the last
  transient error message into the give-up result.
- `NetworkTransactor.commitBlock` (network-transactor.ts:623): remove the fire-and-forget
  `Promise.resolve().then(() => this.cancel({ blockIds, actionId }))`. Leave the
  stale-vs-throw branching (return `{success:false}` for stale, `throw tailError`
  otherwise) intact — that is exactly the signal `commitCollection` now keys off. Add a
  brief comment noting cancellation is the caller's responsibility (coordinator
  `cancelPhase`; `TransactorSource.transact`).
- `TransactorSource.transact` (transactor-source.ts:64-86): no behavior change needed — it
  already self-cancels on both branches. Confirm it still compiles/reads correctly once
  the inner auto-cancel is gone (it does the right thing; just verify).
- Update `InstrumentedTransactor` (coordinator.spec.ts:89-104): give it a way to force a
  **thrown** (transient) failure distinct from a **returned** stale failure — e.g. a
  second failure-set that throws, or a per-collection mode flag. Keep counting attempts.
- Rewrite/split the coordinator.spec.ts:216 test:
  - Returned stale failure → assert `commitAttemptsByCollection.get(failing) === 1` (no
    retry), still partitioned into `failedCollections`, `committedCollections` = the
    others.
  - New case: transient/thrown failure → assert it is retried the full 3 attempts before
    giving up, and lands in `failedCollections`.
- Optionally add a coordinator-level assertion that a failed `commitPhase` triggers
  `cancelPhase` exactly once for the still-pending collections (guards "cancel exactly
  once per pend").
- Build + test db-core: from `packages/db-core`, run the type check and the coordinator /
  network-transactor specs, streaming output:
  `yarn build 2>&1 | tee /tmp/build.log` then
  `yarn test 2>&1 | tee /tmp/test.log` (or the package's narrower `vitest run test/coordinator.spec.ts test/network-transactor.spec.ts` if available). Verify no
  regression in `network-transactor.spec.ts` from removing the auto-cancel.
