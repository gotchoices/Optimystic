description: Before every live query, each table checks the network for changes, and even when nothing changed that check fetches the same two small blocks seven or eight times, one at a time. Over a slow relay each fetch is a round trip, so polling an idle chat costs seconds. Stop early when the table has not moved, and never fetch one block twice in one check.
files:
  - packages/db-core/src/collection/collection.ts (`updateInternal` ~line 726, `bootstrapContext` ~line 1575, `reportShortfall`, `advanceContext`)
  - packages/db-core/src/log/log.ts (`getFrom`, `getInvalidationsFrom`, `getActionContext`)
  - packages/db-core/src/chain/chain.ts (`Chain.open`, `getTail`, `getHeader`, `select`)
  - packages/db-core/src/transform/tracker.ts (`tryGet` — keeps only blocks it has staged changes for)
  - packages/db-core/src/transactor/transactor-source.ts (`tryGet` line 44 sends `actionContext` with every get)
  - packages/db-core/src/transform/cache-source.ts (candidate per-refresh cache)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (live read arm calls `Tree.update()` on the table and on each index tree, ~line 1215)
  - packages/db-core/test/collection.spec.ts (existing refresh tests, incl. 'a refresh that lands short of the tail it just read')
repro: verified
----
# A refresh of an unchanged collection fetches the same blocks seven or more times

Reported from sereus (a two-party chat app with one party on a phone behind a relay). Every live read (`optimystic-module.ts`, live arm) calls `Tree.update()` → `Collection.update()` → `updateInternal()` for the table and again for each index tree. On sereus's joining machine an unchanged `SELECT` cost 2–7 `/repo` streams to the other party. Those requests are exactly this refresh.

## Measured (db-core, no network)

A counting subclass of `TestTransactor` recorded every `get`. Scenario: a writer tree makes N single-row writes, and a second handle refreshes once and then refreshes again with nothing changed.

- N = 50: the unchanged refresh made **8** `get` calls, each for **one** block. Only 3 distinct blocks were involved: the collection header 4 times, the log tail 3 times, and one older log block once.
- N = 500: the unchanged refresh made **22** `get` calls, and the handle's `actionContext.committed` list held **500** entries. That list goes out with every `get` (`transactor-source.ts:44`).

Stack traces for the 8 calls in the N = 50 run:

1. Header: `updateInternal` → `tracker.tryGet(this.id)`.
2. Tail: `bootstrapContext` → `transactor.get({blockIds:[tailId]})` (direct, no cache).
3. Header: `Log.open` → `Chain.open` → `tryGet`. The comment in `updateInternal` says this "reuses the cached header". It does not: `Tracker` only keeps blocks it has transforms for, and nothing between it and the `TransactorSource` caches.
4. Header, then tail: `Log.getFrom` → `chain.select` → `getTail` → `getHeader` + `tryGet(tailId)`.
5. Older log blocks: `getFrom` keeps walking back to a checkpoint ("Can't stop at rev, because we need to collect all pending actions for the context"). Nothing in production ever writes a checkpoint (`Log.addCheckpoint` has no non-test caller), so the walk reaches the log head and the cost grows with history. That part is filed separately as `debt-the-collection-log-never-writes-a-checkpoint`. This ticket only avoids the walk when nothing changed.
6. Header, then tail: `getInvalidationsFrom` → `select` → `getTail` again.

On a p2p node each of these `get`s is a separate `NetworkTransactor.get`. Header and tail are routed independently, so each one is either served locally or becomes a `/repo` request to another member.

Test to keep, adapted from the repro (the file was removed from the tree):

```ts
class Counting extends TestTransactor {
	gets: string[][] = []
	override async get(b: BlockGets): Promise<GetBlockResults> { this.gets.push([...b.blockIds]); return super.get(b) }
}
// writer = Tree.createOrOpen(net, 't', e => e.key); 50× writer.replace(...)
// reader = Tree.createOrOpen(net, 't', ...); await reader.update(); net.gets = []
// await reader.update()  → today 8 gets; target ≤ 2 (≤ 1 with the batched arm)
```

## Fix

**Early exit when the tail shows nothing new.** In `updateInternal`, after `bootstrapContext`: if the tail's claimed `latest` equals the held context (same `rev` **and** the same `actionId` at that rev in `this.source.actionContext.committed`), and there is no `inFlightActionId`, return before `Log.open`. This is sound for three reasons:

- Every commit and every invalidation writes the tail and takes a revision, so equal revisions mean there are no new entries and no new invalidations.
- `advanceContext` would adopt the same context, and `mustReplay` needs a revision advance or a conflict. Neither can happen without new entries.
- Comparing the action id as well as the revision keeps a forked lineage from short-circuiting. On a mismatch, fall through to the full walk so the existing refusal and fork diagnostics still run.

`reportShortfall` has nothing to report when `tailRev === held rev`, so skipping it loses nothing. If the held context is **above** the tail's claim (the lagging-read or over-claim case in the `bootstrapContext` NOTE), do not exit early. Take the full path so `collection:context-not-lowered` and related diagnostics still fire.

**Fetch each block at most once per refresh.** When something did change, the full path still re-reads header and tail 3–4 times. Put a refresh-scoped cache between `Tracker` and the scratch `TransactorSource` in `updateInternal`, and route `bootstrapContext`'s tail read through the same cache. Two things to watch:

- `bootstrapContext` sets `source.actionContext` *after* the unpinned tail read. A cached unpinned tail must not be served later as a pinned read at a different context. Either key the scratch cache per context, or cache only the header and tail (the two unpinned reads). Keep `bootstrapContext`'s `unavailable` / `unconfirmedAheadRev` throws on the first read.
- Consider merging `getFrom` and `getInvalidationsFrom` into one reverse walk that returns both, so the tail and newer log blocks are walked once.

**Optional, batched arm.** Remember the header's `tailId` from the previous refresh and request `[headerId, tailId]` in one `get`. If the fresh header names a different tail, fetch that tail. An unchanged refresh then costs one request when both blocks route to the same coordinator.

## Not in scope

- Skipping the refresh entirely when a change notification says nothing changed: `feat-a-live-read-can-skip-a-refresh-the-cohort-already-told-it-about`.
- Making the log stop growing the context: `debt-the-collection-log-never-writes-a-checkpoint`.

## TODO

- Add the counting-transactor spec to `packages/db-core/test` (header/tail get counts for an unchanged refresh, a changed refresh, and an index-bearing tree). Assert upper bounds, not exact counts.
- Implement the early exit with the rev + actionId check, and fall through when the held rev is above the tail's claim.
- Add a refresh-scoped block cache so header and tail are fetched at most once per `updateInternal`.
- Optionally merge the `getFrom` / `getInvalidationsFrom` walks.
- Optionally batch header + remembered tail in one `get`.
- Confirm the existing refresh suites still pass: `collection.spec.ts`, including the over-claiming tail and fork diagnostics tests, plus the tree and transaction specs. Then run the `quereus-plugin-optimystic` tests.
- Update `docs/internals.md` "pull-on-read" if it describes the refresh cost.
