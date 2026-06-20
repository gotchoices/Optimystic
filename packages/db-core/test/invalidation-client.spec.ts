import { use, expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
use(chaiAsPromised)
import { Collection } from '../src/collection/index.js'
import { NetworkTransactor } from '../src/transactor/network-transactor.js'
import { Log } from '../src/log/index.js'
import { Tracker } from '../src/transform/tracker.js'
import { CacheSource } from '../src/transform/cache-source.js'
import { TransactorSource } from '../src/transactor/transactor-source.js'
import { peerIdFromString } from '../src/network/types.js'
import { TestTransactor } from './test-transactor.js'
import type {
	Action, ActionHandler, BlockStore, IBlock, IRepo, BlockId, CollectionId, ActionId,
	IKeyNetwork, ClusterPeers, FindCoordinatorOptions, PeerId, DisputeResolutionProof, RevertedBlock,
} from '../src/index.js'

/**
 * Client-facing surfaces of invalidation (7.6-invalidation-client-notification):
 *  - the **pull** path: `NetworkTransactor.getStatus` reports `committed-invalidated` from the durable
 *    log (survives a fresh transactor over the same storage — the "node restart" case);
 *  - the **client reaction**: `Collection.update`/`updateAndSync` treats a durable invalidation like a
 *    stale read — it drops the reverted block from cache and replays pending work against the reverted
 *    base, so a resubmit succeeds.
 *
 * Both drive the REAL `Collection`/`Log`/`NetworkTransactor` code over a `TestTransactor` store. The
 * invalidation entry is appended through the same commit machinery a real reversal uses (a `Log` over a
 * tracker + `TransactorSource.transact`), so `findInvalidation`/`getInvalidationsFrom` read genuine
 * durable state.
 */

interface TestAction { value: string }

/** Route every block to the single backing repo (a one-node mock key network). */
class SingleNodeKeyNetwork implements IKeyNetwork {
	constructor(private readonly peer: string) { }
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		return peerIdFromString(this.peer)
	}
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return { [this.peer]: { multiaddrs: [], publicKey: '' } }
	}
}

const FIXED_BLOCK = 'data-block-B' as BlockId

/** Handlers that target a single, known data block so the test can name it. */
const handlers: Record<string, ActionHandler<TestAction>> = {
	create: async (action, store) => {
		store.insert({ header: store.createBlockHeader('TEST', FIXED_BLOCK), value: action.data.value } as unknown as IBlock)
	},
	bump: async (action, store) => {
		store.update(FIXED_BLOCK, [`value`, 0, 0, action.data.value] as unknown as never)
	},
}

const initOptions = {
	modules: handlers,
	createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({ header: store.createBlockHeader('TEST', id) }),
}

function makeProof(disputeId: string): DisputeResolutionProof {
	// A structurally-complete v3 proof (these tests exercise client notification, not crypto verification —
	// signatures are placeholders).
	return {
		disputeId,
		messageHash: `msg-${disputeId}`,
		outcome: 'challenger-wins',
		challengerPeerId: 'challenger-1',
		arbitratorSet: ['arb-1', 'arb-2'],
		arbitratorSetSignature: 'set-sig',
		votes: [
			{ version: 'v3', arbitratorPeerId: 'arb-1', vote: 'agree-with-challenger', computedHash: 'h', signature: 'sig-1' },
			{ version: 'v3', arbitratorPeerId: 'arb-2', vote: 'agree-with-challenger', computedHash: 'h', signature: 'sig-2' },
		],
	}
}

/** The committed action ids in the collection log, oldest→newest. */
async function committedActionIds(repo: IRepo, collectionId: CollectionId): Promise<ActionId[]> {
	const source = new TransactorSource<IBlock>(collectionId, repo as never, undefined)
	const tracker = new Tracker<IBlock>(new CacheSource<IBlock>(source))
	const log = await Log.open<Action<TestAction>>(tracker, collectionId)
	const from = log ? await log.getFrom(0) : undefined
	return (from?.entries ?? []).map(e => e.actionId)
}

/**
 * Append a durable {@link import('../src/log/struct.js').InvalidationEntry} for `invalidatedActionId` to
 * the collection's log via the same machinery a reversal uses: open the log on a fresh tracker, add the
 * entry, and commit the resulting log-tail transform through `TransactorSource.transact`.
 */
