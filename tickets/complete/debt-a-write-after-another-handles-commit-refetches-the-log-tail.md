description: A write that follows another party's write used to fetch the same piece of the change log from the network twice. It is now kept from the first fetch, so such a write costs one less network round trip.
architecture: packages/db-core/docs/collections.md#update-process
files:
  - packages/db-core/src/transform/cache-source.ts (`CacheSource.offerServed`, `CacheSource.heldRevision`, `CacheSource.keep`)
  - packages/db-core/src/collection/collection.ts (`Collection.keepWhatTheRefreshRead`, called from `Collection.forgetAndAdopt`)
  - packages/db-core/src/transactor/block-floors.ts (`BlockFloors.meetsApplicableFloor`, `BlockFloors.unmetFloor`)
  - packages/db-core/test/refresh-read-cost.spec.ts (two budgets)
  - packages/db-core/test/collection.spec.ts (`countingTransactor`, one case in "a refresh that lands short of the tail it just read")
  - packages/db-core/test/block-floors.spec.ts (the non-reporting floor check)
  - packages/db-core/docs/collections.md (Update Process)
  - docs/internals.md (the refresh-budget paragraphs under "Quereus vtab read path")
----
# A refresh now keeps the header and log tail it just read

## What shipped

Every refresh reads the collection header and the log tail block up front (`Collection.readLogEnds`), around the collection's own block cache. When the refresh then walks a log entry from another handle, the clear beside that entry drops the log tail from the cache — a commit's blocks include the log block its entry was appended to — and `Chain.add` fetches the same block again moments later to append this write's own entry. The refresh now keeps what it read instead.

- **`CacheSource.offerServed(id, block, rev)`** adopts an answer some other read obtained: a no-op when the cache holds strictly newer content for the id, otherwise a `keep` of a clone, so the generation bump, the `unkept` eviction and the `revisions` entry all happen exactly as they do for a fetched answer. The caller owns the floor and pin checks, because the block never came through this cache's source.
- **`Collection.keepWhatTheRefreshRead`** is the last move of `forgetAndAdopt`'s one synchronous step (still no `await` anywhere in it). It offers each block `readLogEnds` returned, under three rules: the handle must hold a context, the served revision must be at or below the adopted one, and the served revision must meet any applicable floor.

Measured on `TestTransactor` with two handles alternating `Tree.replace` on one collection: a write after the other handle's commit went from 3 `get` requests to 2; a solo writer's write stays at 1.

## Review findings

### Verified by re-running the change, not by reading the handoff

Both of the implement ticket's falsifiability claims were re-checked by disabling the code and re-running:

- With `keepWhatTheRefreshRead` replaced by a no-op, `refresh-read-cost.spec.ts` "a write that follows another handle's commit costs two requests" fails at exactly 3 requests, printing the request list `[[header, tail], [leaf], [tail]]` — the claimed shape, block for block.
- With the at-or-below-the-adopted-revision rule removed, `collection.spec.ts` "does not keep a tail it read above the revision its walk adopted" fails on the re-fetch assertion.

So both new rules are genuinely pinned. Suites: db-core 1838 passing (1837 before, plus the one test added here), db-p2p 3109 passing / 63 pending, quereus-plugin-optimystic 997 passing / 13 pending plus smoke ok, `yarn test:harness` clean. `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` all clean. No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

### Fixed in this pass

- **The floor comparison was spelled out a second time, in another file, and nothing tested the copy.** `keepWhatTheRefreshRead` wrote `floor === undefined || rev >= floor.rev` inline — the exact inverse of `BlockFloors.answeredBelowFloor`'s rule, living in `collection.ts` while the rule lives in `block-floors.ts`. Deleting the whole arm left the entire db-core suite green, so a later change to what a floor means would have silently stopped bounding what a refresh keeps, with no test to say so. `BlockFloors` now exposes `meetsApplicableFloor` — the same question without the `collection:block-below-floor` report, which is what the seed path needs — and both public checks are built on one private `unmetFloor`, so the two cannot drift. The call site asks for it instead of restating it.
- **Added one test** (`block-floors.spec.ts`, "answers the same question silently for content that was not served to a reader"), for the one thing the shared helper does not already cover: that the non-reporting face reaches the same verdict AND stays silent. That is the whole reason the method exists — an implementation that delegated to `answeredBelowFloor` would start emitting `collection:block-below-floor` for every refresh seed. No other test was added; the rest of the change is pinned by the two the implementer wrote plus the existing floor, pin and invalidation specs.
- **An offer logged itself as a source load.** `keep` unconditionally logged `miss:loaded`, so on the `optimystic:cache` namespace a block the refresh handed over was indistinguishable from one fetched from the transactor — in the one subsystem whose whole subject here is counting fetches. `keep` now takes a typed `reason` and the offer logs `offer:kept`.
- **The `CacheSource` seed parameter's doc was wrong about its own contract.** It claimed entries "are already cloned by `snapshotEntries`", but `readLogEnds` has always passed raw blocks it also keeps a handle on. Corrected to state the real contract (adopted by reference; a seeder keeping its own handle must not mutate), which is also what makes `offerServed`'s clone the right call rather than an unexplained asymmetry.
- **`docs/internals.md` claimed more than the code does.** "that walk reads through one block cache seeded with the header and tail, so no block is fetched twice in one refresh" is false on one path — see the next section. The sentence now names the exception and points at where the cost is recorded. (Pre-existing text, adjacent to the paragraph this ticket added.)

