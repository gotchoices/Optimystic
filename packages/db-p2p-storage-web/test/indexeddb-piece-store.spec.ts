// Polyfill IndexedDB into the Node test environment before importing `idb`.
import 'fake-indexeddb/auto';
import { expect } from 'chai';
import { conformancePieceId, runPieceStoreConformance, type PieceStoreHarness } from '@optimystic/db-p2p/testing/conformance';
import { openOptimysticWebDb } from '../src/db.js';
import { IndexedDBPieceStore } from '../src/indexeddb-piece-store.js';

let dbCounter = 0;

function freshDbName(): string {
	return `optimystic-idb-pieces-test-${++dbCounter}-${Math.random().toString(36).slice(2)}`;
}

// `fake-indexeddb` honours `durability` without advertising it; see `supportsStrictDurability`.
const STRICT = { strictDurability: true } as const;

// A fresh, uniquely-named database per case; reopen closes the handle and opens the same name again
// through the package's own opener.
runPieceStoreConformance('IndexedDB pieces', async (): Promise<PieceStoreHarness> => {
	const name = freshDbName();
	let db = await openOptimysticWebDb(name);
	return {
		store: new IndexedDBPieceStore(db, STRICT),
		reopen: async () => {
			db.close();
			db = await openOptimysticWebDb(name);
			return new IndexedDBPieceStore(db, STRICT);
		},
		cleanup: async () => {
			db.close();
		}
	};
}, { persistent: true });

describe('IndexedDB pieces specifics', () => {
	// Structured clone stores a typed array's whole buffer, so without the copy in `put` this piece
	// would occupy 1 MiB and read back as a 1 KiB view into it.
	it('a piece handed as a view into a larger buffer is stored at its own length', async () => {
		const db = await openOptimysticWebDb(freshDbName());
		try {
			const store = new IndexedDBPieceStore(db, STRICT);
			const buffer = new Uint8Array(1024 * 1024);
			for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 7) & 0xff;
			const view = buffer.subarray(4096, 4096 + 1024);
			const id = await conformancePieceId(view);

			await store.put(id, view);

			const read = (await store.get(id))!;
			expect(read.byteLength).to.equal(1024);
			expect(read.buffer.byteLength).to.equal(1024);
			expect(Array.from(read)).to.deep.equal(Array.from(view));
			expect(await store.bytesUsed()).to.equal(1024);
		} finally {
			db.close();
		}
	});
});