async function appendInvalidation(
	transactor: NetworkTransactor,
	collectionId: CollectionId,
	invalidatedActionId: ActionId,
	invalidatedRev: number,
	revertedBlock: BlockId,
): Promise<void> {
	const source = new TransactorSource<IBlock>(collectionId, transactor, undefined)
	const tracker = new Tracker<IBlock>(new CacheSource<IBlock>(source))
	const log = (await Log.open<Action<TestAction>>(tracker, collectionId))!
	const ctx = await log.getActionContext()
	const newRev = (ctx?.rev ?? 0) + 1
	const reverted: RevertedBlock[] = [{ blockId: revertedBlock, fromRev: invalidatedRev, restoredContentHash: 'restored-hash' }]
	const { tailPath } = await log.addInvalidation(invalidatedActionId, invalidatedRev, makeProof(`d-${invalidatedActionId}`), reverted, newRev)
	const stale = await source.transact(tracker.transforms, `inv-${newRev}` as ActionId, newRev, collectionId, tailPath.block.header.id)
	if (stale) {
		throw new Error(`invalidation commit was stale: ${JSON.stringify(stale)}`)
	}
}

function makeNetworkTransactor(transactor: TestTransactor): NetworkTransactor {
	return new NetworkTransactor({
		timeoutMs: 2000,
		abortOrCancelTimeoutMs: 1000,
		keyNetwork: new SingleNodeKeyNetwork('peer-A'),
		getRepo: () => transactor as unknown as IRepo,
	})
}

