/**
 * Two independent {@link Collection} handles on ONE collection id, over ONE shared
 * transactor, in ONE process.
 *
 * This is the white-box reduction the two-node harness could not pin down: no mesh, no
 * sockets, no cluster placement — just two handles that each hold their own tracker,
 * read cache and action context, exactly as two machines do. If the reconciliation path
 * (`Collection.update()` -> `Log.getFrom` -> replay) can lose a sibling's write here, it
 * can lose it anywhere.
 *
 * The two shapes mirror what the downstream measurement reported for one table:
 *  - INVENTED (the main table there): neither handle has ever committed; both stage a
 *    header/root of their own and race.
 *  - SEEDED (the index sub-collection there): a committed revision already exists and
 *    both handles depart from it.
 */

import { expect } from 'chai'
import { Tree, type TreeReplaceAction } from '../src/collections/tree/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'

type Entry = [key: string, value: string]

const collectionId = 'tree://default/Table/index/ByToken'

const keyOf = (entry: Entry) => entry[0]
const compareKeys = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/** A b-tree fan-out small enough that a dozen keys already make a MULTI-LEVEL tree, so two keys
 * at opposite ends of the range are guaranteed to sit in different leaves. Not persisted in the
 * header, so every handle on the same tree has to pass it (see `Tree.createOrOpen`'s
 * `nodeCapacity`). */
const SMALL_FANOUT = 4
/** Twelve seeds, enough to split at {@link SMALL_FANOUT}. */
const SPREAD = ['k-a', 'k-b', 'k-c', 'k-d', 'k-e', 'k-f', 'k-g', 'k-h', 'k-i', 'k-j', 'k-k', 'k-l']
/** The low end of {@link SPREAD}, read to pull its leaf into the staging handle. */
const UPSERT_NEIGHBOUR = 'k-a'
/** Sorts next to {@link UPSERT_NEIGHBOUR}, so the upsert writes the leaf that was read. */
const UPSERT_KEY = 'k-a1'
/** Sorts past every seed, so the key deleted blind cannot share a leaf with {@link UPSERT_KEY}. */
const BLIND_KEY = 'k-z'

async function openHandle(network: TestTransactor, nodeCapacity?: number): Promise<Tree<string, Entry>> {
	return Tree.createOrOpen<string, Entry>(network, collectionId, keyOf, compareKeys, nodeCapacity)
}

/** A handle over an ALREADY-COMMITTED tree, whose tracker therefore starts empty — the shape the
 * blind-action tests below need, and the one `createOrOpen` cannot give them (see those tests). */
async function openCommitted(network: TestTransactor, nodeCapacity?: number): Promise<Tree<string, Entry>> {
	const tree = await Tree.open<string, Entry>(network, collectionId, keyOf, compareKeys, nodeCapacity)
	expect(tree, 'the tree must already be committed').to.not.equal(undefined)
	return tree!
}

async function readKeys(tree: Tree<string, Entry>): Promise<string[]> {
	const keys: string[] = []
	const start = await tree.first()
	for await (const path of tree.ascending(start)) {
		const entry = tree.at(path)
		if (entry) keys.push(entry[0])
	}
	return keys.sort()
}

describe('two handles on one collection id', () => {
	it('SEEDED: both handles depart from a committed revision and both writes survive', async () => {
		const network = new TestTransactor()

		const seeder = await openHandle(network)
		await seeder.stage([['k-seed', ['k-seed', 'seed']]])
		await seeder.sync()

		const a = await openHandle(network)
		const b = await openHandle(network)
		await a.update()
		await b.update()

		await a.stage([['k-a', ['k-a', 'a']]])
		await b.stage([['k-b', ['k-b', 'b']]])

		await a.sync()
		await b.sync()

		await a.update()
		await b.update()

		expect(await readKeys(a), 'handle A').to.deep.equal(['k-a', 'k-b', 'k-seed'])
		expect(await readKeys(b), 'handle B').to.deep.equal(['k-a', 'k-b', 'k-seed'])
		expect(a.committedRevision(), 'A rev').to.equal(b.committedRevision())
		expect(a.committedActionId(), 'A action').to.equal(b.committedActionId())
	})

	it('INVENTED: neither handle has committed; both writes survive', async () => {
		const network = new TestTransactor()

		const a = await openHandle(network)
		const b = await openHandle(network)

		await a.stage([['k-a', ['k-a', 'a']]])
		await b.stage([['k-b', ['k-b', 'b']]])

		await a.sync()
		await b.sync()

		await a.update()
		await b.update()

		expect(await readKeys(a), 'handle A').to.deep.equal(['k-a', 'k-b'])
		expect(await readKeys(b), 'handle B').to.deep.equal(['k-a', 'k-b'])
		expect(a.committedActionId(), 'A action').to.equal(b.committedActionId())
	})
})

