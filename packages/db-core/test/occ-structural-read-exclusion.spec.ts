import { expect } from 'chai'
// Import the aggregate barrel FIRST — importing deep modules ahead of it triggers a
// module-init order (TDZ) error in the collection-type registry (see transaction.spec.ts,
// which follows the same barrel-then-testing order).
import {
	Tree,
	KeyRange,
	KeyBound,
	ReadDependencyCollector,
	CacheSource,
	Tracker,
	ActionsEngine,
	createTransactionStamp,
	createTransactionId,
	collectOperations,
	hashOperations,
	TransactionValidator,
	type EngineRegistration,
	type ValidationCoordinatorFactory,
	type BlockStateProvider,
	type Transaction,
	type ReadDependency,
	type BlockId,
	type BlockType,
	type IBlock,
	type BlockSource,
	type Transforms,
} from '../src/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'

// Optimistic-concurrency structural read exclusion (ticket 4.7). A B-tree point lookup walks
// interior branch nodes purely to reach the target leaf; those NAVIGATION reads are excluded from
// the conflict (read) set, while the terminal leaf — the load-bearing VALUE read — is retained.
// Dropping a covered navigation read cannot admit a lost update (any concurrent restructuring that
// changes the result also bumps the retained leaf), but removes false-positive stale rejections.

