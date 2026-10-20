description: When a machine checks several blocks with the other members of its group in one read, it sends one request per block to each member. Ask each member about all of that read's blocks in a single request instead, so a read of a table's header and log tail costs one request per member rather than two.
prereq: a-cohort-consult-sends-bytes-only-when-the-peer-is-ahead
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/consult-round.ts (new), packages/db-p2p/src/repo/coordinator-repo.ts (`get`, `readRepairBlock`, `startHeldBlockConsult`, `runHeldBlockConsult`, `fetchBlockFromCluster`, `queryClusterForLatest`, `CoordinatorRepoComponents`), packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/storage/block-archive.ts (`serveConsultAnswer`), packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, `coordinatorRepoFactory` components), packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/consult-round.spec.ts (new), packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/transactions.md, docs/internals.md
----

# A cohort consult asks each peer about all its blocks at once

GitHub [#29](https://github.com/gotchoices/Optimystic/issues/29) question 3 and [#43](https://github.com/gotchoices/Optimystic/issues/43) arm 1 (split out of plan ticket `feat-a-cohort-consult-batches-blocks-per-peer`). Builds on the wire shape of `a-cohort-consult-sends-bytes-only-when-the-peer-is-ahead` (`SyncRequest.held`, `SyncResponse.answers`, `serveConsultAnswer`).

## Today

`CoordinatorRepo.get` runs one `readRepairBlock` per block, concurrently (`Promise.all`). Each that consults — blocking, or in the background via `startHeldBlockConsult` — calls `fetchBlockFromCluster`, which runs `findCluster` for its block and then `queryClusterForLatest`, which calls `clusterLatestCallback(peer, block, …)` once per cohort peer. So a read naming k blocks costs k `sync` requests to each peer. `Collection.readLogEnds` reads the header and log tail in one request, so every idle refresh that consults costs two requests per peer where one would do. #43 counts `sync` requests per minute between two idle machines, and on phones the count is the cost.

`docs/transactions.md` § Lazy read-repair window says batching "would save streams but not time once the consults run together, and is not done". This ticket does it, for the request count.

## Design

### The round: a barrier per `get`, not a timer

The per-block passes stay exactly as they are — independent, each with its own exits, verdicts and memo updates. What changes is how a pass's per-peer question is sent. Each `get` opens a **consult round** that every pass started by that `get` joins; a pass registers its (peer, block) questions with its seat instead of sending them; once every seat has either registered its questions or left without asking, the round sends ONE request per peer naming every block registered for it, and settles each (peer, block) question from that answer.

A barrier rather than a coalescing timer, because the passes reach their questions after an asynchronous `findCluster` that reads the peerStore (possibly a persisted datastore), so no fixed tick is guaranteed to catch them all, and a timer adds latency to every single-block read. The barrier adds none: a round with one seat sends as soon as that seat registers.

New file `packages/db-p2p/src/repo/consult-round.ts`:

```ts
/** One peer's answers for the blocks it was asked about: a claim, or `undefined` for "holds
 *  nothing". A block absent from the map was not answered (the peer is on an older build and
 *  answered only the first block, or answered malformed) — see `ConsultBatchAnswer.unbatched`. */
export interface ConsultBatchAnswer {
	answers: ReadonlyMap<BlockId, ClusterLatestAnswer | undefined>;
	/** True when the peer answered in the original single-block form (an older build): only the
	 *  first block was answered and the rest must be asked one at a time. */
	unbatched?: boolean;
}

/** Ask one peer about several blocks in one request. Rejects on silence, like ClusterLatestCallback. */
export type ClusterLatestBatchCallback = (
	peerId: PeerId,
	asks: ReadonlyArray<{ blockId: BlockId; held?: ActionRev }>,
	context?: ActionContext
) => Promise<ConsultBatchAnswer>;

export class ConsultRound {
	constructor(deps: { batch: ClusterLatestBatchCallback; single: ClusterLatestCallback; selfId?: string; context?: ActionContext; log: Logger });
	/** A pass that will (or may) consult joins synchronously, before its first await. */
	join(): ConsultSeat;
	/** No more seats will join; the round may send once every seat is ready. */
	close(): void;
}

export interface ConsultSeat {
	/** Register one question; the promise settles when the round sends. Three-way contract per question. */
	ask(peerId: string, blockId: BlockId, held?: ActionRev): Promise<ClusterLatestAnswer | undefined>;
	/** This seat has registered everything it will ask. Idempotent; call from `finally` too. */
	ready(): void;
}
```

Rules the round enforces:

- **Sends** when `close()` has been called and every joined seat is ready. Per peer it sends `batch` with that peer's asks in registration order, split into chunks of at most `MAX_CONSULT_BATCH_BLOCKS` (new, in `packages/db-p2p/src/protocol-limits.ts`; 32 — a `get` rarely names more than a handful, and 32 ids plus held revisions is a few KB against the 1 MiB request cap).
- **Self** questions go through `single` (the existing short-circuit to local storage), never `batch`.
- **Silence**: `batch` rejecting rejects every question in that chunk — the peer was silent for each of them. A block missing from `answers` without `unbatched` rejects that one question (a malformed answer is silence, never "holds nothing").
- **An older peer** (`unbatched`): the first block's answer settles its question; each remaining block is asked through `single`, in parallel, at once. This costs that peer the same request count it costs today, plus one round trip of latency for blocks after the first.
- A question registered on a seat after `ready()`, or on a round that already sent, is a programming error: throw.

### Wiring it into `CoordinatorRepo`

- New optional component `clusterLatestBatchCallback?: ClusterLatestBatchCallback` on `CoordinatorRepoComponents`, passed through the factory like `clusterLatestCallback`. Absent → no round, every pass calls `clusterLatestCallback` directly, exactly as today (every existing spec double keeps working).
- `get`: when the batch callback is present and the consult block runs, open a round, pass it to each `readRepairBlock`, and call `round.close()` immediately after the `blockIds.map(...)` that starts the passes — every pass has made its join decision by then, because everything in `readRepairBlock` before its first `await` is synchronous (state that invariant in a comment at the join site; it is what makes the barrier sound).
- `readRepairBlock` joins a seat exactly where it decides to consult: on the blocking path just before `fetchBlockFromCluster`, and on the background path only when `startHeldBlockConsult` actually starts a pass (not when one is already in flight for the block or the cap is reached). The pass leaves the seat (`ready()`) in a `finally`, so every exit of `fetchBlockFromCluster` that asks nobody — the empty cohort, the solo-self exit, a thrown `findCluster` — releases the barrier.
- `queryClusterForLatest` registers its per-peer questions through the seat when it has one (keeping the asker stand-in exclusion and the existing `withDeadline(cohortQueryTimeoutMs)` around each question), then calls `seat.ready()` before awaiting `Promise.allSettled`. Without a seat it calls `clusterLatestCallback` as today. Keep both paths in one place — a small `askPeer` closure chosen once — rather than two copies of the loop.
- The per-question deadline still starts when the question is registered, not when the round sends. The difference is the other seats' `findCluster` time, which is local. Add a tripwire `NOTE:` at the registration: one seat's slow `findCluster` (the bounded bootstrap-contact wait, `bootstrapContactImminent` in `packages/db-p2p/src/libp2p-key-network.ts`) eats into every other seat's deadline in the round; if consults in a round ever time out together right after start, start the deadline at send instead.

### Wire (`packages/db-p2p/src/sync/protocol.ts`)

```ts
export interface SyncRequest {
	/** The first (or only) block asked. With `blockIds`, MUST equal `blockIds[0]`, so an older
	 *  server — which reads only this field — answers the first block. */
	blockId: BlockId;
	/** Every block asked, in order, `blockId` first. Requires `held` (possibly empty). */
	blockIds?: BlockId[];
	held?: Record<BlockId, ActionRev>;
	// …
}
export type SyncContentOmitted = 'held' | 'size';
```

`'size'`: the server left this block's bytes out to keep the response under its content budget. Unlike `'held'`, the peer may be AHEAD of the asker, so the asking callback returns such a block's claim **without** the archive — leaving that peer out of `ConsultedArchives`, so an acquisition that follows asks it again for the bytes. This is the case the previous ticket's comment at the archive attach site anticipates; update that comment to cover both.

No protocol version bump, for the same reason as the previous ticket: an older server answers `{ success, archive }` for `blockId` alone, which the asker recognises (no `answers`) and reports as `unbatched`. Nothing is lost silently, so this needs none of the capability advertisement `tickets/blocked/a-transaction-pends-and-commits-its-collections-together.md` recommends for writes.

### Serving (`SyncService`)

For a request with `blockIds`: answer the first `MAX_CONSULT_BATCH_BLOCKS` distinct ids (ignore the rest — an honest asker never sends more, and a block left unanswered reads as silence to it) with `serveConsultAnswer`, sequentially or with bounded concurrency, each caught on its own (a serve fault for one block is `{}` for that block, logged, never a failure of the response).

**Content budget**: a response may carry several archives with bytes, and `SyncClient.requestBlock` reads it under `MAX_BLOCK_MESSAGE_BYTES` (8 MiB). Keep a running total of the JSON-encoded size of archives that carry bytes; include a block's bytes when it is the first one carrying bytes (so a single block behaves exactly as today) or when the total stays within `CONSULT_RESPONSE_CONTENT_BUDGET_BYTES` (new, in `protocol-limits.ts`: half of `MAX_BLOCK_MESSAGE_BYTES`, leaving room for claims, proofs and framing); otherwise serve it as the claim-and-proof shape with `contentOmitted: 'size'`. Encoding each archive once to measure it is an accepted cost: bytes are sent only when the peer is ahead, which is rare on a settled cohort.

### `libp2p-node-base.ts`

Add `clusterLatestBatchCallback` beside `clusterLatestCallback`, sending `{ blockId: asks[0].blockId, blockIds, held, rev: undefined }` under the same `withinRequestBudget(…, cohortQueryTimeoutMs, …)` and projecting each answer the way the single callback does (share the projection: one function from `SyncBlockAnswer` to `ClusterLatestAnswer | undefined`, used by both). Self is never passed to it (the round routes self to `single`). Pass it to `coordinatorRepoFactory`.

The mesh harness gets a batch callback too, serving each block through `serveConsultAnswer`, honoring `silentPeers` per peer, and counting requests per peer, so the coordinator-level test below can run on it. Leave the harness's single callback as is.

## Edge cases & interactions

- **One block per read** (the common case): a round of one seat, one chunk of one block — sends as soon as the seat registers. Same request count as today, now in the batch form. Covered by the existing read-repair specs once the harness supplies the batch callback.
- **Blocks with different cohorts**: each peer is asked only about the blocks it was registered for. Round test.
- **A seat that consults nobody** (solo-self, empty cohort, throw, asker stand-in covering the only peer): leaves via `finally`; the round still sends for the others. Round test.
- **A peer silent for the whole chunk**: every block in it reads that peer as silent — the fail-closed rule each block already applies. Round test.
- **Older peer**: first block answered, the rest asked singly. Round test.
- **Malformed answer** (`answers` lacks a block): only that block's question rejects. Round test.
- **Background and blocking passes in one `get`** share the round, so a read that finds one block missing and one held-but-expired sends one request per peer, and the blocking pass waits only on that request. By inspection; note that a held block's background question may therefore ride in the same request a missing block's blocking question waits on — no extra latency, because the request was going out anyway.
- **A background pass not started** (already in flight for the block, or `MAX_HELD_BLOCK_CONSULTS` reached) joins nothing. By inspection.
- **Concurrent `get`s** each open their own round; there is no coalescing across reads. Deliberate: a cross-read coalescer needs a timer, and the barrier keeps single-block reads at zero added latency.
- **Size budget**: a block whose bytes would push the response past the budget is served `'size'` and its claim reaches the asker without an archive; an acquisition then fetches it through `fetchArchiveFromPeer` as before. Serving test.
- **`MAX_CONSULT_BATCH_BLOCKS`**: the round chunks; the server ignores ids past the cap. By inspection plus one round-test case with cap + 1 blocks for one peer (two sends).
- **The three-way contract** (`ClusterLatestCallback` doc in `coordinator-repo.ts`): unchanged per (peer, block). Restate it on `ClusterLatestBatchCallback`.
- **Deadlines**: unchanged per question; the batch request runs under the same `withinRequestBudget`, so the coordinator's deadline and the stream teardown still fire together.
- **Freshness, memo, holds**: untouched — every per-block decision after the answers arrive is the code that runs today.

## Tests

- `packages/db-p2p/test/consult-round.spec.ts` (new), against fake `batch` / `single` functions: two seats asking one peer about two blocks → one `batch` call with both; a seat that leaves without asking does not block the send; batch rejection → both questions reject; a block missing from `answers` → only it rejects; `unbatched` → the remaining blocks go through `single`; self goes through `single`; cap + 1 blocks → two `batch` calls.
- `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts`: one case — a two-block `get` of blocks missing on a mesh node sends one `sync` request per peer (the harness's per-peer count), not two.
- The serving-side budget: one case in the spec that covers `serveConsultAnswer` (`block-archive-proof.spec.ts`, or wherever the previous ticket put it) driving `SyncService`'s batch handler — or a small exported pure helper for the budget decision if that is simpler to test — asserting the second large block comes back `'size'` with its proof.

## TODO

- Add `MAX_CONSULT_BATCH_BLOCKS` and `CONSULT_RESPONSE_CONTENT_BUDGET_BYTES` to `packages/db-p2p/src/protocol-limits.ts`.
- Extend `SyncRequest` (`blockIds`) and `SyncContentOmitted` (`'size'`) in `packages/db-p2p/src/sync/protocol.ts`.
- `SyncService`: the batch branch with the cap, per-block catch and content budget.
- Write `packages/db-p2p/src/repo/consult-round.ts` (`ConsultRound`, `ConsultSeat`, `ClusterLatestBatchCallback`, `ConsultBatchAnswer`).
- `CoordinatorRepo`: the component, the round in `get`, seat join/leave in `readRepairBlock` / `startHeldBlockConsult` / `runHeldBlockConsult`, `askPeer` in `queryClusterForLatest`, the deadline `NOTE:`.
- `libp2p-node-base.ts`: `clusterLatestBatchCallback`, the shared answer projection, the `'size'` handling at the archive attach site, the factory wiring.
- Mesh harness: batch callback with per-peer request counts.
- Tests above; run `yarn workspace @optimystic/db-p2p test` and `yarn test:integration` from root.
- Docs: `docs/transactions.md` § Lazy read-repair window — replace "Batching a read's blocks into one request per peer … is not done" with what is done now (one request per peer per read, older peers asked one block at a time, the size budget); `docs/internals.md` — the *Quereus vtab read path* paragraph ("one cohort consult per block per window") gains "batched per peer within one read". Run `yarn lint:docs`.
