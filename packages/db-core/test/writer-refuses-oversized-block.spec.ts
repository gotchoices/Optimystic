/**
 * A write that would leave a block larger than `MAX_BLOCK_BYTES` is refused by the writer, before
 * anything is sent, on both write paths: `Collection.sync` and `TransactionCoordinator.commit`.
 *
 * The block here grows across two writes, each well under the per-transaction limit, which is the way
 * a block outgrows one message without any single transaction being too large to send.
 */

import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	BlockTooLargeError,
	Collection,
	MAX_BLOCK_BYTES,
	TransactionCoordinator,
	createActionsStatements,
	createTransactionId,
	createTransactionStamp,
	type ActionHandler,
	type BlockId,
	type BlockStore,
	type CollectionActions,
	type CollectionInitOptions,
	type IBlock,
	type PendRequest,
	type PendResult,
	type Transaction,
} from '../src/index.js';
import { DelegatingTransactor, TestTransactor } from '../src/testing/test-transactor.js';

type GrowAction = { id: BlockId; chars?: number };
type ItemsBlock = IBlock & { items: string[] };

/** Over the limit after two grows, under it after one. */
const chunkChars = Math.ceil(MAX_BLOCK_BYTES / 2);

/** A test-only handler that grows a block by appending a string of `chars` characters: the action
 * itself is a few bytes, so only the block outgrows the limit. */
const handlers: Record<string, ActionHandler<GrowAction>> = {
	insert: async (action, store) => {
		store.insert({ header: store.createBlockHeader('TEST', action.data.id), items: [] } as ItemsBlock);
	},
	grow: async (action, store) => {
		const block = await store.tryGet(action.data.id) as ItemsBlock;
		store.update(action.data.id, ['items', block.items.length, 0, ['x'.repeat(action.data.chars!)]]);
	},
};

const init = (): CollectionInitOptions<GrowAction> => ({
	modules: handlers,
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => ({ header: store.createBlockHeader('TEST', id) }),
});

class CountingTransactor extends DelegatingTransactor {
	pends = 0;
	constructor(inner: TestTransactor) { super(inner); }
	override async pend(request: PendRequest): Promise<PendResult> {
		this.pends++;
		return this.inner.pend(request);
	}
}

const big = 'big' as BlockId;
const insertThenGrow = [{ type: 'insert', data: { id: big } }, { type: 'grow', data: { id: big, chars: chunkChars } }];
const growAgain = [{ type: 'grow', data: { id: big, chars: chunkChars } }];

function expectBlockTooLarge(error: unknown): void {
	expect(error).to.be.instanceOf(BlockTooLargeError);
	const tooLarge = error as BlockTooLargeError;
	expect(tooLarge.blockId).to.equal(big);
	expect(tooLarge.bytes).to.be.greaterThan(MAX_BLOCK_BYTES);
	expect(tooLarge.limit).to.equal(MAX_BLOCK_BYTES);
	expect(tooLarge.message).to.contain('MAX_BLOCK_BYTES');
}

async function stageAndCommit(coordinator: TransactionCoordinator, actions: CollectionActions[]): Promise<void> {
	const statements = createActionsStatements(actions);
	const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
	const transaction: Transaction = { stamp, statements, reads: [], id: await createTransactionId(stamp.id, statements, []) };
	await coordinator.applyActions(actions, stamp.id);
	await coordinator.commit(transaction);
}

describe('a writer refuses a block too large to copy', () => {
	it('Collection.sync refuses it before the pend, and actAndSync unstages the write', async () => {
		const transactor = new CountingTransactor(new TestTransactor());
		const collection = await Collection.createOrOpen<GrowAction>(transactor, 'oversized', init());
		await collection.actAndSync(insertThenGrow);
		const pendsBefore = transactor.pends;

		const error = await collection.actAndSync(growAgain).then(() => undefined, (e: unknown) => e);

		expectBlockTooLarge(error);
		expect(transactor.pends, 'nothing reached the transactor').to.equal(pendsBefore);
		expect(collection.hasUnsyncedChanges(), 'the refused write is unstaged').to.be.false;
		expect(((await collection.tracker.tryGet(big)) as ItemsBlock).items, 'the block is as it was committed').to.have.lengthOf(1);
	});

	it('TransactionCoordinator.commit refuses it by name before the pend', async () => {
		const transactor = new CountingTransactor(new TestTransactor());
		const collection = await Collection.createOrOpen<GrowAction>(transactor, 'oversized', init());
		const coordinator = new TransactionCoordinator(transactor, new Map([['oversized', collection]]) as Map<string, Collection<any>>);
		await stageAndCommit(coordinator, [{ collectionId: 'oversized', actions: insertThenGrow }]);
		const pendsBefore = transactor.pends;

		const error = await stageAndCommit(coordinator, [{ collectionId: 'oversized', actions: growAgain }]).then(() => undefined, (e: unknown) => e);

		expectBlockTooLarge(error);
		expect(transactor.pends, 'nothing reached the transactor').to.equal(pendsBefore);
	});
});
