/**
 * Tests for secondary index support in Optimystic quereus plugin
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '@quereus/quereus';
import { register } from '../src/plugin.js';

describe('Optimystic Index Support', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await register(db, {
			default_transactor: 'test',
			default_key_network: 'test',
			enable_cache: false,
		});
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
			const indexes = await db.exec('SELECT name FROM sqlite_master WHERE type="index" AND tbl_name="products"');
			expect(indexes).toContainEqual({ name: 'idx_category' });
		});

		it('should create multi-column index', async () => {
			await db.exec('CREATE INDEX idx_category_price ON products(category, price)');

			const indexes = await db.exec('SELECT name FROM sqlite_master WHERE type="index" AND tbl_name="products"');
			expect(indexes).toContainEqual({ name: 'idx_category_price' });
		});

		it('should create unique index', async () => {
			await db.exec('CREATE UNIQUE INDEX idx_name ON products(name)');

			const indexes = await db.exec('SELECT name FROM sqlite_master WHERE type="index" AND tbl_name="products"');
			expect(indexes).toContainEqual({ name: 'idx_name' });
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
			const result = await db.exec('SELECT * FROM products WHERE category = "Tools"');
			expect(result).toHaveLength(3);
			expect(result.every(r => r.category === 'Tools')).toBe(true);
		});

		it('should use index for range search', async () => {
			const result = await db.exec('SELECT * FROM products WHERE price >= 20 AND price <= 50');
			expect(result).toHaveLength(2);
		});

		it('should use composite index', async () => {
			const result = await db.exec('SELECT * FROM products WHERE category = "Electronics" AND price > 50');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Gizmo');
		});

		it('should maintain index on INSERT', async () => {
			await db.exec(`INSERT INTO products (id, name, category, price, stock) VALUES (6, 'Contraption', 'Tools', 39.99, 60)`);

			const result = await db.exec('SELECT * FROM products WHERE category = "Tools"');
			expect(result).toHaveLength(4);
		});

		it('should maintain index on UPDATE', async () => {
			await db.exec(`UPDATE products SET category = 'Hardware' WHERE id = 1`);

			const toolsResult = await db.exec('SELECT * FROM products WHERE category = "Tools"');
			expect(toolsResult).toHaveLength(2);

			const hardwareResult = await db.exec('SELECT * FROM products WHERE category = "Hardware"');
			expect(hardwareResult).toHaveLength(1);
			expect(hardwareResult[0].name).toBe('Widget');
		});

		it('should maintain index on DELETE', async () => {
			await db.exec(`DELETE FROM products WHERE id = 1`);

			const result = await db.exec('SELECT * FROM products WHERE category = "Tools"');
			expect(result).toHaveLength(2);
			expect(result.every(r => r.id !== 1)).toBe(true);
		});
	});

	describe('Index optimization', () => {
		beforeEach(async () => {
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
			const result = await db.exec('SELECT * FROM users WHERE email = "user50@example.com"');
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(50);
		});

		it('should use composite index when beneficial', async () => {
			// Query with city and age should use idx_city_age
			const result = await db.exec('SELECT * FROM users WHERE city = "City5" AND age > 30');
			expect(result.length).toBeGreaterThan(0);
			expect(result.every(r => r.city === 'City5' && r.age > 30)).toBe(true);
		});

		it('should handle ORDER BY with index', async () => {
			// ORDER BY indexed column should be optimized
			const result = await db.exec('SELECT * FROM users WHERE city = "City1" ORDER BY age');
			expect(result.length).toBeGreaterThan(0);

			// Verify ordering
			for (let i = 1; i < result.length; i++) {
				expect(result[i].age).toBeGreaterThanOrEqual(result[i - 1].age);
			}
		});
	});

	describe('Index edge cases', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE test_table (
					id INTEGER PRIMARY KEY,
					value TEXT
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

			const result = await db.exec('SELECT * FROM test_table WHERE value IS NULL');
			expect(result).toHaveLength(2);
		});

		it('should handle empty strings in index', async () => {
			await db.exec(`
				INSERT INTO test_table (id, value) VALUES
					(1, ''),
					(2, 'A'),
					(3, '')
			`);

			const result = await db.exec('SELECT * FROM test_table WHERE value = ""');
			expect(result).toHaveLength(2);
		});

		it('should handle duplicate values in non-unique index', async () => {
			await db.exec(`
				INSERT INTO test_table (id, value) VALUES
					(1, 'duplicate'),
					(2, 'duplicate'),
					(3, 'duplicate')
			`);

			const result = await db.exec('SELECT * FROM test_table WHERE value = "duplicate"');
			expect(result).toHaveLength(3);
		});
	});
});

