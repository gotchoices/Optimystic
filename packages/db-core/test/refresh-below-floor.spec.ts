/**
 * A refresh that walks a log entry learns that the blocks the entry names changed at the entry's
 * revision. That revision is the block's FLOOR: a later read of the block, at a context at or above
 * it, that comes back OLDER is provably not the view that was asked for (a BELOW-FLOOR ANSWER).
 *
 * The defect these cases pin: the refresh cleared the block from the collection's read cache, the
 * re-read was answered by a machine that had not caught up, and the cache kept that answer — for
 * good, because the log entry that would have cleared it had just been consumed. The reader showed
 * old data indefinitely, even after its own storage was corrected.
 *
 * The rule now: a below-floor answer is handed to the reader (there may be nobody better to ask,
 * and the content may even be correct — see the abandoned-entry case) but is never remembered, so
 * the next read asks again and sees storage the moment it catches up.
 */

import { use, expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
use(chaiAsPromised)
import { Tree } from '../src/collections/tree/index.js'
import { TestTransactor, TailLandsButReportsStale } from '../src/testing/test-transactor.js'
import { LogDataBlockType } from '../src/log/struct.js'
import { Log } from '../src/log/log.js'
import { TornActionError } from '../src/index.js'
import { servedRevision } from '../src/transactor/transactor-source.js'
import type { BlockGets, CommitRequest, CommitResult, GetBlockResults } from '../src/index.js'
import { captureCollectionLog } from './capture-log.js'

interface Row { key: number; value: string }
const keyOf = (row: Row) => row.key

const OLD: Row = { key: 1, value: 'old' }
const NEW: Row = { key: 1, value: 'new' }

/** Records every block id asked for — one entry per request per id. */
class CountingTransactor extends TestTransactor {
	fetched: string[] = []

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		this.fetched.push(...gets.blockIds)
		return super.get(gets)
	}

	/** The block ids asked for while `read` ran. */
	async fetchedDuring(read: () => Promise<unknown>): Promise<string[]> {
		const mark = this.fetched.length
		await read()
		return this.fetched.slice(mark)
	}
}

/** While `lagAt` is set, a PINNED read of any non-log block is answered as of `lagAt` at most —
 *  the content and the `materialized` revision a replica that stopped at `lagAt` would report.
 *  Unpinned reads (the refresh's header and tail) and log blocks are served current, so the reader
 *  correctly learns that the log moved. */
class LaggingDataTransactor extends CountingTransactor {
	lagAt?: number
	/** Pinned reads answered below the revision they asked for, as [blockId, askedRev, servedRev]. */
	laggedReads: Array<[string, number, number]> = []

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		// Decided when the read is ASKED, so a double that answers two reads in flight differently
		// can flip `lagAt` around the call without the other read seeing the flip.
		const lagAt = this.lagAt
		const results = await super.get(gets)
		const askedRev = gets.context?.rev
		if (lagAt === undefined || askedRev === undefined || askedRev <= lagAt) return results
		for (const [id, entry] of Object.entries(results)) {
			if (!entry.block || entry.block.header.type === LogDataBlockType) continue
			const lagged = (await TestTransactor.prototype.get.call(this, { blockIds: [id], context: { ...gets.context!, committed: [], rev: lagAt } }))[id]!
			// Same shape StorageRepo gives a lagging replica: its own newest revision as `state.latest`.
			results[id] = { ...lagged, state: { ...lagged.state, latest: lagged.materialized } }
			if ((lagged.materialized?.rev ?? 0) < (entry.materialized?.rev ?? 0)) {
				this.laggedReads.push([id, askedRev, lagged.materialized?.rev ?? 0])
			}
		}
		return results
	}
}