describe('a pending action that changed no block', () => {
	/** The delete that writes nothing.
	 *
	 * A refresh detects a conflict by finding an incoming log entry that names a block this
	 * handle already holds a transform for. An action that changed NO block holds no transform,
	 * so it can never register one — and a staged delete of a key the staging handle cannot see
	 * is exactly that action: the tree's `replace` handler misses on `find` and `deleteAt`
	 * returns false without writing. Before `updateInternal` replayed on context advance, such
	 * an action stayed in `pending` unapplied until the commit wrote a log entry listing it
	 * whose transforms did nothing, and the delete was lost on every node.
	 *
	 * `Tree.open` for B is load-bearing: building BOTH handles with `createOrOpen` does not
	 * reproduce, because the second `createOrOpen` stages its own header/root into B's tracker,
	 * A's log entry names the root, and the resulting block conflict forces the replay anyway.
	 * B has to open an already-committed tree so its tracker starts empty.
	 *
	 * The assertion reads through a THIRD, fresh `Tree.open`: reading back through B would be
	 * satisfied by B's own tracker state and would prove nothing about what is durable. */
	it('a blind delete staged against an unseen key still lands', async () => {
		const network = new TestTransactor()

		const a = await openHandle(network)
		await a.stage([['k-anchor', ['k-anchor', 'anchor']]])
		await a.sync()

		const b = await openCommitted(network)
		expect(await b.get('k-anchor'), 'B reads the anchor').to.deep.equal(['k-anchor', 'anchor'])

		// A commits a second entry that B has never read, so nothing about it is in B's tracker.
		await a.stage([['k-later', ['k-later', 'later']]])
		await a.sync()

		// B stages a delete of that key blind: `find` misses at B's stale context, `deleteAt`
		// returns false, and no block is written.
		await b.stage([['k-later', undefined]])
		await b.sync()

		const reader = await openCommitted(network)
		expect(await reader.get('k-later'), 'the blind delete is durable').to.equal(undefined)
		expect(await reader.get('k-anchor'), 'the anchor is untouched').to.deep.equal(['k-anchor', 'anchor'])
	})

	/** The same blind delete, but PAIRED with an upsert — the shape `updateIndexEntries`
	 * (`packages/quereus-plugin-optimystic/src/schema/index-manager.ts`) stages for every UPDATE
	 * that moves a row's indexed value: one action carrying `[oldKey, undefined]` and
	 * `[newKey, entry]` together.
	 *
	 * A single-leaf tree cannot show the defect: the upsert writes the one leaf, the rival's
	 * commit named that same leaf, and the resulting block conflict forces the replay that the
	 * delete needed anyway. `SMALL_FANOUT` is what removes that cover — it forces a multi-level
	 * tree from a handful of keys, so the delete and the upsert land in DIFFERENT leaves and the
	 * upsert's transform no longer overlaps the block the rival rewrote. Then the action's only
	 * conflict-registering half is gone and the delete is on its own again. */
	it('a blind delete paired with an upsert in a different leaf still lands', async () => {
		const network = new TestTransactor()

		const a = await openHandle(network, SMALL_FANOUT)
		const seeds: TreeReplaceAction<string, Entry> = SPREAD.map(key => [key, [key, 'seed']])
		await a.stage(seeds)
		await a.sync()

		const b = await openCommitted(network, SMALL_FANOUT)
		// Force B to materialize the leaf it will UPSERT into, and only that one, so its staged
		// upsert has a block to rewrite while the delete's leaf stays unread.
		expect(await b.get(UPSERT_NEIGHBOUR), 'B reads the upsert side').to.deep.equal([UPSERT_NEIGHBOUR, 'seed'])

		// A commits a key at the far end of the range — a different leaf from the upsert's, and one
		// B has never read.
		await a.stage([[BLIND_KEY, [BLIND_KEY, 'later']]])
		await a.sync()

		await b.stage([[BLIND_KEY, undefined], [UPSERT_KEY, [UPSERT_KEY, 'upserted']]])
		await b.sync()

		const reader = await openCommitted(network, SMALL_FANOUT)
		expect(await reader.get(BLIND_KEY), 'the blind delete is durable').to.equal(undefined)
		expect(await reader.get(UPSERT_KEY), 'the paired upsert is durable').to.deep.equal([UPSERT_KEY, 'upserted'])
		expect(await readKeys(reader), 'no seed was lost').to.deep.equal([...SPREAD, UPSERT_KEY].sort())
	})
})

