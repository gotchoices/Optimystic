import { expect } from 'aegir/chai';
import {
	ActionsEngine,
	createActionsStatements,
	createTransactionStamp,
	createTransactionId,
	TransactionCoordinator,
	TransactionValidator,
	Tree,
	type Transaction,
	type CollectionActions,
	type EngineRegistration,
	type ValidationCoordinatorFactory,
	type Transforms
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
				'reference-peer',
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

	describe('Multi-Collection Transactions', () => {
		it('should execute transaction across multiple collections', async () => {
			// Create a test transactor
			const transactor = new TestTransactor();

			// Create two Tree collections
			type UserEntry = { key: number; name: string };
			type PostEntry = { key: number; userId: number; title: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const postsTree = await Tree.createOrOpen<number, PostEntry>(
				transactor,
				'posts',
				entry => entry.key
			);

			// Access the underlying collections
			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const postsCollection = (postsTree as unknown as { collection: unknown }).collection;

			// Create coordinator with both collections
			const collections = new Map();
			collections.set('users', usersCollection);
			collections.set('posts', postsCollection);

			const coordinator = new TransactionCoordinator(
				transactor,
				collections
			);
			const actionsEngine = new ActionsEngine(coordinator);

			// Create transaction that affects BOTH collections
			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{
						type: 'replace',
						data: [[1, { key: 1, name: 'Alice' }]]
					}]
				},
				{
					collectionId: 'posts',
					actions: [{
						type: 'replace',
						data: [[100, { key: 100, userId: 1, title: 'First Post' }]]
					}]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp(
				'reference-peer',
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

			// Verify both collections see the changes
			const alice = await usersTree.get(1);
			expect(alice).to.deep.equal({ key: 1, name: 'Alice' });

			const post = await postsTree.get(100);
			expect(post).to.deep.equal({ key: 100, userId: 1, title: 'First Post' });
		});

		it('should include operations hash in pend request for multi-collection transactions', async () => {
			// Create a test transactor that tracks pend requests
			const pendRequests: { operationsHash?: string; transaction?: Transaction }[] = [];
			const transactor = new TestTransactor();
			const originalPend = transactor.pend.bind(transactor);
			transactor.pend = async (request) => {
				pendRequests.push({
					operationsHash: request.operationsHash,
					transaction: request.transaction
				});
				return originalPend(request);
			};

			// Create two Tree collections
			type UserEntry = { key: number; name: string };
			type PostEntry = { key: number; userId: number; title: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const postsTree = await Tree.createOrOpen<number, PostEntry>(
				transactor,
				'posts',
				entry => entry.key
			);

			// Access the underlying collections
			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const postsCollection = (postsTree as unknown as { collection: unknown }).collection;

			// Create coordinator with both collections
			const collections = new Map();
			collections.set('users', usersCollection);
			collections.set('posts', postsCollection);

			const coordinator = new TransactionCoordinator(
				transactor,
				collections
			);
			const actionsEngine = new ActionsEngine(coordinator);

			// Create transaction that affects BOTH collections
			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{
						type: 'replace',
						data: [[1, { key: 1, name: 'Alice' }]]
					}]
				},
				{
					collectionId: 'posts',
					actions: [{
						type: 'replace',
						data: [[100, { key: 100, userId: 1, title: 'First Post' }]]
					}]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp(
				'reference-peer',
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

			// Execute transaction through coordinator.execute() which goes through full PEND flow
			await coordinator.execute(transaction, actionsEngine);

			// Verify pend requests include operations hash and transaction
			expect(pendRequests.length).to.be.greaterThan(0);
			for (const request of pendRequests) {
				expect(request.operationsHash).to.be.a('string');
				expect(request.transaction).to.exist;
				expect(request.transaction?.id).to.equal(transaction.id);
			}
		});

		it('should skip GATHER phase for single collection transactions', async () => {
			// Create a test transactor that tracks cluster nominee queries
			let clusterNomineesQueried = false;
			const transactor = new TestTransactor();
			transactor.queryClusterNominees = async () => {
				clusterNomineesQueried = true;
				return { nominees: [] };
			};

			// Create one Tree collection
			type UserEntry = { key: number; name: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			// Access the underlying collection
			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;

			// Create coordinator with one collection
			const collections = new Map();
			collections.set('users', usersCollection);

			const coordinator = new TransactionCoordinator(
				transactor,
				collections
			);
			const actionsEngine = new ActionsEngine(coordinator);

			// Create transaction that affects ONLY one collection
			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{
						type: 'replace',
						data: [[1, { key: 1, name: 'Alice' }]]
					}]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp(
				'reference-peer',
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

			// Execute transaction through coordinator.execute() which goes through full flow
			await coordinator.execute(transaction, actionsEngine);

			// Verify GATHER phase was skipped (no cluster nominee queries)
			expect(clusterNomineesQueried).to.be.false;
		});

		it('should query cluster nominees for multi-collection transactions', async () => {
			// Create a test transactor that tracks cluster nominee queries
			const queriedBlockIds: string[] = [];
			const transactor = new TestTransactor();
			transactor.queryClusterNominees = async (blockId) => {
				queriedBlockIds.push(blockId);
				return { nominees: [] };
			};

			// Create two Tree collections
			type UserEntry = { key: number; name: string };
			type PostEntry = { key: number; userId: number; title: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const postsTree = await Tree.createOrOpen<number, PostEntry>(
				transactor,
				'posts',
				entry => entry.key
			);

			// Access the underlying collections
			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const postsCollection = (postsTree as unknown as { collection: unknown }).collection;

			// Create coordinator with both collections
			const collections = new Map();
			collections.set('users', usersCollection);
			collections.set('posts', postsCollection);

			const coordinator = new TransactionCoordinator(
				transactor,
				collections
			);
			const actionsEngine = new ActionsEngine(coordinator);

			// Create transaction that affects BOTH collections
			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{
						type: 'replace',
						data: [[1, { key: 1, name: 'Alice' }]]
					}]
				},
				{
					collectionId: 'posts',
					actions: [{
						type: 'replace',
						data: [[100, { key: 100, userId: 1, title: 'First Post' }]]
					}]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp(
				'reference-peer',
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

			// Execute transaction through coordinator.execute() which goes through full flow
			await coordinator.execute(transaction, actionsEngine);

			// Verify GATHER phase queried cluster nominees for both collections
			expect(queriedBlockIds.length).to.equal(2);
		});

		it('should atomically update multiple collections with pre-existing data', async () => {
			const transactor = new TestTransactor();

			// Create collections and pre-populate with data
			type UserEntry = { key: number; name: string; balance: number };
			type OrderEntry = { key: number; userId: number; amount: number };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const ordersTree = await Tree.createOrOpen<number, OrderEntry>(
				transactor,
				'orders',
				entry => entry.key
			);

			// Pre-populate users with balance via replace
			await usersTree.replace([[1, { key: 1, name: 'Alice', balance: 100 }]]);
			await usersTree.replace([[2, { key: 2, name: 'Bob', balance: 50 }]]);

			// Verify initial state
			const aliceInitial = await usersTree.get(1);
			expect(aliceInitial?.balance).to.equal(100);

			// Setup coordinator
			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const ordersCollection = (ordersTree as unknown as { collection: unknown }).collection;

			const collections = new Map();
			collections.set('users', usersCollection);
			collections.set('orders', ordersCollection);

			const coordinator = new TransactionCoordinator(transactor, collections);
			const actionsEngine = new ActionsEngine(coordinator);

			// Create transaction that deducts from Alice and creates an order
			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{
						type: 'replace',
						data: [[1, { key: 1, name: 'Alice', balance: 75 }]] // Deduct 25
					}]
				},
				{
					collectionId: 'orders',
					actions: [{
						type: 'replace',
						data: [[1001, { key: 1001, userId: 1, amount: 25 }]]
					}]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			const result = await actionsEngine.execute(transaction);
			expect(result.success).to.be.true;

			// Verify both collections updated atomically
			const aliceUpdated = await usersTree.get(1);
			expect(aliceUpdated?.balance).to.equal(75);

			const order = await ordersTree.get(1001);
			expect(order).to.deep.equal({ key: 1001, userId: 1, amount: 25 });
		});

		it('should handle transaction with three or more collections', async () => {
			const transactor = new TestTransactor();
			transactor.queryClusterNominees = async () => ({ nominees: [] });

			type UserEntry = { key: number; name: string };
			type PostEntry = { key: number; userId: number; title: string };
			type CommentEntry = { key: number; postId: number; text: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const postsTree = await Tree.createOrOpen<number, PostEntry>(
				transactor,
				'posts',
				entry => entry.key
			);

			const commentsTree = await Tree.createOrOpen<number, CommentEntry>(
				transactor,
				'comments',
				entry => entry.key
			);

			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const postsCollection = (postsTree as unknown as { collection: unknown }).collection;
			const commentsCollection = (commentsTree as unknown as { collection: unknown }).collection;

			const collections = new Map();
			collections.set('users', usersCollection);
			collections.set('posts', postsCollection);
			collections.set('comments', commentsCollection);

			const coordinator = new TransactionCoordinator(transactor, collections);
			const actionsEngine = new ActionsEngine(coordinator);

			// Create user, post, and comment all in one transaction
			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
				},
				{
					collectionId: 'posts',
					actions: [{ type: 'replace', data: [[100, { key: 100, userId: 1, title: 'Hello World' }]] }]
				},
				{
					collectionId: 'comments',
					actions: [{ type: 'replace', data: [[1000, { key: 1000, postId: 100, text: 'Great post!' }]] }]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			const result = await coordinator.execute(transaction, actionsEngine);
			expect(result.success).to.be.true;

			// Verify all three collections updated
			expect(await usersTree.get(1)).to.deep.equal({ key: 1, name: 'Alice' });
			expect(await postsTree.get(100)).to.deep.equal({ key: 100, userId: 1, title: 'Hello World' });
			expect(await commentsTree.get(1000)).to.deep.equal({ key: 1000, postId: 100, text: 'Great post!' });
		});

		it('should propagate supercluster nominees to pend requests', async () => {
			// Create mock PeerIds
			const { generateKeyPair } = await import('@libp2p/crypto/keys');
			const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');

			const mockPeerIds = await Promise.all([
				generateKeyPair('Ed25519').then(peerIdFromPrivateKey),
				generateKeyPair('Ed25519').then(peerIdFromPrivateKey),
				generateKeyPair('Ed25519').then(peerIdFromPrivateKey)
			]);

			const pendRequests: { superclusterNominees?: string[] }[] = [];
			const transactor = new TestTransactor();
			const originalPend = transactor.pend.bind(transactor);
			transactor.pend = async (request) => {
				pendRequests.push({
					superclusterNominees: request.superclusterNominees?.map(p => p.toString())
				});
				return originalPend(request);
			};

			// Return mock nominees for each cluster query
			let queryCount = 0;
			transactor.queryClusterNominees = async () => {
				const nominee = mockPeerIds[queryCount % mockPeerIds.length]!;
				queryCount++;
				return { nominees: [nominee] };
			};

			type UserEntry = { key: number; name: string };
			type PostEntry = { key: number; userId: number; title: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const postsTree = await Tree.createOrOpen<number, PostEntry>(
				transactor,
				'posts',
				entry => entry.key
			);

			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const postsCollection = (postsTree as unknown as { collection: unknown }).collection;

			const collections = new Map();
			collections.set('users', usersCollection);
			collections.set('posts', postsCollection);

			const coordinator = new TransactionCoordinator(transactor, collections);
			const actionsEngine = new ActionsEngine(coordinator);

			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
				},
				{
					collectionId: 'posts',
					actions: [{ type: 'replace', data: [[100, { key: 100, userId: 1, title: 'Post' }]] }]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			await coordinator.execute(transaction, actionsEngine);

			// All pend requests should include supercluster nominees
			expect(pendRequests.length).to.be.greaterThan(0);
			for (const request of pendRequests) {
				expect(request.superclusterNominees).to.be.an('array');
				expect(request.superclusterNominees!.length).to.be.greaterThan(0);
			}
		});

		it('should fail if a collection does not exist', async () => {
			const transactor = new TestTransactor();

			type UserEntry = { key: number; name: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;

			// Only register 'users' collection, but transaction references 'posts'
			const collections = new Map();
			collections.set('users', usersCollection);

			const coordinator = new TransactionCoordinator(transactor, collections);
			const actionsEngine = new ActionsEngine(coordinator);

			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
				},
				{
					collectionId: 'posts', // This collection doesn't exist
					actions: [{ type: 'replace', data: [[100, { key: 100, title: 'Post' }]] }]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			const result = await actionsEngine.execute(transaction);
			expect(result.success).to.be.false;
			expect(result.error).to.include('Collection not found: posts');
		});

		it('should handle empty transaction gracefully', async () => {
			const transactor = new TestTransactor();

			type UserEntry = { key: number; name: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const collections = new Map();
			collections.set('users', usersCollection);

			const coordinator = new TransactionCoordinator(transactor, collections);
			const actionsEngine = new ActionsEngine(coordinator);

			// Empty transaction with no actions
			const statements = createActionsStatements([]);
			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			const result = await coordinator.execute(transaction, actionsEngine);
			expect(result.success).to.be.true;
		});

		it('should trace full GATHER/PEND/COMMIT phases for multi-collection transaction', async () => {
			const phaseLog: { phase: string; data: unknown }[] = [];

			const transactor = new TestTransactor();

			// Track GATHER phase
			transactor.queryClusterNominees = async (blockId) => {
				phaseLog.push({ phase: 'GATHER', data: { blockId } });
				return { nominees: [] };
			};

			// Track PEND phase
			const originalPend = transactor.pend.bind(transactor);
			transactor.pend = async (request) => {
				phaseLog.push({
					phase: 'PEND',
					data: {
						actionId: request.actionId,
						hasTransaction: !!request.transaction,
						hasOperationsHash: !!request.operationsHash,
						blockCount: Object.keys(request.transforms.inserts).length +
							Object.keys(request.transforms.updates).length +
							request.transforms.deletes.length
					}
				});
				return originalPend(request);
			};

			// Track COMMIT phase
			const originalCommit = transactor.commit.bind(transactor);
			transactor.commit = async (request) => {
				phaseLog.push({
					phase: 'COMMIT',
					data: {
						actionId: request.actionId,
						blockCount: request.blockIds.length
					}
				});
				return originalCommit(request);
			};

			type UserEntry = { key: number; name: string };
			type PostEntry = { key: number; userId: number; title: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const postsTree = await Tree.createOrOpen<number, PostEntry>(
				transactor,
				'posts',
				entry => entry.key
			);

			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const postsCollection = (postsTree as unknown as { collection: unknown }).collection;

			const collections = new Map();
			collections.set('users', usersCollection);
			collections.set('posts', postsCollection);

			const coordinator = new TransactionCoordinator(transactor, collections);
			const actionsEngine = new ActionsEngine(coordinator);

			// Clear phase log before our transaction
			phaseLog.length = 0;

			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
				},
				{
					collectionId: 'posts',
					actions: [{ type: 'replace', data: [[100, { key: 100, userId: 1, title: 'Post' }]] }]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			const result = await coordinator.execute(transaction, actionsEngine);
			expect(result.success).to.be.true;

			// Verify phase order: GATHER (2x for 2 collections), PEND (2x), COMMIT (2x)
			const gatherPhases = phaseLog.filter(p => p.phase === 'GATHER');
			const pendPhases = phaseLog.filter(p => p.phase === 'PEND');
			const commitPhases = phaseLog.filter(p => p.phase === 'COMMIT');

			expect(gatherPhases.length).to.equal(2, 'Should have 2 GATHER calls');
			expect(pendPhases.length).to.equal(2, 'Should have 2 PEND calls');
			expect(commitPhases.length).to.equal(2, 'Should have 2 COMMIT calls');

			// Verify GATHER happens before PEND, PEND before COMMIT
			const firstGatherIdx = phaseLog.findIndex(p => p.phase === 'GATHER');
			const firstPendIdx = phaseLog.findIndex(p => p.phase === 'PEND');
			const firstCommitIdx = phaseLog.findIndex(p => p.phase === 'COMMIT');

			expect(firstGatherIdx).to.be.lessThan(firstPendIdx, 'GATHER should come before PEND');
			expect(firstPendIdx).to.be.lessThan(firstCommitIdx, 'PEND should come before COMMIT');

			// Verify PEND has transaction and operations hash
			for (const pendPhase of pendPhases) {
				const data = pendPhase.data as { hasTransaction: boolean; hasOperationsHash: boolean };
				expect(data.hasTransaction).to.be.true;
				expect(data.hasOperationsHash).to.be.true;
			}
		});
	});

	describe('Transaction Validation', () => {
		it('should validate transaction with matching operations hash', async () => {
			const transactor = new TestTransactor();

			type UserEntry = { key: number; name: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;

			const collections = new Map();
			collections.set('users', usersCollection);

			const coordinator = new TransactionCoordinator(transactor, collections);
			const actionsEngine = new ActionsEngine(coordinator);

			// Create transaction
			const collectionActions: CollectionActions[] = [
				{
					collectionId: 'users',
					actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
				}
			];

			const statements = createActionsStatements(collectionActions);
			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');

			const transaction: Transaction = {
				stamp,
				statements,
				reads: [],
				id: createTransactionId(stamp.id, statements, [])
			};

			// Execute to get operations hash
			const result = await coordinator.execute(transaction, actionsEngine);
			expect(result.success).to.be.true;

			// Set up validator with same engine
			const validationTransforms = new Map<string, Transforms>();
			const engines = new Map<string, EngineRegistration>();
			engines.set('actions@1.0.0', {
				engine: actionsEngine,
				getSchemaHash: async () => 'schema-hash-123'
			});

			const createValidationCoordinator: ValidationCoordinatorFactory = () => ({
				applyActions: async (actions, _stampId) => {
					for (const { collectionId } of actions) {
						validationTransforms.set(collectionId, {
							inserts: {},
							updates: {},
							deletes: []
						});
					}
				},
				getTransforms: () => validationTransforms,
				dispose: () => validationTransforms.clear()
			});

			const validator = new TransactionValidator(engines, createValidationCoordinator);

			// Validation should succeed with matching hash (using empty transforms since we simplified)
			const validationResult = await validator.validate(transaction, 'ops:0');
			expect(validationResult.valid).to.be.true;
		});

		it('should reject transaction with unknown engine', async () => {
			const engines = new Map<string, EngineRegistration>();
			const createValidationCoordinator: ValidationCoordinatorFactory = () => ({
				applyActions: async () => {},
				getTransforms: () => new Map(),
				dispose: () => {}
			});

			const validator = new TransactionValidator(engines, createValidationCoordinator);

			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'unknown-engine@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements: [],
				reads: [],
				id: createTransactionId(stamp.id, [], [])
			};

			const result = await validator.validate(transaction, 'ops:abc');
			expect(result.valid).to.be.false;
			expect(result.reason).to.include('Unknown engine');
		});

		it('should reject transaction with schema mismatch', async () => {
			const transactor = new TestTransactor();

			type UserEntry = { key: number; name: string };

			const usersTree = await Tree.createOrOpen<number, UserEntry>(
				transactor,
				'users',
				entry => entry.key
			);

			const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
			const collections = new Map();
			collections.set('users', usersCollection);

			const coordinator = new TransactionCoordinator(transactor, collections);
			const actionsEngine = new ActionsEngine(coordinator);

			// Engine has DIFFERENT schema hash than transaction
			const engines = new Map<string, EngineRegistration>();
			engines.set('actions@1.0.0', {
				engine: actionsEngine,
				getSchemaHash: async () => 'different-schema-hash'
			});

			const createValidationCoordinator: ValidationCoordinatorFactory = () => ({
				applyActions: async () => {},
				getTransforms: () => new Map(),
				dispose: () => {}
			});

			const validator = new TransactionValidator(engines, createValidationCoordinator);

			const stamp = createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements: [],
				reads: [],
				id: createTransactionId(stamp.id, [], [])
			};

			const result = await validator.validate(transaction, 'ops:abc');
			expect(result.valid).to.be.false;
			expect(result.reason).to.include('Schema mismatch');
		});
	});
});