/** Two machines with one history: the replica asked FIRST is behind (it answers as of `lagAt`, like
 *  its base), the other has caught up. A read carrying a floor (`BlockGets.floors`) whose first
 *  answer falls under it is re-asked against the second replica, and the newer content wins — the
 *  second-chance round `NetworkTransactor.get` runs against a coordinator it excluded, in miniature,
 *  so what a collection sees can be pinned without standing up a simulated network. A read carrying
 *  no floor is one round, exactly as before. */
class TwoReplicaTransactor extends LaggingDataTransactor {
	/** One entry per block the second replica was asked for. */
	reAsked: string[] = []

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		const answers = await super.get(gets)
		const tooOld = Object.entries(answers)
			.filter(([id, entry]) => gets.floors?.[id] !== undefined && entry.block !== undefined
				&& servedRevision(entry) < gets.floors[id]!)
			.map(([id]) => id)
		if (tooOld.length === 0) return answers
		this.reAsked.push(...tooOld)
		const behind = this.lagAt
		this.lagAt = undefined	// the second replica, which is current
		try {
			const fresh = await super.get({ ...gets, blockIds: tooOld })
			for (const id of tooOld) {
				const entry = fresh[id]
				if (entry && servedRevision(entry) > servedRevision(answers[id]!)) answers[id] = entry
			}
		} finally {
			this.lagAt = behind
		}
		return answers
	}
}

/** Once `armed`, the next two pinned reads are held until both have been asked, then answered
 *  one after the other — the first read's answer always lands first. The read numbered
 *  `currentNth` is answered current; the other as of `lagAt`. */
class TwoAtOnceTransactor extends LaggingDataTransactor {
	armed = false
	private dataReads = 0
	private releaseBoth!: () => void
	private readonly bothAsked = new Promise<void>(resolve => { this.releaseBoth = resolve })

	constructor(private readonly currentNth: 1 | 2) { super() }

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		const nth = this.armed && gets.context?.rev !== undefined ? ++this.dataReads : 0
		const lagAt = this.lagAt
		if (nth === this.currentNth) this.lagAt = undefined
		const asked = super.get(gets)
		this.lagAt = lagAt
		const results = await asked
		if (nth === 2) this.releaseBoth()
		if (nth === 1 || nth === 2) await this.bothAsked
		if (nth === 2) await new Promise(resolve => setTimeout(resolve, 5))	// after the first answer is dealt with
		return results
	}
}

/** `reader` has refreshed past one write; `net` lags at the revision before it and is armed. */
async function twoReadsAtOnce(collectionId: string, currentNth: 1 | 2) {
	const net = new TwoAtOnceTransactor(currentNth)
	const writer = await Tree.createOrOpen<number, Row>(net, collectionId, keyOf)
	await writer.replace([[1, OLD]])
	const reader = await Tree.createOrOpen<number, Row>(net, collectionId, keyOf)
	await reader.update()
	await reader.get(1)
	net.lagAt = reader.committedRevision()!
	await writer.replace([[1, NEW]])
	await reader.update()
	net.armed = true
	return { net, reader }
}

/** A reader that has refreshed past one write its storage has not caught up with: the log entry for
 *  `NEW` is walked (so the row's block has a floor), while every pinned read of the block is still
 *  answered as of the revision before it.
 *
 *  @param net the machines answering — one lagging replica unless the case supplies more. */
async function readerBehindOneWrite(collectionId: string, net: LaggingDataTransactor = new LaggingDataTransactor()) {
	const writer = await Tree.createOrOpen<number, Row>(net, collectionId, keyOf)
	await writer.replace([[1, OLD]])
	const reader = await Tree.createOrOpen<number, Row>(net, collectionId, keyOf)
	await reader.update()
	await reader.get(1)
	const laggingRev = reader.committedRevision()!
	net.lagAt = laggingRev
	await writer.replace([[1, NEW]])
	await reader.update()
	return { net, writer, reader, laggingRev, floorRev: reader.committedRevision()! }
}

const belowFloorLines = (lines: string[]) => lines.filter(line => line.includes('collection:block-below-floor'))