describe('two handles racing one collection id', () => {
	it('SEEDED: concurrent syncs from one committed base both survive', async () => {
		const network = new TestTransactor()

		const seeder = await openHandle(network)
		await seeder.stage([['k-seed', ['k-seed', 'seed']]])
		await seeder.sync()

		const a = await openHandle(network)
		const b = await openHandle(network)
		await a.update()
		await b.update()

		await a.stage([['k-a', ['k-a', 'a']]])
		await b.stage([['k-b', ['k-b', 'b']]])

		await Promise.all([a.sync(), b.sync()])

		await a.update()
		await b.update()

		expect(await readKeys(a), 'handle A').to.deep.equal(['k-a', 'k-b', 'k-seed'])
		expect(await readKeys(b), 'handle B').to.deep.equal(['k-a', 'k-b', 'k-seed'])
		expect(a.committedActionId(), 'action id agreement').to.equal(b.committedActionId())
	})

	it('INVENTED: concurrent syncs with nothing committed both survive', async () => {
		const network = new TestTransactor()

		const a = await openHandle(network)
		const b = await openHandle(network)

		await a.stage([['k-a', ['k-a', 'a']]])
		await b.stage([['k-b', ['k-b', 'b']]])

		await Promise.all([a.sync(), b.sync()])

		await a.update()
		await b.update()

		expect(await readKeys(a), 'handle A').to.deep.equal(['k-a', 'k-b'])
		expect(await readKeys(b), 'handle B').to.deep.equal(['k-a', 'k-b'])
	})

	it('SEEDED, multi-block: concurrent writes into a tree spanning several blocks both survive', async () => {
		const network = new TestTransactor()

		// Small fan-out so a handful of entries already forces interior nodes, putting the two
		// writers in different leaf blocks while they still share the header, root and log tail.
		const open = () => Tree.createOrOpen<string, Entry>(
			network, collectionId, e => e[0], (x, y) => x < y ? -1 : x > y ? 1 : 0, 4)

		const seeder = await open()
		for (let i = 0; i < 12; i++) {
			await seeder.stage([[`s${i}`, [`s${i}`, 'seed']]])
		}
		await seeder.sync()

		const a = await open()
		const b = await open()
		await a.update()
		await b.update()

		await a.stage([['s0-a', ['s0-a', 'a']]])
		await b.stage([['s9-b', ['s9-b', 'b']]])

		await Promise.all([a.sync(), b.sync()])

		await a.update()
		await b.update()

		const keysA = await readKeys(a)
		const keysB = await readKeys(b)
		expect(keysA, 'handle A holds both writes').to.include.members(['s0-a', 's9-b'])
		expect(keysB, 'handle B holds both writes').to.include.members(['s0-a', 's9-b'])
		expect(keysA.length, 'no seed row lost').to.equal(14)
		expect(keysA).to.deep.equal(keysB)
	})
})
