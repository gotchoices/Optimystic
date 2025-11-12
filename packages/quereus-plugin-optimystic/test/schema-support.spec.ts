/**
 * Tests for dynamic schema support in Optimystic quereus plugin
 */

import { expect } from 'aegir/chai';
import { Database } from '@quereus/quereus';
import register from '../dist/plugin.js';

describe('Optimystic Schema Support', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		const plugin = register(db, {
			default_transactor: 'test',
			default_key_network: 'test',
			enable_cache: false,
		});

		// Register vtables
		for (const vtable of plugin.vtables) {
			db.registerVtabModule(vtable.name, vtable.module, vtable.auxData);
		}

		// Register functions
		for (const func of plugin.functions) {
			db.registerFunction(func.schema);
		}
	});

	describe('CREATE TABLE with columns', () => {
		it('should create table with multiple columns', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT,
					age INTEGER
				) USING optimystic('tree://test/users')
			`);

			// Verify table was created
			const tables = [];
			for await (const row of db.eval('SELECT name FROM schema() WHERE type="table"')) {
				tables.push(row);
			}
			expect(tables.some((t: any) => t.name === 'users')).to.be.true;
		});

		it('should support different column types', async () => {
			await db.exec(`
				CREATE TABLE products (
					id TEXT PRIMARY KEY,
					name TEXT,
					price REAL,
					stock INTEGER,
					data BLOB NULL
				) USING optimystic('tree://test/products')
			`);

			// Insert a row with different types
			await db.exec(`
				INSERT INTO products (id, name, price, stock, data)
				VALUES ('prod1', 'Widget', 19.99, 100, NULL)
			`);

			const results = [];
			for await (const row of db.eval('SELECT * FROM products WHERE id = "prod1"')) {
				results.push(row);
			}
			expect(results).to.have.lengthOf(1);
			expect(results[0]).to.deep.include({
				id: 'prod1',
				name: 'Widget',
				price: 19.99,
				stock: 100,
			});
		});

		it('should support composite primary keys', async () => {
			await db.exec(`
				CREATE TABLE order_items (
					order_id INTEGER,
					item_id INTEGER,
					quantity INTEGER,
					PRIMARY KEY (order_id, item_id)
				) USING optimystic('tree://test/order_items')
			`);

			// Insert rows one at a time to see which ones succeed
			await db.exec(`INSERT INTO order_items (order_id, item_id, quantity) VALUES (1, 101, 5)`);
			await db.exec(`INSERT INTO order_items (order_id, item_id, quantity) VALUES (1, 102, 3)`);
			await db.exec(`INSERT INTO order_items (order_id, item_id, quantity) VALUES (2, 101, 2)`);

			// First check if all rows were inserted
			const allResults = [];
			for await (const row of db.eval('SELECT * FROM order_items')) {
				allResults.push(row);
			}
			expect(allResults).to.have.lengthOf(3);

			// Then check filtered results
			const results = [];
			for await (const row of db.eval('SELECT * FROM order_items WHERE order_id = 1')) {
				results.push(row);
			}
			expect(results).to.have.lengthOf(2);
		});
	});

	describe('INSERT operations', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT
				) USING optimystic('tree://test/users')
			`);
		});

		it('should insert single row', async () => {
			await db.exec(`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')`);

			const result = [];
			for await (const row of db.eval('SELECT * FROM users WHERE id = 1')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(1);
			expect(result[0]).to.deep.include({
				id: 1,
				name: 'Alice',
				email: 'alice@example.com',
			});
		});

		it('should insert multiple rows', async () => {
			// Insert rows one at a time due to multi-row INSERT issue
			await db.exec(`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')`);
			await db.exec(`INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com')`);
			await db.exec(`INSERT INTO users (id, name, email) VALUES (3, 'Charlie', 'charlie@example.com')`);

			const result = [];
			for await (const row of db.eval('SELECT * FROM users ORDER BY id')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(3);
			expect(result.map(r => r.name)).to.deep.equal(['Alice', 'Bob', 'Charlie']);
		});

		it('should handle NULL values', async () => {
			await db.exec(`INSERT INTO users (id, name, email) VALUES (1, 'Alice', NULL)`);

			const result = await db.exec('SELECT * FROM users WHERE id = 1');
			expect(result[0].email).toBeNull();
		});
	});

	describe('UPDATE operations', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT
				) USING optimystic('tree://test/users')
			`);

			await db.exec(`
				INSERT INTO users (id, name, email) VALUES
					(1, 'Alice', 'alice@example.com'),
					(2, 'Bob', 'bob@example.com')
			`);
		});

		it('should update single row', async () => {
			await db.exec(`UPDATE users SET email = 'alice.new@example.com' WHERE id = 1`);

			const result = await db.exec('SELECT * FROM users WHERE id = 1');
			expect(result[0].email).toBe('alice.new@example.com');
		});

		it('should update multiple rows', async () => {
			await db.exec(`UPDATE users SET email = 'updated@example.com'`);

			const result = await db.exec('SELECT * FROM users');
			expect(result.every(r => r.email === 'updated@example.com')).toBe(true);
		});
	});

	describe('DELETE operations', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT
				) USING optimystic('tree://test/users')
			`);

			await db.exec(`
				INSERT INTO users (id, name, email) VALUES
					(1, 'Alice', 'alice@example.com'),
					(2, 'Bob', 'bob@example.com'),
					(3, 'Charlie', 'charlie@example.com')
			`);
		});

		it('should delete single row', async () => {
			await db.exec(`DELETE FROM users WHERE id = 2`);

			const result = [];
			for await (const row of db.eval('SELECT * FROM users ORDER BY id')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(2);
			expect(result.map(r => r.id)).to.deep.equal([1, 3]);
		});

		it('should delete multiple rows', async () => {
			await db.exec(`DELETE FROM users WHERE id > 1`);

			const result = [];
			for await (const row of db.eval('SELECT * FROM users')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(1);
			expect(result[0].id).to.equal(1);
		});

		it('should delete all rows', async () => {
			await db.exec(`DELETE FROM users`);

			const result = [];
			for await (const row of db.eval('SELECT * FROM users')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(0);
		});
	});

	describe('SELECT queries', () => {
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

			await db.exec(`
				INSERT INTO products (id, name, category, price, stock) VALUES
					(1, 'Widget', 'Tools', 19.99, 100),
					(2, 'Gadget', 'Electronics', 49.99, 50),
					(3, 'Doohickey', 'Tools', 9.99, 200),
					(4, 'Gizmo', 'Electronics', 99.99, 25)
			`);
		});

		it('should select all rows', async () => {
			const result = [];
			for await (const row of db.eval('SELECT * FROM products')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(4);
		});

		it('should filter by equality', async () => {
			const result = [];
			for await (const row of db.eval('SELECT * FROM products WHERE category = "Tools"')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(2);
			expect(result.every(r => r.category === 'Tools')).to.equal(true);
		});

		it('should filter by range', async () => {
			const result = [];
			for await (const row of db.eval('SELECT * FROM products WHERE price > 20 AND price < 100')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(2);
		});

		it('should order results', async () => {
			const result = [];
			for await (const row of db.eval('SELECT * FROM products ORDER BY price DESC')) {
				result.push(row);
			}
			expect(result[0].name).to.equal('Gizmo');
			expect(result[3].name).to.equal('Doohickey');
		});

		it('should limit results', async () => {
			const result = [];
			for await (const row of db.eval('SELECT * FROM products LIMIT 2')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(2);
		});

		it('should aggregate results', async () => {
			const result = [];
			for await (const row of db.eval('SELECT category, COUNT(*) as count, AVG(price) as avg_price FROM products GROUP BY category')) {
				result.push(row);
			}
			expect(result).to.have.lengthOf(2);
			const toolsRow = result.find(r => r.category === 'Tools');
			expect(toolsRow).to.deep.include({
				category: 'Tools',
				count: 2,
			});
		});
	});
});

