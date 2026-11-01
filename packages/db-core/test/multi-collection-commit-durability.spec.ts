/**
 * Ticket: multi-collection-commit-reports-durability.
 *
 * A commit spanning several collections answers the way `Collection.sync` does: who holds what it
 * wrote, per collection, with one overall class that is the weakest of them. These pin that each
 * collection's class reaches the caller from the commit that wrote it, that a commit with nothing
 * staged reports `undefined` rather than a fabricated class, that a partial landing reports the
 * committed half on its error, and that an unknown class is never folded into an overall answer.
 *
 * The case where the class comes from the refresh between attempts rather than from an attempt is
 * pinned in coordinator-own-action-replay.spec.ts ("finishes every half-landed participant of a
 * multi-collection commit").
 */
import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	ActionsEngine,
	Collection,
	CoordinatorPartialCommitError,
	TransactionCoordinator,
	TransactionSession,
	createActionsStatements,
	createTransactionId,
	createTransactionStamp,
	isFullyDurable,
	transactionDurability,
	type ActionHandler,
	type BlockId,
	type BlockStore,
	type CollectionActions,
	type CollectionId,
	type CollectionInitOptions,
	type CommitRequest,
	type CommitResult,
	type IBlock,
	type Transaction,
	type WriteDurability,
} from '../src/index.js';
import { DelegatingTransactor, TestTransactor } from '../src/testing/test-transactor.js';

type SpecAction = { value: string };

const handlers: Record<string, ActionHandler<SpecAction>> = {
	set: async (_action, store) => {
		store.insert({ header: store.createBlockHeader('TEST', store.generateId()) });
	},
};

const init = (): CollectionInitOptions<SpecAction> => ({
	modules: handlers,
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => ({
		header: store.createBlockHeader('TEST', id),
	}),
});

const FULL: WriteDurability = {
	quorum: 'full',
	confirmed: 3,
	cohort: 3,
	unconfirmed: [],
	cohortPeerIds: ['peer-a', 'peer-b', 'peer-c'],
};

const MAJORITY: WriteDurability = {
	quorum: 'majority',
	confirmed: 2,
	cohort: 3,
	unconfirmed: ['peer-f'],
	cohortPeerIds: ['peer-d', 'peer-e', 'peer-f'],
};

/**
 * Commits for real on the inner {@link TestTransactor}, then replaces the durability on a success
 * with the class stamped for the collection the request belongs to — `TestTransactor` is one node
 * and only ever reports `local`. Each commit of `throwsFor` throws instead, the transport-shaped
 * failure `commitCollection` retries and then gives up on.
 *
 * Collections are told apart by their header block id (the collection id), which a brand-new
 * collection's first commit always carries; commit order across the concurrent fan-out is not
 * contractual.
 */
class PerCollectionDurabilityTransactor extends DelegatingTransactor {
	constructor(
		inner: TestTransactor,
		private readonly stamps: ReadonlyMap<CollectionId, WriteDurability>,
		private readonly throwsFor?: CollectionId,
	) {
		super(inner);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (this.throwsFor !== undefined && request.blockIds.includes(this.throwsFor)) {
			throw new Error('injected transport failure');
		}
		const result = await this.inner.commit(request);
		const stamped = [...this.stamps].find(([id]) => request.blockIds.includes(id))?.[1];
		if (!result.success || stamped === undefined) return result;
		return { ...result, durability: stamped };
	}
}

/** The answer minus `blockRevs`, which the coordinator adds per collection (the blocks it
 *  committed, under random ids): these tests compare the class the transactor answered with. */
function answered(d: WriteDurability | undefined): WriteDurability | undefined {
	if (d === undefined) return undefined;
	const { blockRevs: _blockRevs, ...rest } = d;
	return rest;
}

function answeredPerCollection(collections: ReadonlyMap<CollectionId, WriteDurability | undefined>): Map<CollectionId, WriteDurability | undefined> {
	return new Map([...collections].map(([id, d]) => [id, answered(d)]));
}

/** Stage one `set` action per entry and return the transaction that will commit them. With no
 *  entries this is the read-only stamp: the empty pre-stage barrier opens it, nothing is staged. */
