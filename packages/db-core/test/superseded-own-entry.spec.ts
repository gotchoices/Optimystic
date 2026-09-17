/**
 * A write that was SUPERSEDED before its writer could confirm it is reported for what it is.
 *
 * `Collection.completeOwnEntry` finishes a half-landed write by re-sending it at its own revision.
 * Storage refuses that re-send as soon as ANY block has moved past the revision — and every later
 * commit to the collection moves the log tail past it — so the refusal only says a rival was there,
 * not whether the rival built ON the write or OVER it. The writer therefore asks the blocks' own
 * history (`ITransactor.getLineage`) before it answers, and a `TornActionError` now says in `final`
 * whether the caller may safely submit the change again.
 *
 * The in-memory double is one store with no replicas, so every revision was derived from the one
 * before it and `TestTransactor.getLineage` answers from the revision index; the cohort-level
 * folding of per-member answers is pinned in `cohort-lineage.spec.ts`, and the mesh tier in
 * `packages/db-p2p/test/superseded-own-write-is-saved.spec.ts`.
 */

import { expect } from 'chai'
import { Tree } from '../src/collections/tree/index.js'
import { Collection } from '../src/collection/index.js'
import { TestTransactor, CommitLandsButReportsStale, TailLandsButReportsStale, commitRivalTreeWrite } from '../src/testing/test-transactor.js'
import { TornActionError } from '../src/index.js'
import type { ActionBlocks, BlockStore, IBlock, ActionHandler, ITransactor } from '../src/index.js'

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
const retryFast = { maxAttempts: 4, baseBackoffMs: 1, maxBackoffMs: 5 }

/** A wrapper that offers no `getLineage` — the shape of a transactor, or a wrapper around one,
 *  that predates the question. The writer cannot ask. */
const cannotSay = (inner: ITransactor): ITransactor => ({
	get: b => inner.get(b),
	getStatus: a => inner.getStatus(a),
	pend: r => inner.pend(r),
	cancel: a => inner.cancel(a),
	commit: r => inner.commit(r),
})

/** The writer's FIRST cancel (its attempt's own clean-up) goes through; every later one — the
 *  confirmation the settlement needs — is refused. */
class LaterCancelsRefused extends TailLandsButReportsStale {
	private cancels = 0
	override async cancel(ref: ActionBlocks): Promise<void> {
		if (this.cancels++ > 0) {
			throw new Error('cancel refused: injected')
		}
		await super.cancel(ref)
	}
}

async function failing(work: () => Promise<unknown>): Promise<TornActionError> {
	let thrown: unknown
	try {
		await work()
	} catch (err) {
		thrown = err
	}
	expect(thrown).to.be.instanceOf(TornActionError)
	return thrown as TornActionError
}

