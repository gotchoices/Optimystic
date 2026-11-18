import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionId, BlockId } from '@optimystic/db-core';
import type { BlockMetadata } from '@optimystic/db-p2p';
import { conformancePieceId, runPieceStoreConformance, type PieceStoreHarness } from '@optimystic/db-p2p/testing/conformance';
import { SqlitePieceStore } from '../src/sqlite-piece-store.js';
import { SqliteRawStorage } from '../src/sqlite-storage.js';
import { openTestFileDb } from './node-sqlite-driver.js';

// A file database in its own temp dir per case, so reopen can close the handle and open the same
// file again; the stand-in for the NativeScript plugin runs on `node:sqlite`.
runPieceStoreConformance('SQLite pieces', async (): Promise<PieceStoreHarness> => {
	const dir = await mkdtemp(join(tmpdir(), 'optimystic-sqlite-pieces-'));
	const file = join(dir, 'optimystic.db');
	let db = await openTestFileDb(file);
	return {
		store: new SqlitePieceStore(db),
		reopen: async () => {
			await db.close();
			db = await openTestFileDb(file);
			return new SqlitePieceStore(db);
		},
		cleanup: async () => {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	};
}, { persistent: true });

describe('SQLite pieces upgrade', () => {
	it('a database written without the pieces table gains it on its next open', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'optimystic-sqlite-pieces-upgrade-'));
		const file = join(dir, 'optimystic.db');
		try {
			const blockId = 'older-block' as BlockId;
			const meta: BlockMetadata = { ranges: [[1, 2]], latest: { rev: 1, actionId: 'a1' as ActionId } };

			const older = await openTestFileDb(file);
			await older.exec('DROP TABLE pieces');
			const storage = new SqliteRawStorage(older);
			await storage.saveMetadata(blockId, meta);
			await storage.flush();
			await storage.close();
			await older.close();

			const db = await openTestFileDb(file);
			try {
				expect(await new SqliteRawStorage(db).getMetadata(blockId)).to.deep.equal(meta);
				const store = new SqlitePieceStore(db);
				const bytes = new Uint8Array([1, 2, 3, 4]);
				const id = await conformancePieceId(bytes);
				await store.put(id, bytes);
				expect(Array.from((await store.get(id))!)).to.deep.equal([1, 2, 3, 4]);
			} finally {
				await db.close();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
