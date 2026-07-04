import { expect } from 'chai';
import { openTestDb } from './node-sqlite-driver.js';
import { SqliteRawStorage } from '../src/sqlite-storage.js';
import type { ActionId, BlockId, BlockHeader, IBlock, Transform } from '@optimystic/db-core';

// Regression guard for st-nativescript-sqlite-transaction-mutex.
//
// The test driver (NodeSqliteWrapper) mirrors production ns-opener's transaction()
// exactly — BEGIN/COMMIT/ROLLBACK on a single shared connection with no mutex — over a
// REAL node:sqlite. Two concurrent transaction() bodies therefore nest on one connection:
// the second BEGIN throws "cannot start a transaction within a transaction", and its catch
// ROLLBACKs the FIRST transaction's still-open writes.
//
// SKIPPED until the fix lands. The `describe.skip` KEEPS THIS SUITE RED-FREE for sibling
// tickets in the pipeline while still handing the implement stage a ready assertion. The
// implement stage must remove `.skip` and make it pass by serializing transaction() (and
// plain writes) on the shared connection.
//
// Verified failing at fix time (unskipped): "two concurrent promotes ..." fails with
//   promote outcomes: [ 'fulfilled', 'rejected' ] [ 'cannot start a transaction within a transaction' ]

const makeBlock = (id: string): IBlock => {
	const header: BlockHeader = { id: id as BlockId, type: 'test', collectionId: 'c1' as BlockId };
	return { header };
};
const makeTransform = (id: string): Transform => ({ insert: makeBlock(id) });

describe.skip('SQLite transaction serialization on the shared connection', () => {
	it('two concurrent promotes on disjoint blocks both survive', async () => {
		const db = await openTestDb();
		const storage = new SqliteRawStorage(db);
		const aId = 'action-A' as ActionId;
		const bId = 'action-B' as ActionId;
		const blockA = 'block-A' as BlockId;
		const blockB = 'block-B' as BlockId;

		await storage.savePendingTransaction(blockA, aId, makeTransform('block-A'));
		await storage.savePendingTransaction(blockB, bId, makeTransform('block-B'));

		// Each promote opens its own BEGIN/COMMIT via db.transaction(). On an unserialized
		// shared connection they nest and cross-rollback; serialized, both land.
		const results = await Promise.allSettled([
			storage.promotePendingTransaction(blockA, aId),
			storage.promotePendingTransaction(blockB, bId),
		]);

		expect(results.filter(r => r.status === 'rejected'), 'no promote should fail').to.have.length(0);
		expect(await storage.getTransaction(blockA, aId)).to.deep.equal(makeTransform('block-A'));
		expect(await storage.getTransaction(blockB, bId)).to.deep.equal(makeTransform('block-B'));
		expect(await storage.getPendingTransaction(blockA, aId)).to.equal(undefined);
		expect(await storage.getPendingTransaction(blockB, bId)).to.equal(undefined);

		await db.close();
	});

	it('a plain write concurrent with a transaction is neither lost nor rolled back with it', async () => {
		const db = await openTestDb();
		const storage = new SqliteRawStorage(db);
		const blockA = 'block-A' as BlockId;
		const blockC = 'block-C' as BlockId;

		// Promote a MISSING pending so the transaction genuinely rolls back, then assert a
		// concurrent plain write for another block was not swept into (and lost by) that rollback.
		const results = await Promise.allSettled([
			storage.promotePendingTransaction(blockA, 'action-A' as ActionId), // rolls back: no pending
			storage.savePendingTransaction(blockC, 'action-C' as ActionId, makeTransform('block-C')),
		]);

		// The promote is expected to reject (missing pending); the plain write must still succeed.
		expect(results[1]!.status, 'plain write must not fail').to.equal('fulfilled');
		expect(await storage.getPendingTransaction(blockC, 'action-C' as ActionId), 'C plain write durable')
			.to.deep.equal(makeTransform('block-C'));

		await db.close();
	});
});
