import { expect } from 'chai'
import { Collection } from '../src/collection/index.js'
import { TestTransactor, CommitLandsButReportsStale } from '../src/testing/test-transactor.js'
import type { Action, ActionHandler, BlockStore, IBlock } from '../src/index.js'

interface TestAction {
	value: string
	timestamp: number
}

describe('Collection: own committed action on retry', () => {
	const collectionId = 'own-action-collection'

	const handlers: Record<string, ActionHandler<TestAction>> = {
		'set': async (_action, store) => {
			const blockId = store.generateId()
			store.insert({
				header: store.createBlockHeader('TEST', blockId)
			})
		}
	}

	const initOptions = {
		modules: handlers,
		createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({
			header: store.createBlockHeader('TEST', id)
		})
	}

	const retryFast = { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 }

	async function readLog(collection: Collection<TestAction>) {
		const logged: Action<TestAction>[] = []
		for await (const logAction of collection.selectLog()) {
			logged.push(logAction)
		}
		return logged
	}

	it('consumes its own durably committed entry instead of replaying it', async () => {
		const inner = new TestTransactor()
		const transactor = new CommitLandsButReportsStale(inner)
		const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

		const action: Action<TestAction> = {
			type: 'set',
			data: { value: 'torn', timestamp: 1 }
		}
		await collection.act(action)

		// Must RESOLVE, not exhaust: the action IS durable, so the writer is owed a success.
		await collection.sync(retryFast)

		const logged = await readLog(collection)

		// Pre-fix the retry replays the pending action, re-pends at the next revision and commits a
		// second copy (the injection is spent), so the log holds the action twice.
		expect(logged).to.have.lengthOf(1)
		expect(logged[0]).to.deep.equal(action)

		// Exactly one commit ever landed on the inner transactor — the masked one.
		expect(transactor.landedCommits).to.equal(1)
		expect(collection.hasUnsyncedChanges()).to.equal(false)

		// A second reader sees the same single entry (the durable log, not this instance's view).
		const reader = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
		expect(await readLog(reader)).to.have.lengthOf(1)
	})

	it('consumes a multi-action entry without dropping or duplicating any action', async () => {
		// The consume branch slices `entry.actions.length` off the head of `pending`, so a batch of
		// more than one action is where an off-by-one would show: too small a slice re-commits a
		// duplicate, too large a slice silently loses an action that never landed.
		const inner = new TestTransactor()
		const transactor = new CommitLandsButReportsStale(inner)
		const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

		const actions: Action<TestAction>[] = [
			{ type: 'set', data: { value: 'a', timestamp: 1 } },
			{ type: 'set', data: { value: 'b', timestamp: 2 } },
			{ type: 'set', data: { value: 'c', timestamp: 3 } }
		]
		for (const action of actions) {
			await collection.act(action)
		}

		await collection.sync(retryFast)

		expect((await readLog(collection)).map(a => a.data.value)).to.deep.equal(['a', 'b', 'c'])
		expect(transactor.landedCommits).to.equal(1)
		expect(collection.hasUnsyncedChanges()).to.equal(false)

		const reader = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
		expect((await readLog(reader)).map(a => a.data.value)).to.deep.equal(['a', 'b', 'c'])
	})

	it('consumes a zero-action entry (the invented collection first sync)', async () => {
		// A brand-new collection's header/root blocks live in the tracker with NO pending action to
		// name them, so its first sync commits an entry whose `actions` array is empty. That entry
		// still has to be consumed on the torn retry: only the consume branch's unconditional
		// `mutated` resets the tracker, which is what makes `hasUnsyncedChanges()` false and lets
		// the sync loop exit reporting the success the (durable) commit earned.
		const inner = new TestTransactor()
		const transactor = new CommitLandsButReportsStale(inner)
		const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

		expect(collection.hasUnsyncedChanges()).to.equal(true)
		await collection.sync(retryFast)

		expect(await readLog(collection)).to.have.lengthOf(0)
		expect(transactor.landedCommits).to.equal(1)
		expect(collection.hasUnsyncedChanges()).to.equal(false)
	})

	it('still replays when the committed entry belongs to someone else', async () => {
		// Guard against the consumption branch firing on a foreign entry: a rival's committed action
		// must NOT be treated as this sync's own work, so the local action still lands.
		const inner = new TestTransactor()
		const rival = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
		await rival.act({ type: 'set', data: { value: 'rival', timestamp: 1 } })
		await rival.updateAndSync()

		const local = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
		await local.act({ type: 'set', data: { value: 'local', timestamp: 2 } })
		await local.sync(retryFast)

		expect((await readLog(local)).map(a => a.data.value)).to.deep.equal(['rival', 'local'])
	})

	it('update() with no in-flight action is unaffected', async () => {
		// The entry loop must behave exactly as before when no in-flight id is threaded: a plain
		// update() over a log entry this instance did not write keeps its pending action.
		const inner = new TestTransactor()
		const writer = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
		await writer.act({ type: 'set', data: { value: 'committed', timestamp: 1 } })
		await writer.updateAndSync()

		const other = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
		await other.act({ type: 'set', data: { value: 'staged', timestamp: 2 } })
		await other.update()
		expect(other.hasUnsyncedChanges()).to.equal(true)

		await other.sync(retryFast)
		expect((await readLog(other)).map(a => a.data.value)).to.deep.equal(['committed', 'staged'])
	})
})
