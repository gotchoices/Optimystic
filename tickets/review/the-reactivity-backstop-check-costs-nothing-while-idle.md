description: Every 20–30 seconds each machine re-checked every table it watches with a separate network request, even when nothing had changed, so an idle phone watching 18 tables sent about 54 requests a minute. The check now reads all watched tables together in one read per tick, so the idle cost no longer grows with the number of tables.
prereq: a-held-block-consult-cap-counts-requests-not-blocks
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch`: `armTick`, `disarmTick`, `tick`, `byReader`, `readGroup`, `checkTail`, `followAnswer`, `readTail`, `acceptedTail`; `CollectionTailQuery`, `CollectionTailAnswer`, `CollectionTailReader`, `committedTailReader`), packages/db-core/src/collection/collection.ts (`readCommittedTails`, `answeredHeader`, `committedTailOf`, `judgedTail`, `entryIn`, `readAttributed`, `readAlone`, `readLogEnds`), packages/db-core/src/collection/struct.ts (`CommittedTail`, `CommittedTailQuery`, `CommittedTailAnswer`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`tailReaders`, `tailReaderFor`, `watchCollectionOverNetwork`), packages/db-p2p/test/reactivity/collection-watch.spec.ts, packages/db-p2p/test/reactivity/topic-bytes-encoding.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/db-core/test/refresh-read-cost.spec.ts, docs/reactivity.md, docs/internals.md
----
# The reactivity backstop check costs one read per tick, not one per collection

GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48). The prereq is in `complete/`.

## What changed

**db-core — `Collection.readCommittedTails(transactor, queries)`.** The batched form of `readCommittedTail`. Answers per collection, `{ tail: { tailId, rev } | undefined }` or `{ error }` (what the single read would have resolved or thrown). One `transactor.get` names every header and every known tail id; collections whose header names a different tail share one second `get`. When a batched `get` throws (`NetworkTransactor.get` throws as a whole when any block has no answer), `readAttributed` reads each block in its own `get`, concurrently, and logs `collection:tails-read-split` once, so only the collections whose blocks failed report an error. The per-block judgement is shared with `readLogEnds` through three new private statics: `answeredHeader` (header absent/answered/throws, plus its served revision — `readLogEnds` now uses it), `checkedLogTail` (unchanged, now also used here), `committedTailOf` (the `{ tailId, rev }` projection, now also used by `readCommittedTail`). New exported types `CommittedTail`, `CommittedTailQuery`, `CommittedTailAnswer` in `collection/struct.ts`; `readCommittedTail`'s return type is now `CommittedTail`.

**db-p2p — the watch service.** `CollectionWatchRequest.readTail` is replaced by `tails: CollectionTailReader` (`readTails(queries) → Map<collectionId, CollectionTailAnswer>`). `committedTailReader(transactor)` is a ready-made reader over `Collection.readCommittedTails` (maps `rev` → `revision`); I added it in db-p2p so the plugin and the integration spec don't each write the same adapter — the ticket had the plugin doing that mapping itself.
- Per-subscription timers are gone; one service timer (`armTick`/`disarmTick`), armed on the first subscription, disarmed when the last closes and on `stop()`. `tickRunning` stops a second timer from being armed when a subscription opens during a running tick; the running tick re-arms when its reads settle.
- `tick()`: queues a renewal on every subscription's queue, groups subscriptions by their first listener's reader (identity), calls `readTails` once per group (concurrently), and queues each answer's apply step (`followAnswer`) on its subscription's queue. It resolves when the reads settle, not the follows.
- Every read, batched or single, takes a stamp from one service counter when issued; `acceptedTail` (the one helper both paths go through) drops an answer stamped below the subscription's `appliedReadStamp`, logs and ignores an `error` or missing entry, and otherwise records `lastTailId` and the stamp.
- Single reads (first read, `reAnchor`, `moveThenRecheck`'s re-read) call `readTails` with one query inside the queue, as before.
- The old `armTick` `NOTE:` is replaced by one at the service timer: the new cost, the past-16-collections chunking tripwire, and that a reader whose read never settles now stops the tick for every collection (bounded today by the transactor's read deadlines). The `enqueue` `NOTE:` is updated to the reader shape.

**Plugin.** `CollectionFactory` keeps `tailReaders: WeakMap<ITransactor, CollectionTailReader>` and passes the same reader to every network watch on that transactor (`tailReaderFor`). The unused `Collection` import was dropped.

**Docs.** docs/reactivity.md §The node's watch service: new code sample, the tick bullet (one timer; re-arms after reads, not follows), a bullet on the stale-answer drop, the reader paragraph, *What a tick costs* (the 18-table / two-member numbers from the ticket), *How long a missed commit can go unseen* (one interval vs two intervals); the jitter wording in §Tail rotation now says each **node's** tick started when its first watch opened. docs/internals.md *A host subscribes through `node.reactivityWatch`* rewritten to match, linking to the reactivity section for cost and bounds.

## Tests added

- `collection-watch.spec.ts` — *collections sharing a reader are read in one call per tick, and a commit only the read sees wakes only its own watchers*: three watches on one fake reader; asserts one timer for the service, three idle ticks give exactly three `readTails` calls each naming all three collections, then raising one collection's revision with no notification wakes only that collection's watchers. The spec's fixture now builds a fake reader (`tailReader`) instead of a `readTail` closure; existing cases unchanged.
- `refresh-read-cost.spec.ts`, new `describe('batched committed-tail read cost')`:
  - three collections whose logs stayed on their blocks → at most one request, each answer equal to its writer's committed revision;
  - two of three collections rolled to a new tail (32 more rows each) → at most two requests, answers name the new tails;
  - one header whose every `get` throws (`OneBlockUnreachableTransactor`) → that collection reports `error`, the other two answer correctly (this exercises the per-block fallback).
- Updated, not new: `topic-bytes-encoding.spec.ts` and the two collection-watch cases in `substrate-real-libp2p.integration.spec.ts` (now `countedTailReader`, wrapping `committedTailReader` to keep their in-flight-read counting).

## Validation run

`yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` clean. db-core `yarn test` 1908 passing; db-p2p `yarn test` 3536 passing / 74 pending; plugin `yarn test` 1063 passing; db-p2p `yarn test:integration` 51 passing (both real-socket collection-watch cases included); plugin `yarn test:integration` 1069 passing. Nothing failed.

## Known gaps, for the reviewer

- **The stale-drop rule has no unit test** — the ticket allowed inspection. Worth reading `acceptedTail` against this order: batch read issued (stamp n), a queued re-read issued later (stamp n+1) applies first, the batch answer's step then runs and must be dropped. A failed read does not advance `appliedReadStamp`, on purpose (nothing was applied).
- **The idle request count on a real two-member strand was not measured.** The "2 requests per tick to the other member" figure in the docs is derived from the 32-blocks-per-consult chunk and two blocks per collection, not observed. Checking it means counting sync-protocol requests on a real mesh, which no spec does.
- **"Several readers on one node", "listeners with different readers", "closed/opened during an in-flight batch", "`readTails` rejecting"** are by inspection only, as the ticket allowed. A rejecting reader is logged once per group in `readGroup` and is no news for every collection in it.
- **The fallback's concurrency.** When a batched `get` throws, `readAttributed` issues one `get` per block at once (two per watched collection). For 18 collections that is 36 concurrent gets, only on failure. Not bounded; I judged that fine at the sizes the docs describe.
- **Duplicate ids in one `readCommittedTails` call** keep the last query's `knownTailId` (`new Map(...)` last-wins). The watch service never sends duplicates.
- `readLogEnds` (the refresh path) still fails as a whole when its known tail is unreachable; its existing `NOTE:` about that is unchanged. Only the watch-service path got the per-block fallback.