describe('invalidation — client notification (pull + reaction)', () => {
	const collectionId = 'coll-inv' as CollectionId

	describe('NetworkTransactor.getStatus durable committed-invalidated', () => {
		it('reports committed-invalidated from the log, and survives a fresh transactor (node restart)', async () => {
			const store = new TestTransactor()
			const nt = makeNetworkTransactor(store)

			// Commit action A (creates block B), then action C (bumps B) so A is no longer B's latest.
			const collection = await Collection.createOrOpen<TestAction>(nt, collectionId, initOptions)
			await collection.act({ type: 'create', data: { value: 'v1' } })
			await collection.updateAndSync()
			await collection.act({ type: 'bump', data: { value: 'v2' } })
			await collection.updateAndSync()

			const ids = await committedActionIds(store as unknown as IRepo, collectionId)
			expect(ids.length).to.equal(2)
			const [actionA, actionC] = ids

			// Before any invalidation: A is `aborted` (no longer latest), C is `committed`.
			const before = await nt.getStatus([{ actionId: actionA!, blockIds: [FIXED_BLOCK] }])
			expect(before[0]!.statuses).to.deep.equal(['aborted'])

			// Durably reverse action A.
			await appendInvalidation(nt, collectionId, actionA!, 1, FIXED_BLOCK)

			// Pull: A now reports committed-invalidated; C (the surviving latest) stays committed.
			const afterA = await nt.getStatus([{ actionId: actionA!, blockIds: [FIXED_BLOCK] }])
			expect(afterA[0]!.statuses).to.deep.equal(['committed-invalidated'])
			const afterC = await nt.getStatus([{ actionId: actionC!, blockIds: [FIXED_BLOCK] }])
			expect(afterC[0]!.statuses).to.deep.equal(['committed'])

			// "Node restart": a brand-new transactor over the same durable store still sees the reversal.
			const restarted = makeNetworkTransactor(store)
			const afterRestart = await restarted.getStatus([{ actionId: actionA!, blockIds: [FIXED_BLOCK] }])
			expect(afterRestart[0]!.statuses).to.deep.equal(['committed-invalidated'])
		})

		it('a never-committed action is plain aborted (not mislabeled committed-invalidated)', async () => {
			const store = new TestTransactor()
			const nt = makeNetworkTransactor(store)
			const collection = await Collection.createOrOpen<TestAction>(nt, collectionId, initOptions)
			await collection.act({ type: 'create', data: { value: 'v1' } })
			await collection.updateAndSync()

			const status = await nt.getStatus([{ actionId: 'never-existed' as ActionId, blockIds: [FIXED_BLOCK] }])
			expect(status[0]!.statuses).to.deep.equal(['aborted'])
		})
	})

	describe('Collection.updateAndSync client reaction', () => {
		it('drops the reverted block from cache on update so reads observe the reverted base', async () => {
			const store = new TestTransactor()
			const nt = makeNetworkTransactor(store)

			// Commit A (B="v1"), then C (B="v2").
			const writer = await Collection.createOrOpen<TestAction>(nt, collectionId, initOptions)
			await writer.act({ type: 'create', data: { value: 'v1' } })
			await writer.updateAndSync()
			await writer.act({ type: 'bump', data: { value: 'v2' } })
			await writer.updateAndSync()
			const ids = await committedActionIds(store as unknown as IRepo, collectionId)
			const actionA = ids[0]!

			// A reader opens the collection and caches block B at its current content.
			const reader = await Collection.createOrOpen<TestAction>(nt, collectionId, initOptions)
			const cachedBefore = await reader.tracker.tryGet(FIXED_BLOCK) as unknown as { value: string } | undefined
			expect(cachedBefore?.value).to.equal('v2')

			// A reversal of A lands AND the block is reverted to "v0" out-of-band (compensating revision).
			await appendInvalidation(nt, collectionId, actionA, 1, FIXED_BLOCK)
			await revertBlock(nt, store, FIXED_BLOCK, 'v0')

			// update() drives the invalidation reaction with no pending of its own: the reverted block is
			// dropped from the read cache (unconditionally), so a re-read observes the reverted base ("v0")
			// rather than the stale cached "v2". Asserting `equal('v0')` — not merely `!= 'v2'` — is what
			// actually proves the drop happened: without it the reader keeps serving the cached "v2".
			await reader.update()
			const observed = await reader.tracker.tryGet(FIXED_BLOCK) as unknown as { value: string } | undefined
			expect(observed?.value).to.equal('v0')
		})

		it('replays pending work against the reverted base and resubmits successfully', async () => {
			const store = new TestTransactor()
			const nt = makeNetworkTransactor(store)

			// Commit A (B="v1"), then C (B="v2").
			const writer = await Collection.createOrOpen<TestAction>(nt, collectionId, initOptions)
			await writer.act({ type: 'create', data: { value: 'v1' } })
			await writer.updateAndSync()
			await writer.act({ type: 'bump', data: { value: 'v2' } })
			await writer.updateAndSync()
			const actionA = (await committedActionIds(store as unknown as IRepo, collectionId))[0]!

			const reader = await Collection.createOrOpen<TestAction>(nt, collectionId, initOptions)
			expect((await reader.tracker.tryGet(FIXED_BLOCK) as unknown as { value: string } | undefined)?.value).to.equal('v2')

			// A reversal of A lands AND the block is reverted to "v0" out-of-band (compensating revision).
			await appendInvalidation(nt, collectionId, actionA, 1, FIXED_BLOCK)
			await revertBlock(nt, store, FIXED_BLOCK, 'v0')

			// The reader has pending work: the landed invalidation flags a conflict (pending present), so
			// updateAndSync drops the reverted block, replays the pending action against the reverted base,
			// and the resubmit commits. The resubmit is a distinct, durably-committed action past the
			// reversal — proven by a new log action entry — and the collection reads its own result.
			await reader.act({ type: 'bump', data: { value: 'v3' } })
			await reader.updateAndSync()

			const committed = await committedActionIds(store as unknown as IRepo, collectionId)
			expect(committed.length).to.equal(3) // create + writer bump + reader's resubmitted bump
			const observed = await reader.tracker.tryGet(FIXED_BLOCK) as unknown as { value: string } | undefined
			expect(observed?.value).to.equal('v3')
		})
	})
})

/**
 * Commit a compensating revision to `blockId` (the as-if-reverted content), so the block's latest is a new
 * action distinct from the reversed one — the durable effect an invalidation's per-block reversal has.
 */
async function revertBlock(transactor: NetworkTransactor, store: TestTransactor, blockId: BlockId, value: string): Promise<void> {
	const current = await transactor.get({ blockIds: [blockId] })
	const rev = (current[blockId]?.state.latest?.rev ?? 0) + 1
	const actionId = `revert-${rev}` as ActionId
	await store.pend({ actionId, transforms: { inserts: {}, updates: { [blockId]: [['value', 0, 0, value] as unknown as never] }, deletes: [] }, policy: 'c' })
	await store.commit({ actionId, blockIds: [blockId], tailId: blockId, rev })
}
