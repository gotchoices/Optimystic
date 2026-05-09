import 'fake-indexeddb/auto';
import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { loadOrCreateBrowserPeerKey } from '../src/identity.js';
import { openOptimysticWebDb, type OptimysticWebDBHandle } from '../src/db.js';

let dbCounter = 0;
async function freshDb(): Promise<OptimysticWebDBHandle> {
	return openOptimysticWebDb(`optimystic-test-id-${++dbCounter}-${Math.random().toString(36).slice(2)}`);
}

describe('loadOrCreateBrowserPeerKey', () => {
	it('generates a key on first call and persists it', async () => {
		const db = await freshDb();
		try {
			const key1 = await loadOrCreateBrowserPeerKey(db);
			const key2 = await loadOrCreateBrowserPeerKey(db);

			expect(peerIdFromPrivateKey(key1).toString()).to.equal(peerIdFromPrivateKey(key2).toString());
		} finally {
			db.close();
		}
	});

	it('persists the key as a Uint8Array under the given keyName', async () => {
		const db = await freshDb();
		try {
			await loadOrCreateBrowserPeerKey(db, 'my-key');
			const stored = await db.get('kv', 'my-key');
			expect(stored).to.be.instanceOf(Uint8Array);
		} finally {
			db.close();
		}
	});

	it('survives a close+reopen cycle (simulating a page reload)', async () => {
		const dbName = `optimystic-test-id-reload-${Math.random().toString(36).slice(2)}`;
		const db1 = await openOptimysticWebDb(dbName);
		const key1 = await loadOrCreateBrowserPeerKey(db1);
		const peerId1 = peerIdFromPrivateKey(key1).toString();
		db1.close();

		const db2 = await openOptimysticWebDb(dbName);
		const key2 = await loadOrCreateBrowserPeerKey(db2);
		const peerId2 = peerIdFromPrivateKey(key2).toString();
		db2.close();

		expect(peerId2).to.equal(peerId1);
	});

	it('different keyNames yield different identities', async () => {
		const db = await freshDb();
		try {
			const a = await loadOrCreateBrowserPeerKey(db, 'a');
			const b = await loadOrCreateBrowserPeerKey(db, 'b');
			expect(peerIdFromPrivateKey(a).toString()).to.not.equal(peerIdFromPrivateKey(b).toString());
		} finally {
			db.close();
		}
	});
});
