import { expect } from 'chai'
import { Collection, TransactionExpiredError } from '../src/index.js'
import { NetworkTransactor } from '../src/transactor/network-transactor.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import { routingKeyForBlock } from '../src/network/routing-key.js'
import { peerIdFromString } from '../src/network/types.js'
import type {
	ActionBlocks, ActionHandler, BlockGets, BlockId, BlockStore, ClusterPeers, CommitRequest, IBlock,
	IKeyNetwork, IRepo, PendResult, PeerId, TransactionExpiry,
} from '../src/index.js'

/**
 * GitHub issue #24, the writer's half. A cohort whose clocks are ahead of the writer's by more than
 * the transaction timeout refuses every write as already expired, and the coordinating repo returns
 * that refusal with its numbers. A sync must stop on it by name after ONE attempt — the retry's
 * expiration would come from the same clock — rather than spend its retry budget re-sending a
 * decided failure.
 *
 * The collection's first pend spans two coordinators: the header's answers a lost race, the log's
 * the expiry. So the refusal also has to survive `NetworkTransactor.pend` rebuilding one answer from
 * the two, and win over the retryable conflict beside it.
 */

interface TestAction { value: string }

const handlers: Record<string, ActionHandler<TestAction>> = {
	set: async (_action, store) => {
		store.insert({ header: store.createBlockHeader('TEST', store.generateId()) })
	}
}

const initOptions = {
	modules: handlers,
	createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({ header: store.createBlockHeader('TEST', id) })
}

const sameKey = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i])

/** The collection's header block on `headerPeer`, every other block on `otherPeer`, each a cohort of one. */
class SplitKeyNetwork implements IKeyNetwork {
	constructor(private readonly headerId: BlockId, private readonly headerPeer: string, private readonly otherPeer: string) { }
	private peerFor(key: Uint8Array): string {
		return sameKey(key, routingKeyForBlock(this.headerId)) ? this.headerPeer : this.otherPeer
	}
	async findCoordinator(key: Uint8Array): Promise<PeerId> { return peerIdFromString(this.peerFor(key)) }
	async findCluster(key: Uint8Array): Promise<ClusterPeers> { return { [this.peerFor(key)]: { multiaddrs: [], publicKey: '' } } }
}

/** Reads, commits and cancels go to the shared store; every pend is answered with `refusal`. */
class RefusingRepo implements IRepo {
	pends = 0
	constructor(private readonly store: TestTransactor, private readonly refusal: () => PendResult) { }
	get(blockGets: BlockGets) { return this.store.get(blockGets) }
	async pend(): Promise<PendResult> {
		this.pends++
		return this.refusal()
	}
	cancel(actionRef: ActionBlocks) { return this.store.cancel(actionRef) }
	commit(request: CommitRequest) { return this.store.commit(request) }
}

describe('a write refused because the transaction expired by the cohort\'s clocks', () => {
	it('throws TransactionExpiredError after one attempt, with the numbers, and keeps the change staged', async () => {
		const collectionId = 'expiring-collection' as BlockId
		const memberClock = Date.now() + 31_000
		const expiry: TransactionExpiry = {
			expiration: memberClock - 1_000,
			memberClocks: { 'member-1': memberClock },
			coordinatorClock: memberClock - 31_000,
		}
		const store = new TestTransactor()
		const header = new RefusingRepo(store, () => ({ success: false, conflict: true, reason: 'lost a race' }))
		const log = new RefusingRepo(store, () => new TransactionExpiredError(expiry, expiry.coordinatorClock).toFailure())
		const transactor = new NetworkTransactor({
			timeoutMs: 1000,
			abortOrCancelTimeoutMs: 500,
			keyNetwork: new SplitKeyNetwork(collectionId, 'peer-header', 'peer-log'),
			getRepo: (peerId: PeerId) => peerId.toString() === 'peer-header' ? header : log,
		})

		const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
		await collection.act({ type: 'set', data: { value: 'a' } })

		let caught: unknown
		try {
			await collection.sync({ baseBackoffMs: 1, maxBackoffMs: 1 })
		} catch (err) {
			caught = err
		}

		expect(caught).to.be.instanceOf(TransactionExpiredError)
		expect([header.pends, log.pends], 'one attempt, and no coordinator re-picked').to.deep.equal([1, 1])
		const error = caught as TransactionExpiredError
		expect(error.expiration).to.equal(expiry.expiration)
		expect(error.memberClocks).to.deep.equal(expiry.memberClocks)
		expect(error.coordinatorClock).to.equal(expiry.coordinatorClock)
		expect(error.apparentSkewMs, 'measured against the writer\'s own clock').to.be.closeTo(31_000, 1_000)
		expect(collection.hasUnsyncedChanges(), 'a sync after the clock is fixed still has the change to send').to.equal(true)
	})
})
