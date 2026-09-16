/**
 * Ticket: write-durability-reaches-the-writer.
 *
 * The transactor already answers a commit with a `WriteDurability` (ticket
 * commit-result-carries-durability-class). These pin that the answer actually REACHES the writer:
 * `TransactorSource.transact` returns the commit result instead of collapsing success to
 * `undefined`, `Collection.sync` returns the class of what it committed, and `Tree`/`Diary` forward
 * it without interpreting it.
 *
 * The contract has exactly one hole a caller must handle, and it is asserted here too: a sync with
 * NOTHING STAGED does no pend and no commit, so it reports `undefined` rather than a fabricated
 * class. Everything else either returns a class or throws.
 */
import { use, expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
use(chaiAsPromised)
import { Collection, SyncRetryExhaustedError, type CollectionInitOptions } from '../src/collection/index.js'
import { Tree } from '../src/collections/tree/index.js'
import { Diary } from '../src/collections/diary/index.js'
import { DelegatingTransactor, FlakyCommitTransactor, TestTransactor } from '../src/testing/test-transactor.js'
import { isFullyDurable } from '../src/index.js'
import type { ActionHandler, BlockStore, CommitRequest, CommitResult, IBlock, WriteDurability } from '../src/index.js'

interface TestAction {
	value: string
}

const handlers: Record<string, ActionHandler<TestAction>> = {
	'set': async (_action, store) => {
		store.insert({ header: store.createBlockHeader('TEST', store.generateId()) })
	}
}

const initOptions: CollectionInitOptions<TestAction> = {
	modules: handlers,
	createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({ header: store.createBlockHeader('TEST', id) })
}

/**
 * Commits for real on the inner {@link TestTransactor}, then REPLACES the durability on the success
 * with `stamped`. Nothing else changes, so the write really lands and the collection's own
 * bookkeeping (revisions, log entries, pend discharge) runs exactly as in production — only the
 * class the writer is told about is under the test's control.
 *
 * This is the only honest way to reach a multi-machine class from a unit test: `TestTransactor` is
 * one node and can only ever report `local`.
 */
class StampedDurabilityTransactor extends DelegatingTransactor {
	/** Successful commits observed, so a test can prove how many the sync actually ran. */
	commits = 0

	constructor(inner: TestTransactor, private readonly stamped: WriteDurability) {
		super(inner)
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		const result = await this.inner.commit(request)
		if (!result.success) return result
		this.commits++
		return { ...result, durability: this.stamped }
	}
}

/**
 * Refuses the first `failFirstN` commits as a retryable conflict, then commits for real and stamps
 * `stamped` on the answer — the retry-loop shape: attempts that wrote nothing, followed by one that
 * did. Nothing advances a revision on the refusals, so the collection rebases and re-pends under the
 * same action id exactly as it does against a real lost race.
 */
class RefuseThenStampTransactor extends DelegatingTransactor {
	/** Commits refused so far. */
	refusals = 0
	/** Commits that actually landed. */
	commits = 0

	constructor(inner: TestTransactor, private readonly failFirstN: number, private readonly stamped: WriteDurability) {
		super(inner)
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (this.refusals < this.failFirstN) {
			this.refusals++
			return { success: false, conflict: true, reason: 'forced stale' }
		}
		const result = await this.inner.commit(request)
		if (!result.success) return result
		this.commits++
		return { ...result, durability: this.stamped }
	}
}

/** A cohort of three that two members confirmed — the shape a real `majority` commit reports. */
const MAJORITY: WriteDurability = {
	quorum: 'majority',
	confirmed: 2,
	cohort: 3,
	unconfirmed: ['peer-c'],
	cohortPeerIds: ['peer-a', 'peer-b', 'peer-c']
}

/** A whole cohort that holds the tail, over an action that abandoned a block anyway. `quorum` alone
 *  would read as saved here; `torn` is the only thing that says otherwise, which is why it must
 *  survive the trip up to the writer. */
const TORN: WriteDurability = {
	quorum: 'full',
	confirmed: 3,
	cohort: 3,
	unconfirmed: [],
	cohortPeerIds: ['peer-a', 'peer-b', 'peer-c'],
	torn: ['abandoned-block-1', 'abandoned-block-2']
}

describe('write durability reaches the writer', () => {
	describe('Collection.sync', () => {
		it('reports the class the transactor answered the commit with', async () => {
			const transactor = new StampedDurabilityTransactor(new TestTransactor(), MAJORITY)
			const collection = await Collection.createOrOpen<TestAction>(transactor, 'majority-coll', initOptions)
			await collection.act({ type: 'set', data: { value: 'one' } })

			const durability = await collection.sync()

			expect(durability, 'sync answers with who holds the write').to.deep.equal(MAJORITY)
			expect(isFullyDurable(durability!), 'a majority write is not fully durable').to.equal(false)
		})

		it('reports undefined when nothing is staged — no write happened, so there is no class to report', async () => {
			const transactor = new StampedDurabilityTransactor(new TestTransactor(), MAJORITY)
			const collection = await Collection.createOrOpen<TestAction>(transactor, 'empty-coll', initOptions)
			// The first sync flushes the invented collection's header/root, which live in the tracker
			// until then. Only after it is the collection genuinely clean.
			expect(await collection.sync(), 'the header flush is a write like any other').to.not.equal(undefined)
			expect(collection.hasUnsyncedChanges(), 'nothing left staged').to.equal(false)

			const commitsBefore = transactor.commits
			const durability = await collection.sync()

			expect(durability, 'an empty sync writes nothing, so it reports nothing').to.equal(undefined)
			expect(transactor.commits, 'an empty sync does not commit at all').to.equal(commitsBefore)
		})

		it("reports the COMMITTING attempt's class after earlier attempts were refused", async () => {
			// Two refusals, then the real commit — so the class that comes back has to be the one the
			// attempt that actually landed answered with, not anything accumulated over the refusals
			// (which wrote nothing that survived).
			const transactor = new RefuseThenStampTransactor(new TestTransactor(), 2, MAJORITY)
			const collection = await Collection.createOrOpen<TestAction>(transactor, 'retry-coll', initOptions)
			await collection.act({ type: 'set', data: { value: 'eventually' } })

			const durability = await collection.sync({ maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 })

			expect(transactor.refusals, 'the first two attempts were refused').to.equal(2)
			expect(transactor.commits, 'exactly one attempt committed').to.equal(1)
			expect(durability, "the answer is the committing attempt's").to.deep.equal(MAJORITY)
		})

		it('throws rather than reporting a class when the write never lands', async () => {
			const inner = new TestTransactor()
			const flaky = new FlakyCommitTransactor(inner, Infinity, 'always stale')
			const collection = await Collection.createOrOpen<TestAction>(flaky, 'refused-coll', initOptions)
			await collection.act({ type: 'set', data: { value: 'never-lands' } })

			const syncPromise = collection.sync({ maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 5 })
			syncPromise.catch(() => { /* asserted below - avoid unhandled rejection */ })

			await expect(syncPromise).to.be.rejectedWith(SyncRetryExhaustedError)
		})
	})

	describe('Tree and Diary forward it unchanged', () => {
		it('surfaces a torn commit\'s abandoned blocks through Tree.replace', async () => {
			const transactor = new StampedDurabilityTransactor(new TestTransactor(), TORN)
			const tree = await Tree.createOrOpen<number, { key: number, value: string }>(
				transactor, 'torn-tree', entry => entry.key)

			const durability = await tree.replace([[1, { key: 1, value: 'one' }]])

			expect(durability?.torn, 'the abandoned blocks arrive verbatim').to.deep.equal(TORN.torn)
			expect(durability?.quorum, 'the cohort class is not rewritten on the way up').to.equal('full')
			expect(isFullyDurable(durability!), 'a torn action is never fully durable, whatever the cohort said')
				.to.equal(false)
		})

		it('reports the class through Tree.sync, and undefined when the tree has nothing staged', async () => {
			const transactor = new StampedDurabilityTransactor(new TestTransactor(), MAJORITY)
			const tree = await Tree.createOrOpen<number, { key: number, value: string }>(
				transactor, 'staged-tree', entry => entry.key)
			await tree.stage([[2, { key: 2, value: 'two' }]])

			expect(await tree.sync(), 'the staged row reports its class').to.deep.equal(MAJORITY)
			expect(tree.hasUnsyncedChanges(), 'the flush emptied the tree').to.equal(false)
			expect(await tree.sync(), 'a second flush writes nothing, so it reports nothing').to.equal(undefined)
		})

		it('reports the class through Diary.append', async () => {
			const transactor = new StampedDurabilityTransactor(new TestTransactor(), MAJORITY)
			const diary = await Diary.createOrOpen<string>(transactor, 'durable-diary')

			expect(await diary.append('first entry')).to.deep.equal(MAJORITY)
		})
	})

	describe('TransactorSource.transact', () => {
		it('hands the collection the commit result rather than collapsing success to undefined', async () => {
			// Proved through the collection rather than by reaching into the source: `transact`'s value
			// is only useful if the one caller that has it passes it on, and that is what this asserts.
			const transactor = new StampedDurabilityTransactor(new TestTransactor(), MAJORITY)
			const collection = await Collection.createOrOpen<TestAction>(transactor, 'source-coll', initOptions)
			await collection.act({ type: 'set', data: { value: 'through-the-source' } })

			const durability = await collection.updateAndSync()

			expect(durability, 'updateAndSync carries the same answer as sync').to.deep.equal(MAJORITY)
			expect(durability?.cohortPeerIds, 'the cohort list is not flattened away').to.deep.equal(MAJORITY.cohortPeerIds)
		})
	})
})
