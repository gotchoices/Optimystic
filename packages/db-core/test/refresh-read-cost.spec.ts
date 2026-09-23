/**
 * What one refresh (`Collection.update`, reached through `Tree.update`) costs in block reads.
 *
 * Every live query refreshes each tree it reads before reading it, so an idle poll pays this cost
 * once per tree per query. On a peer-to-peer node every `get` below is a separate network request,
 * and over a slow relay each is a round trip — the reason these are budgets and not just checks.
 *
 * The bounds are upper bounds, never exact counts: a refresh that gets cheaper still passes.
 */

import { expect } from 'chai'
import { Tree } from '../src/collections/tree/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import { LogDataBlockType } from '../src/log/struct.js'
import type { BlockGets, GetBlockResults, IBlock } from '../src/index.js'

interface Row { key: number; value: string }

const keyOf = (row: Row) => row.key

/** Records every `get` it serves: one entry per request, listing the block ids it asked for. */
class CountingTransactor extends TestTransactor {
	requests: string[][] = []

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		this.requests.push([...gets.blockIds])
		return super.get(gets)
	}

	/** Runs `refresh` and returns what it cost. */
	async cost(refresh: () => Promise<void>): Promise<{ requests: number, fetchesPerBlock: Map<string, number> }> {
		this.requests = []
		await refresh()
		const fetchesPerBlock = new Map<string, number>()
		for (const id of this.requests.flat()) {
			fetchesPerBlock.set(id, (fetchesPerBlock.get(id) ?? 0) + 1)
		}
		return { requests: this.requests.length, fetchesPerBlock }
	}

	/** The log tail block id a collection's committed header names. Read around the counter. */
	async tailIdOf(collectionId: string): Promise<string | undefined> {
		const header = (await super.get({ blockIds: [collectionId] }))[collectionId]?.block as { tailId?: string } | undefined
		return header?.tailId
	}
}

/** While `hideNewestAction` is set, serves every log block with its newest entry stripped of its
 *  action — the entry keeps its revision but reads as naming no action. A handle opened through it
 *  holds a context at that revision whose committed list does not name it. */
class NewestActionHidingTransactor extends CountingTransactor {
	hideNewestAction = false

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		const results = await super.get(gets)
		if (this.hideNewestAction) {
			for (const [id, entry] of Object.entries(results)) {
				const block = entry.block as (IBlock & { entries?: { rev: number, action?: unknown }[] }) | undefined
				const newest = block?.entries?.[block.entries.length - 1]
				if (block?.header.type === LogDataBlockType && newest !== undefined) {
					results[id] = { ...entry, block: { ...block, entries: [...block.entries!.slice(0, -1), { ...newest, action: undefined }] } as IBlock }
				}
			}
		}
		return results
	}
}

const row = (key: number): Row => ({ key, value: `row ${key}` })

async function writeRows(tree: Tree<number, Row>, from: number, count: number) {
	for (let key = from; key < from + count; ++key) {
		await tree.replace([[key, row(key)]])
	}
}

function expectNoBlockFetchedTwice(fetchesPerBlock: Map<string, number>) {
	const repeated = [...fetchesPerBlock].filter(([, count]) => count > 1)
	expect(repeated, 'no block is fetched more than once in one refresh').to.deep.equal([])
}

