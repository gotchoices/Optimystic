description: Every 20–30 seconds each machine re-checks every table it watches with a separate network request, even when nothing has changed, so an idle phone watching 18 tables sends about 54 requests a minute. Check all watched tables together in one read per tick, so the idle cost no longer grows with the number of tables.
prereq: a-held-block-consult-cap-counts-requests-not-blocks
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch`, `armTick`, `tick`, `checkTail`, `readTail`, `CollectionWatchRequest`), packages/db-core/src/collection/collection.ts (`readCommittedTail`, `readLogEnds`, `checkedLogTail`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`watchCollectionOverNetwork`), packages/db-p2p/test/reactivity/collection-watch.spec.ts, packages/db-core/test/refresh-read-cost.spec.ts, docs/reactivity.md, docs/internals.md
----
# The reactivity backstop check costs one read per tick, not one per collection

GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48) (kjeib). Read the issue in full (`gh issue view 48`).

## Today

`ReactivityCollectionWatch` (in `packages/db-p2p/src/reactivity/collection-watch.ts`) keeps one subscription per watched collection, and each subscription arms its own timer (`armTick`) at the renewal cadence — TTL / 3: 30 s Core, 20 s Edge. Each tick renews the subscription's cohort registration and then reads the collection's committed tail (`checkTail` → the watcher's `readTail` → `Collection.readCommittedTail`, one `transactor.get` of the header plus the known tail block).

On a cohort member (every member of a two-machine strand stores everything) that read is answered locally, but the read-repair window (10 s) has always expired by the next tick (20–30 s), so `CoordinatorRepo` starts a background cohort consult for the header and the tail, which is one sync request per peer. The per-read batching of consults (`ConsultRound`) never sees two collections together because each collection's timer issues its own read. Measured in the issue: one ~360 ms sync request per watched collection per tick while idle — about 54 a minute for 18 tables on an edge profile.

## Design

**One node-wide tick, one batched tail read per reader.**

- **A tail reader is a shared object, not a per-watch closure.** `CollectionWatchRequest.readTail` is replaced by `tails: CollectionTailReader`:

  ```ts
  /** One collection a batched tail read names, with the tail block the service's previous read found. */
  export interface CollectionTailQuery {
  	readonly collectionId: string;
  	readonly knownTailId?: BlockId;
  }
  /** One collection's answer: its tail (`undefined` when it has never committed), or why its read failed. */
  export type CollectionTailAnswer =
  	| { readonly tail: CollectionTail | undefined }
  	| { readonly error: unknown };
  /** Reads several collections' committed tails together. Hosts pass ONE reader per transactor to every watch. */
  export interface CollectionTailReader {
  	readTails(queries: ReadonlyArray<CollectionTailQuery>): Promise<ReadonlyMap<string, CollectionTailAnswer>>;
  }
  ```

  A subscription reads through its first listener's reader (as it reads through the first listener's `readTail` today). The service groups subscriptions by reader **identity**, so batching happens exactly when the host shares one reader object; a host that builds a reader per watch still works, one read per collection.

- **db-core supplies the batched reader's body.** Add `Collection.readCommittedTails(transactor, queries: ReadonlyArray<{ id: CollectionId; knownTailId?: BlockId }>)` resolving a per-collection answer of the same shape (tail `{ tailId, rev }`, `undefined`, or an error). It sends one `transactor.get` naming every header and every known tail id (deduplicated). For each collection it judges the header and, when the header still names the known tail, the tail, with the same checks `readLogEnds` makes (`answeredBlock`, `checkedLogTail`) — factor those per-collection steps out of `readLogEnds` so the two readers cannot drift, rather than copying them. Collections whose header names a different tail get a second `transactor.get` naming all of those new tails together. A per-block check that throws (`BlockUnavailableError`, `BlockPossiblyStaleError`) becomes that collection's `error` only.
  - **One unreachable block must not blind the others.** `NetworkTransactor.get` throws as a whole when any requested block gets no answer (the `NOTE:` in `readLogEnds`). When a batched `get` throws, `readCommittedTails` reads each of that batch's blocks in its own `get` and attributes failures per collection. That fallback costs what today's path costs, only on failure; log it once per batch.
  - `readCommittedTail` stays as it is (single collection, its errors thrown); it may delegate to the shared per-collection steps.

- **The plugin shares one reader per transactor.** `CollectionFactory.watchCollectionOverNetwork` builds a `CollectionTailReader` over `Collection.readCommittedTails` once per transactor (a `WeakMap<ITransactor, CollectionTailReader>` on the factory) and passes that same object to every watch, mapping `rev` to `revision`.

- **The service runs one timer.** Replace the per-subscription `armTick`/`cancelTick` with one service-level timer, armed when the first subscription opens and cancelled when the last closes or on `stop()`. Each tick:
  1. Enqueues a renewal on every open subscription's serial queue (renewal cadence unchanged at TTL / 3; a subscription opened mid-interval just renews sooner the first time).
  2. For each reader, issues one `readTails` naming every open subscription that reads through it, each with its current `lastTailId`.
  3. As each read resolves, enqueues on each named subscription's queue a step that applies its answer: drop it if stale (below), set `lastTailId`, `wakeIfNewer`, then `moveThenRecheck` as `checkTail` does today. An `error` answer, or a missing entry, is logged and reads as "no news", as a failed `readTail` does today.
  4. Re-arms after all of the tick's reads have settled — not after the per-subscription follow steps, so one subscription's slow registration walk does not delay every other collection's backstop. Reads of one tick never overlap the next tick's.

- **Per-subscription reads stay, through the same reader.** The first read at `watch()`, a re-anchor (`reAnchor`), and the re-read after a registration lands (`moveThenRecheck`) call `readTails` with a one-element list inside the subscription's queue, as today. They are event-driven, not idle traffic.

- **A tail read older than one already applied is dropped.** The batched read runs outside the subscriptions' queues, so its answer can be overtaken by a per-subscription read issued later (a re-anchor, a rotation follow's re-read). Stamp every read — batched or single — from one service-wide counter when it is issued, record per subscription the stamp of the newest read applied, and drop an answer whose stamp is below it. Without this, a batch answer taken before a rotation could move a registration back to the old tail (the same two-registration cost the `NOTE:` at `reRegister` already accepts, but here it would recur on every rotation).

- **Remove the `NOTE:` in `armTick`** (its tripwire has tripped and this ticket is the remedy), and replace it with one at the service timer stating the new cost and the chunking tripwire below.

## Cost and bound (for the docs)

- **Idle cost.** One `readTails` per reader per tick, which is one `transactor.get` when no tail moved. `NetworkTransactor` splits it per coordinator, so on a node that holds the collections, the read is local plus, once the prereq lands, one consult request per cohort peer per 32 blocks (`MAX_CONSULT_BATCH_BLOCKS`; two blocks per collection). Eighteen tables on a two-member strand: 2 requests per tick to the other member (6 a minute on Edge) instead of 18 (54). A node that holds none of the blocks sends one request per coordinator its blocks map to. Renewals are unchanged and are still one per collection when the registration's primary is another machine — backlog `feat-subscription-renewals-to-one-cohort-member-share-a-request`.
- **Chunking tripwire** (the `NOTE:` at the timer): past 16 watched collections a cohort member's tick consult takes a second request per peer; if hosts watch hundreds of collections, read only the tail blocks on the tick (the old tail's revision and `nextId` move when the log rolls over, so the header is not needed to notice) to halve the blocks.
- **Recovery bound, unchanged by this ticket.** A commit whose notification was lost wakes the watcher on the first tick whose read sees it: within one tick interval (TTL / 3) plus that read's latency, when the read is answered by a machine holding the commit. On a cohort member that missed the commit itself, the tick's read is served from its stale copy and starts the background consult that repairs it; the repair's local change event wakes local storage listeners at once (the Quereus table's own storage subscription), and the watch service's next tick sees it — two intervals for `onChange` alone. State both in docs/reactivity.md.

**Rejected:** skipping a collection's read on a tick after a notification or local apply reached it — it saves nothing when idle, which is the case that matters, and with batching the request count no longer depends on how many collections are in the read. Reading the tick's tail locally without the consult — the consult is what notices a cohort member that missed a commit, and suppressing it would need a new "no consult" flag carried through `ITransactor.get`, `IRepo.get` and the repo protocol, with no meaning on a node that holds none of the blocks. Lengthening the tick — the batched read already removes the per-collection cost, and a longer interval would widen the bound above.

## Edge cases & interactions

- **One collection's header or tail unavailable.** Only that collection reports an error; the others apply. Test (db-core).
- **The whole batched `get` throws.** Per-block fallback inside `readCommittedTails`; the watch service never sees the throw. Covered by the test above if it uses a transactor that throws on a batch naming the bad block. A `readTails` that throws anyway (a host reader's bug) gives every subscription in that group no news for the tick, logged; next tick retries. By inspection.
- **A header naming a new tail.** Second batched `get`; the apply step follows the new tail through `moveThenRecheck`. Test (db-core request count).
- **Stale batch answer after a per-subscription read.** Dropped by stamp. Assert at the seam: unit-test is optional; the rule is small enough to verify by inspection, but keep it in one helper both read paths call.
- **Subscription closed while a batch read is in flight.** Its apply step is skipped by `enqueue`'s closed check. By inspection.
- **Subscription opened while a batch read is in flight.** Not named in that batch; its own first read covers it, and the next tick includes it. By inspection.
- **Listeners of one collection with different readers.** The first listener's reader is used; when it closes, the next listener's. By inspection.
- **Several readers on one node** (two transactors). One `readTails` per reader per tick, issued concurrently. By inspection.
- **Last subscription closes / `stop()`.** The timer is cancelled; no tick fires after `stop()` (today's guarantee). By inspection.
- **Subscription queue stalled.** Unchanged: the `NOTE:` at `enqueue` still applies to everything queued behind a step that never settles, including that subscription's apply steps; other subscriptions are unaffected because the tick no longer waits on any one subscription's queue.
- **Rotation scheduler jitter.** docs/reactivity.md says tick-driven follows need no jitter because "each subscription's tick started when its watch opened". That stays true across machines (each node's timer starts when its first watch opens); reword it to say so.
- **The prereq.** Without `a-held-block-consult-cap-counts-requests-not-blocks`, a batched read naming more than 16 blocks starts consults for only the first 16 every tick and never for the rest.

## Tests

- `packages/db-p2p/test/reactivity/collection-watch.spec.ts`: three watched collections sharing one fake reader, driven by the spec's fake timer through several idle ticks: the reader is called once per tick, naming all three, and never once per collection. Then raise one collection's revision in the fake reader with no notification delivered: the next tick wakes that collection's watchers and no other's. (Update the spec's existing `readTail` fakes to the reader shape.)
- `packages/db-core/test/refresh-read-cost.spec.ts`: `readCommittedTails` over several collections whose known tails are current costs one request; with one collection's header naming a new tail, two; with one collection's header unretrievable (the transactor throws on a batch naming it), the others still answer and only that collection reports an error.

## TODO

- db-core: factor `readLogEnds`'s per-collection header/tail judgement into a shared helper; add `Collection.readCommittedTails` with the batched gets and per-block fallback; export the query/answer types.
- db-p2p: add `CollectionTailQuery`, `CollectionTailAnswer`, `CollectionTailReader`; replace `CollectionWatchRequest.readTail` with `tails`; replace per-subscription timers with the service timer; route single reads through the reader; add read stamps and the stale-drop rule; replace the `armTick` `NOTE:`.
- plugin: one reader per transactor in `CollectionFactory`, passed to every watch.
- Tests above; build and run db-core, db-p2p and quereus-plugin-optimystic tests (`yarn build` first — the test guard refuses a stale build). Run the reactivity integration specs too (`yarn test:integration` from root) since they drive the real watch service over sockets.
- Docs: docs/reactivity.md §The node's watch service (*The tick* bullet: one timer, one read per reader, the cost and both bounds; the jitter wording in §Tail rotation), docs/internals.md *A host subscribes through `node.reactivityWatch`* (replace "one tail read per watched collection per tick"); `yarn lint:docs`.
