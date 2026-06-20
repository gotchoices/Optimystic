import { expect } from 'chai'
import { Log } from '../src/log/index.js'
import type { ReadDependency } from '../src/index.js'
import { TestLogStore } from './test-log-store.js'
import { generateNumericActionId } from './generate-numeric-action-id.js'

/**
 * Read-set persistence (invalidation cascade prerequisite). The committed read set must survive a
 * log write/read round-trip so a later cascade can discover an action's read-dependents. Legacy
 * entries written without a read set stay distinguishable (`reads === undefined`) from a transaction
 * that genuinely read nothing (`reads === []`).
 */
describe('Log action read-set persistence', () => {
	let store: TestLogStore

	beforeEach(() => {
		store = new TestLogStore()
	})

	it('round-trips a committed read set through the log chain', async () => {
		const log = await Log.create<string>(store)
		const id = generateNumericActionId(1)
		const reads: ReadDependency[] = [
			{ blockId: 'block-A', revision: 3 },
			{ blockId: 'block-B', revision: 7 },
		]

		const { entry } = await log.addActions(['op'], id, 1, () => ['block-W'], [], reads)
		expect(entry.action?.reads).to.deep.equal(reads)

		// Survives a fresh read back through getFrom.
		const fromStart = await log.getFrom(0)
		expect(fromStart.entries[0]?.reads).to.deep.equal(reads)

		// And through forward iteration.
		const iterated: (ReadDependency[] | undefined)[] = []
		for await (const e of log.select()) {
			if (e.action) iterated.push(e.action.reads)
		}
		expect(iterated).to.deep.equal([reads])
	})

	it('distinguishes a legacy entry (no read set) from one that read nothing', async () => {
		const log = await Log.create<string>(store)
		const legacyId = generateNumericActionId(1)
		const emptyId = generateNumericActionId(2)

		// Legacy path (no reads argument): undefined — the cascade treats this as an unknown dependency.
		await log.addActions(['legacy'], legacyId, 1, () => [])
		// Explicit empty read set: a transaction that genuinely read nothing.
		await log.addActions(['empty'], emptyId, 2, () => [], [], [])

		const { entries } = await log.getFrom(0)
		const legacy = entries.find(e => e.actionId === legacyId)
		const empty = entries.find(e => e.actionId === emptyId)
		expect(legacy?.reads).to.equal(undefined)
		expect(empty?.reads).to.deep.equal([])
	})
})