async function stage(
	coordinator: TransactionCoordinator,
	entries: { collectionId: string; value: string }[],
): Promise<Transaction> {
	const actions: CollectionActions[] = entries.map(({ collectionId, value }) => ({
		collectionId,
		actions: [{ type: 'set', data: { value } }],
	}));
	const statements = createActionsStatements(actions);
	const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
	const transaction: Transaction = {
		stamp, statements, reads: [],
		id: await createTransactionId(stamp.id, statements, []),
	};
	await coordinator.applyActions(actions, stamp.id);
	return transaction;
}

describe('multi-collection commit reports durability', () => {
	it('reports each collection with its own class, and the weaker one overall', async () => {
		const idA = 'mc-durability-full';
		const idB = 'mc-durability-majority';
		const transactor = new PerCollectionDurabilityTransactor(new TestTransactor(), new Map([[idA, FULL], [idB, MAJORITY]]));
		const a = await Collection.createOrOpen<SpecAction>(transactor, idA, init());
		const b = await Collection.createOrOpen<SpecAction>(transactor, idB, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[idA, a], [idB, b]]));
		const session = await TransactionSession.create(coordinator, new ActionsEngine());
		await session.execute('stmt1', [
			{ collectionId: idA, actions: [{ type: 'set', data: { value: 'a' } }] },
			{ collectionId: idB, actions: [{ type: 'set', data: { value: 'b' } }] },
		]);

		const result = await session.commit();

		expect(result.success).to.equal(true);
		expect(result.durability, 'a commit that wrote something reports it').to.not.equal(undefined);
		const durability = result.durability!;
		expect(answeredPerCollection(durability.collections)).to.deep.equal(new Map([[idA, FULL], [idB, MAJORITY]]));
		expect(durability.overall?.quorum, 'overall is the weaker class').to.equal('majority');
		expect(isFullyDurable(durability.overall!), 'one collection held by a majority is not fully held').to.equal(false);
	});

	it('reports undefined when nothing was staged — nothing was written, so there is no class', async () => {
		const id = 'mc-durability-empty';
		const transactor = new PerCollectionDurabilityTransactor(new TestTransactor(), new Map([[id, FULL]]));
		const collection = await Collection.createOrOpen<SpecAction>(transactor, id, init());
		// Flush the invented collection's header, which lives in the tracker until the first sync.
		await collection.sync();
		const coordinator = new TransactionCoordinator(transactor, new Map([[id, collection]]));
		const transaction = await stage(coordinator, []);

		expect(await coordinator.commit(transaction)).to.equal(undefined);
	});

	it('reports the committed half on a partial landing, and only that half', async () => {
		const idA = 'mc-durability-landed';
		const idB = 'mc-durability-throws';
		// B's commit throws on every try, which spends commitCollection's transport retries: a hard
		// failure after A landed, so the commit escapes at once as a partial landing.
		const transactor = new PerCollectionDurabilityTransactor(new TestTransactor(), new Map([[idA, MAJORITY]]), idB);
		const a = await Collection.createOrOpen<SpecAction>(transactor, idA, init());
		const b = await Collection.createOrOpen<SpecAction>(transactor, idB, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[idA, a], [idB, b]]));
		const transaction = await stage(coordinator, [
			{ collectionId: idA, value: 'a' },
			{ collectionId: idB, value: 'b' },
		]);

		let thrown: unknown;
		try {
			await coordinator.commit(transaction);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).to.be.instanceOf(CoordinatorPartialCommitError);
		const partial = thrown as CoordinatorPartialCommitError;
		expect(partial.committedCollections).to.deep.equal([idA]);
		expect(partial.failedCollections).to.deep.equal([idB]);
		expect(answeredPerCollection(partial.durability.collections), 'names exactly the committed collection, with its class')
			.to.deep.equal(new Map([[idA, MAJORITY]]));
		expect(answered(partial.durability.overall)).to.deep.equal(MAJORITY);
	});

	it('never folds an unknown class into an overall answer', () => {
		const durability = transactionDurability(new Map([['a', FULL], ['b', undefined]]));

		expect([...durability.collections.keys()], 'a saved collection of unknown class is still listed')
			.to.deep.equal(['a', 'b']);
		expect(durability.overall, 'no overall class is fabricated over an unknown one').to.equal(undefined);
		expect(() => transactionDurability(new Map()), 'a commit that wrote nothing has no report at all').to.throw();
	});
});
