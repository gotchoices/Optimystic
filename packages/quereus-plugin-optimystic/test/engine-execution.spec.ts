/**
 * TEST-7.1.1: Quereus engine execution tests
 *
 * Tests the QuereusEngine.execute() method — the core SQL execution
 * path for Optimystic transactions. Verifies that SQL statements are
 * correctly executed through the Quereus database, actions are tracked
 * by the coordinator (not returned in the result), and error handling
 * works properly.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import {
	QuereusEngine,
	QUEREUS_ENGINE_ID,
	createQuereusStatement,
	createQuereusStatements,
} from '../dist/index.js';
import register from '../dist/plugin.js';
import {
	createTransactionStamp,
	createTransactionId,
	type Transaction,
} from '@optimystic/db-core';

type Row = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
};

/** Create a Transaction object for testing */
async function createTestTransaction(statements: string[]): Promise<Transaction> {
	const stamp = await createTransactionStamp(
		'test-peer',
		Date.now(),
		'test-schema-hash',
		QUEREUS_ENGINE_ID
	);
	return {
		stamp,
		statements,
		reads: [],
		id: await createTransactionId(stamp.id, statements, []),
	};
}

describe('QuereusEngine execute() (TEST-7.1.1)', () => {
	let db: Database;
	let engine: QuereusEngine;

	beforeEach(async () => {
		db = new Database();
		const plugin = register(db, {
			default_transactor: 'mesh-test',
			default_key_network: 'test',
			enable_cache: false,
		});

		for (const vtable of plugin.vtables) {
			db.registerModule(vtable.name, vtable.module, vtable.auxData);
		}
		for (const func of plugin.functions) {
			db.registerFunction(func.schema);
		}

		// Create test table before engine execution.
		// Note: Quereus virtual tables default columns to NOT NULL.
		// Use explicit NULL to allow nullable columns.
		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT NULL
			) USING optimystic('tree://test/users')
		`);

		// execute() doesn't use the coordinator directly — mutations go through
		// the virtual table module → TransactionBridge, not through this reference
		const mockCoordinator = {} as any;
		engine = new QuereusEngine(db, mockCoordinator);
	});

	describe('successful execution', () => {
		it('should execute a single INSERT statement', async () => {
			const txn = await createTestTransaction([
				createQuereusStatement("INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@test.com')")
			]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);

			const rows = await collectRows(db.eval('SELECT * FROM users WHERE id = 1'));
			expect(rows).to.have.lengthOf(1);
			expect(rows[0]!.name).to.equal('Alice');
			expect(rows[0]!.email).to.equal('alice@test.com');
		});

		it('should execute multiple statements in order', async () => {
			const txn = await createTestTransaction(createQuereusStatements([
				{ sql: "INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'a@test.com')" },
				{ sql: "INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'b@test.com')" },
				{ sql: "UPDATE users SET email = 'alice.updated@test.com' WHERE id = 1" },
			]));

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);

			const rows = await collectRows(db.eval('SELECT * FROM users ORDER BY id'));
			expect(rows).to.have.lengthOf(2);
			expect(rows[0]!.email).to.equal('alice.updated@test.com');
			expect(rows[1]!.name).to.equal('Bob');
		});

		it('should execute parameterized statements', async () => {
			const txn = await createTestTransaction([
				createQuereusStatement(
					'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
					[1, 'Charlie', 'charlie@test.com']
				)
			]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);

			const rows = await collectRows(db.eval('SELECT * FROM users WHERE id = 1'));
			expect(rows).to.have.lengthOf(1);
			expect(rows[0]!.name).to.equal('Charlie');
		});

		it('should execute DELETE statements', async () => {
			// Virtual tables require all columns in INSERT (even nullable ones)
			await db.exec("INSERT INTO users (id, name, email) VALUES (1, 'Alice', NULL)");
			await db.exec("INSERT INTO users (id, name, email) VALUES (2, 'Bob', NULL)");

			const txn = await createTestTransaction([
				createQuereusStatement('DELETE FROM users WHERE id = 1')
			]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);

			const rows = await collectRows(db.eval('SELECT * FROM users'));
			expect(rows).to.have.lengthOf(1);
			expect(rows[0]!.name).to.equal('Bob');
		});

		it('should handle empty transaction (no statements)', async () => {
			const txn = await createTestTransaction([]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);
		});

		it('should return empty actions array — actions tracked by coordinator, not returned', async () => {
			const txn = await createTestTransaction([
				createQuereusStatement("INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'a@test.com')")
			]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);
			// By design: actions are collected by the coordinator's internal trackers,
			// not returned in ExecutionResult. See HUNT-7.1.2.
			expect(result.actions).to.deep.equal([]);
		});

		it('should handle SELECT statements (read-only, no mutations)', async () => {
			await db.exec("INSERT INTO users (id, name, email) VALUES (1, 'Alice', NULL)");

			const txn = await createTestTransaction([
				createQuereusStatement('SELECT * FROM users WHERE id = 1')
			]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);
		});
	});

	describe('error handling', () => {
		it('should return failure for invalid SQL syntax', async () => {
			const txn = await createTestTransaction([
				createQuereusStatement('NOT VALID SQL AT ALL')
			]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(false);
			expect(result.error).to.be.a('string');
			expect(result.error).to.include('Failed to execute SQL transaction');
		});

		it('should return failure for SQL referencing non-existent table', async () => {
			const txn = await createTestTransaction([
				createQuereusStatement('SELECT * FROM nonexistent_table')
			]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(false);
			expect(result.error).to.include('Failed to execute SQL transaction');
		});

		it('should return failure for invalid JSON in statements', async () => {
			const txn = await createTestTransaction(['{{not-valid-json}}']);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(false);
			expect(result.error).to.include('Failed to execute SQL transaction');
		});

		it('should stop at first failing statement — partial mutations remain (no rollback)', async () => {
			const txn = await createTestTransaction(createQuereusStatements([
				{ sql: "INSERT INTO users (id, name, email) VALUES (1, 'Alice', NULL)" },
				{ sql: 'INVALID SQL BREAKS HERE' },
				{ sql: "INSERT INTO users (id, name, email) VALUES (2, 'Bob', NULL)" },
			]));

			const result = await engine.execute(txn);
			expect(result.success).to.equal(false);

			// First statement executed before error — mutations are NOT rolled back.
			// execute() provides no atomicity across statements; that's the
			// TransactionBridge/session's responsibility.
			const rows = await collectRows(db.eval('SELECT * FROM users'));
			expect(rows).to.have.lengthOf(1);
			expect(rows[0]!.name).to.equal('Alice');
		});

		it('should include original error message in failure result', async () => {
			const txn = await createTestTransaction([
				createQuereusStatement('DROP TABLE nonexistent')
			]);

			const result = await engine.execute(txn);
			expect(result.success).to.equal(false);
			// Error message should wrap the original error
			expect(result.error).to.match(/Failed to execute SQL transaction: .+/);
		});
	});

	describe('multi-table execution', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE products (
					id INTEGER PRIMARY KEY,
					name TEXT NULL,
					price REAL NULL
				) USING optimystic('tree://test/products')
			`);
		});

		it('should execute statements across multiple tables', async () => {
			const txn = await createTestTransaction(createQuereusStatements([
				{ sql: "INSERT INTO users (id, name, email) VALUES (1, 'Alice', NULL)" },
				{ sql: "INSERT INTO products (id, name, price) VALUES (1, 'Widget', 9.99)" },
			]));

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);

			const users = await collectRows(db.eval('SELECT * FROM users'));
			expect(users).to.have.lengthOf(1);

			const products = await collectRows(db.eval('SELECT * FROM products'));
			expect(products).to.have.lengthOf(1);
			expect(products[0]!.price).to.equal(9.99);
		});

		it('should fail midway through multi-table transaction without rolling back prior tables', async () => {
			const txn = await createTestTransaction(createQuereusStatements([
				{ sql: "INSERT INTO users (id, name, email) VALUES (1, 'Alice', NULL)" },
				{ sql: "INSERT INTO products (id, name, price) VALUES (1, 'Widget', 9.99)" },
				{ sql: 'SELECT * FROM nonexistent' }, // fails
				{ sql: "INSERT INTO users (id, name, email) VALUES (2, 'Bob', NULL)" },
			]));

			const result = await engine.execute(txn);
			expect(result.success).to.equal(false);

			// Both prior mutations persist — no cross-statement atomicity in execute()
			const users = await collectRows(db.eval('SELECT * FROM users'));
			expect(users).to.have.lengthOf(1);
			const products = await collectRows(db.eval('SELECT * FROM products'));
			expect(products).to.have.lengthOf(1);
		});
	});

	describe('idempotency and determinism considerations', () => {
		it('should produce same side-effects when re-executed with same statements', async () => {
			// First execution
			const stmts = createQuereusStatements([
				{ sql: "INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'a@test.com')" },
			]);
			const txn1 = await createTestTransaction(stmts);
			const result1 = await engine.execute(txn1);
			expect(result1.success).to.equal(true);

			// Second execution of same INSERT should fail (duplicate PK)
			const txn2 = await createTestTransaction(stmts);
			const result2 = await engine.execute(txn2);

			// The virtual table should detect the duplicate and either fail
			// or silently replace. Either way, we should end up with exactly one row.
			const rows = await collectRows(db.eval('SELECT * FROM users'));
			expect(rows).to.have.lengthOf(1);
		});

		it('should execute INSERT + UPDATE + DELETE sequence correctly', async () => {
			const txn = await createTestTransaction(createQuereusStatements([
				{ sql: "INSERT INTO users (id, name, email) VALUES (1, 'Alice', NULL)" },
				{ sql: "INSERT INTO users (id, name, email) VALUES (2, 'Bob', NULL)" },
				{ sql: "UPDATE users SET name = 'Alice Updated' WHERE id = 1" },
				{ sql: 'DELETE FROM users WHERE id = 2' },
			]));

			const result = await engine.execute(txn);
			expect(result.success).to.equal(true);

			const rows = await collectRows(db.eval('SELECT * FROM users'));
			expect(rows).to.have.lengthOf(1);
			expect(rows[0]!.id).to.equal(1);
			expect(rows[0]!.name).to.equal('Alice Updated');
		});
	});
});
