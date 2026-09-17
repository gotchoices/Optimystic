/**
 * A write may be reported as saved only if EVERY block its log entry names holds that write's
 * revision. Finding the write's own log entry proves only that the log tail landed.
 *
 * `NetworkTransactor.commit` commits the collection's log tail first and only then sweeps the
 * remaining blocks; when the tail commit answers `success: false` it returns at once and the sweep
 * never runs. A failed tail commit does NOT mean the tail is absent — the coordinator's durability
 * gate answers `commit-not-durable` whenever fewer than a majority hold the revision, even though
 * some members stored it. The writer then cancels its pend (dropping the data blocks' pending
 * records everywhere), refreshes, and finds its own log entry.
 *
 * Before this suite's fix the refresh consumed that entry on sight: the pending actions were
 * dropped, the sync returned success, and every data block stayed at its previous revision on every
 * node. The row was permanently missing and no reader got an error.
 *
 * These cases use {@link TailLandsButReportsStale}, which — unlike `CommitLandsButReportsStale` —
 * lands ONLY the tail before reporting failure, the shape the network transactor actually produces.
 */

import { expect } from 'chai'
import { Tree } from '../src/collections/tree/index.js'
import { Collection } from '../src/collection/index.js'
import { TestTransactor, TailLandsButReportsStale, commitRivalTreeWrite } from '../src/testing/test-transactor.js'
import { Log, TornActionError } from '../src/index.js'
import type { Action, ActionHandler, BlockStore, IBlock } from '../src/index.js'

interface Row { key: string; value: string }

const keyOf = (r: Row) => r.key

type SetAction = { value: string }

/** Each `set` inserts one fresh block — a block OTHER than the log tail, so a write that landed only
 *  its tail visibly leaves something behind. */
const handlers: Record<string, ActionHandler<SetAction>> = {
	set: async (_action, store) => {
		store.insert({ header: store.createBlockHeader('TEST', store.generateId()) })
	},
}

const initOptions = {
	modules: handlers,
	createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({ header: store.createBlockHeader('TEST', id) }),
}

/** Short, bounded backoff: these cases are about WHAT the retry does, not how long it waits. */
const retryFast = { maxAttempts: 4, baseBackoffMs: 1, maxBackoffMs: 5 }

/** One durable commit through the unwrapped transactor, so the collection under test opens against
 *  a committed header and its own log entry is reachable after a tail-only landing. */
async function seed(inner: TestTransactor, collectionId: string) {
	const seeded = await Collection.createOrOpen<SetAction>(inner, collectionId, initOptions)
	await seeded.act({ type: 'set', data: { value: 'seed' } })
	await seeded.sync(retryFast)
}

async function logValues(collection: Collection<SetAction>): Promise<string[]> {
	const out: string[] = []
	for await (const action of collection.selectLog()) out.push(action.data.value)
	return out
}

/** The newest log entry in durable storage, read through a fresh collection. */
async function newestEntry(inner: TestTransactor, collectionId: string) {
	const reader = await Collection.createOrOpen<SetAction>(inner, collectionId, initOptions)
	const log = await Log.open<Action<SetAction>>(reader.tracker, collectionId)
	const { entries } = await log!.getFrom(0)
	return entries[entries.length - 1]!
}

