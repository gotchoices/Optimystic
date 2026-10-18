description: When a database request goes unanswered and is sent again to another machine, the new copy now waits first — one declared link round trip, doubling — so it stops lengthening the send queue its predecessor is stuck in.
architecture: docs/transactions.md#a-retry-waits-before-it-is-sent
files: packages/db-core/src/utility/batch-coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/utility/unref-timer.ts, packages/db-core/test/batch-coordinator.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/test/link-deadlines.spec.ts, packages/db-p2p/readme.md, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/reference-peer/src/cli.ts, docs/transactions.md, docs/optimystic.md, .release-notes.pending.md
----

# Coordinator and read retries back off

Source: Sereus `../sereus/tickets/blocked/optimystic-retries-do-not-back-off.md` (gotchoices/sereus#48), which measured retries at 28–48% of a two-member group's extra traffic over a phone-shaped link. The third retry site (the read-repair consult after a silent one) is `silent-read-repair-consults-back-off`, which reads the `retryBackoffBaseMs` added here.

## What landed

Implemented in `ticket(implement): coordinator-and-read-retries-back-off`, with review changes below.

- **Base.** `LinkDeadlines.retryBackoffBaseMs` (`packages/db-p2p/src/rpc-deadline.ts`): exactly the declared `linkRoundTripMs`, 0 when undeclared, no floor, not moved by `rpcDeadlines`. Passed to `NetworkTransactorInit.retryBackoffBaseMs` by `collection-factory.ts` and `reference-peer/src/cli.ts`. The mesh harness stays at base 0.
- **Wait rule.** `retryWaitMs` in `packages/db-core/src/utility/batch-coordinator.ts`: 0 at base ≤ 0; else `base × 2^(attempt − 1)` with `attempt` the retry's excluded-peer count, floored at the failed request's `outstandingMs` when the retry set includes the failed peer or this node. `retryWaitWithinBudget` skips a retry whose wait would reach the expiration (`retry:skipped-budget`). A zero wait awaits nothing.
- **Sites.** `processBatches` (every `NetworkTransactor` round except the one-round commit) and `NetworkTransactor.get`'s second-chance round, where only a batch with no response waits.
- **Read round selection.** The round no longer re-asks a coordinator `processBatches` already re-batched (new `CoordinatorBatch.rebatched`); its retries are judged in its place.

## Review findings

**Read the diff first, then the handoff.** Checked every changed source file, the five `processBatches` call sites, the test changes, and the four docs touched (`docs/transactions.md`, `docs/optimystic.md`, `packages/db-p2p/readme.md`, release notes).

### Found and fixed in this pass

- **Major, fixed inline — the read round still re-asked a coordinator that had already been retried, now after a second wait.** The implementer's `settledBy` change stopped the round re-asking a thrown first coordinator only when its `processBatches` retry answered *authoritatively*. When that retry answered with a doubt (`unavailable`, `unconfirmedAheadRev`, below its floor), the round retried *both* the thrown root (excluding only itself, so usually re-picking the coordinator that just answered) and the retry batch. The root has no valid response, so it waited, and under the outstanding floor that wait is a whole request deadline when the retry goes through this node. Concrete case: a two-member cohort, a floored read, the other member times out, this node answers below the floor: the read waits ~33 s extra at a declared 3 s round trip and asks itself again. The implementer's own test pinned it (`sleeps` `[100, 100]`, the second being the duplicate). Fix: `processBatches` marks a batch it re-batched (`rebatched`, set only once its retries are actually sent), and the round skips marked batches. Retried batches then cover disjoint blocks, so the cross-batch `settled` set was redundant: the round is back to the original per-batch `isAuthoritative` (restoring its `every` short-circuit and the original `get:below-floor` log volume). The behaviour the implementer added is kept: a thrown root whose retry answered is still not re-asked. Applies at base 0 too, where it only removes a duplicate request.
- **Minor, fixed — `processBatches`' `retry` slept before checking it had any retries.** It now returns on an empty retry set before computing a wait, and logs `retry peer=` only for a retry it will send.
- **Tests.** Rewrote the `[100, 100]` test as the reproduction of the defect above (A throws → B answers `unavailable` → C; one sleep, A/B/C each asked once; verified it fails without the fix). Added one test for the round's own wait, which after the fix runs only when `processBatches` could not re-batch the thrown batch (its retry lookup threw): a key network whose first lookup past A fails. Kept the other new tests: the `retryWaitMs` table pins real branching (base 0, doubling, both floor triggers, no floor for a third peer); the three `processBatches` backoff tests pin ordering and the budget skip; the "does not ask again" test now pins the same contract through `rebatched`.
- **Docs.** `docs/transactions.md` § A retry waits before it is sent now describes the `rebatched` rule, that the round's thrown-batch wait runs only when `processBatches` could not re-batch, and that `retry peer=` logs only after the coordinator lookup succeeds (Sereus counts that line). Release note reworded to match.

### Tripwires recorded

- **Outstanding floor can be a large share of the budget** (a dial-deadline failure holds a self-coordinated retry back ~33 s of 132 s at a 3 s round trip). `NOTE:` in `retryWaitMs`, `packages/db-core/src/utility/batch-coordinator.ts`, with a revisit condition (cap at a few round trips).

### Checked, no change

- **`retryBackoffBaseMs` not validated in db-core.** NaN or negative disables the wait, consistent with how the same constructor treats a non-positive `dialTimeoutMs`. `Infinity` would make every retry skip on budget, but the constructor does not validate `timeoutMs` either, and db-p2p's value is validated through `linkRoundTripMs`. Left as is.
- **Read-round guarantees.** An authoritative absent is still final. A below-floor entry still earns the round. The merge ranking is untouched. One change is consistent with the existing rule: an authoritative absent from `processBatches`' retry of a thrown coordinator is now final too, as it is when the first coordinator answers absent.
- **Cancel budget.** Waits in `cancelRound` come out of `abortOrCancelTimeoutMs`, and the budget skip bounds them. Checked by reading the code, as the handoff said. No test, because the rule is the same `retryWaitWithinBudget` already pinned.
- **Resource cleanup.** `unrefDelay` uses the existing unref'd timer helper, so it holds no process open. The waits are not abortable, but every one is bounded by the operation's expiration before it is armed.
- **Error handling.** The original error is still the batch's error when the retry is skipped or its setup throws.
- **Type safety.** Removed the round's `as any`/redundant casts. `allBatches` is already typed.
- **File size.** `network-transactor.ts` is 1700 lines (`wc -l`), which predates this ticket. The diff adds about 30 lines. Not filed.
- **Not covered: a non-zero base on a real mesh.** Every mesh and integration spec runs at base 0, and nothing has re-run Sereus's phone-link measurement. Whether traffic drops as intended is unverified until Sereus measures again.

### Validation

`yarn build` (db-core) and `yarn typecheck` (root) clean. eslint clean on changed files. `yarn lint:docs` clean. `yarn test`: db-core 1902 passing; db-p2p 3474 passing, 73 pending; quereus-plugin-optimystic 1052 passing, 14 pending. `yarn test:integration` was not run.
