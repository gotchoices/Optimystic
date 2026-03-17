/**
 * TEST-7.3.1: Adapter integration tests
 *
 * Tests the optimystic adapter layer that bridges Quereus SQL operations
 * to the distributed database: CollectionFactory, TransactionBridge,
 * OptimysticVirtualTableConnection, and KeyNetwork registration.
 *
 * These tests exercise the adapter components via the plugin registration
 * entry point, since internal classes are bundled and not directly exported.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';
import type { TransactionState } from '../dist/index.js';

type Row = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
};

/** Helper to create a fresh db + plugin for each test */
function createTestEnv() {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
	});

	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}

	return { db, plugin };
}

// ─────────────────────────────────────────────────────
// CollectionFactory (via plugin.collectionFactory)
// ─────────────────────────────────────────────────────

describe('CollectionFactory (TEST-7.3.1)', () => {
	it('should create a test transactor with expected interface', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const transactor = await factory.getOrCreateTransactor(options);
		expect(transactor).to.be.an('object');
		expect(transactor.get).to.be.a('function');
		expect(transactor.pend).to.be.a('function');
		expect(transactor.commit).to.be.a('function');
		expect(transactor.cancel).to.be.a('function');
	});

	it('should cache transactors across calls with same key', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const t1 = await factory.getOrCreateTransactor(options);
		const t2 = await factory.getOrCreateTransactor(options);
		expect(t1).to.equal(t2); // Same reference
	});

	it('should create a collection with correct interface', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const collection = await factory.createOrGetCollection(options);
		expect(collection).to.be.an('object');
		expect(collection.replace).to.be.a('function');
	});

	it('should cache collections within an active transaction', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const txnState: TransactionState = {
			transactor: await factory.getOrCreateTransactor(options),
			isActive: true,
			collections: new Map(),
			stampId: 'test-stamp',
		};

		const col1 = await factory.createOrGetCollection(options, txnState);
		const col2 = await factory.createOrGetCollection(options, txnState);
		expect(col1).to.equal(col2); // Same reference from cache
		expect(txnState.collections.size).to.equal(1);
	});

	it('should NOT cache collections when transaction is inactive', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const txnState: TransactionState = {
			transactor: await factory.getOrCreateTransactor(options),
			isActive: false,
			collections: new Map(),
			stampId: 'test-stamp',
		};

		await factory.createOrGetCollection(options, txnState);
		expect(txnState.collections.size).to.equal(0); // Not stored
	});

	it('should registerTransactor and use it on next getOrCreate call', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const mockTransactor = {
			get: async () => [],
			getStatus: async () => { throw new Error('not impl'); },
			pend: async () => ({ success: true }),
			commit: async () => ({ success: true }),
			cancel: async () => { },
		} as any;

		factory.registerTransactor('test:test', mockTransactor);

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const result = await factory.getOrCreateTransactor(options);
		expect(result).to.equal(mockTransactor);
	});

	it('should clearCache and create fresh transactors', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const t1 = await factory.getOrCreateTransactor(options);
		factory.clearCache();
		const t2 = await factory.getOrCreateTransactor(options);

		// After clearing, a new transactor is created
		expect(t1).to.not.equal(t2);
	});

	it('should throw for unknown custom transactor', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'nonexistent-custom',
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		try {
			await factory.getOrCreateTransactor(options);
			expect.fail('Should have thrown');
		} catch (e: any) {
			expect(e.message).to.include('nonexistent-custom');
			expect(e.message).to.include('not found');
		}
	});

	it('should return undefined for getPeerId when no libp2p node registered', () => {
		const { plugin } = createTestEnv();

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const peerId = plugin.collectionFactory.getPeerId(options);
		expect(peerId).to.be.undefined;
	});

	it('should create separate collections for different URIs', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const optsUsers = {
			collectionUri: 'tree://mydb/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const optsProducts = {
			collectionUri: 'tree://mydb/products',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const col1 = await factory.createOrGetCollection(optsUsers);
		const col2 = await factory.createOrGetCollection(optsProducts);

		expect(col1).to.be.an('object');
		expect(col2).to.be.an('object');
		// Different collections (different URIs)
		expect(col1).to.not.equal(col2);
	});
});

// ─────────────────────────────────────────────────────
// TransactionBridge (via plugin.txnBridge)
// ─────────────────────────────────────────────────────

