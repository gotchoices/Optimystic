/**
 * Ticket: bug-a-pended-transform-does-not-carry-its-base (second of three).
 *
 * The multi-collection coordinator's pend (`TransactionCoordinator.pendCollection`) names, per
 * update-only block, the committed revision the block's staged operations were computed against —
 * read from the same tracker the commit side digests, and omitted entirely when nothing is named.
 * The single-collection sibling is "Collection.sync declares its blocks" in
 * commit-digest-threading.spec.ts.
 */

import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	Collection,
	TransactionCoordinator,
	blockIdsForTransforms,
	createActionsStatements,
	createTransactionId,
	createTransactionStamp,
	type ActionHandler,
	type BlockId,
	type BlockOperation,
	type BlockStore,
	type CollectionActions,
	type CollectionInitOptions,
	type CommitRequest,
	type CommitResult,
	type IBlock,
	type PendRequest,
	type PendResult,
	type Transaction,
} from '../src/index.js';
import { DelegatingTransactor, TestTransactor } from '../src/testing/test-transactor.js';

type SpecAction = { id: string; op?: BlockOperation };

/** Blocks carry an `items` array so an `update` action has something valid to splice into. */
const handlers: Record<string, ActionHandler<SpecAction>> = {
	insert: async (action, store) => {
		store.insert({ header: store.createBlockHeader('TEST', action.data.id as BlockId), items: [] } as IBlock);
	},
	update: async (action, store) => {
		store.update(action.data.id as BlockId, action.data.op!);
	},
};

const init = (): CollectionInitOptions<SpecAction> => ({
	modules: handlers,
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => ({
		header: store.createBlockHeader('TEST', id),
	}),
});

/** Captures every pend and commit reaching the transactor, delegating everything else. */
class CapturingTransactor extends DelegatingTransactor {
	readonly pends: PendRequest[] = [];
	readonly commits: CommitRequest[] = [];
	constructor(inner: TestTransactor) { super(inner); }
	override async pend(request: PendRequest): Promise<PendResult> {
		this.pends.push(structuredClone(request));
		return this.inner.pend(request);
	}
	override async commit(request: CommitRequest): Promise<CommitResult> {
		this.commits.push(structuredClone(request));
		return this.inner.commit(request);
	}
}

const baseKeys = (request: PendRequest) => Object.keys(request.baseRevs ?? {}).sort();
const hasBasesKey = (request: object) => Object.prototype.hasOwnProperty.call(request, 'baseRevs');

/** Stage `actions` under a fresh stamp and commit them through the coordinator. */
async function stageAndCommit(coordinator: TransactionCoordinator, actions: CollectionActions[]): Promise<void> {
	const statements = createActionsStatements(actions);
	const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
	const transaction: Transaction = {
		stamp, statements, reads: [],
		id: await createTransactionId(stamp.id, statements, []),
	};
	await coordinator.applyActions(actions, stamp.id);
	await coordinator.commit(transaction);
}

describe('TransactionCoordinator.pendCollection names the bases of the collection\'s tracker', () => {
	it('names a base for every update-only block of each collection, and never for an inserted one', async () => {
		const transactor = new CapturingTransactor(new TestTransactor());
		const collections = new Map<string, Collection<SpecAction>>();
		for (const id of ['c1', 'c2']) {
			collections.set(id, await Collection.createOrOpen<SpecAction>(transactor, id, init()));
		}
		const coordinator = new TransactionCoordinator(transactor, collections as Map<string, Collection<any>>);

		// Round 1: create both collections and one block in each. Everything is an insert.
		await stageAndCommit(coordinator, [
			{ collectionId: 'c1', actions: [{ type: 'insert', data: { id: 'b1' } }] },
			{ collectionId: 'c2', actions: [{ type: 'insert', data: { id: 'b2' } }] },
		]);
		const firstRound = transactor.pends.slice(-2);
		expect(firstRound.length).to.equal(2);
		for (const pend of firstRound) {
			expect(hasBasesKey(pend), 'an all-insert pend omits the field entirely').to.be.false;
		}

		// Round 2: update the block in each collection. Each pend names its own block's base (and
		// its own log tail's), read from that collection's tracker, and nothing from the other.
		await stageAndCommit(coordinator, [
			{ collectionId: 'c1', actions: [{ type: 'update', data: { id: 'b1', op: ['items', 0, 0, ['v1']] } }] },
			{ collectionId: 'c2', actions: [{ type: 'update', data: { id: 'b2', op: ['items', 0, 0, ['v2']] } }] },
		]);
		const secondRound = transactor.pends.slice(-2);
		expect(secondRound.length).to.equal(2);
		for (const pend of secondRound) {
			const ids = blockIdsForTransforms(pend.transforms);
			const own = ids.includes('b1' as BlockId) ? 'b1' : 'b2';
			expect(baseKeys(pend), `the updated block ${own} names its base`).to.include(own);
			expect(ids, 'every named id is one this pend carries').to.include.members(baseKeys(pend));
			expect(pend.baseRevs![own as BlockId], 'a committed revision, not a guess').to.be.a('number');
			// The same tracker digests the commit: the pend's base is the base the digest was computed from.
			const commit = transactor.commits.find(c => c.actionId === pend.actionId && c.blockIds.includes(own as BlockId));
			expect(commit, 'the commit of the same action and collection').to.exist;
			expect(commit!.blockDigests?.[own as BlockId]?.baseRev).to.equal(pend.baseRevs![own as BlockId]);
		}
	});
});
