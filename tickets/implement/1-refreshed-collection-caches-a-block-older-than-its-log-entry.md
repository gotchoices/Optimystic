description: After a shared table changes, a machine that re-reads the changed record can be handed an old copy of it, keeps that old copy in memory, and never looks again — so it goes on showing stale data even after its own disk has been brought up to date. The machine already knows which revision the record must be at least as new as; make it use that, and never remember an answer that is provably too old.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/collection/collection.ts (updateInternal — the per-entry `this.sourceCache.clear(entry.blockIds)` loop; probeHeader and createReadTracker — the two places a TransactorSource is built for reads), packages/db-core/src/transactor/transactor-source.ts (tryGet, servedRevision), packages/db-core/src/transform/cache-source.ts (tryGet miss-load; generations), packages/db-core/src/transform/tracker.ts (tryGet memo, lines ~109-127), packages/db-core/src/log/log.ts (getFrom — entries carry no revision of their own), packages/db-core/src/testing/test-transactor.ts (get — the `context.committed` pending overlay reports the BASE revision as `materialized`), packages/db-core/test/refresh-read-cost.spec.ts (budgets that must keep passing), docs/transactions.md (§ Lazy read-repair window), docs/internals.md
difficulty: hard
repro: verified
----

# A refreshed collection re-reads a changed block, is served an older revision of it, and caches that forever

Reported from the downstream `sereus` repository (its ticket `control-peer-row-refresh-invisible-to-third-node`). Follow-up to `complete/a-reader-cannot-tell-its-view-stopped-advancing`; that fix is correct and is not on this path.

## What a user sees

Three machines share a member directory (a table). Machine C updates its own row. Machine B, polling that row four times a second, keeps reading the old row — in a bad run for the whole 45 s the downstream test waits (167 identical reads), although B's own disk copy was corrected 12 s in. Nothing is logged as wrong. B recovers only when some later write happens to touch the same block.

## The mechanism (from the downstream trace, 2026-09-17, `1.0.0-beta.3`)

A is owner and storage node, B the reader, C the writer. B connects only to A.

1. Revisions 7 and 8 (C writes its address) commit on the cohort {C, A}; B took no part, so B's disk copy of the one data block stays at revision 6. Expected — catching B up is read-repair's job.
2. B's poll refreshes the collection. `Collection.updateInternal` reads the log tail from A, correctly learns the log moved, walks the new entry, calls `this.sourceCache.clear(entry.blockIds)` (which names the data block) and advances its context to revision 7.
3. The SQL read re-fetches the data block pinned at revision 7. For *this* block B's coordinator lookup picks B itself. `CoordinatorRepo.get` finds the block present locally and asks only `shouldReadRepair(blockId)` — a pure time test. B consulted the cohort about the block 2.1 s earlier, inside the 10 s `readRepairWindowMs`, so there is no consult, and B's revision-6 content is returned as the answer to a read pinned at 7. The answer honestly reports `materialized.rev = 6`.
4. The collection puts that answer in its `CacheSource`. The log entry that would have invalidated it has just been consumed; the cache has no expiry and is cleared only by log entries. Every later refresh sees "tail at revision 8 = held revision 8" and (correctly) stops after one request. B never fetches the data block again.
5. 12 s later B's lazy read-repair fixes B's disk copy (`oldRev: 6, newRev: 8`). No reader sees it, because the collection is reading its cache.

Whether this bites depends on which machine B happens to use as coordinator for two blocks of one collection: tail from A (current) + data block from B itself (stale) → stale until another write touches the block. When B reads *both* from itself it is stale only for the ~10 s window, by coincidence of two repairs landing together. The faster a reader learns that the log moved, the more durable its stale copy becomes.

## Reproduced in db-core (repro: verified, 2026-09-17)

The spec below was run against HEAD from `packages/db-core` with `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/refresh-below-floor.spec.ts" --reporter spec`. **Both cases fail**: the first returns `value: 'old'` after the refresh adopted the new revision; the second still returns `'old'` after the lag is lifted and three more refreshes run. The file was deleted again after the run (a fix-stage ticket leaves no failing test in the tree) — recreate it as `packages/db-core/test/refresh-below-floor.spec.ts` as the first step.

