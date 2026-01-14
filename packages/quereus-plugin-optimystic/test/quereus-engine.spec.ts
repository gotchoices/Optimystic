/**
 * Tests for QuereusEngine - SQL transaction engine for Optimystic
 */

import { expect } from 'aegir/chai';
import { Database } from '@quereus/quereus';
import {
	QuereusEngine,
	QUEREUS_ENGINE_ID,
	createQuereusStatement,
	createQuereusStatements
} from '../dist/index.js';
import register from '../dist/plugin.js';

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
});

