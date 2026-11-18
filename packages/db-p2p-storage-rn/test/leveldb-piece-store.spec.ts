import { expect } from 'chai';
import type { ActionId, BlockId } from '@optimystic/db-core';
import { blockStoreCountsPieces } from '@optimystic/db-p2p';
import { conformancePieceId, runPieceStoreConformance, type PieceStoreHarness } from '@optimystic/db-p2p/testing/conformance';
import { loadOrCreateRNPeerKey } from '../src/identity.js';
import { LevelDBKVStore } from '../src/leveldb-kv-store.js';
import type { LevelDBLike } from '../src/leveldb-like.js';
import { PIECE_LIST_PAGE, LevelDBPieceStore } from '../src/leveldb-piece-store.js';
import { LevelDBJournalStore, LevelDBRawStorage } from '../src/leveldb-storage.js';
import { TAG_PIECES, commitProofKey, encodePieceSize, pieceSizeKey } from '../src/keys.js';
import { openAtPath, openTestDb } from './classic-level-driver.js';

// A file-backed database in its own temp dir per case, so reopen can close the handle (LevelDB holds
// a lock on its directory) and open the same path again.
runPieceStoreConformance('LevelDB pieces', async (): Promise<PieceStoreHarness> => {
	const handle = await openTestDb();
	let reopened: LevelDBLike | undefined;
	return {
		store: new LevelDBPieceStore(handle.db),
		reopen: async () => {
			await handle.db.close();
			reopened = await openAtPath(handle.path);
			return new LevelDBPieceStore(reopened);
		},
		cleanup: async () => {
			await reopened?.close();
			await handle.cleanup();
		},
	};
}, { persistent: true });

describe('LevelDB pieces listing', () => {
	it('lists every id once across several pages', async () => {
		const handle = await openTestDb();
		try {
			// Two and a half pages of size keys, written directly in one batch: a put per piece would
			// only slow the case down, and listing reads size keys alone.
			const count = PIECE_LIST_PAGE * 2 + PIECE_LIST_PAGE / 2;
			const batch = handle.db.batch();
			for (let i = 1; i <= count; i++) batch.put(pieceSizeKey(`piece-${String(i).padStart(6, '0')}`), encodePieceSize(1));
			await batch.write();

			const ids: string[] = [];
			for await (const id of new LevelDBPieceStore(handle.db).list()) ids.push(id);
			expect(ids.length).to.equal(count);
			expect(new Set(ids).size).to.equal(count);
		} finally {
			await handle.cleanup();
		}
	});
});

/** The handle, with the key of every entry an `iterator` scan read a value for recorded. */
function spyValueReads(db: LevelDBLike): { db: LevelDBLike; valueKeys: Uint8Array[] } {
	const valueKeys: Uint8Array[] = [];
	const spied: LevelDBLike = {
		canSync: db.canSync,
		get: key => db.get(key),
		getText: key => db.getText(key),
		batch: () => db.batch(),
		textIterator: options => db.textIterator(options),
		close: () => db.close(),
		iterator: options => {
			const inner = db.iterator(options);
			return {
				async next() {
					const entry = await inner.next();
					if (entry && !options?.keys) valueKeys.push(entry[0]);
					return entry;
				},
				close: () => inner.close(),
			};
		},
	};
	return { db: spied, valueKeys };
}

describe('LevelDB pieces beside every other store', () => {
	it('pieces stay out of every other listing, and the block store counts their bytes once without reading them', async () => {
		const handle = await openTestDb();
		const { db, valueKeys } = spyValueReads(handle.db);
		const storage = new LevelDBRawStorage(db);
		const kv = new LevelDBKVStore(db);
		try {
			const block = 'block-1' as BlockId;
			const actionId = 'action-1' as ActionId;
			await storage.saveMetadata(block, { ranges: [[1, 2]], latest: { rev: 1, actionId } });
			await storage.saveRevision(block, 1, actionId);
			await storage.saveMaterializedBlock(block, actionId, { header: { id: block, type: 'test', collectionId: 'collection-1' as BlockId } });
			await storage.flush();
			// After the flush, which ran the journal's recovery and applied the group, so this record
			// stays in the journal as the one a crash would leave.
			const journal = new LevelDBJournalStore(db);
			const record = { seq: 1000, entries: [{ key: { store: 'metadata', blockId: 'journaled' as BlockId } as const, value: new Uint8Array([1]) }] };
			await journal.appendJournal(record);
			await db.batch().put(commitProofKey('message-hash-1'), new TextEncoder().encode('{}')).write();
			await kv.set('entry', 'value');
			await kv.flush();
			await loadOrCreateRNPeerKey(db);

			const pieces = new LevelDBPieceStore(db);
			const before = await storage.getApproximateBytesUsed();
			const stored = [new Uint8Array(50_000).fill(1), new Uint8Array(70_000).fill(2)];
			const ids = await Promise.all(stored.map(bytes => conformancePieceId(bytes)));
			for (const [i, bytes] of stored.entries()) await pieces.put(ids[i]!, bytes);

			valueKeys.length = 0;
			const after = await storage.getApproximateBytesUsed();
			const pieceBytes = stored[0]!.byteLength + stored[1]!.byteLength;
			expect(after - before, 'growth of the block store\'s figure').to.be.within(pieceBytes, 2 * pieceBytes - 1);
			const pieceBytesRead = valueKeys.filter(key => key[0] === TAG_PIECES && key[1] === 0x00);
			expect(pieceBytesRead, 'piece values the measurement read').to.deep.equal([]);
			expect(blockStoreCountsPieces(storage, pieces)).to.equal(true);

			const listed: string[] = [];
			for await (const id of pieces.list()) listed.push(id);
			expect(listed.sort()).to.deep.equal([...ids].sort());
			const blocks: string[] = [];
			for await (const id of storage.listBlockIds()) blocks.push(id);
			expect(blocks).to.deep.equal([block]);
			expect(await kv.list('')).to.deep.equal(['entry']);
			expect((await journal.readJournal()).records).to.deep.equal([record]);
		} finally {
			await kv.close();
			await storage.close();
			await handle.cleanup();
		}
	});
});
