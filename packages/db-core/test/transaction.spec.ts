import { expect } from 'aegir/chai';
import {
	ActionsEngine,
	createActionsPayload,
	createTransactionId,
	createTransactionCid,
	TransactionCoordinator,
	TransactionContext,
	type Transaction,
	type CollectionActions,
	type ITransactor
} from '../src/index.js';

describe('Transaction', () => {
	describe('Transaction Structure', () => {
		it('should create a valid transaction with all required fields', () => {
			const collections: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [
						{ type: 'insert', data: { id: 1, name: 'Alice' } }
					]
				}
			];

			const payload = createActionsPayload(collections);
			const transactionId = createTransactionId('peer1', Date.now());

			const transaction: Omit<Transaction, 'cid'> = {
				engine: 'actions@1.0.0',
				payload,
				reads: [
					{ blockId: 'block1', revision: 1 }
				],
				transactionId
			};

			const cid = createTransactionCid(transaction);
			const fullTransaction: Transaction = { ...transaction, cid };

			expect(fullTransaction.engine).to.equal('actions@1.0.0');
			expect(fullTransaction.payload).to.be.a('string');
			expect(fullTransaction.reads).to.have.lengthOf(1);
			expect(fullTransaction.transactionId).to.be.a('string');
			expect(fullTransaction.cid).to.be.a('string');
		});

		it('should create unique transaction IDs for different peers', () => {
			const timestamp = Date.now();
			const id1 = createTransactionId('peer1', timestamp);
			const id2 = createTransactionId('peer2', timestamp);

			expect(id1).to.not.equal(id2);
			expect(id1).to.include('peer1');
			expect(id2).to.include('peer2');
		});

		it('should create unique CIDs for different transactions', () => {
			const transaction1: Omit<Transaction, 'cid'> = {
				engine: 'actions@1.0.0',
				payload: createActionsPayload([]),
				reads: [],
				transactionId: 'txn1'
			};

			const transaction2: Omit<Transaction, 'cid'> = {
				engine: 'actions@1.0.0',
				payload: createActionsPayload([]),
				reads: [],
				transactionId: 'txn2'
			};

			const cid1 = createTransactionCid(transaction1);
			const cid2 = createTransactionCid(transaction2);

			expect(cid1).to.not.equal(cid2);
		});
	});

	describe('ActionsEngine', () => {
		let engine: ActionsEngine;

		beforeEach(() => {
			engine = new ActionsEngine();
		});

		it('should execute a transaction with valid actions payload', async () => {
			const collections: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [
						{ type: 'insert', data: { id: 1, name: 'Alice' } },
						{ type: 'insert', data: { id: 2, name: 'Bob' } }
					]
				}
			];

			const payload = createActionsPayload(collections);
			const transaction: Transaction = {
				engine: 'actions@1.0.0',
				payload,
				reads: [],
				transactionId: createTransactionId('peer1', Date.now()),
				cid: 'test-cid'
			};

			const result = await engine.execute(transaction);

			expect(result.success).to.be.true;
			expect(result.actions).to.have.lengthOf(1);
			expect(result.actions![0]!.collectionId).to.equal('users');
			expect(result.actions![0]!.actions).to.have.lengthOf(2);
		});

		it('should execute a transaction with multiple collections', async () => {
			const collections: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{ type: 'insert', data: { id: 1 } }]
				},
				{
					collectionId: 'posts',
					actions: [{ type: 'insert', data: { id: 1 } }]
				}
			];

			const payload = createActionsPayload(collections);
			const transaction: Transaction = {
				engine: 'actions@1.0.0',
				payload,
				reads: [],
				transactionId: createTransactionId('peer1', Date.now()),
				cid: 'test-cid'
			};

			const result = await engine.execute(transaction);

			expect(result.success).to.be.true;
			expect(result.actions).to.have.lengthOf(2);
		});

		it('should fail execution for invalid JSON payload', async () => {
			const transaction: Transaction = {
				engine: 'actions@1.0.0',
				payload: 'invalid json',
				reads: [],
				transactionId: createTransactionId('peer1', Date.now()),
				cid: 'test-cid'
			};

			const result = await engine.execute(transaction);

			expect(result.success).to.be.false;
			expect(result.error).to.include('Failed to parse payload');
		});
	});

	describe('TransactionContext', () => {
		let coordinator: TransactionCoordinator;
		let mockTransactor: ITransactor;

		beforeEach(() => {
			// Create a minimal mock transactor
			mockTransactor = {
				get: async () => ({ blocks: [] }),
				pend: async () => ({ success: true }),
				commit: async () => ({ success: true }),
				cancel: async () => {},
				getStatus: async () => []
			} as unknown as ITransactor;

			const engines = new Map();
			engines.set('actions@1.0.0', new ActionsEngine());

			coordinator = new TransactionCoordinator(
				mockTransactor,
				engines,
				new Map()
			);
		});

		it('should create a transaction context with begin()', () => {
			const context = coordinator.begin();

			expect(context).to.be.instanceOf(TransactionContext);
			expect(context.transactionId).to.be.a('string');
			expect(context.engine).to.equal('actions@1.0.0');
		});

		it('should allow custom engine in begin()', () => {
			const context = coordinator.begin('custom@1.0.0');

			expect(context.engine).to.equal('custom@1.0.0');
		});

		it('should accumulate actions in context', async () => {
			const context = coordinator.begin();

			await context.addAction('users', { type: 'insert', data: { id: 1, name: 'Alice' } });
			await context.addAction('users', { type: 'insert', data: { id: 2, name: 'Bob' } });
			await context.addAction('posts', { type: 'insert', data: { id: 1, userId: 1 } });

			const collectionActions = context.getCollectionActions();
			expect(collectionActions.size).to.equal(2);
			expect(collectionActions.get('users')).to.have.lengthOf(2);
			expect(collectionActions.get('posts')).to.have.lengthOf(1);
		});

		it('should track affected collections', async () => {
			const context = coordinator.begin();

			await context.addAction('users', { type: 'insert', data: { id: 1 } });
			await context.addAction('posts', { type: 'insert', data: { id: 1 } });

			const affected = context.getAffectedCollections();
			expect(affected.size).to.equal(2);
			expect(affected.has('users')).to.be.true;
			expect(affected.has('posts')).to.be.true;
		});

		it('should track read dependencies', () => {
			const context = coordinator.begin();

			context.addRead({ blockId: 'block1', revision: 1 });
			context.addRead({ blockId: 'block2', revision: 2 });

			const reads = context.getReads();
			expect(reads).to.have.lengthOf(2);
			expect(reads[0]!.blockId).to.equal('block1');
			expect(reads[1]!.blockId).to.equal('block2');
		});

		it('should rollback accumulated state', async () => {
			const context = coordinator.begin();

			await context.addAction('users', { type: 'insert', data: { id: 1 } });
			context.addRead({ blockId: 'block1', revision: 1 });

			context.rollback();

			expect(context.getCollectionActions().size).to.equal(0);
			expect(context.getReads()).to.have.lengthOf(0);
		});

		it('should handle empty commit', async () => {
			const context = coordinator.begin();

			const result = await context.commit();

			expect(result.success).to.be.true;
		});
	});
});

