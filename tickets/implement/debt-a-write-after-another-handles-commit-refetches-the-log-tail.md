description: When one party writes to a table another party has just written to, its write fetches the same log block from the network twice — once to check what changed, then again to append to it. Keeping the first copy removes one network round trip from every such write.
architecture: packages/db-core/docs/collections.md#update-process
files:
  - packages/db-core/src/collection/collection.ts (`updateInternal`, `readLogEnds`, `forgetAndAdopt`, the `LogEnds` type)
  - packages/db-core/src/transform/cache-source.ts (`CacheSource` — the new `offerServed`, beside `admit`/`keep`)
  - packages/db-core/src/transactor/block-floors.ts (`BlockFloors.applicableTo`, the check the seed has to make for itself)
  - packages/db-core/test/refresh-read-cost.spec.ts (the existing read-budget spec — where the new budget goes)
  - packages/db-core/test/collection.spec.ts (`describe('a refresh that lands short of the tail it just read')` — its `truncatedTailTransactor` is the harness for the admission-rule test)
  - packages/db-core/docs/collections.md (§Update Process — the step-4 sketch)
  - docs/internals.md (the refresh-budget paragraph under "Quereus vtab read path")
----
# A write that follows another handle's commit refetches the log tail

## What was measured, and what it says about the ticket this came from

The plan ticket (`debt-non-coordinating-writer-fetches-more-after-the-one-round-commit`) suspected the one-round tail-and-blocks commit of making the non-coordinating writer fetch more. **It did not.** Measured on a two-node mesh (`createMesh(2, { responsibilityK: 2, clusterSize: 2 })`, one party driving a transactor with no `localPeerId` so every call of its is remote, ten alternating inserts into one tree, counting every `IRepo` call that party makes):

| per insert, non-coordinating party | `get` | `pend` | `commit` | total `/repo` |
| --- | --- | --- | --- | --- |
| one-round commit (today) | 3 | 1 | 1 | **5** |
| tail-then-sweep (the one-round path forced off) | 3 | 1 | 2 | **6** |

The get count is identical on both paths, block id for block id; the only difference is the commit round the change removed. So that change strictly *reduced* this party's `/repo` traffic, by one call per insert.

What sereus's relay numbers (1–4 before, 3–6 after, on the other party 1–3 → 0–2) most likely show instead is **where the blocks landed on the ring, which is a fresh coin flip per dataset.** Block ids are random (`randomBytes(32)`, `packages/db-core/src/transactor/transactor-source.ts`), and in a two-node group each read goes to whichever node the ring places nearest the block, so a get either crosses the relay or does not. The log tail block gets a new random id each time a collection is created, and it is read twice per write (below), so a run whose tail lands on the other side of the relay pays about two more crossings per insert *for the whole run*. Two separately-created datasets differ on that by chance. The measured span between the two builds sereus compared is 101 commits, not one, and nothing in it adds a read on this path: the cache clear that sends the tail back to the network predates the span (it was only moved into `forgetAndAdopt` by `refreshed-collection-caches-a-block-older-than-its-log-entry`), and `restageIfBasesMoved`'s extra read fires only for a block the cache handed through unkept, which never happened in any run measured here.

## The real cost, which is placement-independent

Every write that follows *another handle's* commit fetches the log tail block twice:

1. `Collection.readLogEnds` reads the collection header and the log tail block in one request — the refresh at the top of `actAndSync`.
2. The walk finds the other handle's entry. `forgetAndAdopt` drops every block that entry names from `this.sourceCache`, and the log tail is always one of them (a commit's transformed blocks include the log block its entry was appended to).
3. The write then appends its own entry, `Chain.add` → `Chain.getTail` reads the tail — a second fetch of the block step 1 just received.

The block read in step 1 never reaches the collection's long-lived cache at all: the refresh builds a throwaway `CacheSource` seeded with `ends.served` for its own walk, and that cache is discarded when `updateInternal` returns.

Measured at the db-core tier with `TestTransactor` (two handles alternating `Tree.replace` on one collection, counting `ITransactor.get` requests per `replace`):

