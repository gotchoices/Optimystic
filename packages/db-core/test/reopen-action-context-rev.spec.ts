import { expect } from 'chai'
import { Collection } from '../src/collection/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import type { Action, ActionHandler, BlockStore, IBlock } from '../src/index.js'

interface TestAction { value: string }

// A collection re-opened over an EXISTING log must resume at the log's current
// revision. `Collection.attachToLog` takes it from `Log.getActionContext()`.
describe('re-opened collection action context', () => {
	const collectionId = 'reopen-rev'
	const handlers: Record<string, ActionHandler<TestAction>> = {
		set: async (_action, store) => {
			store.insert({ header: store.createBlockHeader('TEST', store.generateId()) })
		}
	}
	const initOptions = {
		modules: handlers,
		createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({
			header: store.createBlockHeader('TEST', id)
		})
	}
	const act = (value: string): Action<TestAction> => ({ type: 'set', data: { value } })

	it('resumes at the committed revision instead of restarting at 1', async () => {
		const transactor = new TestTransactor()

		const writer = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
		for (const v of ['a', 'b', 'c']) {
			await writer.act(act(v))
			await writer.sync()
		}
		expect(writer.getNextRev(), 'the writer is at rev 3, so its next rev is 4').to.equal(4)

		const reopened = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
		expect(reopened.getNextRev(), 're-opening the same collection resumes at rev 4').to.equal(4)
	})
})