```ts
import { expect } from 'chai'
import { Tree } from '../src/collections/tree/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import { LogDataBlockType } from '../src/log/struct.js'
import type { BlockGets, GetBlockResults } from '../src/index.js'

interface Row { key: number; value: string }
const keyOf = (row: Row) => row.key

/** While `lagAt` is set, a PINNED read of any non-log block is answered as of `lagAt` at most —
 *  the content and the `materialized` revision a replica that stopped at `lagAt` would report.
 *  Unpinned reads (the refresh's header and tail) and log blocks are served current, so the reader
 *  correctly learns that the log moved. */
class LaggingDataTransactor extends TestTransactor {
	lagAt?: number
	/** Pinned reads answered below the revision they asked for, as [blockId, askedRev, servedRev]. */
	laggedReads: Array<[string, number, number]> = []

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		const results = await super.get(gets)
		const lagAt = this.lagAt
		const askedRev = gets.context?.rev
		if (lagAt === undefined || askedRev === undefined || askedRev <= lagAt) return results
		for (const [id, entry] of Object.entries(results)) {
			if (!entry.block || entry.block.header.type === LogDataBlockType) continue
			const lagged = (await super.get({ blockIds: [id], context: { ...gets.context!, committed: [], rev: lagAt } }))[id]!
			// Same shape StorageRepo gives a lagging replica: its own newest revision as `state.latest`.
			results[id] = { ...lagged, state: { ...lagged.state, latest: lagged.materialized } }
			if ((lagged.materialized?.rev ?? 0) < (entry.materialized?.rev ?? 0)) {
				this.laggedReads.push([id, askedRev, lagged.materialized?.rev ?? 0])
			}
		}
		return results
	}
}

describe('a refreshed collection re-reading a block its log entry names', () => {
	it('does not keep a too-old answer after storage has caught up', async () => {
		const net = new LaggingDataTransactor()
		const writer = await Tree.createOrOpen<number, Row>(net, 'directory-kept', keyOf)
		await writer.replace([[1, { key: 1, value: 'old' }]])
		const reader = await Tree.createOrOpen<number, Row>(net, 'directory-kept', keyOf)
		await reader.update()
		await reader.get(1)
		net.lagAt = reader.committedRevision()!
		await writer.replace([[1, { key: 1, value: 'new' }]])
		await reader.update()
		try { await reader.get(1) } catch { /* a loud refusal is an acceptable answer here */ }

		net.lagAt = undefined
		for (let poll = 0; poll < 3; ++poll) await reader.update()
		expect(await reader.get(1), 'the reader sees the write once storage can answer').to.deep.equal({ key: 1, value: 'new' })
	})
})
```

The second case that was run asserts the stricter property — the too-old content is not *returned* either (`served?.value !== 'old'`, a throw being acceptable). Under the recommendation below that stricter property is met by the companion ticket `a-too-old-block-answer-is-retried-against-another-machine`, not here; against a single test transactor with nobody else to ask, this ticket's reader returns the old content once per read and keeps nothing.

## The invariant

A block named by a log entry at revision *r*, read at a context at or above *r*, must come back materialized at *r* or later. Anything lower is provably not the view that was asked for. The reader holds both numbers with no wire change:

- the entry it just walked says *revision r changed block X* (`entry.blockIds`; every block an action transforms is committed at that action's revision);
- the answer reports the revision its content was materialized at — `servedRevision(entry)`, already computed in `TransactorSource.tryGet`.

Call the pair (block id → the revision and action id of the newest walked entry naming it) the block's **floor**. Today nothing compares the two numbers.

## Recommended correction

**1. Record floors where entries are consumed.** In `updateInternal`'s entry loop, beside `this.sourceCache.clear(entry.blockIds)`, record for each block id the entry's revision and action id, keeping the highest. `Log.getFrom` returns `ActionEntry` values, which carry no revision; the revision is in `latest.context.committed` keyed by action id (the same lookup `updateInternal` already does for `ownEntry`). An entry whose revision cannot be resolved (older than a checkpoint — none are written today) sets no floor; say so in a `NOTE:`.

**2. Hold floors in one object shared by every read source of the collection,** the way the `ReadDependencyCollector` is shared — not on one `TransactorSource`. `createReadTracker` builds a private `TransactorSource` + `CacheSource` for a pinned view; a view created right after a refresh would otherwise fetch the changed block through a source that knows no floor. The check applies only when the reading context's revision is at or above the floor (`context === undefined || context.rev >= floor.rev`), so a view pinned below the floor is untouched.

**3. Check in `TransactorSource.tryGet`, enforce "never remembered" in `CacheSource`.** An answer carrying a block whose `servedRevision` is below an applicable floor is a **below-floor answer**. It must never enter `CacheSource` (not `cache`, not `revisions`), and the floor is dropped once an answer meets it (that is what bounds the map). Two traps found while researching:

- *The Tracker's memo.* `Tracker.tryGet` memoizes `source block + staged ops` stamped with `CacheSource.getGeneration(id)` and serves the memo while the generation is unchanged. If a below-floor block is handed through uncached **without bumping the generation**, a tracker holding staged updates for that block memoizes the stale base and keeps serving it after the cache would have re-asked. Bump the generation whenever a below-floor answer passes through (over-bumping is documented as safe).
- *The test double's pending overlay.* `TestTransactor.get` serves a block whose action is named in `context.committed` but still pending by laying the pending transform over the base, and reports the **base** revision as `materialized` ("a pending carries no revision of its own"). That content *is* the entry's content, but reads as below the floor. The real `StorageRepo.get` does not have this shape — it promotes such a pending on read, so `materialized` is the entry's revision. Either accept an answer whose `state.pendings` names the floor's action id, or make the double promote like the real repo; do not let the floor check reject the overlay (`collection-own-action-replay.spec.ts`, `own-entry-completes-the-action.spec.ts` and the torn-tail doubles exercise it).

**4. What the reader does with a below-floor answer: return it uncached and say so in the log — do not throw.** Emit one `collection:block-below-floor id=… tag=… block=… floorRev=… servedRev=…` line (`log.enabled`-gated like its neighbours). This is the decision the source ticket left open; the reasoning:

- *Throwing (`BlockPossiblyStaleError`) would make correct data unreadable.* A log entry is not proof its blocks landed. `backlog/bug-a-refused-write-can-leave-its-log-entry-behind` documents, with verified specs, a reachable state where an entry at revision N is permanently in the log while the data blocks it names never took revision N on any machine (the log tail is committed first; a rival commits before the writer's retry; `TornActionError` reason `rival-holds-revision`). Downstream has observed `TornActionError` under contention. For such an entry the below-floor content is the *correct* content, no machine can ever meet the floor, and a throw would fail every read of that block on every handle that refreshed past the entry, until the block is next written — which cannot happen through a handle that cannot read it.
- *A throw inside `updateInternal`'s replay* leaves the tracker half re-staged (`backlog/debt-a-failed-refresh-can-leave-a-collection-half-restaged`); the replay reads through the same source.
- *Returning uncached restores exactly the staleness bound the system already documents.* `docs/transactions.md` § Lazy read-repair window accepts that a self-served read can be one window (10 s default) behind. The defect is that the collection's cache turned that bounded lag into an unbounded one. Uncached, the next read re-asks; the moment the replica's window expires and read-repair lands, the reader sees it. In the downstream trace that is ≤ 10 s instead of never. The companion ticket then removes most of the remaining window by asking a different machine.

Record the decision as an accepted-tradeoff `NOTE:` at the check, with the revisit condition: if log entries ever become proof that their blocks landed (the backlog bug above is fixed by making abandoned entries distinguishable), switch the exhausted case to `BlockPossiblyStaleError`.

**Cost to flag (tripwire `NOTE:` at the site, not a ticket):** while a floor is unmet, every read of that block goes to the transactor instead of memory. For a lagging replica that lasts at most one read-repair window. For an abandoned entry it lasts until the block is next written or the handle is reopened. Not measured. If it ever shows up, retire a floor after some number of consecutive below-floor answers from a coordinator other than this node.

**A write staged over a below-floor read** is built on content the log says is superseded. That hazard exists at HEAD in a worse form (the stale block is cached and used for every later write); this ticket narrows it to the unmet-floor interval and does not close it. Do not try to close it here — the class is `backlog/bug-a-pended-transform-does-not-carry-its-base`. Mention it in the review handoff.

## Out of scope, deliberately

- **Asking another machine.** `ITransactor.get` gives `TransactorSource` no way to exclude the coordinator that answered; that needs the floor to reach `NetworkTransactor.get`. Companion ticket `a-too-old-block-answer-is-retried-against-another-machine` (prereq: this one).
- **The db-p2p cause** (`CoordinatorRepo.get` letting a time stamp suppress the consult for a read whose floor is above the block's local revision). Left to `backlog/feat-refresh-can-demand-a-revision-floor`, which now carries the concrete design notes from this investigation. This ticket plus its companion close the hole regardless of why a coordinator served old content.
- **Blocks first read at open** (`attachToLog` walks no entries, so there are no floors) and **invalidation entries** (`getInvalidationsFrom` → `sourceCache.clear(revertedBlockIds)`; whether a reverted block is re-committed at the invalidation's revision was not checked). Both are the general form in the backlog feat ticket.

## What this is not

Not the corroboration deadlock (`complete/1-repair-deadlock-is-never-named`), not a fork (no `collection:lineage-divergence` / `context-not-lowered` / `context-short-of-tail` in the trace), not commit-side freshness arming, and not routing as such — self-coordinating a block one is a cohort member for is intended.

## Reproducing downstream (owned by the downstream ticket; not agent-runnable from here)

In `../sereus/packages/integration-tests` (needs `@serfab/cadre-core` built and this repo's `dist` fresh): `DEBUG='optimystic:db-p2p:*,optimystic:db-core:collection*,sereus:cadre:node' DEBUG_COLORS=0 npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts`. Failure fingerprint: `Timeout waiting for B resolves C's signed CadrePeer address record after 45000ms`. Intermittent (2 of 6 cold runs), so loop it and look for a positive pass marker — a stale-build abort prints neither pass nor the failure string.

## TODO

- Recreate `packages/db-core/test/refresh-below-floor.spec.ts` from the block above and confirm it fails before changing anything.
- Add the shared floors object; record floors in `updateInternal`'s entry loop; hand the same object to the sources built in `probeHeader` and `createReadTracker`.
- Check in `TransactorSource.tryGet`; keep below-floor content out of `CacheSource` on every path, including the replay inside `updateInternal`; bump the generation when a below-floor answer passes through; drop a floor once met.
- Handle the test double's pending overlay (see trap above) and run the own-entry / torn-tail suites.
- Add specs: a pinned read view created after the refresh does not keep the too-old block either; a view pinned *below* the floor is served and cached as before; a tracker with staged updates on the block does not keep serving a memo built on the below-floor base; the floor map empties once the answer meets the floor; an "abandoned entry" shape (floor never met) keeps reading successfully.
- Add the `collection:block-below-floor` line, and the two `NOTE:`s (accepted tradeoff with revisit condition; per-read cost tripwire).
- Run the whole db-core suite (`yarn workspace @optimystic/db-core test` or the package's `test` script) — `refresh-read-cost.spec.ts` budgets must hold — plus build/type-check, and the quereus-plugin / db-p2p suites that build on `Collection`.
- Update `docs/transactions.md` § Lazy read-repair window (the window bounds what a *repo* serves; say what stops a collection's memory from extending it) and the read-path bullets in `docs/internals.md` near the `materialized` / `unconfirmedAheadRev` description.
- After release, note the outcome in `../sereus/tickets/blocked/control-peer-row-refresh-invisible-to-third-node.md` so the downstream re-measurement gets scheduled (carry this item through to the review/complete ticket if the release has not happened).
