/**
 * Tests for QuereusEngine - SQL transaction engine for Optimystic
 */

import { expect } from 'aegir/chai';
import { Database } from '@quereus/quereus';
import {
	QuereusEngine,
	QUEREUS_ENGINE_ID,
	createQuereusStatement,
	createQuereusStatements,
	createQuereusValidator,
} from '../dist/index.js';
import register from '../dist/plugin.js';
import {
	TransactionCoordinator,
	createTransactionStamp,
	createTransactionId,
	type Transaction,
} from '@optimystic/db-core';

describe('QuereusEngine', () => {
	let db: Database;

	beforeEach(async () => {
		// Create database and register plugin
		db = new Database();
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
	});

	describe('Engine ID', () => {
		it('should have correct engine ID format', () => {
			expect(QUEREUS_ENGINE_ID).to.match(/^quereus@\d+\.\d+\.\d+$/);
		});

		it('should be quereus@0.5.3', () => {
			expect(QUEREUS_ENGINE_ID).to.equal('quereus@0.5.3');
		});
	});

	describe('Statement helpers', () => {
		it('should create a single statement JSON', () => {
			const stmt = createQuereusStatement('SELECT * FROM users WHERE id = ?', [1]);
			const parsed = JSON.parse(stmt);

			expect(parsed.sql).to.equal('SELECT * FROM users WHERE id = ?');
			expect(parsed.params).to.deep.equal([1]);
		});

		it('should create statement without params', () => {
			const stmt = createQuereusStatement('SELECT * FROM users');
			const parsed = JSON.parse(stmt);

			expect(parsed.sql).to.equal('SELECT * FROM users');
			expect(parsed.params).to.be.undefined;
		});

		it('should create statement with named params', () => {
			const stmt = createQuereusStatement('SELECT * FROM users WHERE id = :id', { id: 1 });
			const parsed = JSON.parse(stmt);

			expect(parsed.sql).to.equal('SELECT * FROM users WHERE id = :id');
			expect(parsed.params).to.deep.equal({ id: 1 });
		});

		it('should create multiple statements', () => {
			const stmts = createQuereusStatements([
				{ sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [1, 'Alice'] },
				{ sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [2, 'Bob'] }
			]);

			expect(stmts).to.have.lengthOf(2);

			const parsed0 = JSON.parse(stmts[0]!);
			expect(parsed0.sql).to.include('INSERT INTO users');
			expect(parsed0.params).to.deep.equal([1, 'Alice']);

			const parsed1 = JSON.parse(stmts[1]!);
			expect(parsed1.params).to.deep.equal([2, 'Bob']);
		});
	});

	describe('QuereusEngine construction', () => {
		it('should construct with database and coordinator', () => {
			// Create a minimal mock coordinator for testing
			const mockCoordinator = {} as any;
			const engine = new QuereusEngine(db, mockCoordinator);
			expect(engine).to.be.instanceOf(QuereusEngine);
		});
	});

	describe('Schema hash', () => {
		// Create a minimal mock coordinator for testing
		const mockCoordinator = {} as any;

		it('should compute schema hash', async () => {
			const engine = new QuereusEngine(db, mockCoordinator);
			const hash = await engine.getSchemaHash();

			expect(hash).to.be.a('string');
			expect(hash).to.match(/^schema:/);
		});

		it('should cache schema hash', async () => {
			const engine = new QuereusEngine(db, mockCoordinator);

			const hash1 = await engine.getSchemaHash();
			const hash2 = await engine.getSchemaHash();

			expect(hash1).to.equal(hash2);
		});

		it('should invalidate cache when requested', async () => {
			const engine = new QuereusEngine(db, mockCoordinator);

			const hash1 = await engine.getSchemaHash();
			const version1 = engine.getSchemaVersion();

			engine.invalidateSchemaCache();

			const version2 = engine.getSchemaVersion();
			expect(version2).to.equal(version1 + 1);

			// Hash should be recomputed (same value since schema unchanged)
			const hash2 = await engine.getSchemaHash();
			expect(hash2).to.equal(hash1);
		});

		it('should produce different hash after schema change', async () => {
			const engine = new QuereusEngine(db, mockCoordinator);

			const hash1 = await engine.getSchemaHash();

			// Create a table to change the schema
			await db.exec(`
				CREATE TABLE test_users (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING optimystic('tree://test/users')
			`);

			engine.invalidateSchemaCache();
			const hash2 = await engine.getSchemaHash();

			expect(hash2).to.not.equal(hash1);
		});
	});

	describe('Quereus Validator', () => {
		it('should create a validator with QuereusEngine', async () => {
			// Create a TransactionCoordinator with empty collections
			// (for testing validator creation, not actual transaction execution)
			const mockTransactor = {
				pend: async () => ({}),
				commit: async () => {},
				abort: async () => {},
				queryClusterNominees: async () => ({ nodes: [], assignments: {} }),
			};
			const collections = new Map();
			const coordinator = new TransactionCoordinator(mockTransactor as any, collections);

			const validator = createQuereusValidator({
				db,
				coordinator,
			});

			expect(validator).to.exist;
			expect(validator.validate).to.be.a('function');
		});

		it('should reject transaction with unknown engine', async () => {
			const mockTransactor = {
				pend: async () => ({}),
				commit: async () => {},
				abort: async () => {},
				queryClusterNominees: async () => ({ nodes: [], assignments: {} }),
			};
			const collections = new Map();
			const coordinator = new TransactionCoordinator(mockTransactor as any, collections);

			const validator = createQuereusValidator({
				db,
				coordinator,
			});

			// Create a transaction with a different engine ID
			const stamp = createTransactionStamp('test-peer', Date.now(), 'schema-hash', 'other-engine@1.0.0');
			const transaction: Transaction = {
				stamp,
				statements: [],
				reads: [],
				id: createTransactionId(stamp.id, [], []),
			};

			const result = await validator.validate(transaction, 'ops:abc');
			expect(result.valid).to.be.false;
			expect(result.reason).to.include('Unknown engine');
		});

		it('should reject transaction with schema mismatch', async () => {
			const mockTransactor = {
				pend: async () => ({}),
				commit: async () => {},
				abort: async () => {},
				queryClusterNominees: async () => ({ nodes: [], assignments: {} }),
			};
			const collections = new Map();
			const coordinator = new TransactionCoordinator(mockTransactor as any, collections);

			const validator = createQuereusValidator({
				db,
				coordinator,
			});

			// Create a transaction with wrong schema hash
			const stamp = createTransactionStamp('test-peer', Date.now(), 'wrong-schema-hash', QUEREUS_ENGINE_ID);
			const transaction: Transaction = {
				stamp,
				statements: [],
				reads: [],
				id: createTransactionId(stamp.id, [], []),
			};

			const result = await validator.validate(transaction, 'ops:abc');
			expect(result.valid).to.be.false;
			expect(result.reason).to.include('Schema mismatch');
		});
	});
});