| | requests per write | which |
| --- | --- | --- |
| a write after the other handle's commit | 3 | `[header, tail]`, `[leaf]`, `[tail]` |
| the same write, with the fix | 2 | `[header, tail]`, `[leaf]` |
| a solo writer's write | 1 | `[header, tail]` — unchanged; its own commit folds the tail back into the cache, and its next refresh stops at `tailShowsNothingNewer` without clearing anything |

The remaining two are both required: the refresh has to ask, and the leaf the other writer changed has to be re-read. In a workload where two parties alternate writes to one table — sereus's — every write is the contended case, so this is one relay round trip per insert for whichever party the tail is remote from.

The plan ticket asked whether the writer can "reuse what it just committed instead of re-reading it". It already does: `syncAttempts` folds the committed transforms into the cache (`sourceCache.transformCache(transforms, newRev)`) on success. The re-read is not of what this handle committed — it is of what the refresh read moments earlier and then threw away.

## The change

Keep what `readLogEnds` already read, in the collection's own cache, at the end of the same synchronous step that forgets and adopts.

`CacheSource` gains one method, beside `admit`/`keep`:

```ts
/** Adopt an answer some other read already obtained for `id` — the header and log tail
 *  `Collection.readLogEnds` fetches around this cache — so the next read of the id is a hit
 *  rather than a second fetch of a block this handle just received. Kept only when nothing
 *  strictly newer is held (of two answers to one source the higher revision is the truer, as in
 *  `admit`). The CALLER owns the floor and pin checks: the offered block did not come through
 *  this cache's source, so `sourceServed` can say nothing about it. */
offerServed(id: BlockId, block: T, rev: number): void
```