describe('Collection: a superseded write is reported for what it is', () => {
	it('is SAVED when the rival built the next revision on top of it', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'built-upon', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])

		// The whole write lands; before the writer hears (a refusal), a rival reads it and adds to it.
		const wrapped = new CommitLandsButReportsStale(inner, 1, () =>
			commitRivalTreeWrite<string, Row>(inner, 'built-upon', keyOf, [['rival', { key: 'rival', value: 'Rival' }]]))
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'built-upon', keyOf)
		await joiner.update()
		const before = joiner.committedRevision()!

		const durability = await joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]])
		expect(wrapped.landedCommits, 'the write landed once and was masked; no re-drive landed a second time').to.equal(1)
		expect(durability, 'a saved write reports who holds it').to.not.equal(undefined)
		expect(joiner.hasUnsyncedChanges(), 'nothing is left staged').to.equal(false)

		const fresh = await Tree.createOrOpen<string, Row>(inner, 'built-upon', keyOf)
		expect(await fresh.get('joiner')).to.deep.equal({ key: 'joiner', value: 'Joiner' })
		expect(await fresh.get('rival')).to.deep.equal({ key: 'rival', value: 'Rival' })
		expect(fresh.committedRevision(), 'the write and the rival: two revisions, no re-drive').to.equal(before + 2)
	})

	it('is torn and FINAL when the rival built over it: the blocks exclude it and the pending records are gone', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'built-over', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])
		const wrapped = new TailLandsButReportsStale(inner, 1, () =>
			commitRivalTreeWrite<string, Row>(inner, 'built-over', keyOf, [['rival', { key: 'rival', value: 'Rival' }]]))
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'built-over', keyOf)
		await joiner.update()

		const torn = await failing(() => joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]]))
		expect(torn.reason).to.equal('rival-holds-revision')
		expect(torn.final, 'safe to submit again').to.equal(true)
		expect(torn.message).to.include('safe to submit again')
		expect(joiner.hasUnsyncedChanges(), 'a failed replace leaves nothing staged').to.equal(false)

		// Final means final: submitting it again stores it exactly once, with nothing riding along.
		await joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]])
		const fresh = await Tree.createOrOpen<string, Row>(inner, 'built-over', keyOf)
		expect(await fresh.get('joiner')).to.deep.equal({ key: 'joiner', value: 'Joiner' })
		expect(await fresh.get('rival')).to.deep.equal({ key: 'rival', value: 'Rival' })
	})

	it('is torn but NOT final when the writer cannot ask the blocks (no getLineage)', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'cannot-ask', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])
		// Everything landed, the rival built on it — the write IS saved, and the writer has no way
		// to find that out. It must not claim either way.
		const wrapped = cannotSay(new CommitLandsButReportsStale(inner, 1, () =>
			commitRivalTreeWrite<string, Row>(inner, 'cannot-ask', keyOf, [['rival', { key: 'rival', value: 'Rival' }]])))
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'cannot-ask', keyOf)
		await joiner.update()

		const torn = await failing(() => joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]]))
		expect(torn.reason).to.equal('rival-holds-revision')
		expect(torn.final, 'not established — the row is in fact saved').to.equal(false)
		expect(torn.message).to.include('could not be established')
	})

	it('is torn but NOT final when its pending records could not be confirmed gone', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'cancel-refused', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])
		const wrapped = new LaterCancelsRefused(inner, 1, () =>
			commitRivalTreeWrite<string, Row>(inner, 'cancel-refused', keyOf, [['rival', { key: 'rival', value: 'Rival' }]]))
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'cancel-refused', keyOf)
		await joiner.update()

		const torn = await failing(() => joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]]))
		expect(torn.reason).to.equal('rival-holds-revision')
		expect(torn.final, 'the records may still land the write').to.equal(false)
	})

	it('settles a write it gives up on after repeated refusals: torn, and final once nothing can land it', async () => {
		const inner = new TestTransactor()
		const seeded = await Collection.createOrOpen<SetAction>(inner, 'gave-up', initOptions)
		await seeded.act({ type: 'set', data: { value: 'seed' } })
		await seeded.sync(retryFast)

		const transactor = new TailLandsButReportsStale(inner, Infinity)
		const collection = await Collection.createOrOpen<SetAction>(transactor, 'gave-up', initOptions)
		await collection.act({ type: 'set', data: { value: 'local' } })

		const torn = await failing(() => collection.sync(retryFast))
		expect(torn.reason).to.equal('completion-refused')
		// The last refresh of the budget settled it instead of asking for another round: the inserted
		// block never reached the revision anywhere, and the cancel was confirmed.
		expect(torn.final).to.equal(true)
		expect(collection.hasUnsyncedChanges(), 'at the collection level the action stays staged for the caller to decide').to.equal(true)
	})

	it('a failed replace leaves nothing staged, so nothing rides along with the next one', async () => {
		const inner = new TestTransactor()
		const host = await Tree.createOrOpen<string, Row>(inner, 'nothing-rides-along', keyOf)
		await host.replace([['host', { key: 'host', value: 'Host' }]])
		const wrapped = new TailLandsButReportsStale(inner, 1, () =>
			commitRivalTreeWrite<string, Row>(inner, 'nothing-rides-along', keyOf, [['rival', { key: 'rival', value: 'Rival' }]]))
		const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'nothing-rides-along', keyOf)
		await joiner.update()

		await failing(() => joiner.replace([['torn', { key: 'torn', value: 'Torn' }]]))
		expect(joiner.hasUnsyncedChanges()).to.equal(false)
		expect(await joiner.get('torn'), 'the writer no longer sees its own failed row').to.equal(undefined)

		// Before the fix this next write carried the torn row with it: the row reported failed
		// "appeared one write later".
		await joiner.replace([['later', { key: 'later', value: 'Later' }]])
		const fresh = await Tree.createOrOpen<string, Row>(inner, 'nothing-rides-along', keyOf)
		expect(await fresh.get('later')).to.deep.equal({ key: 'later', value: 'Later' })
		expect(await fresh.get('torn'), 'the failed row did not come along').to.equal(undefined)
	})
})