describe('Collection: an acknowledged write is complete, not merely logged', () => {
	it('an acknowledged write is readable afterwards', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'participants', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])

		const wrapped = new TailLandsButReportsStale(inner)
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'participants', keyOf)
		await joiner.update()
		await joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]])	// resolves: "saved"
		expect(wrapped.tears, 'the tail-only landing must actually have been injected').to.equal(1)

		await joiner.update()
		expect(await joiner.get('joiner'), 'the writer reads its own acknowledged row')
			.to.deep.equal({ key: 'joiner', value: 'Joiner' })
		// A freshly opened tree over the UNWRAPPED transactor: durable storage, not the writer's view.
		const fresh = await Tree.createOrOpen<string, Row>(inner, 'participants', keyOf)
		expect(await fresh.get('joiner'), 'a fresh reader finds the acknowledged row')
			.to.deep.equal({ key: 'joiner', value: 'Joiner' })
		expect(await fresh.get('host'), 'and the earlier row is untouched')
			.to.deep.equal({ key: 'host', value: 'Host' })
	})

	it('the completed write is logged exactly once, at the revision its tail landed at', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'once', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])

		const wrapped = new TailLandsButReportsStale(inner)
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'once', keyOf)
		await joiner.update()
		const before = joiner.committedRevision()!
		await joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]])

		// Completing the action must not move it: re-driving under a NEW revision would record the
		// same entry twice.
		expect(joiner.committedRevision(), 'the write landed at the one revision its tail took')
			.to.equal(before + 1)
		const fresh = await Tree.createOrOpen<string, Row>(inner, 'once', keyOf)
		expect(fresh.committedRevision(), 'storage agrees on the revision').to.equal(before + 1)

		// Every block the write touched holds THAT revision under THAT action — more than the log
		// tail alone, which is all that held it before the write was finished.
		const actionId = joiner.committedActionId()!
		const committed = inner.getCommittedActions().get(actionId)
		expect(committed?.rev, "the action's blocks are committed at the tail's revision").to.equal(before + 1)
		const touched = Object.keys(committed!.transforms.updates ?? {}).length
			+ Object.keys(committed!.transforms.inserts ?? {}).length
		expect(touched, 'the log tail AND at least one data block').to.be.at.least(2)
	})

	it('reports the durability of the commit that completed the action', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'durability', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])

		const wrapped = new TailLandsButReportsStale(inner)
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'durability', keyOf)
		await joiner.update()
		const durability = await joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]])

		// `undefined` is the documented answer for "nothing was written" — a lie here, since a
		// write WAS made durable on this sync's behalf.
		expect(durability, 'a sync that completed a write reports who holds it').to.not.equal(undefined)
	})

	it('refuses, by name, when a rival took a block the half-landed write still needed', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'rival', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])

		// The rival writes AFTER the joiner's tail landed and its data blocks were abandoned, so the
		// revision the joiner's blocks needed is now held by someone else. The write cannot be
		// completed; it must never be reported saved, and never be re-driven at a new revision.
		const wrapped = new TailLandsButReportsStale(inner, 1, () =>
			commitRivalTreeWrite<string, Row>(inner, 'rival', keyOf, [['rival', { key: 'rival', value: 'Rival' }]]))
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'rival', keyOf)
		await joiner.update()

		let thrown: unknown
		try {
			await joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]])
		} catch (err) {
			thrown = err
		}
		expect(thrown, 'the write is refused, not acknowledged').to.be.instanceOf(TornActionError)
		const torn = thrown as TornActionError
		expect(torn.collectionId).to.equal('rival')
		expect(torn.blockIds, 'the blocks that never landed are named').to.not.be.empty

		const fresh = await Tree.createOrOpen<string, Row>(inner, 'rival', keyOf)
		expect(await fresh.get('joiner'), 'the refused row is not in storage').to.equal(undefined)
		expect(await fresh.get('rival'), "the rival's row is").to.deep.equal({ key: 'rival', value: 'Rival' })
	})
})