describe('refresh read cost', () => {
	let net: CountingTransactor

	beforeEach(() => {
		net = new CountingTransactor()
	})

	/** A writer with `history` committed rows, and a second handle that has already caught up. */
	async function caughtUpReader(collectionId: string, history: number) {
		const writer = await Tree.createOrOpen<number, Row>(net, collectionId, keyOf)
		await writeRows(writer, 0, history)
		const reader = await Tree.createOrOpen<number, Row>(net, collectionId, keyOf)
		await reader.update()
		return { writer, reader }
	}

	it('a refresh that finds nothing new costs one request', async () => {
		const { reader } = await caughtUpReader('unchanged', 50)

		const { requests, fetchesPerBlock } = await net.cost(() => reader.update())
		expect(requests, `requests: ${JSON.stringify(net.requests)}`).to.be.at.most(1)
		expectNoBlockFetchedTwice(fetchesPerBlock)
	})

	it('stays at one request however long the history grows', async () => {
		const { reader } = await caughtUpReader('long-history', 200)

		const { requests } = await net.cost(() => reader.update())
		expect(requests, `requests: ${JSON.stringify(net.requests)}`).to.be.at.most(1)
	})

	it('the first refresh after opening, with nothing new, costs one request', async () => {
		const writer = await Tree.createOrOpen<number, Row>(net, 'first-after-open', keyOf)
		await writeRows(writer, 0, 5)
		const reader = await Tree.createOrOpen<number, Row>(net, 'first-after-open', keyOf)

		const { requests } = await net.cost(() => reader.update())
		expect(requests, `requests: ${JSON.stringify(net.requests)}`).to.be.at.most(1)
	})

	it("a handle's own commit does not make its next refresh walk the log", async () => {
		const { reader } = await caughtUpReader('own-commit', 10)
		await reader.replace([[100, row(100)]])

		const { requests } = await net.cost(() => reader.update())
		expect(requests, `requests: ${JSON.stringify(net.requests)}`).to.be.at.most(1)
	})

	it('a refresh that finds a new commit fetches no block twice, and sees the commit', async () => {
		// 50 entries span two log blocks, so the walk reads a block beyond the header and tail.
		const { writer, reader } = await caughtUpReader('changed', 50)
		await writeRows(writer, 50, 1)

		const { requests, fetchesPerBlock } = await net.cost(() => reader.update())
		expectNoBlockFetchedTwice(fetchesPerBlock)
		expect(requests, `requests: ${JSON.stringify(net.requests)}`).to.be.at.most(3)
		expect(await reader.get(50), 'the refresh adopted the new commit').to.deep.equal(row(50))
	})

	it('a refresh that follows the log onto a new tail block still sees every commit', async () => {
		// The reader last saw the tail block before it filled; the header now names a different one,
		// so the tail id remembered from the previous refresh is out of date.
		const { writer, reader } = await caughtUpReader('rolled-tail', 30)
		const tailBefore = await net.tailIdOf('rolled-tail')
		await writeRows(writer, 30, 5)
		expect(await net.tailIdOf('rolled-tail'), 'the writes filled the tail block').to.not.equal(tailBefore)

		const { fetchesPerBlock } = await net.cost(() => reader.update())
		expect(fetchesPerBlock.get('rolled-tail'), 'the header is fetched once').to.equal(1)
		for (let key = 30; key < 35; ++key) {
			expect(await reader.get(key), `row ${key} after the tail moved`).to.deep.equal(row(key))
		}
		const { requests } = await net.cost(() => reader.update())
		expect(requests, 'and the refresh after it is back to one request').to.be.at.most(1)
	})

	it('repeated refreshes with nothing new keep seeing later commits', async () => {
		const { writer, reader } = await caughtUpReader('poll', 3)
		for (let i = 0; i < 3; ++i) {
			await reader.update()
		}
		await writeRows(writer, 3, 1)
		await reader.update()
		expect(await reader.get(3), 'a commit made after idle refreshes is adopted').to.deep.equal(row(3))
	})

	it('a refresh with nothing new still walks the log when the held context does not name its own revision', async () => {
		// The walk adopts the log's list of committed actions, which travels with every later read;
		// skipping it here would leave that list without the newest action for good.
		const hiding = new NewestActionHidingTransactor()
		const writer = await Tree.createOrOpen<number, Row>(hiding, 'unnamed', keyOf)
		await writeRows(writer, 0, 3)
		const newestAction = writer.committedActionId()
		expect(newestAction, 'the writer names the action behind its revision').to.be.a('string')

		hiding.hideNewestAction = true
		const reader = await Tree.createOrOpen<number, Row>(hiding, 'unnamed', keyOf)
		hiding.hideNewestAction = false
		expect(reader.committedRevision(), 'the reader holds the latest revision').to.equal(writer.committedRevision())
		expect(reader.committedActionId(), 'but its list names no action there').to.equal(undefined)

		await reader.update()
		expect(reader.committedActionId(), 'the refresh walked and adopted the complete list').to.equal(newestAction)
	})

	it("a write that follows another handle's commit costs two requests", async () => {
		// The contended shape: two parties alternating writes to one table, which is what a shared
		// SQL table under two writers looks like. Every such write refreshes (reading the header and
		// the log tail in one request), finds the other handle's entry, and forgets the blocks it
		// names — the log tail among them, since a commit's blocks include the log block its entry
		// was appended to. The two requests left are both owed: the refresh has to ask, and the leaf
		// the other writer changed has to be re-read. A third would be a second fetch of the tail the
		// refresh just received.
		const a = await Tree.createOrOpen<number, Row>(net, 'alternating', keyOf)
		const b = await Tree.createOrOpen<number, Row>(net, 'alternating', keyOf)
		// Two rounds before the measured one: a handle learns the log tail's id from a refresh that
		// found a committed header, and asks for the header and the tail in one request only from
		// then on (`Collection.logTailId`).
		await a.replace([[0, row(0)]])
		await b.replace([[1, row(1)]])
		await a.replace([[2, row(2)]])
		await b.replace([[3, row(3)]])

		const { requests, fetchesPerBlock } = await net.cost(async () => { await a.replace([[4, row(4)]]) })
		expect(requests, `requests: ${JSON.stringify(net.requests)}`).to.be.at.most(2)
		expectNoBlockFetchedTwice(fetchesPerBlock)
		expect(await a.get(3), "and the write still saw the other handle's row").to.deep.equal(row(3))
	})

	it("a solo writer's write still costs one request", async () => {
		// The uncontended half of the budget above, and the guard that the seed did not make it
		// worse: this handle's own commit folds the tail back into its cache, so its next refresh
		// stops at `tailShowsNothingNewer` having cleared nothing.
		const writer = await Tree.createOrOpen<number, Row>(net, 'solo', keyOf)
		await writeRows(writer, 0, 5)

		const { requests, fetchesPerBlock } = await net.cost(async () => { await writer.replace([[5, row(5)]]) })
		expect(requests, `requests: ${JSON.stringify(net.requests)}`).to.be.at.most(1)
		expectNoBlockFetchedTwice(fetchesPerBlock)
	})

	it('a table and its index tree each cost one request when neither changed', async () => {
		// The query adapter refreshes the table tree and then each index tree it scans through.
		const table = await Tree.createOrOpen<number, Row>(net, 'table', keyOf)
		const index = await Tree.createOrOpen<number, Row>(net, 'table.index', keyOf)
		for (let key = 0; key < 40; ++key) {
			await table.replace([[key, row(key)]])
			await index.replace([[key, row(key)]])
		}
		const tableReader = await Tree.createOrOpen<number, Row>(net, 'table', keyOf)
		const indexReader = await Tree.createOrOpen<number, Row>(net, 'table.index', keyOf)
		await tableReader.update()
		await indexReader.update()

		const { requests, fetchesPerBlock } = await net.cost(async () => {
			await tableReader.update()
			await indexReader.update()
		})
		expect(requests, `requests: ${JSON.stringify(net.requests)}`).to.be.at.most(2)
		expectNoBlockFetchedTwice(fetchesPerBlock)
	})
})
