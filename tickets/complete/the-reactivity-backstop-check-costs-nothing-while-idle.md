description: Every 20–30 seconds each machine re-checked every table it watches with a separate network request, even when nothing had changed, so an idle phone watching 18 tables sent about 54 requests a minute. The check now reads all watched tables together in one read per tick, so the idle cost no longer grows with the number of tables.
prereq: a-held-block-consult-cap-counts-requests-not-blocks
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/reactivity/collection-watch.spec.ts, packages/db-core/test/refresh-read-cost.spec.ts, packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts, docs/reactivity.md, docs/internals.md
----
# The reactivity backstop check costs one read per tick, not one per collection

GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48). Landed in `ticket(implement): the-reactivity-backstop-check-costs-nothing-while-idle`, with the review fixes below.

## What shipped

- **db-core** — `Collection.readCommittedTails(transactor, queries)`: the batched form of `readCommittedTail`, answering per collection `{ tail }` or `{ error }`. One `transactor.get` names every header and every known tail; collections whose header names a new tail share one second get. A get that throws as a whole falls back to one get per block (`readAttributed`), so only the collections whose blocks failed report an error. Shares its per-block judgement with `readLogEnds` (`answeredHeader`, `checkedLogTail`, `committedTailOf`). New types `CommittedTail`, `CommittedTailQuery`, `CommittedTailAnswer`.
- **db-p2p** — the watch service takes `tails: CollectionTailReader` instead of `readTail`; `committedTailReader(transactor)` is the ready-made reader. One service timer replaces the per-subscription timers. Each tick renews every registration and calls `readTails` once per reader identity, applying each answer on its subscription's queue. Every read is stamped when issued and `acceptedTail` drops an answer older than the newest one applied.
- **Plugin** — `CollectionFactory` keeps one reader per transactor (`tailReaders`) and hands it to every network watch.
- **Docs** — docs/reactivity.md §The node's watch service (tick, stale-answer drop, reader, cost, recovery bound) and docs/internals.md's watch-service paragraph.

## Review findings

**Read first:** the implement diff, then the handoff. Checked the batched read against `readLogEnds` case by case (header absent, header with no tail, tail unchanged, tail moved, header or tail unreadable, doubted answers), the service's timer lifecycle (arm on first watch, re-arm after reads, a watch opened mid-tick, last close mid-tick, `stop()` mid-tick), the stamp ordering the handoff asked about (batch at n, a queued re-read at n+1 applied first, the batch's answer dropped; a failed read not advancing the stamp — correct, since it applied nothing), reader grouping, the plugin wiring, exports, and every doc that mentioned `readTail`.

**Fixed in this pass:**

- *Test that had gone vacuous* — `packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts` counted the watch service's tail reads by patching `Collection.readCommittedTail`, which the plugin no longer calls. Its read count therefore stayed at zero and its "a notification, not a tail read, woke the watch" assertion proved nothing while still passing. It now patches `Collection.readCommittedTails`; re-run over real libp2p and passing (52 s).
- *Lost back-pressure on a slow subscription (regression)* — the old per-subscription tick re-armed only after its own work finished. The new tick re-arms once the reads settle and queues a renewal and an apply step on every subscription each interval, so a subscription whose queue is slower than the tick interval (a registration walk held up by dial timeouts) grew its queue by two steps every tick, without bound. Added `Subscription.tickQueued`: a subscription whose previous tick's answer has not been applied sits later ticks out; the apply step clears the flag first, and a rejected group read still queues that step, so the flag cannot stick. New test in `collection-watch.spec.ts` (*a collection whose earlier tick is still queued behind its registration sits later ticks out*); the tick bullet in docs/reactivity.md says so.

**Tripwires parked:**

- `readAttributed`'s fallback issues two gets per collection at once, unbounded, only after a failed batched get — `NOTE:` at `readAttributed` in `packages/db-core/src/collection/collection.ts` (batch it if callers ever name hundreds of collections).
- Already parked by the implementer and left as is: the 16-collection consult-chunk threshold and the "a read that never settles stops the tick for every collection" bound (`NOTE:` at `armTick`), and the reader-deadline note at `enqueue`.

**Checked, nothing to change:**

- *Correctness of `readCommittedTails`* — matches `readCommittedTail` for every case above. Duplicate ids in one call keep the last query's `knownTailId`; the service never sends duplicates, so no change.
- *Stale-answer drop* — reasoned through both orders (single read inside the queue before the batch, and after); no unit test added, since the order that matters needs a reader held mid-read and the rule is one comparison.
- *`tick()` rejecting* — `readGroup` catches the reader's rejection and synchronous throw, so the voided `tick().finally(...)` has no reachable rejection.
- *Readers that differ between listeners of one collection* — the first listener's reader is used, as before; a closed first listener hands over to the next. No change.
- *Type safety / any* — none introduced. *File size* — `collection-watch.ts` is 685 lines (`wc -l`), mostly doc comments; not split.
- *Unmeasured idle request count on a real two-member group* — the docs' "2 requests per tick" figure is derived, as the handoff says, not observed; left as stated (it says how it was derived).
- *Implementer's tests* — the three `refresh-read-cost` cases each pin a branch of the batched read (one request, shared second request, per-block fallback) and the shared-reader watch case pins the batching itself; all kept.

**Validation:** `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` clean. db-p2p `yarn test` 3537 passing / 74 pending; db-core batched/refresh specs 15 passing; db-p2p real-libp2p collection-watch integration cases 2 passing; plugin `network-change-notification.integration.spec.ts` 1 passing. Full plugin and db-core suites were not re-run: this pass changed only a comment in db-core and a spec in the plugin, and the implement run had them green.