describe('Collection: finishing a half-landed write can itself be refused', () => {
	it('retries the FINISH, not a new attempt, when finishing is refused for a cause that can clear', async () => {
		const collectionId = 'finish-refused-once'
		const inner = new TestTransactor()
		await seed(inner, collectionId)
		// Two tears: the first is the write's own attempt, the second is the re-send that tries to
		// finish it — refused the same retryable way, with nothing new landed. The third passes.
		const transactor = new TailLandsButReportsStale(inner, 2)
		const collection = await Collection.createOrOpen<SetAction>(transactor, collectionId, initOptions)
		await collection.act({ type: 'set', data: { value: 'local' } })

		const durability = await collection.sync(retryFast)

		expect(transactor.tears, 'the attempt and its first finish were both refused').to.equal(2)
		expect(durability, 'the finished write reports who holds it').to.not.equal(undefined)
		expect(collection.hasUnsyncedChanges()).to.equal(false)
		// Still ONE revision and ONE entry. A refused finish that fell through to a fresh attempt
		// would have rebuilt the log entry; one that moved on to a new revision would have logged
		// the action twice.
		expect(collection.committedRevision()).to.equal(2)
		expect(await logValues(collection)).to.deep.equal(['seed', 'local'])
		const entry = await newestEntry(inner, collectionId)
		const [status] = await inner.getStatus([{ actionId: entry.actionId, blockIds: entry.blockIds }])
		expect(status!.statuses.every(s => s === 'committed'), 'every block the entry names holds the action')
			.to.equal(true)
	})

	it('gives up as a TORN write, not as a plain exhausted retry, and keeps the action staged', async () => {
		const collectionId = 'finish-refused-forever'
		const inner = new TestTransactor()
		await seed(inner, collectionId)
		const transactor = new TailLandsButReportsStale(inner, Infinity)
		const collection = await Collection.createOrOpen<SetAction>(transactor, collectionId, initOptions)
		await collection.act({ type: 'set', data: { value: 'local' } })

		let thrown: unknown
		try {
			await collection.sync(retryFast)
		} catch (err) {
			thrown = err
		}

		// "Exhausted" would say the write never landed and invite a blind retry. The truth is worse
		// and more specific: the log holds an entry for a write whose data is not saved.
		expect(thrown).to.be.instanceOf(TornActionError)
		const torn = thrown as TornActionError
		expect(torn.reason).to.equal('completion-refused')
		expect(torn.rev).to.equal(2)
		expect(torn.blockIds, 'the blocks left behind are named').to.not.be.empty
		expect(collection.hasUnsyncedChanges(), 'the unsaved action is still staged').to.equal(true)
		expect(collection.committedRevision(), 'and the revision was not advanced past it').to.equal(1)
	})

	it('refuses when it finds its own half-landed entry but no longer holds what would finish it', async () => {
		const collectionId = 'finish-without-transforms'
		const inner = new TestTransactor()
		await seed(inner, collectionId)
		// `later` opens BEFORE the torn write so the entry is still unseen when it refreshes.
		const later = await Collection.createOrOpen<SetAction>(inner, collectionId, initOptions)

		// A writer whose single attempt lands only its tail, then gives up: a durable log entry
		// whose inserted block is on nobody.
		const transactor = new TailLandsButReportsStale(inner)
		const writer = await Collection.createOrOpen<SetAction>(transactor, collectionId, initOptions)
		await writer.act({ type: 'set', data: { value: 'local' } })
		let gaveUp: unknown
		try {
			await writer.sync({ ...retryFast, maxAttempts: 1 })
		} catch (err) {
			gaveUp = err
		}
		expect(gaveUp, 'the single attempt was refused').to.be.instanceOf(Error)
		const tornEntry = await newestEntry(inner, collectionId)

		// `later` adopts that action as its own in-flight write — but it never made the attempt, so
		// it holds nothing to finish it with. Consuming on sight here is exactly the old data loss.
		await later.act({ type: 'set', data: { value: 'local' } })
		later.beginInFlightAction(tornEntry.actionId)
		let thrown: unknown
		try {
			await later.update()
		} catch (err) {
			thrown = err
		}
		expect(thrown).to.be.instanceOf(TornActionError)
		expect((thrown as TornActionError).reason).to.equal('transforms-not-held')
		expect(later.hasUnsyncedChanges(), 'the pending action was not consumed').to.equal(true)
		expect(later.committedRevision(), 'and the refresh changed nothing').to.equal(1)
	})
})