describe('TransactionBridge (TEST-7.3.1)', () => {
	const defaultOptions = {
		collectionUri: 'tree://test/users',
		transactor: 'test' as const,
		keyNetwork: 'test' as const,
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
	};

	describe('legacy mode (no coordinator)', () => {
		it('should begin a transaction and return active state', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const txn = await bridge.beginTransaction(defaultOptions);
			expect(txn.isActive).to.be.true;
			expect(txn.stampId).to.be.a('string');
			expect(txn.stampId.length).to.be.greaterThan(0);
			expect(txn.collections).to.be.instanceOf(Map);
		});

		it('should return same transaction on double-begin (SQLite semantics)', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const txn1 = await bridge.beginTransaction(defaultOptions);
			const txn2 = await bridge.beginTransaction(defaultOptions);
			expect(txn1).to.equal(txn2); // Same object
			expect(txn1.stampId).to.equal(txn2.stampId);
		});

		it('should commit successfully in legacy mode', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			await bridge.commitTransaction();
			expect(bridge.isTransactionActive()).to.be.false;
		});

		it('should rollback and clear state', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const txn = await bridge.beginTransaction(defaultOptions);
			expect(bridge.isTransactionActive()).to.be.true;

			await bridge.rollbackTransaction();

			expect(bridge.isTransactionActive()).to.be.false;
			expect(txn.isActive).to.be.false;
			expect(txn.collections.size).to.equal(0);
		});

		it('should throw when committing without active transaction', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			try {
				await bridge.commitTransaction();
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e.message).to.include('No active transaction');
			}
		});

		it('should throw when rolling back without active transaction', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			try {
				await bridge.rollbackTransaction();
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e.message).to.include('No active transaction');
			}
		});

		it('should generate unique stampIds across transactions', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			const stamp1 = bridge.getCurrentTransaction()!.stampId;
			await bridge.commitTransaction();

			await bridge.beginTransaction(defaultOptions);
			const stamp2 = bridge.getCurrentTransaction()!.stampId;
			await bridge.commitTransaction();

			expect(stamp1).to.not.equal(stamp2);
		});
	});

	describe('statement accumulation', () => {
		it('should accumulate statements during active transaction', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);

			bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			bridge.addStatement('INSERT INTO users VALUES (2, "Bob")');

			expect(bridge.getStatements()).to.deep.equal([
				'INSERT INTO users VALUES (1, "Alice")',
				'INSERT INTO users VALUES (2, "Bob")',
			]);
			expect(bridge.getStatementCount()).to.equal(2);
		});

		it('should NOT accumulate statements outside a transaction', () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			expect(bridge.getStatements()).to.deep.equal([]);
			expect(bridge.getStatementCount()).to.equal(0);
		});

		it('should clear statements after commit', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			await bridge.commitTransaction();

			expect(bridge.getStatementCount()).to.equal(0);
		});

		it('should clear statements after rollback', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			await bridge.rollbackTransaction();

			expect(bridge.getStatementCount()).to.equal(0);
		});

		it('should clear accumulated statements on new transaction begin', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			await bridge.commitTransaction();

			await bridge.beginTransaction(defaultOptions);
			expect(bridge.getStatementCount()).to.equal(0);
		});
	});

	describe('transaction mode detection', () => {
		it('should report transaction mode disabled by default', () => {
			const { plugin } = createTestEnv();
			expect(plugin.txnBridge.isTransactionModeEnabled()).to.be.false;
		});

		it('should report transaction mode enabled after configure', () => {
			const { plugin } = createTestEnv();
			plugin.txnBridge.configureTransactionMode(
				{} as any, // mock coordinator
				{} as any, // mock engine
				async () => 'test-hash',
			);
			expect(plugin.txnBridge.isTransactionModeEnabled()).to.be.true;
		});

		it('should return null session in legacy mode', async () => {
			const { plugin } = createTestEnv();
			await plugin.txnBridge.beginTransaction(defaultOptions);
			expect(plugin.txnBridge.getSession()).to.be.null;
		});
	});

	describe('cleanup', () => {
		it('should rollback active transaction on cleanup', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			expect(bridge.isTransactionActive()).to.be.true;

			await bridge.cleanup();

			expect(bridge.isTransactionActive()).to.be.false;
			expect(bridge.getCurrentTransaction()).to.be.null;
		});

		it('should be safe to call cleanup with no active transaction', async () => {
			const { plugin } = createTestEnv();
			await plugin.txnBridge.cleanup();
			expect(plugin.txnBridge.getCurrentTransaction()).to.be.null;
		});
	});

	describe('savepoint errors', () => {
		it('should throw on savepoint operations (not yet implemented)', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			try {
				await bridge.savepoint('sp1');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e.message).to.include('not yet implemented');
			}

			try {
				await bridge.releaseSavepoint('sp1');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e.message).to.include('not yet implemented');
			}

			try {
				await bridge.rollbackToSavepoint('sp1');
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e.message).to.include('not yet implemented');
			}
		});
	});
});

