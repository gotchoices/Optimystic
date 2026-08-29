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
import { Tree } from '../src/collections/tree/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'

type Entry = [key: string, value: string]

const collectionId = 'tree://default/Table/index/ByToken'

async function openHandle(network: TestTransactor): Promise<Tree<string, Entry>> {
	return Tree.createOrOpen<string, Entry>(network, collectionId, e => e[0], (a, b) => a < b ? -1 : a > b ? 1 : 0)
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
