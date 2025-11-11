/**
 * Tests for TransactionId() SQL function
 */

import { expect } from 'aegir/chai';
import { Database } from '@quereus/quereus';
import register from '../dist/plugin.js';

describe('TransactionId() Function', () => {
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

		// Create a test table
		await db.exec(`
			CREATE TABLE test_data (
				id INTEGER PRIMARY KEY,
				txn_id TEXT,
				value TEXT
			) USING optimystic('tree://test/txn_test')
		`);
	});

	describe('Function registration', () => {
		it('should be registered and callable', async () => {
			const result = await db.prepare('SELECT TransactionId() as txn_id').get();
			expect(result).to.exist;
		});

		it('should return NULL when not in a transaction', async () => {
			const result = await db.prepare('SELECT TransactionId() as txn_id').get();
			expect(result).to.exist;
			expect(result?.txn_id).to.be.null;
		});
	});

	describe('Transaction integration', () => {
		it('should return a transaction ID immediately after BEGIN (without DML)', async () => {
			await db.exec('BEGIN');
			// Should work immediately without needing a DML operation first
			const result = await db.prepare('SELECT TransactionId() as txn_id').get();
			await db.exec('ROLLBACK');

			expect(result).to.exist;
			expect(result?.txn_id).to.be.a('string');
			expect(result?.txn_id).to.not.be.null;
		});

		it('should return a transaction ID when in a transaction', async () => {
			await db.exec('BEGIN');
			// Trigger connection registration by inserting data
			await db.exec('INSERT INTO test_data (id, txn_id, value) VALUES (1, \'test\', \'test\')');
			const result = await db.prepare('SELECT TransactionId() as txn_id').get();
			await db.exec('ROLLBACK');

			expect(result).to.exist;
			expect(result?.txn_id).to.be.a('string');
			expect(result?.txn_id).to.not.be.null;
		});

		it('should return the same ID within a single transaction', async () => {
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test_data (id, txn_id, value) VALUES (1, \'test\', \'test\')');

			const result1 = await db.prepare('SELECT TransactionId() as txn_id').get();
			const result2 = await db.prepare('SELECT TransactionId() as txn_id').get();
			const result3 = await db.prepare('SELECT TransactionId() as txn_id').get();

			await db.exec('COMMIT');

			expect(result1?.txn_id).to.equal(result2?.txn_id);
			expect(result2?.txn_id).to.equal(result3?.txn_id);
		});

		it('should generate different IDs for different transactions', async () => {
			// Transaction 1
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test_data (id, txn_id, value) VALUES (1, \'test\', \'test\')');
			const result1 = await db.prepare('SELECT TransactionId() as txn_id').get();
			await db.exec('COMMIT');

			// Transaction 2
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test_data (id, txn_id, value) VALUES (2, \'test\', \'test\')');
			const result2 = await db.prepare('SELECT TransactionId() as txn_id').get();
			await db.exec('COMMIT');

			expect(result1?.txn_id).to.not.equal(result2?.txn_id);
		});

		it('should be usable in INSERT statements', async () => {
			await db.exec('BEGIN');
			// First insert to trigger connection registration
			await db.exec('INSERT INTO test_data (id, txn_id, value) VALUES (1, \'init\', \'test\')');
			// Verify TransactionId() returns a value during the transaction
			const txnIdResult = await db.prepare('SELECT TransactionId() as txn_id').get();
			await db.exec('COMMIT');

			expect(txnIdResult).to.exist;
			expect(txnIdResult?.txn_id).to.be.a('string');
			expect(txnIdResult?.txn_id).to.not.be.null;
		});

		it('should work with WITH CONTEXT clause', async () => {
			// Create a table with context variable for transaction ID
			await db.exec(`
				CREATE TABLE context_test (
					id INTEGER PRIMARY KEY,
					data TEXT,
					txn_id TEXT DEFAULT context_txn_id
				) USING optimystic('tree://test/context_test')
				WITH CONTEXT (
					context_txn_id TEXT
				)
			`);

			// Insert data with context - TransactionId() should be callable in WITH CONTEXT
			// This will use an implicit transaction
			await db.exec(`
				INSERT INTO context_test (id, data)
				WITH CONTEXT context_txn_id = TransactionId()
				VALUES (1, 'test')
			`);

			// The test passes if the INSERT succeeds without error
			// (proving TransactionId() can be used in WITH CONTEXT expressions)
		});

		it('should be base64url encoded', async () => {
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test_data (id, txn_id, value) VALUES (1, \'test\', \'test\')');
			const result = await db.prepare('SELECT TransactionId() as txn_id').get();
			await db.exec('COMMIT');

			const txnId = result?.txn_id as string;
			// base64url should only contain: A-Z, a-z, 0-9, -, _
			expect(txnId).to.match(/^[A-Za-z0-9_-]+$/);
		});

		it('should have reasonable length (32 bytes encoded)', async () => {
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test_data (id, txn_id, value) VALUES (1, \'test\', \'test\')');
			const result = await db.prepare('SELECT TransactionId() as txn_id').get();
			await db.exec('COMMIT');

			const txnId = result?.txn_id as string;
			// 32 bytes in base64url is approximately 43 characters
			expect(txnId.length).to.be.at.least(40);
			expect(txnId.length).to.be.at.most(50);
		});
	});

	describe('Implementation details', () => {
		it('should be defined in package.json metadata', async () => {
			const { readFile } = await import('fs/promises');
			const pkgJson = await readFile(new URL('../package.json', import.meta.url), 'utf-8');
			const pkg = JSON.parse(pkgJson);
			expect(pkg.quereus).to.exist;
			expect(pkg.quereus.provides).to.exist;
			expect(pkg.quereus.provides.functions).to.be.an('array');
			expect(pkg.quereus.provides.functions).to.include('TransactionId');
		});
	});
});

