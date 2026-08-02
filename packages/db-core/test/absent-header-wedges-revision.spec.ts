import { expect } from 'chai'
import { Collection, SyncRetryExhaustedError } from '../src/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import type {
	Action,
	ActionBlocks,
	ActionHandler,
	BlockGets,
	BlockId,
	BlockStore,
	CommitRequest,
	GetBlockResults,
	IBlock,
	ITransactor,
	PendRequest,
} from '../src/index.js'

/**
 * What a collection does when its HEADER reads as authoritatively absent while the
 * cluster's write path knows the collection exists at a later revision.
 *
 * `Collection.updateInternal` treats an absent header as authoritative and silently
 * no-ops (collection.ts:199-202), then unconditionally assigns the log's context —
 * `this.source.actionContext = latest?.context` (collection.ts:251). With no log to
 * read, `latest` is undefined, so the assignment sets the context to `undefined`. Every
 * `sync` retry therefore recomputes `newRev = (actionContext?.rev ?? 0) + 1 === 1` and
 * asks for rev 1 again, learning nothing from ten stale rejections that each named the
 * real revision — the exact signature the sereus `control-db-two-node-convergence`
 * scenario reports (see fix/cross-node-convergence-sereus-signature-not-reproducible).
 *
 * These tests pin the CURRENT behaviour so a fix has something to flip.
 */

interface TestAction { value: string }

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

/**
 * Wraps a transactor and rewrites reads of `hiddenId` into an AUTHORITATIVE absent
 * answer (`{ state: {} }` — an entry that is present, carries no block, and sets no
 * `unavailable` flag). Writes are untouched, so pend/commit still see the real state:
 * this models a node whose header read is answered "does not exist" by a peer that
 * simply never held the block, while its pend reaches a coordinator that has it.
 */
class HeaderHidingTransactor implements ITransactor {
	hide = true
	/** Every rev a pend was attempted at, in order — the diagnostic this test is about. */
	readonly pendRevs: (number | undefined)[] = []

	constructor(private readonly inner: TestTransactor, private readonly hiddenId: BlockId) { }

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		const results = await this.inner.get(blockGets)
		if (this.hide && blockGets.blockIds.includes(this.hiddenId)) {
			results[this.hiddenId] = { state: {} }
		}
		return results
	}
	async getStatus(actionRefs: ActionBlocks[]) { return this.inner.getStatus(actionRefs) }
	async pend(request: PendRequest) {
		this.pendRevs.push(request.rev)
		return this.inner.pend(request)
	}
	async cancel(actionRef: ActionBlocks) { return this.inner.cancel(actionRef) }
	async commit(request: CommitRequest) { return this.inner.commit(request) }
}

/** Commit `count` revisions of `collectionId` through `transactor`. */
async function seedRevisions(transactor: TestTransactor, collectionId: string, count: number): Promise<void> {
	const writer = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
	for (let i = 0; i < count; i++) {
		await writer.act(act(`seed-${i}`))
		await writer.sync()
	}
}

describe('a header that reads absent wedges the revision context at rev 1', () => {
	it('re-requests rev 1 on every retry until the budget is exhausted', async () => {
		const collectionId = 'wedged-collection'
		const inner = new TestTransactor()
		await seedRevisions(inner, collectionId, 3)

		// This node cannot see the header, so createOrOpen invents a rival empty collection.
		const blind = new HeaderHidingTransactor(inner, collectionId)
		const joiner = await Collection.createOrOpen<TestAction>(blind, collectionId, initOptions)
		expect(joiner.getNextRev(), 'an invented collection starts at rev 1').to.equal(1)

		await joiner.act(act('from-joiner'))

		let caught: unknown
		try {
			await joiner.sync({ maxAttempts: 4, baseBackoffMs: 1, maxBackoffMs: 2 })
		} catch (e) {
			caught = e
		}

		expect(caught, 'the sync must not silently succeed').to.be.instanceOf(SyncRetryExhaustedError)
		expect((caught as Error).message).to.match(/exhausted \d+ retries/)
		// The point of the test: every attempt asked for the SAME revision. The rejections
		// each named a later one, and none of them moved the client forward.
		expect(blind.pendRevs.length).to.be.greaterThan(1)
		expect(new Set(blind.pendRevs), 'every retry re-requests the same rev').to.deep.equal(new Set([1]))
	})

	it('resets an already-correct revision context to undefined on update()', async () => {
		// The narrower latent defect, independent of whether the collection was invented:
		// a collection that HAS a good context loses it the moment one header read answers
		// absent, because updateInternal assigns `latest?.context` unconditionally.
		const collectionId = 'context-lost-on-absent-header'
		const inner = new TestTransactor()
		await seedRevisions(inner, collectionId, 3)

		const blind = new HeaderHidingTransactor(inner, collectionId)
		blind.hide = false
		const collection = await Collection.createOrOpen<TestAction>(blind, collectionId, initOptions)
		expect(collection.getNextRev(), 'opened over the committed log, so rev 3 → next 4').to.equal(4)

		blind.hide = true
		await collection.update()

		expect(collection.getNextRev(), 'an absent header read wipes the known revision').to.equal(1)
	})
})
