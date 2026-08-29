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
 * `computeBlockContentDigests` describes a commit WITHOUT loading anything: it peeks the read cache
 * for each touched block's base and omits any id the cache cannot answer for. The cache
 * (`CacheSource`) is an LRU with a default capacity of 128, and a `Collection` builds exactly one at
 * that default (`collection.ts` `probeHeader`). So coverage is bounded by the CACHE, not by the
 * transaction — and a commit whose update-carrying blocks outnumber the capacity declares only the
 * ids still resident.
 *
 * That matters more than the omission-is-safe framing suggests: an undeclared block retains no
 * durable commit proof and so can never GAIN a holder by push. The consequence is stated in full at
 * `CommitRequest.blockDigests` in `src/network/struct.ts`.
 *
 * These tests measure that, through the production path (`Collection.act` → `Collection.sync` →
 * `computeBlockContentDigests`), rather than by poking the digest function directly — the unit-level
 * mechanics already have coverage in `digest.spec.ts`. They are the standing guard for the whole
 * class: if a remediation lands (size the cache to the transaction, or carry the base revision
 * alongside the staged updates), `declares every block it touches` starts passing and
 * `pins today's gap` starts failing, which is the signal to retire the second test and the NOTEs it
 * cites.
 */

/** Must match `CacheSource`'s `DefaultMaxSize`, which is what `Collection` constructs with.
 *
 * NOTE: the assertions below pin the SHAPE of the gap (bounded by the cache; identical at 2x and 4x),
 * not the exact declared count — deliberately, so they do not break on an off-by-one in how many
 * slots the collection's own header and log tail occupy. The consequence is that the concrete table
 * quoted in `src/transform/digest.ts` and in `debt-digest-coverage-capped-by-read-cache` (126
 * declared at N>=128) is NOT pinned by anything and will rot silently if `DefaultMaxSize` changes.
 * Re-measure it there if you change the cache default; last confirmed 2026-08-28. */
const CacheCapacity = 128

interface TestAction { id?: string; op?: BlockOperation }

/** Captures every CommitRequest reaching the transactor, delegating everything else. */
class CapturingTransactor implements ITransactor {
	readonly commits: CommitRequest[] = []
	constructor(private readonly inner: TestTransactor) { }
	get(b: BlockGets): Promise<GetBlockResults> { return this.inner.get(b) }
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
		update: async (action: { data: TestAction }, store: BlockStore<IBlock>) => {
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

describe('commit digest coverage under read-cache pressure', () => {
	/** Drives one insert-then-update-everything round over `count` data blocks and reports what the
	 *  update sync declared. */
	async function measure(count: number, collectionId: string) {
		const inner = new TestTransactor()
		const transactor = new CapturingTransactor(inner)
		const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

		const ids = Array.from({ length: count }, (_, i) => `blk-${String(i).padStart(4, '0')}`)
		await seedBlocks(collection, ids)

		const from = transactor.commits.length
		for (const id of ids) {
			await collection.act({ type: 'update', data: { id, op: ['items', 0, 0, ['v']] } })
		}
		await collection.sync()
		expect(transactor.commits.length, 'the update round committed').to.be.greaterThan(from)

		const { touched, declared } = coverageSince(transactor, from)
		const updatedTouched = ids.filter(id => touched.has(id))
		const updatedDeclared = ids.filter(id => declared.has(id))
		return { ids, touched, declared, updatedTouched, updatedDeclared }
	}

	// Control: a transaction that fits inside the cache declares everything it touches. Without this,
	// the pressure test below could pass for a reason unrelated to eviction (a broken harness that
	// never declares anything at all would look identical).
	it('declares every update-carrying block when the transaction fits in the read cache', async function () {
		this.timeout(30_000)
		const { updatedTouched, updatedDeclared } = await measure(CacheCapacity / 4, 'digest-coverage-small')

		expect(updatedTouched.length, 'every seeded block is in the update commit').to.equal(CacheCapacity / 4)
		expect(updatedDeclared, 'a transaction inside the cache declares all of it')
			.to.deep.equal(updatedTouched)
	})

	// The measurement arm C exists for. Twice the cache capacity in update-carrying blocks.
	it('pins today\'s gap: a transaction larger than the read cache declares only part of itself', async function () {
		this.timeout(60_000)
		const count = CacheCapacity * 2
		const { updatedTouched, updatedDeclared } = await measure(count, 'digest-coverage-large')

		expect(updatedTouched.length, 'every seeded block is in the update commit').to.equal(count)

		// The gap. When a remediation lands this flips and this test must be retired along with the
		// accepted-tradeoff NOTEs at `transform/digest.ts` and `network/struct.ts` that cite it.
		expect(updatedDeclared.length, 'coverage is bounded by the cache, so it is short of the transaction')
			.to.be.lessThan(updatedTouched.length)

		// ...and bounded by the cache specifically: the shortfall is never larger than eviction can
		// explain. The collection's own header and log tail share the same 128 slots, so the declared
		// count lands just under the capacity rather than exactly on it.
		expect(updatedDeclared.length, 'no more update-carrying blocks are declared than the cache can hold')
			.to.be.at.most(CacheCapacity)

		// The surviving declarations are the RECENT ids, not an arbitrary subset — the LRU evicts
		// oldest-first and the seeding loop touches ids in order. This is what makes the shortfall
		// attributable to eviction rather than to some unrelated omission (an unreplayable op, a
		// delete) that `digest.spec.ts` covers separately.
		const declaredIndexes = updatedDeclared.map(id => updatedTouched.indexOf(id))
		expect(Math.min(...declaredIndexes), 'the undeclared blocks are the oldest ones, i.e. the evicted ones')
			.to.be.greaterThan(0)
		expect(Math.max(...declaredIndexes), 'the newest touched block is still resident, so still declared')
			.to.equal(updatedTouched.length - 1)
	})

	// The sharpest form of the defect, and the reason it is worth a standing guard rather than a
	// comment: coverage does not merely thin out with transaction size, it CAPS. The number of
	// declared blocks is a function of the cache capacity alone, so it is identical at 2x and 4x
	// capacity while the touched count doubles — i.e. declared coverage decays as 1/N, and an
	// arbitrarily large commit declares an arbitrarily small fraction of itself.
	it('the declared count saturates at the cache capacity, so coverage decays as 1/N', async function () {
		this.timeout(120_000)
		const twoX = await measure(CacheCapacity * 2, 'digest-coverage-2x')
		const fourX = await measure(CacheCapacity * 4, 'digest-coverage-4x')

		expect(fourX.updatedTouched.length, 'the 4x transaction really does touch twice as much')
			.to.equal(twoX.updatedTouched.length * 2)
		expect(fourX.updatedDeclared.length, 'but declares exactly as many blocks as the 2x one')
			.to.equal(twoX.updatedDeclared.length)
	})
})