### Found, measured, and deliberately not filed

- **A refresh that follows the log onto a new tail block fetches the previous tail twice.** Measured directly (a 30-row collection, five more writes to roll the tail, then one refresh): requests `[[header, oldTail], [newTail], [oldTail]]` — the old tail's answer is fetched in `readLogEnds`'s batched request, discarded when the header turns out to name a different tail, and fetched again by the chain walk. Same function, same class of defect as this ticket. **Not filed**: the completed predecessor `refresh-of-an-unchanged-collection-refetches-the-same-blocks` already weighed and parked it ("a rolled tail is fetched twice in that one refresh"), and the accepted cost is recorded in code at `Collection.logTailId` ("A stale value costs one extra request and nothing else"). Re-filing would be exactly the re-discovery that rule exists to stop. Nothing about the finding has changed; what changed is that the doc now admits it. Fixing it is also not free: the discarded answer is one the refresh currently never inspects, so seeding from it means deciding what to do with a doubted or unavailable prior tail, and getting that wrong turns a working refresh into a throw.

### Recorded as a tripwire

- **An offer over an LRU-evicted id is accepted even when it is older than the revision this cache last served for that id.** `heldRevision` deliberately ignores the `revisions` entry that outlives an eviction, so a lagging replica answering the unpinned refresh read below what this handle has already seen — with no walked entry to floor the block — is kept. It is not a regression: a pinned re-read of the evicted id would have been kept at that same answer, so the offer path is no worse than the read path it replaces. `NOTE:` at `CacheSource.heldRevision`, naming the remedy (refuse an offer below `getCachedRevision`; a block never goes back a revision, so refusing is always right) for whenever lagging-replica staleness on the header or tail shows up.

### Checked and found sound — no finding

Named explicitly rather than left as silence, since each was a real possibility:

- **The equal-revision re-keep** the implementer flagged for a second opinion. Correct as written. `Tracker.revalidatePin` treats the same revision as the same committed content and refreshes the pin in place, so a re-keep at an equal revision cannot mislabel a staged write's base; the cost is one generation bump and a re-materialize. The existing `NOTE:` at the site already says why not to "fix" it reflexively, and that reason holds.
- **The short-of-tail test's weak observable**, also flagged. Agreed with the implementer's judgment. The rule it protects is "do not label a cache entry with a revision above the collection's"; asserting the base a staged write then declares would need a harness that stages over the tail through a lying transactor, and the declaration path is already pinned by `revalidatePin` / `stagedBaseRevs` and the pend-base specs. The re-fetch is a sufficient observable for the rule as written.
- **Pinned read views.** `createReadTracker` seeds from `snapshotEntries()` and drops entries above the pin. Every offered entry is at or below the adopted revision by construction, so an offer can never survive that filter into a view it does not belong in.
- **Races against the one synchronous step.** `offerServed` bypasses `stillWanted`, which is safe only because the offer happens inside `forgetAndAdopt` with no `await`: a read in flight across the step lands with a moved generation and is re-judged by `admit` against the offered content, which is the newer of the two whenever the offer was accepted. Re-read the whole step to confirm it is still await-free after the change; it is.
- **The invalidation interaction.** Confirmed the offer runs after BOTH clears, so a reverted id is re-offered rather than left forgotten, and that this is sound because the revert is itself a commit and `readLogEnds` reads unpinned. The existing invalidation cases stay green.
- **The idle fast path.** `tailShowsNothingNewer` compares against the answer just read, never against the cache, so keeping the tail cannot make an idle refresh miss a rival's commit. The "a solo writer's write still costs one request" budget is the guard that the seed did not make the uncontended case worse.
- **Resource cleanup and scale.** At most two extra entries in an already LRU-bounded cache, both of which were fetched anyway; no new long-lived state; the loop is over a two-element array.
- **Source hygiene.** The comment density on `keepWhatTheRefreshRead` is high but every line states a constraint or a non-obvious consequence rather than narrating a statement, which matches the surrounding file. `collection.ts` is now 2118 lines (`wc -l packages/db-core/src/collection/collection.ts`), up 57; the open `debt-collection-write-retry-logic-outgrew-its-file` already owns that, and this measurement was appended to it as evidence rather than filed fresh.
- **Docs.** Read `packages/db-core/docs/collections.md` and `docs/internals.md` in full around the change; both reflect the new behaviour. The one overclaim found is fixed above.

### Empty categories

No new tickets were filed and nothing was routed to `blocked/`. No tests were cut: the implementer added three, and each pins a distinct rule that fails when its rule is removed (two of the three verified here by removing it), so none restates the implementation or verifies a mock.
