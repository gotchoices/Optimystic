import { expect } from 'chai'
import { TransactorSource } from '../src/transactor/transactor-source.js'
import { CacheSource } from '../src/transform/cache-source.js'
import { ReadDependencyCollector } from '../src/transaction/read-dependency-collector.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import type { ActionId, BlockId, IBlock } from '../src/index.js'

// Regression for the bug where a block served from the cache recorded NO read dependency:
// reads flow Tracker -> CacheSource -> TransactorSource, and the dependency was written only
// on a source fetch. A cache HIT (which never touches the source) therefore left the block out
// of the transaction's read set, so the optimistic-concurrency stale-read check could not fire.
//
// The fix shares ONE ReadDependencyCollector between the TransactorSource and the CacheSource,
// and the CacheSource re-emits the revision it learned when it first loaded the block. So the
// realistic wiring passes the same collector to both layers (what Collection.createOrOpen does);
// the ticket's `source.getReadDependencies()` assertions then work because that accessor
// delegates to the shared collector.
describe('repro: read-dependency capture misses cache hits', () => {
	const collectionId = 'coll' as BlockId
	const blockId = 'blk' as BlockId

	async function seedBlock(transactor: TestTransactor) {
		await transactor.pend({
			actionId: 'seed' as ActionId,
			transforms: { inserts: { [blockId]: { header: { id: blockId, type: 'T' as any, collectionId } } as IBlock }, updates: {}, deletes: [] },
			policy: 'c',
		})
		await transactor.commit({ actionId: 'seed' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })
	}

	function wire(transactor: TestTransactor) {
		const collector = new ReadDependencyCollector()
		const source = new TransactorSource<IBlock>(collectionId, transactor, undefined, collector)
		const cache = new CacheSource<IBlock>(source, undefined, collector)
		return { collector, source, cache }
	}

	it('records a dependency on a cache HIT across a transaction boundary', async () => {
		const transactor = new TestTransactor()
		await seedBlock(transactor)
		const { source, cache } = wire(transactor)

		await cache.tryGet(blockId)          // txn 1: miss -> records dep
		source.clearReadDependencies()       // txn 1 commits -> clears deps
		expect(source.getReadDependencies()).to.be.empty

		await cache.tryGet(blockId)          // txn 2: cache HIT
		expect(source.getReadDependencies().map(d => d.blockId)).to.include(blockId)
	})

	it('records the block exactly once on a cache miss (source + cache collapse to one entry)', async () => {
		const transactor = new TestTransactor()
		await seedBlock(transactor)
		const { source, cache } = wire(transactor)

		await cache.tryGet(blockId)          // miss: both layers record blk@1
		const deps = source.getReadDependencies()
		expect(deps).to.have.length(1)
		expect(deps[0]).to.deep.equal({ blockId, revision: 1 })
	})

	it('does not record a dependency for an absent block (hit or miss)', async () => {
		const transactor = new TestTransactor()
		await seedBlock(transactor)
		const { source, cache } = wire(transactor)

		await cache.tryGet('absent' as BlockId) // miss:absent — nothing cached, nothing recorded
		await cache.tryGet('absent' as BlockId) // still a miss (absent is never cached)
		expect(source.getReadDependencies().map(d => d.blockId)).to.not.include('absent')
	})
})