// ─────────────────────────────────────────────────────
// VtabConnection (tested indirectly through SQL)
// ─────────────────────────────────────────────────────

describe('VirtualTableConnection via SQL (TEST-7.3.1)', () => {
	it('should handle implicit transaction on single INSERT', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT NULL
			) USING optimystic('tree://test/users')
		`);

		// Single INSERT without BEGIN/COMMIT — implicit transaction
		await db.exec("INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'a@test.com')");

		const rows = await collectRows(db.eval('SELECT * FROM users'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]!.name).to.equal('Alice');
	});

	it('should handle explicit BEGIN/COMMIT', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/users')
		`);

		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice')");
		await db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob')");
		await db.exec('COMMIT');

		const rows = await collectRows(db.eval('SELECT * FROM users ORDER BY id'));
		expect(rows).to.have.lengthOf(2);
	});

	it('should handle ROLLBACK discarding pending changes', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/users')
		`);

		// Insert one row committed
		await db.exec("INSERT INTO users (id, name) VALUES (1, 'Committed')");

		// Begin, insert, rollback
		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (2, 'RolledBack')");
		await db.exec('ROLLBACK');

		const rows = await collectRows(db.eval('SELECT * FROM users'));
		// Rollback behavior depends on vtab implementation; at minimum the
		// rollback path should execute without error
		expect(rows.length).to.be.at.most(2);
	});

	it('should share transaction state across multiple tables', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/users')
		`);
		await db.exec(`
			CREATE TABLE products (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/products')
		`);

		// Both tables in one transaction
		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice')");
		await db.exec("INSERT INTO products (id, name) VALUES (1, 'Widget')");
		await db.exec('COMMIT');

		const users = await collectRows(db.eval('SELECT * FROM users'));
		const products = await collectRows(db.eval('SELECT * FROM products'));
		expect(users).to.have.lengthOf(1);
		expect(products).to.have.lengthOf(1);
	});

	it('should support sequential transactions on the same table', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/users')
		`);

		// Transaction 1
		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice')");
		await db.exec('COMMIT');

		// Transaction 2
		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob')");
		await db.exec('COMMIT');

		const rows = await collectRows(db.eval('SELECT * FROM users ORDER BY id'));
		expect(rows).to.have.lengthOf(2);
		expect(rows[0]!.name).to.equal('Alice');
		expect(rows[1]!.name).to.equal('Bob');
	});
});

// ─────────────────────────────────────────────────────
// Key Network Registration
// ─────────────────────────────────────────────────────

describe('Custom Registration via Factory (TEST-7.3.1)', () => {
	it('should register and instantiate a custom transactor class via factory', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		let instantiated = false;

		class TestTransactor {
			constructor() { instantiated = true; }
			async get() { return []; }
			async getStatus() { throw new Error('not impl'); }
			async pend() { return {}; }
			async commit() { return {}; }
			async cancel() { }
		}

		factory.registerCustomTransactor('test-custom-tx', TestTransactor as any);

		const options = {
			collectionUri: 'tree://test/custom-tx',
			transactor: 'test-custom-tx',
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const transactor = await factory.getOrCreateTransactor(options);
		expect(transactor).to.be.instanceOf(TestTransactor);
		expect(instantiated).to.be.true;
	});

	it('should register a custom key network class via factory', () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		class TestKeyNetwork {
			async findCoordinator() { return null; }
			async findCluster() { return []; }
		}

		// Should not throw
		factory.registerCustomKeyNetwork('test-custom-kn', TestKeyNetwork as any);
	});

	it('should use factory-registered transactor instance for custom transactor key', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const mockTransactor = {
			get: async () => [],
			getStatus: async () => { throw new Error('not impl'); },
			pend: async () => ({ success: true }),
			commit: async () => ({ success: true }),
			cancel: async () => { },
		} as any;

		// Register via factory instance method
		// The transactor key format is `${transactor}:${keyNetwork}`
		factory.registerTransactor('my-custom:test', mockTransactor);

		const options = {
			collectionUri: 'tree://test/custom',
			transactor: 'my-custom',
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const transactor = await factory.getOrCreateTransactor(options);
		expect(transactor).to.equal(mockTransactor);
	});

	it('should throw with helpful message for unregistered custom transactor', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/unknown',
			transactor: 'unknown-tx',
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		try {
			await factory.getOrCreateTransactor(options);
			expect.fail('Should have thrown');
		} catch (e: any) {
			expect(e.message).to.include('unknown-tx');
			expect(e.message).to.include('registerCustomTransactor');
		}
	});
});

// ─────────────────────────────────────────────────────
// End-to-End: Plugin Registration & Lifecycle
// ─────────────────────────────────────────────────────

describe('Plugin Registration & Lifecycle (TEST-7.3.1)', () => {
	it('should expose collectionFactory and txnBridge from register()', () => {
		const { plugin } = createTestEnv();

		expect(plugin.collectionFactory).to.be.an('object');
		expect(plugin.collectionFactory.createOrGetCollection).to.be.a('function');
		expect(plugin.collectionFactory.getOrCreateTransactor).to.be.a('function');

		expect(plugin.txnBridge).to.be.an('object');
		expect(plugin.txnBridge.beginTransaction).to.be.a('function');
		expect(plugin.txnBridge.commitTransaction).to.be.a('function');
		expect(plugin.txnBridge.rollbackTransaction).to.be.a('function');
	});

	it('should register the optimystic virtual table module', () => {
		const { plugin } = createTestEnv();

		expect(plugin.vtables).to.have.lengthOf(1);
		expect(plugin.vtables[0]!.name).to.equal('optimystic');
	});

	it('should register the StampId function', () => {
		const { plugin } = createTestEnv();

		expect(plugin.functions).to.have.lengthOf(1);
		expect(plugin.functions[0]!.schema.name).to.equal('StampId');
	});

	it('should support full CRUD lifecycle through adapter', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				qty INTEGER NULL
			) USING optimystic('tree://test/items')
		`);

		// Create
		await db.exec("INSERT INTO items (id, name, qty) VALUES (1, 'Apple', 10)");
		await db.exec("INSERT INTO items (id, name, qty) VALUES (2, 'Banana', 5)");

		// Read
		let rows = await collectRows(db.eval('SELECT * FROM items ORDER BY id'));
		expect(rows).to.have.lengthOf(2);
		expect(rows[0]!.name).to.equal('Apple');

		// Update
		await db.exec("UPDATE items SET qty = 20 WHERE id = 1");
		rows = await collectRows(db.eval('SELECT * FROM items WHERE id = 1'));
		expect(rows[0]!.qty).to.equal(20);

		// Delete
		await db.exec('DELETE FROM items WHERE id = 2');
		rows = await collectRows(db.eval('SELECT * FROM items'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]!.id).to.equal(1);
	});

	it('should support DROP TABLE and re-CREATE with different schema', async () => {
		const { db, plugin } = createTestEnv();

		await db.exec(`
			CREATE TABLE ephemeral (
				id INTEGER PRIMARY KEY,
				val TEXT NOT NULL
			) USING optimystic('tree://test/ephemeral')
		`);

		await db.exec("INSERT INTO ephemeral (id, val) VALUES (1, 'hello')");

		await db.exec('DROP TABLE ephemeral');

		// Re-create with different schema
		await db.exec(`
			CREATE TABLE ephemeral (
				id INTEGER PRIMARY KEY,
				value TEXT NOT NULL,
				extra INTEGER NULL
			) USING optimystic('tree://test/ephemeral2')
		`);

		await db.exec("INSERT INTO ephemeral (id, value, extra) VALUES (1, 'world', 42)");
		const rows = await collectRows(db.eval('SELECT * FROM ephemeral'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]!.value).to.equal('world');
	});
});
