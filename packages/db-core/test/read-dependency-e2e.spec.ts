import { expect } from 'chai'
// Import the aggregate barrel FIRST — importing deep modules ahead of it triggers a
// module-init order (TDZ) error in the collection-type registry (see transaction.spec.ts and
// occ-structural-read-exclusion.spec.ts, which follow the same barrel-then-testing order).
import {
	Tree,
	ActionsEngine,
	ACTIONS_ENGINE_ID,
	createTransactionStamp,
	createTransactionId,
	collectOperations,
	hashOperations,
	isTransformsEmpty,
	TransactionValidator,
	type EngineRegistration,
	type ValidationCoordinatorFactory,
	type BlockStateProvider,
	type Transaction,
	type ReadDependency,
	type BlockId,
	type Transforms,
} from '../src/index.js'
import { TestTransactor, commitRivalTreeWrite } from '../src/testing/test-transactor.js'

// END-TO-END composition of the `txn-read-dependency-misses-cache-hits` fix.
//
// That fix is already covered in two SEPARATE halves:
//   - capture   — test/read-dependency-cache-hit.repro.spec.ts + test/cache-source.spec.ts prove a
//                 cache hit emits a { blockId, revision } dependency, but they hand-wire a
//                 TransactorSource + CacheSource + collector.
//   - rejection — test/transaction.spec.ts proves TransactionValidator rejects a transaction whose
//                 `reads` name a block whose revision moved, but its `reads` are hand-written.
//
// Neither drives the chain. These tests do: a REAL Collection (built by Collection.createOrOpen via
// Tree.createOrOpen, which is where the shared ReadDependencyCollector is wired into BOTH the
// source and the cache layer — collection.ts probeHeader) reads a block on a CACHE HIT, another
// writer supersedes that block, and the resulting transaction is rejected at validation.
//
// Why the rival must be a genuinely separate writer: validator.ts compares the recorded revision
// with strict `!==` against the transactor's current one. A LOCAL commit advances the cached
// revision in lockstep (syncInternal's `transformCache(transforms, newRev)`, and
// recordCommitted/applyCommittedToCache on the coordinator path), so a local commit can never
// produce a stale read. Only a cross-writer commit moves the transactor forward while the reader's
// recorded revision stays behind.
describe('read dependencies end to end: cache hit -> superseded -> stale-read rejection', () => {
	const SCHEMA_HASH = 'schema-e2e'
	type Entry = { key: number; name: string }

	const seedEntries: [number, Entry][] = [
		[1, { key: 1, name: 'one' }],
		[2, { key: 2, name: 'two' }],
		[3, { key: 3, name: 'three' }],
	]

	/** A tree with committed content. The commit resets the collection's tracker and folds the
	 *  committed blocks into its read cache, which is precisely the state a later read serves from
	 *  the CACHE rather than from staged transforms. */
	async function seedTree(transactor: TestTransactor, id: string) {
		const tree = await Tree.createOrOpen<number, Entry>(transactor, id, e => e.key)
		await tree.replace(seedEntries)
		return tree
	}

	async function currentRev(transactor: TestTransactor, blockId: BlockId): Promise<number> {
		const result = await transactor.get({ blockIds: [blockId] })
		return result[blockId]?.state?.latest?.rev ?? 0
	}

	/** The exact validator wiring from transaction.spec.ts's stale-read cases, but reading block
	 *  state from the same transactor the tree committed through. The stub coordinator factory keeps
	 *  the computed operations hash at "no transforms", so a transaction with no statements reaches
	 *  the END of validate() instead of tripping the hash compare — required for the positive cases
	 *  to mean anything. */
	function makeValidator(transactor: TestTransactor) {
		const engines = new Map<string, EngineRegistration>()
		engines.set(ACTIONS_ENGINE_ID, { engine: new ActionsEngine(), getSchemaHash: async () => SCHEMA_HASH })
		const createValidationCoordinator: ValidationCoordinatorFactory = () => ({
			applyActions: async () => {},
			getTransforms: () => new Map<string, Transforms>(),
			dispose: () => {},
		})
		const blockStateProvider: BlockStateProvider = async (blockId: BlockId) => {
			const result = await transactor.get({ blockIds: [blockId] })
			return result[blockId]?.state
		}
		return new TransactionValidator(engines, createValidationCoordinator, blockStateProvider)
	}

	async function makeTxn(reads: ReadDependency[]): Promise<Transaction> {
		const stamp = await createTransactionStamp('peer-reader', Date.now(), SCHEMA_HASH, ACTIONS_ENGINE_ID)
		return { stamp, statements: [], reads, id: await createTransactionId(stamp.id, [], reads) }
	}

	const emptyOpsHash = () => hashOperations(collectOperations(new Map<string, Transforms>()))

	/**
	 * Steps 2-4 of the ticket's flow, with the vacuous-pass guards attached: open the transaction
	 * boundary, prove the read cannot be served by the tracker, do the read, and prove the captured
	 * dependency set is both non-empty and recorded at the revisions the validator will compare
	 * against. Returns the captured set.
	 */
	async function captureCacheHitReads(
		transactor: TestTransactor,
		tree: Tree<number, Entry>,
		key: number,
		label: string,
	): Promise<ReadDependency[]> {
		const coll = tree.getCollection()

		// The transaction boundary. A dependency surviving this would let a later rejection be
		// attributed to a block this transaction never read.
		coll.clearReadDependencies()
		expect(coll.getReadDependencies(), `${label}: read set must be empty at the transaction boundary`).to.be.empty

		// Cache hit, NOT a tracker hit. syncInternal resets the collection tracker after a successful
		// commit, so the read below cannot be served by staged transforms — it must fall through to
		// the CacheSource, which is the layer the fix changed. Asserted rather than assumed: a read
		// served by the tracker records nothing and would bypass the fix entirely.
		expect(
			isTransformsEmpty(coll.tracker.transforms),
			`${label}: tracker must be empty so the read falls through to the cache`,
		).to.be.true

		const expected = seedEntries.find(([k]) => k === key)?.[1]
		expect(await tree.get(key), `${label}: seeded entry readable`).to.deep.equal(expected)

		const deps = coll.getReadDependencies()
		expect(deps, `${label}: a cache-hit read must record read dependencies (the whole point of the fix)`).to.not.be.empty

		// Every captured revision must equal what the transactor currently reports — this is the
		// exact equality validator.ts applies, so a capture that drifted here would make the
		// rejection below fire for the wrong reason.
		for (const dep of deps) {
			expect(
				dep.revision,
				`${label}: dep ${dep.blockId} must be captured at the transactor's current revision`,
			).to.equal(await currentRev(transactor, dep.blockId))
			expect(dep.revision, `${label}: no phantom revision-0 dep may leak into the read set`).to.be.greaterThan(0)
		}
		return deps
	}

	/** The block ids in `deps` whose revision has moved since capture. */
	async function movedDeps(transactor: TestTransactor, deps: ReadDependency[]): Promise<BlockId[]> {
		const moved: BlockId[] = []
		for (const dep of deps) {
			if (await currentRev(transactor, dep.blockId) !== dep.revision) moved.push(dep.blockId)
		}
		return moved
	}

	it('rejects a transaction whose cache-hit read was superseded by another writer', async () => {
		const transactor = new TestTransactor()
		const tree = await seedTree(transactor, 'users')

		const deps = await captureCacheHitReads(transactor, tree, 2, 'users')

		// A genuinely separate writer: a second Tree over the same transactor and collection id,
		// committed durably. Key 99 lands in the SAME leaf block as the reader's key (default
		// fan-out 64, four entries total), so it advances the revision of a block the reader
		// depends on.
		await commitRivalTreeWrite<number, Entry>(
			transactor, 'users', e => e.key, [[99, { key: 99, name: 'rival' }]],
		)

		const moved = await movedDeps(transactor, deps)
		expect(moved, 'the rival must supersede at least one block the reader depends on — otherwise this test proves nothing').to.not.be.empty

		const result = await makeValidator(transactor).validate(await makeTxn(deps), await emptyOpsHash())
		expect(result.valid, 'a superseded cache-hit read must not validate').to.be.false
		expect(result.reason, 'rejected for staleness, not for some other validation step').to.include('Stale read')
		// Name the block that ACTUALLY moved: asserting only on the 'Stale read' substring would
		// pass even if the rejection blamed a block the rival never touched.
		expect(
			moved.some(id => result.reason!.includes(id)),
			`reason must name a superseded block; moved=[${moved.join(', ')}] reason=${result.reason}`,
		).to.be.true
	})

	it('validates the same cache-hit read clean when nothing supersedes it', async () => {
		// The positive companion. Without it the rejection above cannot be distinguished from a
		// check that fires on everything.
		const transactor = new TestTransactor()
		const tree = await seedTree(transactor, 'users')

		const deps = await captureCacheHitReads(transactor, tree, 2, 'users')
		expect(await movedDeps(transactor, deps), 'no writer ran, so nothing may have moved').to.be.empty

		const result = await makeValidator(transactor).validate(await makeTxn(deps), await emptyOpsHash())
		expect(result.reason ?? '', 'an unsuperseded read must not stale-reject').to.not.include('Stale read')
		expect(result.valid, 'the transaction reaches the end of validate() and passes').to.be.true
	})

	it('rejects for the moved block while untouched deps in the same read set stay clean', async () => {
		// Mixed read set, made deterministic with a second collection the rival never touches:
		// `posts` deps cannot move, `users` deps do. The untouched deps are placed FIRST in the
		// reads array, so the validator has to scan past matching entries before rejecting.
		const transactor = new TestTransactor()
		const users = await seedTree(transactor, 'users')
		const posts = await seedTree(transactor, 'posts')

		const userDeps = await captureCacheHitReads(transactor, users, 2, 'users')
		const postDeps = await captureCacheHitReads(transactor, posts, 3, 'posts')
		const postIds = new Set(postDeps.map(d => d.blockId))
		expect([...postIds].some(id => userDeps.some(d => d.blockId === id)), 'the two collections must not share block ids').to.be.false

		await commitRivalTreeWrite<number, Entry>(
			transactor, 'users', e => e.key, [[99, { key: 99, name: 'rival' }]],
		)

		expect(await movedDeps(transactor, postDeps), 'TestTransactor tracks latestRev per block: an untouched collection cannot move').to.be.empty
		const movedUsers = await movedDeps(transactor, userDeps)
		expect(movedUsers, 'the rival must move at least one users block').to.not.be.empty

		const validator = makeValidator(transactor)

		// Untouched deps alone must NOT reject — an untouched block contributing a false rejection
		// would make every multi-collection transaction fail the moment any collection moved.
		const cleanOnly = await validator.validate(await makeTxn(postDeps), await emptyOpsHash())
		expect(cleanOnly.valid, 'untouched deps alone must validate').to.be.true

		const mixed = await validator.validate(await makeTxn([...postDeps, ...userDeps]), await emptyOpsHash())
		expect(mixed.valid).to.be.false
		expect(mixed.reason).to.include('Stale read')
		expect(
			movedUsers.some(id => mixed.reason!.includes(id)),
			`reason must name a moved users block; moved=[${movedUsers.join(', ')}] reason=${mixed.reason}`,
		).to.be.true
		for (const id of postIds) {
			expect(mixed.reason, `untouched block ${id} must not be blamed`).to.not.include(id)
		}
	})

	it('probing a collection that does not exist leaks no phantom revision-0 dep', async () => {
		// Collection.createOrOpen probes the header block of a collection that has never committed.
		// The capture path deliberately records NOTHING for an absent block (see CacheSource's
		// miss:absent branch and the third case in read-dependency-cache-hit.repro.spec.ts). A
		// spurious `revision: 0` dep here would make every transaction that touched a
		// not-yet-existing block fail validation the instant that block was created.
		//
		// This asserts the CURRENT contract, which is deliberate but not settled: the open ticket
		// `feat-phantom-read-protection` asks a human whether reading "X does not exist" should
		// protect against X appearing. If that answer is ever "yes", this test is the thing that
		// changes — it is not a guarantee to defend, it is today's decision written down.
		const transactor = new TestTransactor()
		const tree = await Tree.createOrOpen<number, Entry>(transactor, 'brand-new', e => e.key)
		const coll = tree.getCollection()

		// Measured, not assumed: the whole open of an absent collection records ZERO deps. Every
		// read after the miss is served from the tracker's staged header, so nothing reaches the
		// cache or source. Asserted as an exact count because the weaker per-dep guards below are
		// vacuous over an empty set — without this line the test passes with capture removed.
		const deps = coll.getReadDependencies()
		expect(deps, 'opening an absent collection must record no read dependency at all').to.be.empty

		// Retained as the guard that bites if the open path ever legitimately starts recording:
		// whatever it records must name a real block at a real revision, never a phantom at 0.
		for (const dep of deps) {
			expect(dep.revision, `absent-header probe must not record ${dep.blockId} at revision 0`).to.be.greaterThan(0)
			expect(
				await currentRev(transactor, dep.blockId),
				`dep ${dep.blockId} must name a block the transactor actually holds`,
			).to.be.greaterThan(0)
		}
		expect(
			deps.map(d => d.blockId),
			'the absent header block itself must not appear in the read set',
		).to.not.include('brand-new')

		// Why the absence matters, demonstrated rather than asserted in the abstract: synthesize the
		// phantom dep the old code emitted and push it through the same validator. Before creation
		// it is inert; the instant the collection comes into existence it rejects. That rejection is
		// the failure mode the empty read set above avoids.
		const phantom: ReadDependency[] = [{ blockId: 'brand-new' as BlockId, revision: 0 }]
		const validator = makeValidator(transactor)
		const beforeCreate = await validator.validate(await makeTxn(phantom), await emptyOpsHash())
		expect(beforeCreate.valid, 'while the block is absent a revision-0 dep still matches').to.be.true

		await tree.replace(seedEntries)
		expect(await currentRev(transactor, 'brand-new' as BlockId), 'the header block now exists').to.be.greaterThan(0)

		const afterCreate = await validator.validate(await makeTxn(phantom), await emptyOpsHash())
		expect(afterCreate.valid, 'a phantom revision-0 dep WOULD reject once the block is created').to.be.false
		expect(afterCreate.reason).to.include('Stale read')

		// And the set actually captured — empty — is unaffected by that same creation.
		const real = await validator.validate(await makeTxn(deps), await emptyOpsHash())
		expect(real.reason ?? '', 'creating a previously-absent block must not stale-reject the probe').to.not.include('Stale read')
		expect(real.valid).to.be.true
	})
})
