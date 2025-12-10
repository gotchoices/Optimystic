import { expect } from 'aegir/chai';
import {
	ActionsEngine,
	createActionsStatements,
	createTransactionStamp,
	createTransactionId,
	TransactionCoordinator,
	Tree,
	type Transaction,
	type CollectionActions
} from '../src/index.js';
import { TestTransactor } from './test-transactor.js';

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

			const statements = createActionsStatements(collections);
			const stamp = createTransactionStamp(
				'peer1',
				Date.now(),
				'schema-hash-123',
				'actions@1.0.0'
			);

			const reads = [{ blockId: 'block1', revision: 1 }];
			const transaction: Transaction = {
				stamp,
				statements,
				reads,
				id: createTransactionId(stamp.id, statements, reads)
			};

			expect(transaction.stamp.engineId).to.equal('actions@1.0.0');
			expect(transaction.stamp.id).to.be.a('string');
			expect(transaction.statements).to.be.an('array');
			expect(transaction.statements).to.have.lengthOf(1);
			expect(transaction.reads).to.have.lengthOf(1);
			expect(transaction.id).to.be.a('string');
		});

		it('should create unique stamp IDs for different peers', () => {
			const timestamp = Date.now();
			const stamp1 = createTransactionStamp(
				'peer1',
				timestamp,
				'schema-hash-123',
				'actions@1.0.0'
			);
			const stamp2 = createTransactionStamp(
				'peer2',
				timestamp,
				'schema-hash-123',
				'actions@1.0.0'
			);

			expect(stamp1.id).to.not.equal(stamp2.id);
		});

		it('should create unique transaction IDs for different transactions', () => {
			const stamp1 = createTransactionStamp(
				'peer1',
				Date.now(),
				'schema-hash-123',
				'actions@1.0.0'
			);

			const stamp2 = createTransactionStamp(
				'peer2',
				Date.now(),
				'schema-hash-123',
				'actions@1.0.0'
			);

			const statements1 = createActionsStatements([]);
			const statements2 = createActionsStatements([]);
			const reads1 = [{ blockId: 'block1', revision: 1 }];
			const reads2 = [{ blockId: 'block2', revision: 2 }];

			const transaction1: Transaction = {
				stamp: stamp1,
				statements: statements1,
				reads: reads1,
				id: createTransactionId(stamp1.id, statements1, reads1)
			};

			const transaction2: Transaction = {
				stamp: stamp2,
				statements: statements2,
				reads: reads2,
				id: createTransactionId(stamp2.id, statements2, reads2)
			};

			expect(transaction1.id).to.not.equal(transaction2.id);
		});
	});

	describe('ActionsEngine', () => {
		let engine: ActionsEngine;
		let coordinator: TransactionCoordinator;

		beforeEach(() => {
			const transactor = new TestTransactor();
			const collections = new Map();
			coordinator = new TransactionCoordinator(transactor, collections);
			engine = new ActionsEngine(coordinator);
		});

		it('should parse and validate actions statements', async () => {
			// Test that ActionsEngine can parse statements correctly
			// Note: Execution will fail because no collection is registered,
			// but we can verify the parsing and validation logic
			const collections: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [
						{ type: 'insert', data: { id: 1, name: 'Alice' } },
						{ type: 'insert', data: { id: 2, name: 'Bob' } }
					]
				}
			];

			const statements = createActionsStatements(collections);
			const stamp = createTransactionStamp(
				'peer1',
				Date.now(),
				'schema-hash-123',
				'actions@1.0.0'
			);

			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			const result = await engine.execute(transaction);

			// Execution fails because no collection is registered
			expect(result.success).to.be.false;
			expect(result.error).to.include('Collection not found');
		});

		it('should validate multiple collections in statements', async () => {
			// Test that ActionsEngine can parse statements with multiple collections
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

			const statements = createActionsStatements(collections);
			const stamp = createTransactionStamp(
				'peer1',
				Date.now(),
				'schema-hash-123',
				'actions@1.0.0'
			);

			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			const result = await engine.execute(transaction);

			// Execution fails because no collections are registered
			expect(result.success).to.be.false;
			expect(result.error).to.include('Collection not found');
		});

		it('should fail execution for invalid JSON statements', async () => {
			const stamp = createTransactionStamp(
				'peer1',
				Date.now(),
				'schema-hash-123',
				'actions@1.0.0'
			);

			const transaction: Transaction = {
				stamp,
				statements: ['invalid json'],
				reads: [],
				id: createTransactionId(stamp.id, ['invalid json'], [])
			};

			const result = await engine.execute(transaction);

			expect(result.success).to.be.false;
			expect(result.error).to.include('Failed to execute transaction');
		});
	});

	// TransactionContext tests removed - use TransactionSession instead
	// TransactionContext is now an internal implementation detail used by commitTransaction()

	describe('Integration with Collections', () => {
		it('should execute actions through collections via ActionsEngine', async () => {
			// Create a test transactor
			const transactor = new TestTransactor();

			// Create a Tree collection
			type TestEntry = { key: number; value: string };
			const usersTree = await Tree.createOrOpen<number, TestEntry>(
				transactor,
				'users-tree',
				entry => entry.key
			);

			// Access the underlying collection (Tree wraps a Collection)
			const underlyingCollection = (usersTree as any).collection;

			// Create coordinator with the underlying collection
			const collections = new Map();
			collections.set('users-tree', underlyingCollection);

			const coordinator = new TransactionCoordinator(
				transactor,
				collections
			);
			const actionsEngine = new ActionsEngine(coordinator);

			// Create transaction with actions
			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users-tree',
					actions: [{
						type: 'replace',
						data: [[1, { key: 1, value: 'Alice' }]]
					}]
				},
				{
					collectionId: 'users-tree',
					actions: [{
						type: 'replace',
						data: [[2, { key: 2, value: 'Bob' }]]
					}]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp(
				'test-peer',
				Date.now(),
				'schema-hash-123',
				'actions@1.0.0'
			);

			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			// Execute transaction through engine
			const result = await actionsEngine.execute(transaction);

			// Verify execution succeeded
			expect(result.success).to.be.true;

			// Verify local snapshot sees the changes (via tracker)
			const aliceValue = await usersTree.get(1);
			expect(aliceValue).to.deep.equal({ key: 1, value: 'Alice' });

			const bobValue = await usersTree.get(2);
			expect(bobValue).to.deep.equal({ key: 2, value: 'Bob' });
		});
	});
});