It clones the block on the way in (the cache stores the reference, and `LogEnds.served` is handed to the refresh's own walk cache as well), and goes through `keep`, so the generation bump, the `unkept` eviction and the `revisions` entry all happen exactly as they do for a fetched answer.

`Collection.forgetAndAdopt` takes `ends.served` and, after `advanceContext`, offers each entry that passes three rules:

- **The handle holds a context.** With no adopted context every later read is unpinned and could legitimately be answered newer than what was read here, so there is nothing to judge the offer against — skip.
- **The served revision is at or below the adopted revision.** `readLogEnds` reads unpinned, so it can come back newer than the view this handle now reads at — that is exactly the `collection:context-short-of-tail` case. Serving that content to a read pinned lower would fabricate a view that never existed. At or below the pin it is sound: a block whose newest content is at `r ≤ R` has the same content at `R`.
- **The served revision meets any applicable floor** (`BlockFloors.applicableTo`, compared without reporting — this is not an answer being served to a reader, so `answeredBelowFloor`'s `collection:block-below-floor` line would misdescribe it). A cache must never keep a below-floor answer; on every other read `TransactorSource.describeServed` enforces that, and this path reads around `TransactorSource`, so the seed enforces it itself.

The whole thing stays inside `forgetAndAdopt`'s one synchronous step — no `await` may appear between the clear, the floors, the adopt and the offer, for the reason that method's doc already gives.

**Only that one site.** The early return at `tailShowsNothingNewer` is deliberately left alone: it fires when the log has not moved, and the cache is then already warm with the tail (folded in by this handle's own commit, or kept from its last walk). Seeding there would buy a fetch back only when the 128-entry cache had evicted the tail, and it would put the "one synchronous step" reasoning in a second place.

## Edge cases & interactions

- **The header names a tail this handle did not know** (the tail block filled since the last refresh). `readLogEnds` already drops the out-of-date block's answer and puts only the newly-read tail into `served`, so the seed can never keep a superseded tail. Verified by inspection of `readLogEnds` plus the existing "a refresh that follows the log onto a new tail block" case in `refresh-read-cost.spec.ts`, which must stay green.
- **The walk lands short of the tail it read** (`collection:context-short-of-tail`). The tail's served revision is then above the adopted one and must not be kept. This is the one rule with a silent failure mode, so it gets the second test below.
- **An invalidation reverted the tail.** `revertedBlockIds` is cleared in the same step; a seed of a reverted id would undo that clear. The floor and revision rules do not cover this on their own, so the offer must run over `served` only after both clears, which it does — and an id in both `served` and `revertedBlockIds` is re-offered at its read revision, which is the content the reverting walk just read. Verify by inspection against `filterAgainstEntry`/the invalidation branch, and keep `packages/db-core/test/collection.spec.ts`'s invalidation cases green.
- **A read of the tail in flight across the refresh.** `keep` bumps the generation, so an answer that missed before the refresh and lands after is judged by `stillWanted` and kept only if it replaces strictly older content — which is what should happen, and is the existing rule, not a new one.
- **The base pinned for the write staged over the tail.** `Tracker.update` pins the cache's revision at the first operation for an id. Before the change that revision came from a freshly fetched tail; after, from the seeded one at the same revision, so `revalidatePin` and `stagedBaseRevs` see the same number. Verified by the existing pend-base specs staying green (`restageIfBasesMoved`, `bases-move` cases in `collection.spec.ts`).
- **Read dependencies.** `readLogEnds` records none (it reads around `TransactorSource`). After the change the later cache hit records one at the seeded revision, where before the re-fetch recorded one at the same revision through `TransactorSource` — the conflict set is unchanged. Verified by inspection of `CacheSource.tryGet`'s hit branch plus the read-dependency specs staying green.
- **Pinned committed read views.** `createReadTracker` seeds a private cache from `snapshotEntries()` and already excludes entries newer than the pin (`ReadViewOptions.pinContext`), and the second rule above keeps the collection cache from ever holding a block above the adopted revision in the first place. Verified by `read-view-pinned.spec.ts` and the plugin's `committed-read-*` specs staying green.
- **A handle with no committed revision** (an invented collection whose header and root are still staged). No context, so nothing is offered — the first rule.

## Cost of not doing it

One extra network request per write, for every writer whose log tail is remote, whenever another handle has committed since that writer last looked. Nothing is wrong today; the request returns the same bytes the handle already holds.

## To do

- Add `CacheSource.offerServed(id, block, rev)` beside `admit`/`keep`: no-op when strictly newer content is held for the id, otherwise `keep` a clone. Document that the caller owns the floor and pin checks, and why (`sourceServed` cannot describe a block this cache's source never returned).
- Thread `ends.served` into `Collection.forgetAndAdopt` and offer each entry after `advanceContext`, under the three rules above. Keep the step free of `await`.
- Put a `NOTE:` at the seed naming the reason the floor check lives there: `readLogEnds` reads around `TransactorSource`, so nothing else on this path would apply it.
- Extend `packages/db-core/test/refresh-read-cost.spec.ts` with the budget this buys — two handles alternating `Tree.replace` on one collection over a `CountingTransactor`, asserting a write that follows the other handle's commit costs at most 2 requests and fetches no block twice (`expectNoBlockFetchedTwice`). This is the reproduction as well as the guard.
- Add one test for the short-of-tail rule, in `collection.spec.ts`'s existing `describe('a refresh that lands short of the tail it just read')`: with `truncatedTailTransactor` armed, the tail read by the refresh is NOT served to the next read from the cache — the read goes back to the transactor and is answered at the adopted revision, rather than getting the higher-revision content the unpinned refresh saw.
- Do **not** add a mesh-tier delivery-count test (the plan ticket suggested one alongside the `/cluster` count test). The db-core tier reproduces this exactly, in milliseconds, and counts the same requests; the `/cluster` count test guards consensus rounds, a different mechanism.
- Update `packages/db-core/docs/collections.md` §Update Process — step 4 of the sketch gains the keep, and the "Selective caching" bullet should say that the header and tail the refresh read are kept rather than re-fetched.
- Update the refresh-budget paragraph in `docs/internals.md` (under "Quereus vtab read path — pull-on-read is shape-independent", which already names `refresh-read-cost.spec.ts`) with what a *write* costs: one request when nothing else has committed, two when another handle has.
- Run `yarn workspace @optimystic/db-core test`, `yarn workspace @optimystic/db-p2p test` and `yarn workspace @optimystic/quereus-plugin-optimystic test`. All three were green against a prototype of this change (1834 / 3109 / 997 passing), so a red one is a real difference from the prototype, not an expected re-baselining.
