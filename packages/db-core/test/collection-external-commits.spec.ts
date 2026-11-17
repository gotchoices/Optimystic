import { expect } from 'chai'
import { Collection } from '../src/collection/index.js'
import { TestTransactor, TailLandsButReportsStale } from '../src/testing/test-transactor.js'
import type { ActionHandler, BlockStore, IBlock } from '../src/index.js'

interface TestAction {
	value: string
}

describe('Collection: reporting commits adopted from other writers', () => {
	const collectionId = 'external-commits-collection'

	const handlers: Record<string, ActionHandler<TestAction>> = {
		'set': async (_action, store) => {
			const blockId = store.generateId()
			store.insert({ header: store.createBlockHeader('TEST', blockId) })
		}
	}

	function initOptions(calls: number[]) {
		return {
			modules: handlers,
			createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({
				header: store.createBlockHeader('TEST', id)
			}),
			onExternalCommits: (rev: number) => { calls.push(rev) }
		}
	}

	const retryFast = { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 }

	it('reports a rival handle\'s commit, never the handle\'s own — folded or finished after a tear', async () => {
		const inner = new TestTransactor()
		const aCalls: number[] = []
		const bCalls: number[] = []

		const a = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions(aCalls))
		await a.act({ type: 'set', data: { value: 'a' } })
		await a.sync(retryFast)

		// B opens after A's commit, then commits through a transactor that lands only the log tail and
		// reports the commit refused, so B's refresh between attempts walks B's OWN entry, finishes it
		// and consumes it.
		const tearing = new TailLandsButReportsStale(inner)
		const b = await Collection.createOrOpen<TestAction>(tearing, collectionId, initOptions(bCalls))
		await b.act({ type: 'set', data: { value: 'b' } })
		await b.sync(retryFast)
		expect(tearing.tears, 'B\'s commit was actually torn').to.equal(1)
		await b.update()

		await a.update()

		expect(aCalls, 'A adopted B\'s entry once, at the revision it adopted').to.deep.equal([a.committedRevision()])
		expect(a.committedRevision()).to.equal(b.committedRevision())
		expect(bCalls, 'B never adopted anything it did not write').to.deep.equal([])
	})
})
