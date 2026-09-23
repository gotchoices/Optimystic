description: A write that follows another party's write used to fetch the same piece of the change log from the network twice. It is now kept from the first fetch, so such a write costs one less network round trip.
architecture: packages/db-core/docs/collections.md#update-process
files:
  - packages/db-core/src/transform/cache-source.ts (`CacheSource.offerServed`, `CacheSource.heldRevision`)
  - packages/db-core/src/collection/collection.ts (`Collection.keepWhatTheRefreshRead`, called from `Collection.forgetAndAdopt`)
  - packages/db-core/test/refresh-read-cost.spec.ts (two new budgets)
  - packages/db-core/test/collection.spec.ts (`countingTransactor`, plus one new case in the "a refresh that lands short of the tail it just read" group)
  - packages/db-core/docs/collections.md (Update Process)
  - docs/internals.md (the refresh-budget paragraph under "Quereus vtab read path")
----
# A refresh now keeps the header and log tail it just read

## What changed

Every refresh reads the collection header and the log tail block up front (`Collection.readLogEnds`), around the collection's own block cache. When the refresh then walks a log entry from another handle, the clear beside that entry drops the log tail from the cache — a commit's blocks include the log block its entry was appended to — and `Chain.add` fetches the same block again moments later to append this write's own entry. The refresh now keeps what it read instead.

Two pieces:

- **`CacheSource.offerServed(id, block, rev)`** — a new method beside `admit`/`keep`. It adopts an answer some other read obtained: a no-op when the cache holds strictly newer content for the id, otherwise a `keep` of a clone, so the generation bump, the `unkept` eviction and the `revisions` entry all happen exactly as they do for a fetched answer. The caller owns the floor and pin checks, because the block never came through this cache's source and `sourceServed` can say nothing about it. A private `heldRevision` helper distinguishes "content is held for this id" from `getCachedRevision`, which deliberately also answers for an LRU-evicted id.
- **`Collection.keepWhatTheRefreshRead(served)`** — the last move of `forgetAndAdopt`'s one synchronous step (still no `await` anywhere in it). It offers each block `readLogEnds` returned, under three rules: the handle must hold a context; the served revision must be at or below the adopted one; and the served revision must meet any applicable floor (`BlockFloors.applicableTo`, compared without reporting, since this is not an answer being served to a reader).

Only that one site seeds. The early return at `tailShowsNothingNewer` was deliberately left alone, for the reason the implement ticket gave.

## Measured

With `TestTransactor` and two handles alternating `Tree.replace` on one collection, counting `ITransactor.get` requests per `replace`:

| | requests | which |
| --- | --- | --- |
| a write after the other handle's commit, before | 3 | `[header, tail]`, `[leaf]`, `[tail]` |
| the same write, after | 2 | `[header, tail]`, `[leaf]` |
| a solo writer's write | 1 | `[header, tail]` — unchanged |

The three-request shape was confirmed by disabling the new call and re-running the new budget: it prints exactly the request list above.

## Tests added

- `refresh-read-cost.spec.ts`, **"a write that follows another handle's commit costs two requests"** — the reproduction and the guard. Asserts at most two requests and `expectNoBlockFetchedTwice`, and that the write still saw the other handle's row. It fails at three requests with the keep disabled. Note the setup does two warm-up rounds first: a handle asks for the header and tail in ONE request only once a refresh has taught it the tail's id (`Collection.logTailId`), and a handle that invented the collection has not been taught it yet.
- `refresh-read-cost.spec.ts`, **"a solo writer's write still costs one request"** — the uncontended half, guarding against the keep making the cheap case worse.
- `collection.spec.ts`, **"does not keep a tail it read above the revision its walk adopted"** — the rule with the silent failure mode. With `truncatedTailTransactor` armed one revision below the newest, the walk still finds an entry (so the tail IS dropped from the cache) but lands short of the tail's own revision; the test asserts the shortfall line fired, that the collection adopted the middle revision, and that the next read of the tail goes back to the transactor. It fails with the at-or-below-the-adopted-revision rule removed.
- `collection.spec.ts` also gained a small `countingTransactor` helper beside the other doubles in that group.

No other test was added. The remaining edge cases the implement ticket listed were verified by inspection plus existing specs staying green, exactly as it specified.

## What a reviewer should look at hardest

- **The short-of-tail test's observable is the re-fetch, not the content.** The truncation makes the tail's unpinned content identical to its content at the adopted revision, so nothing about the returned data can distinguish "kept" from "not kept" — only where the next read is answered from. The real harm the rule prevents is broader than a re-fetch: a cache entry labelled with a revision above the collection's, which a write staged over the tail would then declare as its base. This test does not reach that. Worth a second opinion on whether a base-declaration assertion earns the harness it would need; I judged it did not, given the rule is also covered by inspection against `revalidatePin` / `stagedBaseRevs` and by the existing pend-base specs staying green.
- **`offerServed` re-keeps at an EQUAL revision.** A walking refresh therefore bumps the header's generation even when the header was neither cleared nor changed. Over-bumping is documented as safe on `CacheSource.bump`, and it costs a re-materialize of that block on its next read. Recorded as a `NOTE:` tripwire at `keepWhatTheRefreshRead`, including the reason not to "fix" it reflexively: skipping at an equal revision would also stop the offer correcting a cached block whose content was folded forward locally at that revision.
- **The invalidation interaction is reasoned about, not tested directly.** No test reverts the header or the log tail; invalidations revert data blocks. The offer runs after both clears, so a reverted id is re-offered rather than left forgotten, which is sound because the revert is itself a commit and `readLogEnds` reads unpinned, so what it read already includes the revert. The existing invalidation cases in `collection.spec.ts` stay green.
- **`heldRevision` versus `getCachedRevision`.** The two differ only for an LRU-evicted id, and picking the wrong one would either refuse a worthwhile offer (evicted id, lingering revision entry) or weigh an offer against content the cache no longer holds. The distinction is documented at both.

## Validation run

- `yarn workspace @optimystic/db-core test` — **1837 passing** (1834 before, plus the three added here).
- `yarn workspace @optimystic/db-p2p test` — **3109 passing**, 63 pending.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **997 passing**, 13 pending; smoke ok.
- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` — all clean.

All three suite counts match the numbers the implement ticket recorded for its prototype. No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

## Docs updated

- `packages/db-core/docs/collections.md`, Update Process — step 4 of the sketch gains the keep, and the "Selective caching" bullet now says the header and tail the refresh read are kept rather than re-fetched, with both rules that bound it.
- `docs/internals.md`, under "Quereus vtab read path — pull-on-read is shape-independent" — a new paragraph beside the refresh budget saying what a *write* costs: one request when nothing else has committed, two when another handle has, and why there is no third.

## Not done, on purpose

No mesh-tier delivery-count test, per the implement ticket: the db-core tier reproduces this exactly and counts the same requests, and the `/cluster` count test guards a different mechanism.