describe('a refreshed collection re-reading a block its log entry names', () => {
	it('does not keep a too-old answer after storage has caught up', async () => {
		const net = new LaggingDataTransactor()
		const writer = await Tree.createOrOpen<number, Row>(net, 'directory-kept', keyOf)
		await writer.replace([[1, { key: 1, value: 'old' }]])
		const reader = await Tree.createOrOpen<number, Row>(net, 'directory-kept', keyOf)
		await reader.update()
		await reader.get(1)
		net.lagAt = reader.committedRevision()!
		await writer.replace([[1, { key: 1, value: 'new' }]])
		await reader.update()
		try { await reader.get(1) } catch { /* a loud refusal is an acceptable answer here */ }

		net.lagAt = undefined
		for (let poll = 0; poll < 3; ++poll) await reader.update()
		expect(await reader.get(1), 'the reader sees the write once storage can answer').to.deep.equal({ key: 1, value: 'new' })
	})

	it('asks another machine, and returns the new row on the very first read after the refresh', async () => {
		// The stricter half of the rule, once there is somebody better to ask: not merely "a too-old
		// answer is not remembered" but "too-old content is not returned". The reader's own replica
		// is behind and is asked first; the floor rides out on the read, so the answer under it is
		// re-asked against the machine that holds the revision the log entry named.
		const machines = new TwoReplicaTransactor()
		const { reader } = await readerBehindOneWrite('two-replicas', machines)

		expect(await reader.get(1), 'the current replica answered').to.deep.equal(NEW)
		expect(machines.reAsked, 'the lagging answer earned exactly one re-ask').to.have.length(1)

		// That answer meets the floor, so it is kept like any other good answer — the retry is paid
		// once, not on every read.
		expect(await machines.fetchedDuring(() => reader.get(1)), 'and is remembered').to.deep.equal([])
	})

	it('hands the too-old answer on once per read, keeps nothing, and needs no further refresh to recover', async () => {
		// One machine and nobody else to ask, so the old row is what each read gets (contrast the
		// two-replica case above). What matters here is that each read ASKS.
		const { net, reader } = await readerBehindOneWrite('directory-uncached')

		expect(await reader.get(1)).to.deep.equal(OLD)
		expect(await reader.get(1)).to.deep.equal(OLD)
		expect(net.laggedReads, 'the second read asked storage again').to.have.length(2)

		net.lagAt = undefined
		expect(await reader.get(1), 'seen on the very next read, with no refresh in between').to.deep.equal(NEW)

		const [blockId] = net.laggedReads[0]!
		expect(await net.fetchedDuring(() => reader.get(1)), 'an answer that meets the floor is kept').to.not.include(blockId)
	})

	it('names the block, the floor and the revision served in the collection log', async () => {
		const { net, reader, laggingRev, floorRev } = await readerBehindOneWrite('directory-line')

		const lines = belowFloorLines(await captureCollectionLog(async () => { await reader.get(1) }))
		const [blockId] = net.laggedReads[0]!
		expect(lines, lines.join('\n')).to.have.length(1)
		expect(lines[0]).to.match(new RegExp(
			`collection:block-below-floor id=directory-line tag=\\S+ block=${blockId} floorRev=${floorRev} floorAction=\\S+ servedRev=${laggingRev}$`))

		net.lagAt = undefined
		const after = belowFloorLines(await captureCollectionLog(async () => { await reader.get(1); await reader.get(1) }))
		expect(after, 'silent once the answer meets the floor').to.deep.equal([])
	})

	it('of two concurrent reads, the too-old answer arriving second is not the one kept', async () => {
		// Reads are not serialized (the SQL layer runs reentrant scans over one handle), so two can
		// miss on one block at once. The first answer meets the floor and is kept; the second — from
		// a machine still behind — must not displace it.
		const { net, reader } = await twoReadsAtOnce('two-at-once', 1)
		const answers = await Promise.all([reader.get(1), reader.get(1)])
		net.armed = false
		expect(answers, 'each reader gets the answer it was given').to.deep.equal([NEW, OLD])

		net.lagAt = undefined
		expect(await net.fetchedDuring(async () => {
			expect(await reader.get(1), 'what the collection remembers is the current row').to.deep.equal(NEW)
		}), 'and it is remembered, not re-fetched').to.deep.equal([])
	})

	it('a current answer the cache dropped as overtaken does not leave the next too-old answer unguarded', async () => {
		// The other order. The too-old answer lands first and is handed through; the current one
		// lands second, meets the floor — and is DROPPED by the cache, the block having changed
		// hands while it was in flight. So nothing is remembered and the next read asks again. Were
		// a floor removed by the first answer to meet it, that next read, answered too old, would be
		// judged against nothing and kept for good. (It was: this case returned OLD after storage
		// had caught up, until floors were made to stand.)
		const { net, reader } = await twoReadsAtOnce('two-at-once-reversed', 2)
		const answers = await Promise.all([reader.get(1), reader.get(1)])
		net.armed = false
		expect(answers, 'each reader gets the answer it was given').to.deep.equal([OLD, NEW])

		expect(await reader.get(1), 'storage is still behind, so the old row is what there is').to.deep.equal(OLD)

		net.lagAt = undefined
		expect(await reader.get(1), 'but it was not kept').to.deep.equal(NEW)
		expect(await net.fetchedDuring(() => reader.get(1)), 'and the current row now is').to.deep.equal([])
	})

	it('a read that lands while the refresh is under way does not leave the old block behind', async () => {
		// No lagging machine here: storage is fully current. Reads are not latched, so one can run
		// between the refresh walking the log and adopting the new revision. If the changed block
		// has already been forgotten by then, that read re-fetches it at the revision being LEFT —
		// correctly old, under no floor — and the cache keeps it past the advance, for good.
		//
		// The seam: the refresh reads the log's invalidations after walking its entries and before
		// adopting, so a read issued from inside that call lands exactly in the gap.
		const net = new CountingTransactor()
		const writer = await Tree.createOrOpen<number, Row>(net, 'mid-refresh', keyOf)
		await writer.replace([[1, OLD]])
		const reader = await Tree.createOrOpen<number, Row>(net, 'mid-refresh', keyOf)
		await reader.update()
		await reader.get(1)
		await writer.replace([[1, NEW]])

		const readInvalidations = Log.prototype.getInvalidationsFrom
		let duringTheRefresh: Row | undefined
		Log.prototype.getInvalidationsFrom = async function (this: Log<unknown>, startRev: number | undefined) {
			duringTheRefresh = await reader.get(1)
			return readInvalidations.call(this, startRev)
		} as typeof readInvalidations
		try {
			await reader.update()
		} finally {
			Log.prototype.getInvalidationsFrom = readInvalidations
		}

		expect(duringTheRefresh, 'mid-refresh, the handle still reads at the revision it holds').to.deep.equal(OLD)
		expect(await reader.get(1), 'and once it has adopted the new one, it reads the new row').to.deep.equal(NEW)
	})

	describe('through a pinned read view', () => {
		it('a view created after the refresh does not keep the too-old block either', async () => {
			const { net, reader } = await readerBehindOneWrite('view-after')
			const view = reader.readView(reader.snapshot())

			expect(await view.get(1)).to.deep.equal(OLD)
			expect(await view.get(1)).to.deep.equal(OLD)
			expect(net.laggedReads, "the view's second read asked storage again").to.have.length(2)

			net.lagAt = undefined
			expect(await view.get(1)).to.deep.equal(NEW)
		})

		it('a view answered well does not leave the collection\'s own read unguarded', async () => {
			// The view is answered well; the collection's own read of the same block is then answered
			// too old. Had the view's good answer removed the floor, that answer would be kept for good.
			const { net, reader, laggingRev } = await readerBehindOneWrite('view-retire')
			net.lagAt = undefined
			expect(await reader.readView(reader.snapshot()).get(1)).to.deep.equal(NEW)

			net.lagAt = laggingRev
			expect(await reader.get(1)).to.deep.equal(OLD)

			net.lagAt = undefined
			expect(await reader.get(1), 'the collection did not keep the too-old answer').to.deep.equal(NEW)
		})

		it('a view pinned BELOW the floor is served the older content and keeps it, as before', async () => {
			const net = new CountingTransactor()
			const writer = await Tree.createOrOpen<number, Row>(net, 'view-below', keyOf)
			await writer.replace([[1, OLD]])
			const reader = await Tree.createOrOpen<number, Row>(net, 'view-below', keyOf)
			await reader.update()
			const beforeTheWrite = reader.snapshot()
			await writer.replace([[1, NEW]])
			await reader.update()

			const view = reader.readView(beforeTheWrite)
			let firstRead: string[] = []
			const lines = await captureCollectionLog(async () => {
				firstRead = await net.fetchedDuring(async () => { expect(await view.get(1)).to.deep.equal(OLD) })
			})
			expect(firstRead, 'the refresh dropped the block, so the view fetches it at its own pin').to.not.be.empty
			expect(belowFloorLines(lines), 'older content is what this view asked for').to.deep.equal([])
			expect(await net.fetchedDuring(async () => { expect(await view.get(1)).to.deep.equal(OLD) }), 'and it is kept').to.deep.equal([])
		})
	})

	describe('under staged changes', () => {
		it('a staged update over the block does not freeze the too-old base beneath it', async () => {
			// The tracker memoizes "source block + staged ops" per block. Built over a base the cache
			// declined to keep, that memo would go on serving the old row after the cache re-asked.
			const { net, reader } = await readerBehindOneWrite('staged-memo')
			const staged: Row = { key: 2, value: 'staged' }
			await reader.stage([[2, staged]])
			expect(await reader.get(1)).to.deep.equal(OLD)
			expect(await reader.get(2)).to.deep.equal(staged)

			net.lagAt = undefined
			expect(await reader.get(1), 'the base beneath the staged change follows storage').to.deep.equal(NEW)
			expect(await reader.get(2), 'and the staged change still rides on it').to.deep.equal(staged)
		})

		it('a write staged over a too-old base still declares the base it was really built on', async () => {
			// The storage-side guard against applying edits to the wrong base compares the revision
			// the writer DECLARES it read with the one the member holds. An undeclared block makes that
			// guard abstain, so the too-old base must stay describable even though it is never kept.
			const declared: Array<CommitRequest['blockDigests']> = []
			class DigestRecordingTransactor extends LaggingDataTransactor {
				override async commit(request: CommitRequest): Promise<CommitResult> {
					declared.push(request.blockDigests)
					return super.commit(request)
				}
			}
			const net = new DigestRecordingTransactor()
			const writer = await Tree.createOrOpen<number, Row>(net, 'staged-declared', keyOf)
			await writer.replace([[1, OLD]])
			const reader = await Tree.createOrOpen<number, Row>(net, 'staged-declared', keyOf)
			await reader.update()
			await reader.get(1)
			const laggingRev = reader.committedRevision()!
			net.lagAt = laggingRev
			await writer.replace([[1, NEW]])
			await reader.update()

			declared.length = 0
			await reader.replace([[2, { key: 2, value: 'mine' }]])
			const [blockId] = net.laggedReads[0]!
			expect(declared.at(-1)?.[blockId]?.baseRev, 'the revision the base was SERVED at, not the one asked for').to.equal(laggingRev)
		})
	})

	describe('when the floor can never be met', () => {
		/** Short, bounded backoff: the case is about what is left behind, not how long giving up takes. */
		const giveUpFast = { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 2 }

		it('an entry whose blocks never landed keeps reading, and writing, through a handle that refreshed past it', async () => {
			// A refused write can leave its log entry behind while the blocks it names never take the
			// entry's revision anywhere. The below-floor content is then the CORRECT content, which is
			// why a below-floor answer is returned rather than refused: a refusal would make the row
			// unreadable — and so unwritable — through every handle that refreshed past the entry.
			const inner = new CountingTransactor()
			const seed = await Tree.createOrOpen<number, Row>(inner, 'abandoned', keyOf)
			await seed.replace([[1, OLD]])
			const reader = await Tree.createOrOpen<number, Row>(inner, 'abandoned', keyOf)
			await reader.update()
			const revBefore = reader.committedRevision()!

			const tearsEveryCommit = new TailLandsButReportsStale(inner, Infinity)
			const abandoner = await Tree.createOrOpen<number, Row>(tearsEveryCommit, 'abandoned', keyOf)
			await abandoner.getCollection().act({ type: 'replace', data: [[1, { key: 1, value: 'never lands' }]] })
			await expect(abandoner.getCollection().sync(giveUpFast)).to.be.rejectedWith(TornActionError)

			await reader.update()
			expect(reader.committedRevision(), 'the abandoned entry is in the log, and adopted').to.equal(revBefore + 1)
			for (let read = 0; read < 3; ++read) {
				expect(await reader.get(1), `read ${read}: the row as it really is`).to.deep.equal(OLD)
			}

			const rewritten: Row = { key: 1, value: 'rewritten' }
			await reader.replace([[1, rewritten]])
			expect(await reader.get(1)).to.deep.equal(rewritten)
			const fresh = await Tree.createOrOpen<number, Row>(inner, 'abandoned', keyOf)
			expect(await fresh.get(1), 'and the write is what storage holds').to.deep.equal(rewritten)
		})
	})

	describe("the test double's pending overlay", () => {
		/** Lands the log tail, then parks before committing the rest — the window a real
		 *  `NetworkTransactor.commit` has between its tail commit and its sweep. */
		class ParkedSweepTransactor extends CountingTransactor {
			armed = false
			readonly tailLanded = deferred()
			readonly sweepGate = deferred()

			override async commit(request: CommitRequest): Promise<CommitResult> {
				if (!this.armed || !request.blockIds.some(id => id !== request.tailId)) return super.commit(request)
				this.armed = false
				const tail = await super.commit({ ...request, blockIds: [request.tailId] })
				if (!tail.success) return tail
				this.tailLanded.resolve()
				await this.sweepGate.promise
				return super.commit({ ...request, blockIds: request.blockIds.filter(id => id !== request.tailId) })
			}
		}

		it('serves the entry\'s own content while its block is still pending, and keeps it only once committed', async () => {
			// `TestTransactor` serves a block still pending under an action the reader's context names
			// by laying the pending change over the committed base, and reports the BASE revision (a
			// pending has none of its own) — below the floor, although the content is exactly the
			// entry's. The real `StorageRepo.get` promotes such a pending on read and reports the
			// entry's revision. Either way the reader must see the entry's content; against the double
			// it is simply not kept until the commit lands.
			const net = new ParkedSweepTransactor()
			const writer = await Tree.createOrOpen<number, Row>(net, 'overlay', keyOf)
			await writer.replace([[1, OLD]])
			const reader = await Tree.createOrOpen<number, Row>(net, 'overlay', keyOf)
			await reader.update()
			await reader.get(1)

			net.armed = true
			const writing = writer.replace([[1, NEW]])
			await net.tailLanded.promise
			await reader.update()
			expect(await reader.get(1), 'read through the pending overlay').to.deep.equal(NEW)
			expect(await net.fetchedDuring(() => reader.get(1)), 'not kept while only pending').to.not.be.empty

			net.sweepGate.resolve()
			await writing
			expect(await reader.get(1)).to.deep.equal(NEW)
			expect(await net.fetchedDuring(() => reader.get(1)), 'kept once committed at the floor').to.deep.equal([])
		})
	})
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>(r => { resolve = r })
	return { promise, resolve }
}
