import { expect } from 'chai';
import { SqliteRawStorage } from '../src/sqlite-storage.js';
import { openTestDb } from './node-sqlite-driver.js';
import type { SqliteDb } from '../src/db.js';
import { runRawStorageConformance, type ConformanceHarness } from '@optimystic/db-p2p/testing';
import type { BlockId, ActionId } from '@optimystic/db-core';
import type { BlockMetadata } from '@optimystic/db-p2p';

// ---------------------------------------------------------------------------
// Shared parity suite. Proves SqliteRawStorage (KvRawStorage over
// SqliteStoreDriver) behaves identically to every other backend — round-trips,
// listRevisions ordering, promote atomicity + the exact missing-pend error,
// clone-on-store/read (structural via the byte boundary), drain-before-yield
// iteration, and the BlockStorage parity slice. Runs against `node:sqlite`;
// production is NativeScript SQLite, both satisfy `SqliteDb`. Each case gets a
// fresh in-memory db that cleanup closes.
// ---------------------------------------------------------------------------
runRawStorageConformance('SQLite', async (): Promise<ConformanceHarness> => {
	const db = await openTestDb();
	return {
		storage: new SqliteRawStorage(db),
		cleanup: async () => { await db.close(); }
	};
});

// ---------------------------------------------------------------------------
// SQLite-only tests the shared suite does not cover: the value columns are BLOB
// (a TEXT column would UTF-8-coerce non-ASCII JSON bytes and corrupt them), and
// getApproximateBytesUsed is the optional PRAGMA passthrough the shared suite
// skips.
// ---------------------------------------------------------------------------
describe('SQLite driver specifics', () => {
	let db: SqliteDb;
	let storage: SqliteRawStorage;

	beforeEach(async () => {
		db = await openTestDb();
		storage = new SqliteRawStorage(db);
	});

	afterEach(async () => {
		await db.close();
	});

	it('round-trips non-ASCII metadata through the BLOB value column', async () => {
		// A TEXT/JSON-string column would risk mangling multi-byte UTF-8; the BLOB
		// column stores the kernel's exact bytes. The actionId carries the non-ASCII
		// payload so the round-trip has to survive the byte boundary.
		const blockId = 'blob-block' as BlockId;
		const actionId = 'tx:café—🔒—Ω' as ActionId;
		const meta: BlockMetadata = { ranges: [[1, 5]], latest: { rev: 4, actionId } };

		await storage.saveMetadata(blockId, meta);
		expect(await storage.getMetadata(blockId)).to.deep.equal(meta);
	});

	it('getApproximateBytesUsed returns a non-negative number', async () => {
		const used = await storage.getApproximateBytesUsed();
		expect(used).to.be.a('number');
		expect(used).to.be.at.least(0);
	});
});
