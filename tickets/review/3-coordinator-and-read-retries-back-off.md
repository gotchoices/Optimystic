description: When a database request goes unanswered and is sent again to another machine, the new copy now waits first — one declared link round trip, doubling — so it stops lengthening the send queue its predecessor is stuck in. Review the wait rule, where it applies, and one extra change to the read retry round.
architecture: docs/transactions.md#a-retry-waits-before-it-is-sent
files: packages/db-core/src/utility/batch-coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/utility/unref-timer.ts, packages/db-core/test/batch-coordinator.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/test/link-deadlines.spec.ts, packages/db-p2p/readme.md, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/reference-peer/src/cli.ts, docs/transactions.md, docs/optimystic.md, .release-notes.pending.md
----

# Coordinator and read retries back off — review handoff

Source: Sereus `../sereus/tickets/blocked/optimystic-retries-do-not-back-off.md` (gotchoices/sereus#48). It measured retries at 28–48% of a two-member group's extra traffic over a phone-shaped link. This ticket covers the coordinator retry and the read retry round; the third retry (the read-repair consult after a silent one) is `silent-read-repair-consults-back-off`, which reads the `retryBackoffBaseMs` added here.

## What was built

**The base.** `LinkDeadlines.retryBackoffBaseMs` in `packages/db-p2p/src/rpc-deadline.ts`: exactly the declared `linkRoundTripMs`, 0 when undeclared, with no floor, and not moved by `rpcDeadlines`. db-core takes it by injection as `NetworkTransactorInit.retryBackoffBaseMs` (default 0). Passed at `collection-factory.ts` and `reference-peer/src/cli.ts`. The mesh harness is untouched, so its transactors run at base 0 and its timing does not change.

**The wait rule.** `retryWaitMs` in `packages/db-core/src/utility/batch-coordinator.ts`: 0 when the base is not above 0; otherwise `base × 2^(attempt − 1)`, where `attempt` is the retry batch's excluded-peer count. When the retry set includes the failed peer or `localPeerId`, the wait is at least the failed request's `outstandingMs`. `retryWaitWithinBudget` returns `undefined` (logged `retry:skipped-budget peer=… waitMs=… remainingMs=…`) when a positive wait would reach the expiration, before any timer is armed. A zero wait is returned as is, and callers await nothing for it (no `sleep(0)`), so base 0 is today's behaviour exactly. The default sleep is `unrefDelay`, new in `utility/unref-timer.ts` (it is exported from the db-core index through the existing `export *`).

**`processBatches`.** Takes an optional trailing `backoff`. The retry logic moved into an inner `retry` function: record `batch.outstandingMs` (new optional field on `CoordinatorBatch`) on failure, build the retry batches, compute one wait for the set, skip or log `retry peer=%s excluded=%d waitMs=%d outstandingMs=%d`, sleep, then the existing expiration re-check and `processSet`. The `retry peer=` line now logs after the coordinator lookup rather than before, so a retry whose lookup throws logs only `retry:setup-failed`. Sereus counts `batch-coordinator retry peer=`; that count now leaves out retries that never got a coordinator.

**`NetworkTransactor`.** One `RetryBackoff` is built in the constructor from `retryBackoffBaseMs`, `localPeerId` and the `retrySleep` test seam. It is passed to all five `processBatches` calls (both in `get`, `pend`, `commitBlocks` for the tail and sweep rounds, and `cancelRound`). In `get`'s second-chance round, a batch with no valid response waits (`waitedForReadRetry`, logs `get:retry-wait`) under the same budget skip. A batch that answered but was not authoritative retries at once. The comment above the round records this narrowing.

## A change beyond the ticket: the read retry round no longer re-asks settled blocks

Before, the second-chance round retried every batch in the tree that was not authoritative. A first coordinator that threw was therefore asked about twice more: once by `processBatches`' own retry, and again by the round, even when that retry had already answered authoritatively. That used to cost one redundant request. With this ticket it would also have cost a second full wait. Under the outstanding floor that is a whole per-request deadline. On a two-member cohort where the other member timed out and this node coordinated the retry, it would have roughly doubled the read's latency. So the round now picks batches by block: `settledBy` lists the blocks a batch answered authoritatively, and a batch is retried only if one of its blocks is settled by no batch at all. A batch that is itself authoritative is never retried, as before. Each entry's below-floor check now runs once per batch for every block, where `every` used to stop at the first failing entry, so `get:below-floor` can log a few more lines on a multi-block batch. Please check this against the round's existing guarantees, especially "an authoritative absent is final" and the below-floor merge. I believe they are unchanged.

## Tests added (each beside what it pins)

- `packages/db-core/test/batch-coordinator.spec.ts`, `batch-coordinator.retryWaitMs`: a table of six cases. Base 0 waits nothing even where the floor would apply; attempt 1 waits the base; attempt 3 waits four bases; the floor applies when the retry re-picks the failed peer and when it includes `localPeerId`; a third peer takes no floor.
- Same file, `processBatches (retry backoff)`, with a recording `sleep`: base 0 never sleeps and still sends the retry; base 200 records `sleep:200` between the two coordinators' `process` calls; a wait that would reach the expiration sends no retry and keeps the first attempt's error.
- `packages/db-core/test/network-transactor.spec.ts`, under `get retry accounting`:
  - "a batch that threw waits and one answered unavailable does not": the sleeps are exactly `[100, 100]`, one from `processBatches` and one from the round's retry of the thrown batch. If the batch that answered `unavailable` had waited, its chain of two tried coordinators would have added a 200.
  - "does not ask again … about blocks a retried coordinator already settled": pins the change above. One sleep, and peer B is asked once.
- `packages/db-p2p/test/link-deadlines.spec.ts`: updated for the new field. Undeclared gives 0; 100 ms gives 100 with every other deadline unchanged (that case is renamed); 3000 gives 3000. The existing explicit-`rpcDeadlines` cases spread the derived result, so they already pin that `rpcDeadlines` does not move it.

## Validation run

`yarn build` and `yarn typecheck` (all workspaces) clean; eslint clean on the changed files; `yarn lint:docs` clean. `yarn test`: db-core 1901 passing; db-p2p 3474 passing, 73 pending; quereus-plugin-optimystic 1052 passing, 14 pending; reference-peer 6 passing. Integration specs (`yarn test:integration`) were not run.

## Known gaps and things to look at

- **Only unit tests cover a non-zero base.** Every mesh and integration spec runs at base 0, and nothing re-ran Sereus's phone-link measurement. Whether the traffic drops as intended is unverified until Sereus re-measures.
- **The outstanding floor can be large.** A failure at a full per-request deadline has `outstandingMs` close to that deadline. On a declared 3 s round trip the RPC dial deadline is 33 s, so a self-coordinated retry after a dial timeout waits about 33 s of a 132 s transaction budget. The budget skip stops it from exceeding the budget, not from using a large share of it. This is the ticket's intended rule; a reviewer may want a tripwire `NOTE:` at `retryWaitMs` if that share seems too high.
- **`retryBackoffBaseMs` is not validated in db-core.** A value that is not above 0 (NaN or negative included) disables the wait silently. db-p2p's value is already validated through `linkRoundTripMs`.
- **Cancel budget.** Waits inside `cancelRound` come out of `abortOrCancelTimeoutMs` (5 s floor). The budget skip keeps a long wait from consuming a whole round; `dischargeCancel`'s own time-based loop then retries as before. This was checked by reading the code, not by a test.
- Two documentation additions beyond the ticket's list: `docs/optimystic.md`'s `NetworkTransactor` example now passes `retryBackoffBaseMs`, and `packages/db-p2p/readme.md`'s "a host that dials through the node" sentence names it.
