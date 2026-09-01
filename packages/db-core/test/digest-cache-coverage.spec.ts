import { expect } from 'chai'
import { Collection } from '../src/collection/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import type {
	ActionBlocks, BlockActionStatus, BlockGets, BlockOperation, BlockStore, CommitRequest,
	CommitResult, GetBlockResults, IBlock, ITransactor, PendRequest, PendResult,
} from '../src/index.js'

/**
 * Declaration coverage under read-cache pressure.
 *
 * `computeBlockContentDigests` describes a commit WITHOUT loading anything: each updated block's
 * committed base is PINNED at the moment its update is staged (`Tracker.update` -> `BasePins`) and
 * the digest pass materializes from the pin, so coverage follows what the transaction read and
 * staged — NOT what still happens to be resident in the 128-entry `CacheSource` LRU when the sync
 * finally runs. The `update` module below reads the block before updating it, which is what every
 * production caller (the B-tree write path specifically) does; that read is the moment the base
 * gets pinned.
 *
 * Declaration matters more than the omission-is-safe framing suggests: an undeclared block retains
 * no durable commit proof and so can never GAIN a holder by push. The consequence is stated in full
 * at `CommitRequest.blockDigests` in `src/network/struct.ts`.
 *
 * These tests measure coverage through the production path (`Collection.act` → `Collection.sync` →
 * `computeBlockContentDigests`), rather than by poking the digest function directly — the
 * unit-level pin mechanics have their own coverage in `digest.spec.ts`. The one legitimate
 * remaining omission for updates — a blind update to a block this node never read and that is not
 * cached — has its own guard below, asserting it stays undeclared WITHOUT paying a network read.
 */

/** Must match `CacheSource`'s `DefaultMaxSize`, which is what `Collection` constructs with. The
 * pressure tests below stage transactions at multiples of this so eviction of every early base is
 * guaranteed before the sync-time digest pass runs. */
const CacheCapacity = 128

interface TestAction { id?: string; op?: BlockOperation }

/** Captures every CommitRequest reaching the transactor, and every block id requested through
 * `get`, delegating everything else. */
class CapturingTransactor implements ITransactor {
	readonly commits: CommitRequest[] = []
	readonly gotIds: string[] = []
	constructor(private readonly inner: TestTransactor) { }
	get(b: BlockGets): Promise<GetBlockResults> {
		this.gotIds.push(...b.blockIds)
		return this.inner.get(b)
	}
	getStatus(a: ActionBlocks[]): Promise<BlockActionStatus[]> { return this.inner.getStatus(a) }
	pend(r: PendRequest): Promise<PendResult> { return this.inner.pend(r) }
	cancel(a: ActionBlocks): Promise<void> { return this.inner.cancel(a) }
	async commit(r: CommitRequest): Promise<CommitResult> {
		this.commits.push(structuredClone(r))
		return this.inner.commit(r)
	}
}

/** Blocks carry an `items` array so an `update` action has something valid to splice into. */
const makeBlock = (store: BlockStore<IBlock>, id: string): IBlock =>
	({ header: store.createBlockHeader('TEST', id), items: [] }) as IBlock

const initOptions = {
	modules: {
		insert: async (action: { data: TestAction }, store: BlockStore<IBlock>) => {
			store.insert(makeBlock(store, action.data.id!))
		},
		// Read-then-write, like every production caller: the read is what makes the base pinnable
		// at the moment the update is staged.
		update: async (action: { data: TestAction }, store: BlockStore<IBlock>) => {
			await store.tryGet(action.data.id!)
			store.update(action.data.id!, action.data.op!)
		},
		// The blind form — no read — kept for the carve-out test below.
		blindUpdate: async (action: { data: TestAction }, store: BlockStore<IBlock>) => {
			store.update(action.data.id!, action.data.op!)
		},
	},
	createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({
		header: store.createBlockHeader('TEST', id),
	}),
}

/** Union of `blockIds` / declared digest keys across every commit captured since `from`. A single
 *  `sync()` can emit more than one CommitRequest (log batching), so per-commit assertions would
 *  under-count; coverage is a property of the whole sync. */
function coverageSince(transactor: CapturingTransactor, from: number) {
	const touched = new Set<string>()
	const declared = new Set<string>()
	for (const commit of transactor.commits.slice(from)) {
		for (const id of commit.blockIds) touched.add(id)
		for (const id of Object.keys(commit.blockDigests ?? {})) declared.add(id)
	}
	return { touched, declared }
}

/** Insert `count` data blocks and sync, so the collection holds them at a committed revision. */
async function seedBlocks(
	collection: Collection<TestAction>,
	ids: readonly string[],
): Promise<void> {
	for (const id of ids) {
		await collection.act({ type: 'insert', data: { id } })
	}
	await collection.sync()
}

function makeIds(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `blk-${String(i).padStart(4, '0')}`)
}

const updateOp: BlockOperation = ['items', 0, 0, ['v']]

