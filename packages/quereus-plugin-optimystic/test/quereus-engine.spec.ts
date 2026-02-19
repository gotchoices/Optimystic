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

	describe('Schema hash cache staleness (TEST-7.1.2)', () => {
		const mockCoordinator = {} as any;

		it('should return stale hash after DDL without invalidation (known bug)', async () => {
			const engine = new QuereusEngine(db, mockCoordinator);
			const hash1 = await engine.getSchemaHash();

			await db.exec(`
				CREATE TABLE staleness_test (
					id INTEGER PRIMARY KEY, name TEXT
				) USING optimystic('tree://test/staleness')
			`);

			// BUG: hash is stale — no automatic DDL detection
			const hash2 = await engine.getSchemaHash();
			expect(hash2).to.equal(hash1);

			engine.invalidateSchemaCache();
			const hash3 = await engine.getSchemaHash();
			expect(hash3).to.not.equal(hash1);
		});

		it('should accumulate staleness across multiple DDL operations (known bug)', async () => {
			const engine = new QuereusEngine(db, mockCoordinator);
			const hash1 = await engine.getSchemaHash();

			await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY) USING optimystic('tree://test/t1')`);
			await db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY) USING optimystic('tree://test/t2')`);

			// Still returns original hash — stale through two DDL changes
			const hash2 = await engine.getSchemaHash();
			expect(hash2).to.equal(hash1);

			engine.invalidateSchemaCache();
			const hash3 = await engine.getSchemaHash();
			expect(hash3).to.not.equal(hash1);
		});
	});

	describe('Schema hash determinism (TEST-7.2.1)', () => {
		const mockCoordinator = {} as any;

		function createFreshDb() {
			const freshDb = new Database();
			const plugin = register(freshDb, {
				default_transactor: 'test',
				default_key_network: 'test',
				enable_cache: false,
			});
			for (const vtable of plugin.vtables) {
				freshDb.registerModule(vtable.name, vtable.module, vtable.auxData);
			}
			for (const func of plugin.functions) {
				freshDb.registerFunction(func.schema);
			}
			return freshDb;
		}

		it('should produce identical hash for two databases with identical schema', async () => {
			await db.exec(`
				CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)
				USING optimystic('tree://test/users')
			`);
			const engine1 = new QuereusEngine(db, mockCoordinator);
			engine1.invalidateSchemaCache();
			const hash1 = await engine1.getSchemaHash();

			const db2 = createFreshDb();
			await db2.exec(`
				CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)
				USING optimystic('tree://test/users')
			`);
			const engine2 = new QuereusEngine(db2, mockCoordinator);
			engine2.invalidateSchemaCache();
			const hash2 = await engine2.getSchemaHash();

			expect(hash1).to.equal(hash2);
		});

		it('should produce same hash regardless of table creation order', async () => {
			await db.exec(`CREATE TABLE aaa (id INTEGER PRIMARY KEY) USING optimystic('tree://test/aaa')`);
			await db.exec(`CREATE TABLE zzz (id INTEGER PRIMARY KEY) USING optimystic('tree://test/zzz')`);
			const engine1 = new QuereusEngine(db, mockCoordinator);
			engine1.invalidateSchemaCache();
			const hash1 = await engine1.getSchemaHash();

			const db2 = createFreshDb();
			await db2.exec(`CREATE TABLE zzz (id INTEGER PRIMARY KEY) USING optimystic('tree://test/zzz')`);
			await db2.exec(`CREATE TABLE aaa (id INTEGER PRIMARY KEY) USING optimystic('tree://test/aaa')`);
			const engine2 = new QuereusEngine(db2, mockCoordinator);
			engine2.invalidateSchemaCache();
			const hash2 = await engine2.getSchemaHash();

			// ORDER BY type, name in computeSchemaHash should make this deterministic
			expect(hash1).to.equal(hash2);
		});

		it('should detect column type difference', async () => {
			await db.exec(`CREATE TABLE typed (id INTEGER PRIMARY KEY, value TEXT) USING optimystic('tree://test/typed')`);
			const engine1 = new QuereusEngine(db, mockCoordinator);
			engine1.invalidateSchemaCache();
			const hash1 = await engine1.getSchemaHash();

			const db2 = createFreshDb();
			await db2.exec(`CREATE TABLE typed (id INTEGER PRIMARY KEY, value INTEGER) USING optimystic('tree://test/typed')`);
			const engine2 = new QuereusEngine(db2, mockCoordinator);
			engine2.invalidateSchemaCache();
			const hash2 = await engine2.getSchemaHash();

			expect(hash1).to.not.equal(hash2);
		});

		it('should include vtabArgs in hash — different tree URIs produce different hashes', async () => {
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY) USING optimystic('tree://app1/data')`);
			const engine1 = new QuereusEngine(db, mockCoordinator);
			engine1.invalidateSchemaCache();
			const hash1 = await engine1.getSchemaHash();

			const db2 = createFreshDb();
			await db2.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY) USING optimystic('tree://app2/data')`);
			const engine2 = new QuereusEngine(db2, mockCoordinator);
			engine2.invalidateSchemaCache();
			const hash2 = await engine2.getSchemaHash();

			// vtabArgs are in the sql column from schema(), so different URIs → different hashes.
			// This means validators MUST have matching vtab configs, not just matching columns.
			expect(hash1).to.not.equal(hash2);
		});

		it('should include functions in hash — extra function registration changes hash', async () => {
			const engine1 = new QuereusEngine(db, mockCoordinator);
			engine1.invalidateSchemaCache();
			const hash1 = await engine1.getSchemaHash();

			// Register an extra function
			db.registerFunction({
				name: 'extra_func',
				numArgs: 0,
				flags: 1 as any,
				returnType: { typeClass: 'scalar' as const, logicalType: { name: 'TEXT' } as any, nullable: true, isReadOnly: true },
				implementation: () => 'hello',
			});
			engine1.invalidateSchemaCache();
			const hash2 = await engine1.getSchemaHash();

			// Functions appear in schema() output, so an extra function changes the hash.
			// If one node registers more functions, schema validation will fail.
			expect(hash1).to.not.equal(hash2);
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
