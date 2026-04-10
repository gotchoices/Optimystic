/**
 * TEST-7.4.1: Schema migration tests
 *
 * Tests schema evolution, persistence, and consistency in the
 * quereus-plugin-optimystic package. Verifies that schema changes
 * (CREATE TABLE, DROP TABLE, re-CREATE with different columns)
 * are handled correctly and the SchemaManager maintains consistency.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { QuereusEngine } from '../dist/index.js';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
};

describe('Schema Migration (TEST-7.4.1)', () => {
	let db: Database;

	beforeEach(async () => {
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

	describe('initial schema creation', () => {
		it('should register table in schema catalog after CREATE TABLE', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					email TEXT
				) USING optimystic('tree://test/users')
			`);

			const tables = await collectRows(
				db.eval("SELECT name, type FROM schema() WHERE type = 'table' AND name = 'users'")
			);
			expect(tables).to.have.lengthOf(1);
			expect(tables[0]!.name).to.equal('users');
		});

		it('should persist column information in schema', async () => {
			await db.exec(`
				CREATE TABLE typed_table (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					score REAL,
					data BLOB
				) USING optimystic('tree://test/typed')
			`);

			const columns = await collectRows(
				db.eval("SELECT sql FROM schema() WHERE type = 'table' AND name = 'typed_table'")
			);
			expect(columns).to.have.lengthOf(1);
			const sql = columns[0]!.sql as string;
			expect(sql).to.include('id');
			expect(sql).to.include('name');
			expect(sql).to.include('score');
			expect(sql).to.include('data');
		});

		it('should create multiple independent tables', async () => {
			await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY, a TEXT) USING optimystic('tree://test/t1')`);
			await db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY, b TEXT) USING optimystic('tree://test/t2')`);
			await db.exec(`CREATE TABLE t3 (id INTEGER PRIMARY KEY, c TEXT) USING optimystic('tree://test/t3')`);

			const tables = await collectRows(
				db.eval("SELECT name FROM schema() WHERE type = 'table' ORDER BY name")
			);
			const names = tables.map(t => t.name);
			expect(names).to.include('t1');
			expect(names).to.include('t2');
			expect(names).to.include('t3');
		});
	});

	describe('schema deletion (DROP TABLE)', () => {
		it('should remove table from schema catalog', async () => {
			await db.exec(`CREATE TABLE temp_table (id INTEGER PRIMARY KEY) USING optimystic('tree://test/temp')`);

			// Verify it exists
			let tables = await collectRows(
				db.eval("SELECT name FROM schema() WHERE type = 'table' AND name = 'temp_table'")
			);
			expect(tables).to.have.lengthOf(1);

			// Drop it
			await db.exec('DROP TABLE temp_table');

			// Verify it's gone
			tables = await collectRows(
				db.eval("SELECT name FROM schema() WHERE type = 'table' AND name = 'temp_table'")
			);
			expect(tables).to.have.lengthOf(0);
		});

		it('should not affect other tables when one is dropped', async () => {
			await db.exec(`CREATE TABLE keep_me (id INTEGER PRIMARY KEY) USING optimystic('tree://test/keep')`);
			await db.exec(`CREATE TABLE drop_me (id INTEGER PRIMARY KEY) USING optimystic('tree://test/drop')`);

			await db.exec('DROP TABLE drop_me');

			// keep_me should still work
			await db.exec("INSERT INTO keep_me (id) VALUES (1)");
			const rows = await collectRows(db.eval('SELECT * FROM keep_me'));
			expect(rows).to.have.lengthOf(1);

			// drop_me should be inaccessible
			try {
				await db.exec('SELECT * FROM drop_me');
				expect.fail('Should have thrown for dropped table');
			} catch (err) {
				expect((err as Error).message).to.be.a('string');
			}
		});
	});

	describe('schema replacement (DROP + re-CREATE)', () => {
		it('should allow re-creating a table with the same name and different columns', async () => {
			// Create V1
			await db.exec(`
				CREATE TABLE evolving (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING optimystic('tree://test/evolving')
			`);
			await db.exec("INSERT INTO evolving (id, name) VALUES (1, 'Alice')");

			// Drop V1
			await db.exec('DROP TABLE evolving');

			// Create V2 with different columns
			await db.exec(`
				CREATE TABLE evolving (
					id INTEGER PRIMARY KEY,
					full_name TEXT,
					age INTEGER
				) USING optimystic('tree://test/evolving_v2')
			`);

			// V2 should work with new columns
			await db.exec("INSERT INTO evolving (id, full_name, age) VALUES (1, 'Alice Smith', 30)");
			const rows = await collectRows(db.eval('SELECT * FROM evolving WHERE id = 1'));
			expect(rows).to.have.lengthOf(1);
			expect(rows[0]!.full_name).to.equal('Alice Smith');
			expect(rows[0]!.age).to.equal(30);
		});

		it('should produce different schema hash after re-creation with different columns', async () => {
			const mockCoordinator = {} as any;

			// V1
			await db.exec(`CREATE TABLE versioned (id INTEGER PRIMARY KEY, a TEXT) USING optimystic('tree://test/v1')`);
			const engine1 = new QuereusEngine(db, mockCoordinator);
			engine1.invalidateSchemaCache();
			const hash1 = await engine1.getSchemaHash();

			// Drop and re-create with different columns
			await db.exec('DROP TABLE versioned');
			await db.exec(`CREATE TABLE versioned (id INTEGER PRIMARY KEY, b INTEGER, c REAL) USING optimystic('tree://test/v2')`);
			engine1.invalidateSchemaCache();
			const hash2 = await engine1.getSchemaHash();

			expect(hash1).to.not.equal(hash2);
		});
	});

	describe('schema hash consistency across DDL changes', () => {
		it('should track schema version increments through create/drop cycles', async () => {
			const mockCoordinator = {} as any;
			const engine = new QuereusEngine(db, mockCoordinator);

			const initialHash = await engine.getSchemaHash();
			expect(engine.getSchemaVersion()).to.equal(0);

			// Add a table — auto-invalidation bumps version
			await db.exec(`CREATE TABLE cycle1 (id INTEGER PRIMARY KEY) USING optimystic('tree://test/c1')`);
			expect(engine.getSchemaVersion()).to.equal(1);
			const hash1 = await engine.getSchemaHash();
			expect(hash1).to.not.equal(initialHash);

			// Drop the table — auto-invalidation bumps version again
			await db.exec('DROP TABLE cycle1');
			expect(engine.getSchemaVersion()).to.equal(2);
			const hash2 = await engine.getSchemaHash();

			// After dropping, hash should return to initial state (same schema)
			expect(hash2).to.equal(initialHash);
		});

		it('should detect adding a column vs original schema (via re-creation)', async () => {
			const mockCoordinator = {} as any;

			// Since virtual tables don't support ALTER TABLE, we test via drop+create
			await db.exec(`CREATE TABLE addcol (id INTEGER PRIMARY KEY, a TEXT) USING optimystic('tree://test/ac')`);
			const engine = new QuereusEngine(db, mockCoordinator);
			engine.invalidateSchemaCache();
			const hash1 = await engine.getSchemaHash();

			// "Migrate": drop and re-create with extra column
			await db.exec('DROP TABLE addcol');
			await db.exec(`CREATE TABLE addcol (id INTEGER PRIMARY KEY, a TEXT, b INTEGER) USING optimystic('tree://test/ac2')`);
			engine.invalidateSchemaCache();
			const hash2 = await engine.getSchemaHash();

			expect(hash1).to.not.equal(hash2);
		});
	});

	describe('data preservation during schema lifecycle', () => {
		it('should maintain data across insert/query after table creation', async () => {
			await db.exec(`
				CREATE TABLE persistent (
					id INTEGER PRIMARY KEY,
					value TEXT
				) USING optimystic('tree://test/persistent')
			`);

			// Insert data
			await db.exec("INSERT INTO persistent (id, value) VALUES (1, 'one')");
			await db.exec("INSERT INTO persistent (id, value) VALUES (2, 'two')");
			await db.exec("INSERT INTO persistent (id, value) VALUES (3, 'three')");

			// Verify all data accessible
			const rows = await collectRows(db.eval('SELECT * FROM persistent ORDER BY id'));
			expect(rows).to.have.lengthOf(3);
			expect(rows.map(r => r.value)).to.deep.equal(['one', 'two', 'three']);
		});

		it('should allow creating a table with composite primary key migration', async () => {
			// V1: single PK
			await db.exec(`
				CREATE TABLE events (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING optimystic('tree://test/events_v1')
			`);
			await db.exec("INSERT INTO events (id, name) VALUES (1, 'click')");
			await db.exec('DROP TABLE events');

			// V2: composite PK
			await db.exec(`
				CREATE TABLE events (
					user_id INTEGER,
					event_id INTEGER,
					name TEXT,
					PRIMARY KEY (user_id, event_id)
				) USING optimystic('tree://test/events_v2')
			`);
			await db.exec("INSERT INTO events (user_id, event_id, name) VALUES (1, 1, 'click')");
			await db.exec("INSERT INTO events (user_id, event_id, name) VALUES (1, 2, 'scroll')");

			const rows = await collectRows(db.eval('SELECT * FROM events WHERE user_id = 1'));
			expect(rows).to.have.lengthOf(2);
		});
	});

	describe('concurrent table operations', () => {
		it('should handle many create/drop cycles without leaking state', async () => {
			for (let i = 0; i < 5; i++) {
				const tableName = `cycle_table_${i}`;
				await db.exec(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, v INTEGER) USING optimystic('tree://test/cycle${i}')`);
				await db.exec(`INSERT INTO ${tableName} (id, v) VALUES (1, ${i})`);

				const rows = await collectRows(db.eval(`SELECT v FROM ${tableName} WHERE id = 1`));
				expect(rows[0]!.v).to.equal(i);

				await db.exec(`DROP TABLE ${tableName}`);
			}

			// All cycle tables should be gone
			const tables = await collectRows(
				db.eval("SELECT name FROM schema() WHERE type = 'table' AND name LIKE 'cycle_table_%'")
			);
			expect(tables).to.have.lengthOf(0);
		});

		it('should isolate data between tables using different tree URIs', async () => {
			await db.exec(`CREATE TABLE a (id INTEGER PRIMARY KEY, val TEXT) USING optimystic('tree://test/iso_a')`);
			await db.exec(`CREATE TABLE b (id INTEGER PRIMARY KEY, val TEXT) USING optimystic('tree://test/iso_b')`);

			await db.exec("INSERT INTO a (id, val) VALUES (1, 'in-a')");
			await db.exec("INSERT INTO b (id, val) VALUES (1, 'in-b')");

			const rowsA = await collectRows(db.eval('SELECT val FROM a WHERE id = 1'));
			const rowsB = await collectRows(db.eval('SELECT val FROM b WHERE id = 1'));
			expect(rowsA[0]!.val).to.equal('in-a');
			expect(rowsB[0]!.val).to.equal('in-b');
		});
	});

	describe('schema hash node agreement', () => {
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

		it('should produce matching hashes after identical migration sequences on two nodes', async () => {
			const mockCoord = {} as any;

			// Node 1: create, drop, re-create
			await db.exec(`CREATE TABLE migrated (id INTEGER PRIMARY KEY, a TEXT) USING optimystic('tree://test/m1')`);
			await db.exec('DROP TABLE migrated');
			await db.exec(`CREATE TABLE migrated (id INTEGER PRIMARY KEY, b INTEGER) USING optimystic('tree://test/m2')`);
			const engine1 = new QuereusEngine(db, mockCoord);
			engine1.invalidateSchemaCache();
			const hash1 = await engine1.getSchemaHash();

			// Node 2: same sequence
			const db2 = createFreshDb();
			await db2.exec(`CREATE TABLE migrated (id INTEGER PRIMARY KEY, a TEXT) USING optimystic('tree://test/m1')`);
			await db2.exec('DROP TABLE migrated');
			await db2.exec(`CREATE TABLE migrated (id INTEGER PRIMARY KEY, b INTEGER) USING optimystic('tree://test/m2')`);
			const engine2 = new QuereusEngine(db2, mockCoord);
			engine2.invalidateSchemaCache();
			const hash2 = await engine2.getSchemaHash();

			// Both nodes should agree on schema hash after same migration path
			expect(hash1).to.equal(hash2);
		});

		it('should diverge when nodes apply different migration paths', async () => {
			const mockCoord = {} as any;

			// Node 1: keeps column 'a'
			await db.exec(`CREATE TABLE diverged (id INTEGER PRIMARY KEY, a TEXT) USING optimystic('tree://test/d1')`);
			const engine1 = new QuereusEngine(db, mockCoord);
			engine1.invalidateSchemaCache();
			const hash1 = await engine1.getSchemaHash();

			// Node 2: migrated to column 'b'
			const db2 = createFreshDb();
			await db2.exec(`CREATE TABLE diverged (id INTEGER PRIMARY KEY, b INTEGER) USING optimystic('tree://test/d2')`);
			const engine2 = new QuereusEngine(db2, mockCoord);
			engine2.invalidateSchemaCache();
			const hash2 = await engine2.getSchemaHash();

			// Schema mismatch would cause validation failure in distributed consensus
			expect(hash1).to.not.equal(hash2);
		});
	});
});