describe('commit digest coverage under read-cache pressure', () => {
	async function setup(count: number, collectionId: string) {
		const inner = new TestTransactor()
		const transactor = new CapturingTransactor(inner)
		const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
		const ids = makeIds(count)
		await seedBlocks(collection, ids)
		return { transactor, collection, ids }
	}

	/** Drives one insert-then-update-everything round over `count` data blocks and reports what the
	 *  update sync declared. `actionType` picks the update module; `oneAct` batches every update
	 *  into a single act() call (one Atomic) instead of one act() per block. */
	async function measure(count: number, collectionId: string, actionType = 'update', oneAct = false) {
		const { transactor, collection, ids } = await setup(count, collectionId)

		const from = transactor.commits.length
		const actions = ids.map(id => ({ type: actionType, data: { id, op: updateOp } }))
		if (oneAct) {
			await collection.act(...actions)
		} else {
			for (const action of actions) {
				await collection.act(action)
			}
		}
		await collection.sync()
		expect(transactor.commits.length, 'the update round committed').to.be.greaterThan(from)

		const { touched, declared } = coverageSince(transactor, from)
		const updatedTouched = ids.filter(id => touched.has(id))
		const updatedDeclared = ids.filter(id => declared.has(id))
		return { ids, touched, declared, updatedTouched, updatedDeclared }
	}

	// Control: a transaction that fits inside the cache declares everything it touches. Without this,
	// the pressure tests below could pass for a reason unrelated to pinning (a broken harness that
	// declares everything blindly, or nothing at all, would need this small case to differ).
	it('declares every update-carrying block when the transaction fits in the read cache', async function () {
		this.timeout(30_000)
		const { updatedTouched, updatedDeclared } = await measure(CacheCapacity / 4, 'digest-coverage-small')

		expect(updatedTouched.length, 'every seeded block is in the update commit').to.equal(CacheCapacity / 4)
		expect(updatedDeclared, 'a transaction inside the cache declares all of it')
			.to.deep.equal(updatedTouched)
	})

	// The former defect: a transaction bigger than the cache used to declare only the ~126 ids still
	// resident at sync time (min(N, capacity-2), decaying as 1/N). Pinning the base when the update
	// is staged makes coverage a property of the transaction: every block the handlers read and
	// updated is declared, at any multiple of the cache capacity.
	it('declares every block it touches, even far beyond the cache capacity', async function () {
		this.timeout(120_000)
		const twoX = await measure(CacheCapacity * 2, 'digest-coverage-2x')
		expect(twoX.updatedDeclared, '2x the cache capacity: declared = touched')
			.to.deep.equal(twoX.updatedTouched)

		const fourX = await measure(CacheCapacity * 4, 'digest-coverage-4x')
		expect(fourX.updatedTouched.length, 'the 4x transaction really does touch twice as much')
			.to.equal(twoX.updatedTouched.length * 2)
		expect(fourX.updatedDeclared, '4x the cache capacity: declared = touched')
			.to.deep.equal(fourX.updatedTouched)
	})

	// The Atomic.commit pin-adoption leg specifically: ONE act() whose handlers read+update more
	// blocks than the cache holds. The flush to the collection tracker happens only at
	// Atomic.commit, after every read in the batch already ran — so without the atomic capturing
	// pins at stage time and adopting them into the parent, the early bases would be gone.
	it('one act() carrying more actions than the cache capacity declares them all', async function () {
		this.timeout(60_000)
		const { updatedTouched, updatedDeclared } =
			await measure(CacheCapacity * 2, 'digest-coverage-one-act', 'update', true)

		expect(updatedTouched.length, 'every seeded block is in the update commit').to.equal(CacheCapacity * 2)
		expect(updatedDeclared, 'a single oversized act() declares everything it staged')
			.to.deep.equal(updatedTouched)
	})

	// The honest carve-out: a blind update — no read — to a block whose base is no longer cached
	// has genuinely nothing to declare, and the commit must never pay a network read to describe
	// itself. Seed 2x the capacity so the OLDEST quarter is guaranteed evicted, then blind-update
	// only those: none may be declared, and none may be fetched to find out.
	it('a blind update to a block this node never read stays undeclared, without fetching', async function () {
		this.timeout(60_000)
		const { transactor, collection, ids } = await setup(CacheCapacity * 2, 'digest-coverage-blind')

		// The first quarter of the seed order — evicted from the LRU by the 192+ blocks seeded after
		// them, and never read again below.
		const evicted = ids.slice(0, CacheCapacity / 2)
		const from = transactor.commits.length
		const getsFrom = transactor.gotIds.length
		for (const id of evicted) {
			await collection.act({ type: 'blindUpdate', data: { id, op: updateOp } })
		}
		await collection.sync()

		const { touched, declared } = coverageSince(transactor, from)
		expect(evicted.filter(id => touched.has(id)), 'every blind-updated block is in the commit')
			.to.deep.equal(evicted)
		expect(evicted.filter(id => declared.has(id)), 'none of the never-read, evicted bases declare')
			.to.deep.equal([])
		const fetched = new Set(transactor.gotIds.slice(getsFrom))
		expect(evicted.filter(id => fetched.has(id)), 'and nothing was fetched to find out')
			.to.deep.equal([])
	})
})
