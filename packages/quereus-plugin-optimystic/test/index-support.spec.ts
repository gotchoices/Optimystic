/**
 * Tests for secondary index support in Optimystic quereus plugin
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { KeyRange } from '@optimystic/db-core';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;
type Plugin = ReturnType<typeof register>;

const memOptions = () => ({
	collectionUri: 'tree://unused',
	transactor: 'test' as const,
	keyNetwork: 'test' as const,
	libp2pOptions: {},
	cache: false,
	encoding: 'json' as const,
});

/** Scan a fresh tree and collect all composite tree keys (entry[0]). */
async function scanIndexKeys(plugin: Plugin, collectionUri: string): Promise<string[]> {
	const tree = await plugin.collectionFactory.createOrGetCollection({ ...memOptions(), collectionUri });
	await tree.update();
	const keys: string[] = [];
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (tree.isValid(treePath)) {
			const entry = tree.at(treePath);
			if (entry) keys.push(entry[0] as string);
		}
	}
	return keys;
}

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
};

describe('Optimystic Index Support', () => {
	let db: Database;
	let plugin: Plugin;

	beforeEach(async () => {
		db = new Database();
		plugin = register(db, {
			default_transactor: 'test',
			default_key_network: 'test',
			enable_cache: false,
		});

		// Register vtables
		for (const vtable of plugin.vtables) {
			db.registerModule(vtable.name, vtable.module, vtable.auxData);
		}

		// Register functions
		for (const func of plugin.functions) {
			db.registerFunction(func.schema);
		}
	});

	describe('CREATE INDEX', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE products (
					id INTEGER PRIMARY KEY,
					name TEXT,
					category TEXT,
					price REAL,
					stock INTEGER
				) USING optimystic('tree://test/products')
			`);
		});

		it('should create single-column index', async () => {
			await db.exec('CREATE INDEX idx_category ON products(category)');

			// Verify index was created
			const indexes = [];
			for await (const row of db.eval("SELECT name FROM schema() WHERE type='index' AND tbl_name='products'")) {
				indexes.push(row);
			}
			expect(indexes.some((i: any) => i.name === 'idx_category')).to.be.true;
		});

		it('should create multi-column index', async () => {
			await db.exec('CREATE INDEX idx_category_price ON products(category, price)');

			const indexes = [];
			for await (const row of db.eval("SELECT name FROM schema() WHERE type='index' AND tbl_name='products'")) {
				indexes.push(row);
			}
			expect(indexes.some((i: any) => i.name === 'idx_category_price')).to.be.true;
		});

		it('should create unique index', async () => {
			await db.exec('CREATE UNIQUE INDEX idx_name ON products(name)');

			const indexes = [];
			for await (const row of db.eval("SELECT name FROM schema() WHERE type='index' AND tbl_name='products'")) {
				indexes.push(row);
			}
			expect(indexes.some((i: any) => i.name === 'idx_name')).to.be.true;
		});
	});

	describe('Index-based queries', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE products (
					id INTEGER PRIMARY KEY,
					name TEXT,
					category TEXT,
					price REAL,
					stock INTEGER
				) USING optimystic('tree://test/products')
			`);

			await db.exec('CREATE INDEX idx_category ON products(category)');
			await db.exec('CREATE INDEX idx_price ON products(price)');
			await db.exec('CREATE INDEX idx_category_price ON products(category, price)');

			await db.exec(`
				INSERT INTO products (id, name, category, price, stock) VALUES
					(1, 'Widget', 'Tools', 19.99, 100),
					(2, 'Gadget', 'Electronics', 49.99, 50),
					(3, 'Doohickey', 'Tools', 9.99, 200),
					(4, 'Gizmo', 'Electronics', 99.99, 25),
					(5, 'Thingamajig', 'Tools', 29.99, 75)
			`);
		});

		it('should use index for equality search', async () => {
			const result = await collectRows(db.eval("SELECT * FROM products WHERE category = 'Tools'"));
			expect(result).to.have.lengthOf(3);
			expect(result.every(r => r.category === 'Tools')).to.equal(true);
		});

		it('should use index for range search', async () => {
			const result = await collectRows(db.eval('SELECT * FROM products WHERE price >= 20 AND price <= 50'));
			expect(result).to.have.lengthOf(2);
		});

		it('should use composite index', async () => {
			const result = await collectRows(db.eval("SELECT * FROM products WHERE category = 'Electronics' AND price > 50"));
			expect(result).to.have.lengthOf(1);
			expect(result[0]!.name).to.equal('Gizmo');
		});

		it('should maintain index on INSERT', async () => {
			await db.exec(`INSERT INTO products (id, name, category, price, stock) VALUES (6, 'Contraption', 'Tools', 39.99, 60)`);

			const result = await collectRows(db.eval("SELECT * FROM products WHERE category = 'Tools'"));
			expect(result).to.have.lengthOf(4);
		});

		it('should maintain index on UPDATE', async () => {
			await db.exec(`UPDATE products SET category = 'Hardware' WHERE id = 1`);

			const toolsResult = await collectRows(db.eval("SELECT * FROM products WHERE category = 'Tools'"));
			expect(toolsResult).to.have.lengthOf(2);

			const hardwareResult = await collectRows(db.eval("SELECT * FROM products WHERE category = 'Hardware'"));
			expect(hardwareResult).to.have.lengthOf(1);
			expect(hardwareResult[0]!.name).to.equal('Widget');
		});

		it('should maintain index on DELETE', async () => {
			await db.exec(`DELETE FROM products WHERE id = 1`);

			const result = await collectRows(db.eval("SELECT * FROM products WHERE category = 'Tools'"));
			expect(result).to.have.lengthOf(2);
			expect(result.every(r => r.id !== 1)).to.equal(true);
		});
	});

	describe('Index optimization', () => {
		beforeEach(async function () {
			// Table + 3 index creation + 100 row inserts dominates; individual ops fast
			// but cumulative setup exceeds the 10s package default.
			this.timeout(30000);

			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					age INTEGER,
					city TEXT
				) USING optimystic('tree://test/users')
			`);

			await db.exec('CREATE INDEX idx_email ON users(email)');
			await db.exec('CREATE INDEX idx_age ON users(age)');
			await db.exec('CREATE INDEX idx_city_age ON users(city, age)');

			// Insert test data
			for (let i = 1; i <= 100; i++) {
				await db.exec(`
					INSERT INTO users (id, email, age, city) VALUES
						(${i}, 'user${i}@example.com', ${20 + (i % 50)}, 'City${i % 10}')
				`);
			}
		});

		it('should choose best index for query', async () => {
			// Query with email constraint should use idx_email
			const result = await collectRows(db.eval("SELECT * FROM users WHERE email = 'user50@example.com'"));
			expect(result).to.have.lengthOf(1);
			expect(result[0]!.id).to.equal(50);
		});

		it('should use composite index when beneficial', async () => {
			// Query with city and age should use idx_city_age
			const result = await collectRows(db.eval("SELECT * FROM users WHERE city = 'City5' AND age > 30"));
			expect(result.length).to.be.greaterThan(0);
			expect(result.every(r => r.city === 'City5' && (r.age as number) > 30)).to.equal(true);
		});

		it('should handle ORDER BY with index', async () => {
			// ORDER BY indexed column should be optimized
			const result = await collectRows(db.eval("SELECT * FROM users WHERE city = 'City1' ORDER BY age"));
			expect(result.length).to.be.greaterThan(0);

			// Verify ordering
			for (let i = 1; i < result.length; i++) {
				expect(result[i]!.age as number).to.be.at.least(result[i - 1]!.age as number);
			}
		});
	});

	describe('addIndex with existing data', () => {
		it('should populate index from pre-existing rows', async () => {
			// Create table and insert data BEFORE creating index — triggers addIndex() population loop
			await db.exec(`
				CREATE TABLE categories (
					id TEXT PRIMARY KEY,
					type_id TEXT,
					name TEXT
				) USING optimystic('tree://test/categories')
			`);

			await db.exec(`
				INSERT INTO categories (id, type_id, name) VALUES
					('cat-eating', 'food', 'Eating'),
					('cat-sleeping', 'activity', 'Sleeping'),
					('cat-cooking', 'food', 'Cooking')
			`);

			// Creating the index after data exists triggers addIndex() to populate from existing rows
			await db.exec('CREATE INDEX idx_categories_type ON categories(type_id)');

			// Verify the index is usable and returns correct results
			const result = await collectRows(db.eval("SELECT * FROM categories WHERE type_id = 'food'"));
			expect(result).to.have.lengthOf(2);
			expect(result.every(r => r.type_id === 'food')).to.equal(true);
		});
	});

	describe('Index edge cases', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE test_table (
					id INTEGER PRIMARY KEY,
					value TEXT NULL
				) USING optimystic('tree://test/test_table')
			`);

			await db.exec('CREATE INDEX idx_value ON test_table(value)');
		});

		it('should handle NULL values in index', async () => {
			await db.exec(`
				INSERT INTO test_table (id, value) VALUES
					(1, 'A'),
					(2, NULL),
					(3, 'B'),
					(4, NULL)
			`);

			const result = await collectRows(db.eval('SELECT * FROM test_table WHERE value IS NULL'));
			expect(result).to.have.lengthOf(2);
		});

		it('should handle empty strings in index', async () => {
			await db.exec(`
				INSERT INTO test_table (id, value) VALUES
					(1, ''),
					(2, 'A'),
					(3, '')
			`);

			const result = await collectRows(db.eval("SELECT * FROM test_table WHERE value = ''"));
			expect(result).to.have.lengthOf(2);
		});

		it('should handle duplicate values in non-unique index', async () => {
			await db.exec(`
				INSERT INTO test_table (id, value) VALUES
					(1, 'duplicate'),
					(2, 'duplicate'),
					(3, 'duplicate')
			`);

			const result = await collectRows(db.eval("SELECT * FROM test_table WHERE value = 'duplicate'"));
			expect(result).to.have.lengthOf(3);
		});
	});

	describe('Index orphan regression (UPDATE/DELETE must not leave stale index entries)', () => {
		it('UPDATE that changes an indexed column leaves no orphan', async () => {
			await db.exec(`
				CREATE TABLE orphan_upd (
					id INTEGER PRIMARY KEY,
					cat TEXT
				) USING optimystic('tree://test/orphan_upd')
			`);
			await db.exec(`CREATE INDEX idx_orphan_upd_cat ON orphan_upd(cat)`);

			await db.exec(`INSERT INTO orphan_upd (id, cat) VALUES (1, 'a'), (2, 'b'), (3, 'c')`);

			// Change row 2's indexed column from 'b' to 'z'.
			await db.exec(`UPDATE orphan_upd SET cat = 'z' WHERE id = 2`);

			// Scan the actual index tree (bypasses the vtab's tracker) — must contain
			// exactly the three live composite keys: a/1, c/3, z/2.
			const keys = await scanIndexKeys(plugin, 'tree://test/orphan_upd/index/idx_orphan_upd_cat');
			expect(keys.length, 'index entry count after UPDATE').to.equal(3);
			// Old entry for 'b'/id=2 must be gone (was the orphan before the fix).
			expect(keys.some(k => k.startsWith('b\x00')), "stale 'b' entry is absent").to.be.false;
			// New entry for 'z'/id=2 must be present.
			expect(keys.some(k => k.startsWith('z\x00')), "new 'z' entry is present").to.be.true;
		});

		it('DELETE leaves no orphan index entry', async () => {
			await db.exec(`
				CREATE TABLE orphan_del (
					id INTEGER PRIMARY KEY,
					cat TEXT
				) USING optimystic('tree://test/orphan_del')
			`);
			await db.exec(`CREATE INDEX idx_orphan_del_cat ON orphan_del(cat)`);

			await db.exec(`INSERT INTO orphan_del (id, cat) VALUES (1, 'a'), (2, 'b'), (3, 'c')`);

			// Delete row 3 — its index entry for 'c' must be removed.
			await db.exec(`DELETE FROM orphan_del WHERE id = 3`);

			const keys = await scanIndexKeys(plugin, 'tree://test/orphan_del/index/idx_orphan_del_cat');
			expect(keys.length, 'index entry count after DELETE').to.equal(2);
			expect(keys.some(k => k.startsWith('c\x00')), "deleted 'c' entry is absent").to.be.false;
		});

		it('UPDATE that leaves the indexed column unchanged neither drops nor duplicates the entry', async () => {
			// The new old-row fetch + restage must be a no-op for the index when
			// only a non-indexed column changes: updateIndexEntries sees an
			// unchanged tree key and early-returns, so the entry count is stable.
			await db.exec(`
				CREATE TABLE orphan_noop (
					id INTEGER PRIMARY KEY,
					cat TEXT,
					note TEXT
				) USING optimystic('tree://test/orphan_noop')
			`);
			await db.exec(`CREATE INDEX idx_orphan_noop_cat ON orphan_noop(cat)`);

			await db.exec(`INSERT INTO orphan_noop (id, cat, note) VALUES (1, 'a', 'x'), (2, 'b', 'y')`);

			// Change only the non-indexed `note` column of row 2.
			await db.exec(`UPDATE orphan_noop SET note = 'z' WHERE id = 2`);

			const keys = await scanIndexKeys(plugin, 'tree://test/orphan_noop/index/idx_orphan_noop_cat');
			expect(keys.length, 'index entry count after no-op-index UPDATE').to.equal(2);
			expect(keys.some(k => k.startsWith('a\x00')), "row 1's 'a' entry intact").to.be.true;
			expect(keys.some(k => k.startsWith('b\x00')), "row 2's 'b' entry intact").to.be.true;
		});

		it("UPDATE on a non-unique index removes only the moved row's entry, not a sibling sharing the old value", async () => {
			// Rows 1 and 2 both have cat='b'; their composite index keys differ
			// only by primary key (b\x001 vs b\x002). Moving row 2 to 'z' must
			// delete exactly b\x002 and leave row 1's b\x001 entry in place.
			await db.exec(`
				CREATE TABLE orphan_dup (
					id INTEGER PRIMARY KEY,
					cat TEXT
				) USING optimystic('tree://test/orphan_dup')
			`);
			await db.exec(`CREATE INDEX idx_orphan_dup_cat ON orphan_dup(cat)`);

			await db.exec(`INSERT INTO orphan_dup (id, cat) VALUES (1, 'b'), (2, 'b'), (3, 'c')`);

			await db.exec(`UPDATE orphan_dup SET cat = 'z' WHERE id = 2`);

			const keys = await scanIndexKeys(plugin, 'tree://test/orphan_dup/index/idx_orphan_dup_cat');
			expect(keys.length, 'index entry count after sibling-sharing UPDATE').to.equal(3);
			// Row 1's shared 'b' entry survives; only row 2's 'b' entry is gone.
			expect(keys, "row 1's b\\x001 entry intact").to.include('b\x001');
			expect(keys, "row 2's b\\x002 entry removed").to.not.include('b\x002');
			expect(keys, "row 2's new z\\x002 entry present").to.include('z\x002');
		});

		it('UPDATE/DELETE on an INTEGER-typed indexed column leaves no orphan and seeks correctly', async () => {
			// Black-box guard for the numeric-index path (all prior orphan tests use a
			// TEXT column and never exercise it). NOTE: with the installed @quereus/quereus,
			// integer literals arrive as JS `number` on BOTH the insert and the
			// update/delete side, so this does NOT by itself reproduce the bigint-vs-number
			// serializer mismatch — the direct reproduction is in
			// index-serialize-value.spec.ts. This test guarantees end-to-end correctness of
			// the unified serializer for integer columns and would also catch a regression
			// if a future Quereus ever emitted integer literals as bigint.
			await db.exec(`
				CREATE TABLE orphan_int (
					id INTEGER PRIMARY KEY,
					n INTEGER
				) USING optimystic('tree://test/orphan_int')
			`);
			await db.exec(`CREATE INDEX idx_orphan_int_n ON orphan_int(n)`);

			await db.exec(`INSERT INTO orphan_int (id, n) VALUES (1, 10), (2, 20), (3, 30)`);

			// Move row 2's indexed integer from 20 -> 25, and delete row 3 (n=30).
			await db.exec(`UPDATE orphan_int SET n = 25 WHERE id = 2`);
			await db.exec(`DELETE FROM orphan_int WHERE id = 3`);

			// Index tree must hold exactly the live composite keys: 10/1, 25/2.
			// Old 20/2 and deleted 30/3 keys must be gone.
			const keys = await scanIndexKeys(plugin, 'tree://test/orphan_int/index/idx_orphan_int_n');
			expect(keys.length, 'index entry count after INTEGER UPDATE+DELETE').to.equal(2);
			const key20 = `${(20).toExponential(15)}\x00`;
			const key30 = `${(30).toExponential(15)}\x00`;
			const key25 = `${(25).toExponential(15)}\x00`;
			const key10 = `${(10).toExponential(15)}\x00`;
			expect(keys.some(k => k.startsWith(key20)), 'stale old n=20 entry is absent').to.be.false;
			expect(keys.some(k => k.startsWith(key30)), 'deleted n=30 entry is absent').to.be.false;
			expect(keys.some(k => k.startsWith(key10)), 'live n=10 entry present').to.be.true;
			expect(keys.some(k => k.startsWith(key25)), 'moved n=25 entry present').to.be.true;

			// Seek side: equality query must find exactly the live matching rows.
			const at25 = await collectRows(db.eval('SELECT * FROM orphan_int WHERE n = 25'));
			expect(at25, 'seek n=25 returns exactly the moved row').to.have.lengthOf(1);
			expect(at25[0]!.id).to.equal(2);

			const at20 = await collectRows(db.eval('SELECT * FROM orphan_int WHERE n = 20'));
			expect(at20, 'seek old n=20 returns nothing (row moved)').to.have.lengthOf(0);

			const at10 = await collectRows(db.eval('SELECT * FROM orphan_int WHERE n = 10'));
			expect(at10, 'seek n=10 returns the untouched row').to.have.lengthOf(1);
			expect(at10[0]!.id).to.equal(1);
		});
	});
});