describe('OCC structural read exclusion', () => {

	describe('ReadDependencyCollector: purpose tracking', () => {
		it('un-tagged reads default to value and are retained (fail-safe)', () => {
			const c = new ReadDependencyCollector()
			c.record('a' as BlockId, 1)              // no purpose -> value
			expect(c.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 1 }])
		})

		it('navigation reads are excluded from the conflict set', () => {
			const c = new ReadDependencyCollector()
			c.record('leaf' as BlockId, 3, 'value')
			c.record('branch' as BlockId, 3, 'navigation')
			const ids = c.getReadDependencies().map(r => r.blockId)
			expect(ids).to.include('leaf')
			expect(ids).to.not.include('branch')
		})

		it('value-wins: a block read as value from ANY path stays retained', () => {
			const nav_then_value = new ReadDependencyCollector()
			nav_then_value.record('x' as BlockId, 1, 'navigation')
			nav_then_value.record('x' as BlockId, 1, 'value')
			expect(nav_then_value.getReadDependencies().map(r => r.blockId)).to.include('x')

			// Order-independent: value first, then navigation, must NOT downgrade.
			const value_then_nav = new ReadDependencyCollector()
			value_then_nav.record('x' as BlockId, 1, 'value')
			value_then_nav.record('x' as BlockId, 1, 'navigation')
			expect(value_then_nav.getReadDependencies().map(r => r.blockId)).to.include('x')
		})

		it('markValue upgrades a navigation read to a retained value read (keeps revision)', () => {
			const c = new ReadDependencyCollector()
			c.record('leaf' as BlockId, 7, 'navigation')
			expect(c.getReadDependencies()).to.be.empty        // navigation-only -> dropped
			c.markValue('leaf' as BlockId)
			expect(c.getReadDependencies()).to.deep.equal([{ blockId: 'leaf', revision: 7 }])
		})

		it('markValue is a no-op for a never-recorded id (e.g. uncommitted staged insert)', () => {
			const c = new ReadDependencyCollector()
			c.markValue('ghost' as BlockId)
			expect(c.getReadDependencies()).to.be.empty
		})

		it('revision is still max-wins regardless of purpose', () => {
			const c = new ReadDependencyCollector()
			c.record('a' as BlockId, 5, 'navigation')
			c.record('a' as BlockId, 3, 'value')   // lower rev, but value pins purpose
			expect(c.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 5 }])
		})
	})

	describe('CacheSource: purpose threads through capture', () => {
		function makeRevSource(blocks: Map<string, IBlock>, revs: Map<string, number>): BlockSource<IBlock> {
			return {
				tryGet: async (id: BlockId) => {
					const b = blocks.get(id)
					return b ? structuredClone(b) : undefined
				},
				generateId: () => 'gen' as BlockId,
				createBlockHeader: (type: BlockType) => ({ id: 'gen' as BlockId, type, collectionId: 'col' as BlockId }),
				getReadRevision: (id: BlockId) => revs.get(id),
			} as BlockSource<IBlock>
		}

		function block(id: string): IBlock {
			return { header: { id: id as BlockId, type: 'T' as BlockType, collectionId: 'col' as BlockId } }
		}

		it('a navigation cache read is dropped; markReadValue re-retains it', async () => {
			const collector = new ReadDependencyCollector()
			const blocks = new Map([['n', block('n')]])
			const cache = new CacheSource<IBlock>(makeRevSource(blocks, new Map([['n', 4]])), undefined, collector)

			await cache.tryGet('n' as BlockId, 'navigation')   // miss-load as navigation
			expect(collector.getReadDependencies(), 'navigation-only read excluded').to.be.empty

			cache.markReadValue('n' as BlockId)                // point-lookup leaf upgrade
			expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'n', revision: 4 }])
		})

		it('a value cache read (default) is retained — the path log/chain reads rely on', async () => {
			const collector = new ReadDependencyCollector()
			const blocks = new Map([['v', block('v')]])
			const cache = new CacheSource<IBlock>(makeRevSource(blocks, new Map([['v', 2]])), undefined, collector)
			await cache.tryGet('v' as BlockId)                 // default purpose = value
			expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'v', revision: 2 }])
		})

		it('Tracker forwards purpose AND markReadValue down to the CacheSource collector (reopen-path chain)', async () => {
			// The reopened-tree read path is BTree -> Tracker -> CacheSource -> collector (no AtomicProxy,
			// unlike a freshly-created tree). Exercise the two forwards the point lookup relies on:
			// Tracker.tryGet must thread `navigation` through, and Tracker.markReadValue must reach the
			// CacheSource so the terminal leaf is re-retained.
			const collector = new ReadDependencyCollector()
			const blocks = new Map([['n', block('n')]])
			const cache = new CacheSource<IBlock>(makeRevSource(blocks, new Map([['n', 9]])), undefined, collector)
			const tracker = new Tracker<IBlock>(cache)

			await tracker.tryGet('n' as BlockId, 'navigation')  // navigation threads Tracker -> CacheSource
			expect(collector.getReadDependencies(), 'navigation-only read excluded through the tracker').to.be.empty

			tracker.markReadValue('n' as BlockId)               // forwards Tracker -> CacheSource -> collector
			expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'n', revision: 9 }])
		})
	})

	describe('Tree point lookup vs scan (real store chain, small fan-out for a multi-level tree)', () => {
		// Capacity 4 makes ~60 entries build a 3-level tree (root -> interior branch(es) -> leaves),
		// so a descent has an interior branch to drop. With the default fan-out (64) you would need
		// thousands of entries before any interior node exists between root and leaf.
		const NODE_CAPACITY = 4
		const COUNT = 60
		const TARGET = 27

		async function buildTree() {
			const network = new TestTransactor()
			const tree = await Tree.createOrOpen<number, { key: number }>(
				network, 'occ-tree', e => e.key, undefined, NODE_CAPACITY
			)
			await tree.replace(Array.from({ length: COUNT }, (_, i) => [i, { key: i }] as [number, { key: number }]))
			return tree
		}

		it('get() drops interior branch reads and retains the leaf (and the root)', async () => {
			const tree = await buildTree()
			const coll = tree.getCollection()

			// find() (navigate=false) descends and retains everything — use it to name the structural
			// blocks on the path to TARGET. branches[0] is the root; branches[1..] are interior; then leaf.
			const path = await tree.find(TARGET)
			expect(path.on, 'target present').to.be.true
			expect(path.branches.length, 'tree must have >=1 interior level below the root').to.be.greaterThan(1)
			const rootId = path.branches[0]!.node.header.id
			const interiorIds = path.branches.slice(1).map(b => b.node.header.id)
			const leafId = path.leafNode.header.id

			// Probe a clean point lookup.
			coll.clearReadDependencies()
			expect(await tree.get(TARGET)).to.deep.equal({ key: TARGET })
			const reads = new Set(coll.getReadDependencies().map(r => r.blockId))

			expect(reads.has(leafId), 'terminal leaf retained (load-bearing value read)').to.be.true
			for (const iid of interiorIds) {
				expect(reads.has(iid), `interior branch ${iid} dropped from conflict set`).to.be.false
			}
			expect(reads.has(rootId), 'root retained (conservative: read via the trunk as a value read)').to.be.true
		})

		it('find() (navigable path) conservatively retains interior reads', async () => {
			const tree = await buildTree()
			const coll = tree.getCollection()
			const path = await tree.find(TARGET)
			const interiorIds = path.branches.slice(1).map(b => b.node.header.id)
			expect(interiorIds.length).to.be.greaterThan(0)

			coll.clearReadDependencies()
			await tree.find(TARGET)   // public find -> navigate=false, everything retained
			const reads = new Set(coll.getReadDependencies().map(r => r.blockId))
			for (const iid of interiorIds) {
				expect(reads.has(iid), `find retains interior ${iid} (path may seed a scan)`).to.be.true
			}
		})

		it('range scan retains interior/structure reads', async () => {
			const tree = await buildTree()
			const coll = tree.getCollection()
			const path = await tree.find(TARGET)
			const interiorIds = path.branches.slice(1).map(b => b.node.header.id)

			coll.clearReadDependencies()
			const seen: number[] = []
			for await (const p of tree.range(new KeyRange(new KeyBound(25), new KeyBound(30)))) {
				const e = tree.at(p)
				if (e) seen.push(e.key)
			}
			expect(seen).to.deep.equal([25, 26, 27, 28, 29, 30])
			const reads = new Set(coll.getReadDependencies().map(r => r.blockId))
			// At least one interior node on the TARGET path lies within the scanned range and must be retained.
			const retainedInterior = interiorIds.some(iid => reads.has(iid))
			expect(retainedInterior, 'range retains structural reads (result depends on tree shape)').to.be.true
		})

		it('point lookup read set is deterministic across re-execution', async () => {
			const tree = await buildTree()
			const coll = tree.getCollection()

			coll.clearReadDependencies()
			await tree.get(TARGET)
			const first = coll.getReadDependencies().map(r => `${r.blockId}@${r.revision}`).sort()

			coll.clearReadDependencies()
			await tree.get(TARGET)
			const second = coll.getReadDependencies().map(r => `${r.blockId}@${r.revision}`).sort()

			expect(second).to.deep.equal(first)
			expect(first.length).to.be.greaterThan(0)
		})

		it('absent-key lookup still retains the leaf it descended to (miss covered)', async () => {
			const tree = await buildTree()
			const coll = tree.getCollection()
			// 100 is absent; the descent still terminates at the leaf where it WOULD live.
			const path = await tree.find(100)
			expect(path.on).to.be.false
			const leafId = path.leafNode.header.id

			coll.clearReadDependencies()
			expect(await tree.get(100)).to.be.undefined
			const reads = new Set(coll.getReadDependencies().map(r => r.blockId))
			expect(reads.has(leafId), 'miss descent leaf retained (carries the negative result)').to.be.true
		})
	})

	describe('validator consequence of the reduced read set', () => {
		// The reduced read set = terminal leaf only (interior dropped). These tests exercise the
		// unchanged validator against that set to show the SAFETY consequence: a change that moves the
		// queried key bumps the retained leaf -> still rejected; a change to an interior node the lookup
		// only navigated through is no longer in the set -> no false-positive rejection.
		const LEAF = 'leaf-block' as BlockId
		const INTERIOR = 'interior-block' as BlockId
		const READ_REV = 3

		function makeValidator(blockRevs: Map<BlockId, number>) {
			const engines = new Map<string, EngineRegistration>()
			engines.set('actions@1.0.0', { engine: new ActionsEngine(), getSchemaHash: async () => 'schema-1' })
			const createValidationCoordinator: ValidationCoordinatorFactory = () => ({
				applyActions: async () => {},
				getTransforms: () => new Map<string, Transforms>(),
				dispose: () => {},
			})
			const blockStateProvider: BlockStateProvider = async (id: BlockId) => {
				const rev = blockRevs.get(id)
				return rev === undefined ? undefined : { latest: { actionId: `a${rev}` as any, rev } }
			}
			return new TransactionValidator(engines, createValidationCoordinator, blockStateProvider)
		}

		async function makeTxn(reads: ReadDependency[]): Promise<Transaction> {
			const stamp = await createTransactionStamp('peer', Date.now(), 'schema-1', 'actions@1.0.0')
			return { stamp, statements: [], reads, id: await createTransactionId(stamp.id, [], reads) }
		}

		const emptyOpsHash = async () => hashOperations(collectOperations(new Map<string, Transforms>()))

		it('split-moves-key: the retained leaf bumps -> transaction is stale-rejected', async () => {
			// Reduced set holds only the leaf. A concurrent split that moves the key modifies that leaf.
			const validator = makeValidator(new Map([[LEAF, READ_REV + 1]]))   // leaf advanced
			const txn = await makeTxn([{ blockId: LEAF, revision: READ_REV }])
			const result = await validator.validate(txn, await emptyOpsHash())
			expect(result.valid).to.be.false
			expect(result.reason).to.include('Stale read')
		})

		it('interior-only change: the dropped branch is not in the set -> no false-positive rejection', async () => {
			// Leaf unchanged; an interior node the lookup merely navigated through bumped — but it was
			// excluded from the reduced set, so it cannot be consulted and cannot cause a stale reject.
			const validator = makeValidator(new Map([[LEAF, READ_REV], [INTERIOR, READ_REV + 5]]))
			const txn = await makeTxn([{ blockId: LEAF, revision: READ_REV }])   // interior NOT present
			const result = await validator.validate(txn, await emptyOpsHash())
			expect(result.reason ?? '', 'interior bump must not stale-reject').to.not.include('Stale read')
			expect(result.valid, 'commits: the interior read was safely dropped').to.be.true
		})
	})
})
