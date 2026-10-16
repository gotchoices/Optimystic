import { expect } from 'chai';
import { openTestDb } from './node-sqlite-driver.js';
import type { SqliteDb } from '../src/db.js';

// Regression guard for st-nativescript-sqlite-transaction-mutex.
//
// The test driver (NodeSqliteWrapper) mirrors production ns-opener's transaction() exactly —
// BEGIN/COMMIT/ROLLBACK on a single shared connection, serialized on the connection mutex — over a
// REAL node:sqlite. Without the mutex two concurrent transaction() bodies nest on one connection:
// the second BEGIN throws "cannot start a transaction within a transaction", and its catch
// ROLLBACKs the FIRST transaction's still-open writes; and a plain write issued meanwhile lands
// inside the open transaction and is rolled back with it.
//
// Driven through `SqliteDb.transaction` directly, which is where the mutex lives: the block store
// above it now commits a whole write group per transaction, so a test through the store would
// exercise the overlay rather than the connection.

const INSERT = 'INSERT INTO kv (key, s_val, b_val) VALUES (?, ?, NULL)';

const stored = async (db: SqliteDb, key: string): Promise<string | undefined> => {
	const row = await db.prepare('SELECT s_val FROM kv WHERE key = ?').get(key);
	return row?.s_val as string | undefined;
};

describe('SQLite transaction serialization on the shared connection', () => {
	it('two concurrent transactions on disjoint rows both commit', async () => {
		const db = await openTestDb();
		const write = (key: string) => db.transaction(async (tx) => {
			await tx.prepare(INSERT).run(key, key);
		});

		// Each opens its own BEGIN/COMMIT. On an unserialized shared connection they nest and
		// cross-rollback; serialized, both land.
		const results = await Promise.allSettled([write('a'), write('b')]);

		expect(results.filter(r => r.status === 'rejected'), 'no transaction should fail').to.have.length(0);
		expect(await stored(db, 'a')).to.equal('a');
		expect(await stored(db, 'b')).to.equal('b');

		await db.close();
	});

	it('a plain write concurrent with a transaction that rolls back is neither lost nor rolled back with it', async () => {
		const db = await openTestDb();

		const results = await Promise.allSettled([
			db.transaction(async (tx) => {
				await tx.prepare(INSERT).run('doomed', 'x');
				throw new Error('roll back');
			}),
			db.prepare(INSERT).run('plain', 'y'),
		]);

		expect(results[0]!.status, 'the transaction rolls back').to.equal('rejected');
		expect(results[1]!.status, 'the plain write must not fail').to.equal('fulfilled');
		expect(await stored(db, 'doomed'), 'rolled back').to.equal(undefined);
		expect(await stored(db, 'plain'), 'plain write durable').to.equal('y');

		await db.close();
	});
});
