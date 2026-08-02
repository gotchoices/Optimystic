import { expect } from 'chai'
import { Collection, CollectionHeaderVanishedError, SyncRetryExhaustedError } from '../src/index.js'
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
 * A collection must never LOWER the revision it already knows it committed at.
 *
 * Two reads can talk it into doing so: a header read that answers "nothing was ever
 * committed under this id", and a log read served by a node whose replica lags. Before
 * the fix, `Collection.updateInternal` assigned the log's context unconditionally
 * (`this.source.actionContext = latest?.context`), so either read reset the context —
 * and every subsequent `sync` retry recomputed `newRev = (rev ?? 0) + 1` and re-requested
 * revision 1, learning nothing from ten stale rejections that each named the real
 * revision. `Collection.attachToLog` had the same shape on the open path.
 *
 * Now: an assignment may advance the revision or leave it alone, never lower it; and a
 * header that reads absent while a committed revision is held is a contradiction that
 * throws {@link CollectionHeaderVanishedError} instead of silently no-opping.
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
	/** Every rev a pend was attempted at, in order — the diagnostic these tests are about. */
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

/**
 * Wraps a transactor and answers every read as of `pinnedRev` instead of latest — the
 * behaviour of a peer whose replica has fallen behind. Block CONTENT lags; the per-block
 * `state.latest` the underlying transactor reports does not (a lagging peer still knows
 * which revision it is being asked about). Writes are untouched.
 */
class StaleViewTransactor implements ITransactor {
	/** Revision to answer reads at; undefined serves latest. */
	pinnedRev: number | undefined

	constructor(private readonly inner: TestTransactor) { }

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		return this.inner.get(this.pinnedRev === undefined
			? blockGets
			: { ...blockGets, context: { committed: [], rev: this.pinnedRev } })
	}
	async getStatus(actionRefs: ActionBlocks[]) { return this.inner.getStatus(actionRefs) }
	async pend(request: PendRequest) { return this.inner.pend(request) }
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

describe('a collection never lowers the revision it already holds', () => {
	it('throws instead of forgetting the revision when its header reads absent', async () => {
		const collectionId = 'context-lost-on-absent-header'
		const inner = new TestTransactor()
		await seedRevisions(inner, collectionId, 3)

		const blind = new HeaderHidingTransactor(inner, collectionId)
		blind.hide = false
		const collection = await Collection.createOrOpen<TestAction>(blind, collectionId, initOptions)
		expect(collection.getNextRev(), 'opened over the committed log, so rev 3 → next 4').to.equal(4)

		blind.hide = true
		let caught: unknown
		try {
			await collection.update()
		} catch (e) {
			caught = e
		}

		expect(caught, 'an absent header contradicts a held revision — that is a fault').to.be.instanceOf(CollectionHeaderVanishedError)
		const error = caught as CollectionHeaderVanishedError
		expect(error.collectionId, 'the error names the collection').to.equal(collectionId)
		expect(error.heldRev, 'the error names the revision that was held').to.equal(3)
		expect(error.message).to.contain(collectionId)
		expect(error.message).to.contain('3')
		expect(collection.getNextRev(), 'and the known revision survives the failed update').to.equal(4)
	})

	it('fails a sync immediately instead of re-requesting rev 1 until the budget is exhausted', async () => {
		const collectionId = 'wedged-collection'
		const inner = new TestTransactor()
		await seedRevisions(inner, collectionId, 3)

		const blind = new HeaderHidingTransactor(inner, collectionId)
		blind.hide = false
		const collection = await Collection.createOrOpen<TestAction>(blind, collectionId, initOptions)
		expect(collection.getNextRev()).to.equal(4)

		// A rival takes rev 4 through the real transactor, so our first pend loses the race and
		// sync drops into its retry path — which re-reads the header, and now cannot see it.
		await seedRevisions(inner, collectionId, 1)

		await collection.act(act('from-us'))
		blind.hide = true

		let caught: unknown
		try {
			await collection.sync({ maxAttempts: 10, baseBackoffMs: 1, maxBackoffMs: 2 })
		} catch (e) {
			caught = e
		}

		expect(caught, 'the contradiction aborts the sync rather than being absorbed as a stale failure')
			.to.be.instanceOf(CollectionHeaderVanishedError)
		expect(caught, 'specifically NOT the ten-retry timeout the defect produced')
			.to.not.be.instanceOf(SyncRetryExhaustedError)
		// One pend, at the revision we actually held — not ten at rev 1.
		expect(blind.pendRevs, 'exactly one attempt, at the held rev + 1').to.deep.equal([4])
	})

	it('keeps its revision when a lagging peer serves an older view of the log', async () => {
		const collectionId = 'lagging-peer-on-update'
		const inner = new TestTransactor()
		await seedRevisions(inner, collectionId, 3)

		const lagging = new StaleViewTransactor(inner)
		const collection = await Collection.createOrOpen<TestAction>(lagging, collectionId, initOptions)
		expect(collection.getNextRev(), 'opened over the current log, so rev 3 → next 4').to.equal(4)

		// The header still reads (so no contradiction to throw on), but the log walk now sees
		// only the entries that existed at rev 1 — `getFrom` therefore reports a context at rev 1.
		lagging.pinnedRev = 1
		await collection.update()

		expect(collection.getNextRev(), 'a lagging log read cannot drag the context backwards').to.equal(4)
	})

	it('keeps its revision when a lagging peer serves an older view during open', async () => {
		// The same rule on the open path: `attachToLog` bootstraps the context from the committed
		// tail's state and then adopts `Log.getActionContext()`, which reflects only the entries
		// the lagging replica can see.
		const collectionId = 'lagging-peer-on-open'
		const inner = new TestTransactor()
		await seedRevisions(inner, collectionId, 3)

		const lagging = new StaleViewTransactor(inner)
		lagging.pinnedRev = 1
		const collection = await Collection.createOrOpen<TestAction>(lagging, collectionId, initOptions)

		expect(collection.getNextRev(), 'the committed tail proves rev 3, so the lagging log walk must not lower it').to.equal(4)
	})

	it('still no-ops for a collection that has never committed anything', async () => {
		// The genuinely-absent case: no revision is held, so there is nothing to contradict and
		// nothing to protect. `update()` must stay a silent no-op exactly as before.
		const collectionId = 'never-committed'
		const inner = new TestTransactor()
		const blind = new HeaderHidingTransactor(inner, collectionId)
		const invented = await Collection.createOrOpen<TestAction>(blind, collectionId, initOptions)
		expect(invented.getNextRev(), 'an invented collection starts at rev 1').to.equal(1)

		await invented.update()

		expect(invented.getNextRev(), 'nothing was held, so nothing changed').to.equal(1)
	})

	it('a collection invented against a hidden header still cannot make progress', async () => {
		// Documents the arm this ticket deliberately does NOT close. Here the collection holds no
		// revision at all, so there is no contradiction to detect: it invents a rival empty
		// collection and re-requests rev 1 forever. Making the header read answer correctly in the
		// first place is `cluster-read-consult-cannot-report-unreachable`; giving the client the
		// coordinator's revision to rebase onto is `stale-failure-carries-coordinator-revision`.
		const collectionId = 'invented-rival'
		const inner = new TestTransactor()
		await seedRevisions(inner, collectionId, 3)

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
		expect(new Set(blind.pendRevs), 'every retry re-requests the same rev').to.deep.equal(new Set([1]))
	})
})
