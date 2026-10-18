description: When a database request goes unanswered and is sent again to another machine, the new copy goes out at once, and on a slow link it lands in the same send queue the first copy is still stuck in. Make the coordinator retry and the read retry round wait first, starting at one declared link round trip and doubling, so a retry stops lengthening the queue that made its predecessor late.
architecture: docs/transactions.md#coordinator-selection-and-network-resilience
files: packages/db-core/src/utility/batch-coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/utility/unref-timer.ts, packages/db-core/test/batch-coordinator.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/readme.md, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/reference-peer/src/cli.ts, docs/transactions.md, .release-notes.pending.md
----

# Coordinator and read retries back off

From Sereus `../sereus/tickets/blocked/optimystic-retries-do-not-back-off.md` (gotchoices/sereus#48), which holds the measurement: on a two-member group over a phone-shaped link (every outbound frame 20 ms behind the one before), retries were 28–48% of the traffic beyond the clean workload. This ticket covers two of the three retries it names; the third (the read-repair consult after a silent one) is `silent-read-repair-consults-back-off`, which builds on the `retryBackoffBaseMs` this ticket adds.

## The problem

A request given up on at a deadline was not lost: its frames are usually still in this node's send queue to that peer. Two retries re-send at once:

- **The coordinator retry** — `processBatches` in `packages/db-core/src/utility/batch-coordinator.ts`. A batch whose `process` throws is re-batched at once onto the next coordinator (`createBatchesForPayload` with the failed peer excluded), until the expiration passes or no coordinator is left. On a two-member cohort the chain is the other member, then this node, and the self-coordinated retry runs a cluster transaction that sends to the same slow member.
- **The read retry round** — the second-chance round in `NetworkTransactor.get` (`get:retry`), one extra round at once against coordinators not yet asked, for every batch that is not authoritative.

## Design

### The base: `LinkDeadlines.retryBackoffBaseMs`

Add `retryBackoffBaseMs` to `LinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts`, resolved in `resolveLinkDeadlines` as exactly the declared `linkRoundTripMs`, and **0 when undeclared** (no floor). A zero base disables every wait in this ticket and in `silent-read-repair-consults-back-off`, which is today's behaviour exactly. That is deliberate and documented: a node that declared no round trip is on the LAN deadlines, where a retry's predecessor is not stuck in a queue. Explicit `rpcDeadlines` do not affect it. Update the derivation comment block (`CONNECTION_ROUND_TRIPS` etc.) with one line for it, the `LinkDeadlines` doc in `packages/db-p2p/src/optimystic-node.ts` (it lists what a `NetworkTransactor` host reads), and the deadlines table in `packages/db-p2p/readme.md` (`| retry backoff base | r, 0 when undeclared | … |`).

db-core cannot import db-p2p, so `NetworkTransactorInit` takes `retryBackoffBaseMs?: number` (default 0) by injection. Every construction site passes the node's value: `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` (from the same `node.linkDeadlines ?? resolveLinkDeadlines()` it already destructures), `packages/reference-peer/src/cli.ts` (`node.linkDeadlines.retryBackoffBaseMs`), and both transactors in `packages/db-p2p/src/testing/mesh-harness.ts` (pass 0 / leave unset unless the harness grows a knob; harness timing must not change).

### The wait rule — one pure function in `batch-coordinator.ts`

```ts
export type RetryBackoff = {
	/** First wait in ms; 0 disables every wait (today's behaviour). */
	baseMs: number;
	/** The peer this transactor runs on, when it runs on one (`NetworkTransactorInit.localPeerId`). */
	localPeerId?: PeerId;
	/** Test seam; default an unref'd `setTimeout` promise (`utility/unref-timer.ts`). */
	sleep?: (ms: number) => Promise<void>;
};

/** How long to wait before sending a retry. */
export function retryWaitMs(backoff: RetryBackoff, retry: {
	/** 1-based: how many coordinators this retry's chain has already tried — the retry batch's `excludedPeers.length`. */
	attempt: number;
	/** The coordinator whose request failed. */
	failedPeer: PeerId;
	/** How long that request was outstanding before it failed, ms. */
	outstandingMs: number;
	/** The coordinators the retry will be sent to. */
	retryPeers: readonly PeerId[];
}): number
```

- `baseMs === 0` → 0.
- Otherwise `baseMs × 2^(attempt − 1)`: one round trip before the first retry of an operation, doubling for each further one. Attempt is read off `excludedPeers`, which already grows by one per hop of the chain (`[batch.peerId, ...batch.excludedPeers]`), so no counter is added.
- **Outstanding floor:** when `retryPeers` contains `failedPeer` (the all-excluded re-pick) or `localPeerId` (this node coordinates the retry, and since the failed peer was picked from the block's cohort, this node's consensus round sends to it), the wait is at least `outstandingMs`. Those are exactly the cases where the retry goes out through this node's own queue to the peer whose request is still in it. A retry to a third coordinator goes over a different connection and takes no floor. A fast failure (connection refused) has a small `outstandingMs` and so a small floor; no error classification is needed, and db-core cannot see db-p2p's timeout error types anyway.

### `processBatches`

Takes an optional trailing `backoff?: RetryBackoff`. In the `.catch` of each batch:

- Record when `process(batch)` was called and, on failure, set `batch.outstandingMs` (new optional field on `CoordinatorBatch`) to the elapsed time — the read retry round reads it.
- After `createBatchesForPayload` returns the retries (so their coordinators are known), compute ONE wait for the retry set: `attempt` = the retries' `excludedPeers.length` (the same for all of them), `retryPeers` = their `peerId`s.
- If `Date.now() + wait >= expiration`, do not retry: log `retry:skipped-budget peer=… waitMs=… remainingMs=…` and rethrow the original error as today. This check runs **before** any timer is armed, which is also what keeps a doubled wait from ever reaching `setTimeout` above its 32-bit limit (the transaction budget is far below it — see `MAX_LINK_ROUND_TRIP_MS`).
- Otherwise log `retry peer=%s excluded=%d waitMs=%d outstandingMs=%d` (extend the existing line; Sereus greps `batch-coordinator retry peer=`), sleep `wait`, and proceed exactly as today (the existing `expiration > Date.now()` re-check, root attachment, `processSet(retries)`).
- **When `wait` is 0, await nothing** — not even `sleep(0)`. A zero wait must not add a macrotask yield, or existing ordering-sensitive specs change behaviour under the default.

### The read retry round in `NetworkTransactor.get`

For each `retryable` batch, after its `createBatchesForPayload` and before `processBatches(retries, …)`:

- A batch with **no valid response** (`!hasValidResponse(b)`: its request threw or timed out) waits `retryWaitMs` with `attempt` = the retries' `excludedPeers.length`, `failedPeer = b.peerId`, `outstandingMs = b.outstandingMs ?? 0`, under the same budget skip.
- A batch that **got a response** that was not authoritative (an entry `unavailable`, `unconfirmedAheadRev`, below its floor, or missing) retries at once. Its predecessor is out of the queue, so waiting would add latency and buy nothing. This is a deliberate narrowing of the Sereus proposal's "wait before each retry"; record it in the comment above the round.
- Pass `backoff` into both `processBatches` calls in `get`, and into the ones in `pend`, `cancel`'s `dischargeCancel` path and the commit sweep — every `processBatches` call in the class. One `RetryBackoff` built in the constructor from `retryBackoffBaseMs` and `localPeerId`.

### Why not elsewhere

- The one-round commit (`commitInOneRound`) does not re-batch a throw (see its doc); it is not a retry site.
- `OwedCancels` already re-sends on its own backoff timer and is untouched.
- `Collection.sync`'s and `TransactionCoordinator`'s retry loops sit above the transactor and retry on a *returned* stale refusal, not on silence; out of scope.

## Edge cases & interactions

- **Zero base is today's behaviour**, including no awaited timer at all — verified by a test (sleep never called) and by the existing suites passing unchanged.
- **Budget**: a wait that would reach the expiration skips the retry and keeps the original error as `batch.request.error` (the existing "first-attempt error wins" rule) — test.
- **Doubling** follows the chain length, not wall clock; two concurrent retry chains under one root each compute their own wait from their own `excludedPeers` — by inspection.
- **Outstanding floor** applies only when the retry set includes the failed peer or this node; `localPeerId` absent (the harness's transactor that runs on no node) leaves only the failed-peer arm — covered by the pure-function test.
- **Retry setup failure** (`findCoordinator` throws, e.g. solo node "self-exhausted"): unchanged; the wait happens after setup, so a setup failure never waits — by inspection.
- **Mixed retry set** (blocks re-batched onto several coordinators): one wait for the set, floor if any member qualifies — by inspection.
- **Timers are unref'd** so a pending wait never holds a process open; db-core is cross-platform (browser, React Native), so use the existing `utility/unref-timer.ts`, not Node's `timers/promises`.
- **Cancel under `abortOrCancelTimeoutMs`**: its budget is shorter (5 s floor); waits there come out of it, and the budget skip keeps a long wait from eating the whole cancel. `dischargeCancel`'s own time-based loop then retries against the deadline as it does today — by inspection.
- **Read latency**: a timed-out read now pays one extra round trip (more on the self/failed-peer re-pick) before the second-chance round. Doubtful-but-answered reads pay nothing extra.

## Tests (only these)

- `packages/db-core/test/batch-coordinator.spec.ts`: one table-driven test of `retryWaitMs` — base 0 → 0; attempt 1 → base; attempt 3 → 4 × base; floor applied when the retry peers include the failed peer, and when they include `localPeerId`; not applied for a third peer.
- Same file, `processBatches` with an injected recording `sleep`: (a) base 0 → `sleep` never called and the retry is sent; (b) base > 0 → `sleep(base)` recorded before the second coordinator's `process`; (c) wait ≥ remaining budget → second `process` never called and the batch's error is the first attempt's.
- `packages/db-core/test/network-transactor.spec.ts`: one test that in the read retry round a batch that threw waits and a batch answered with an `unavailable` entry does not (recording `sleep`, base > 0).

## Docs

- `docs/transactions.md` § Coordinator Selection and Network Resilience (and wherever it describes the per-batch re-pick): the wait rule, the floor, the budget skip, zero-when-undeclared.
- `packages/db-p2p/readme.md` deadlines table row (above).
- One line in `.release-notes.pending.md`.

## TODO

- Add `retryBackoffBaseMs` to `LinkDeadlines` / `resolveLinkDeadlines`; update its comments, `optimystic-node.ts` doc, readme table.
- Add `RetryBackoff`, `retryWaitMs`, `CoordinatorBatch.outstandingMs`; thread `backoff` through `processBatches` with the budget skip and zero-wait fast path.
- `NetworkTransactorInit.retryBackoffBaseMs`; build one `RetryBackoff` in the constructor; pass it to every `processBatches` call; add the no-response-only wait to the `get` retry round.
- Pass the node's value at the collection-factory and reference-peer construction sites; leave the mesh harness at 0.
- Write the three tests above.
- Docs and release-notes line.
- `yarn build`, then `yarn test` in db-core and db-p2p (and quereus-plugin-optimystic, whose suite drives the transactor).
