import { expect } from 'chai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { loadOrCreateNSPeerKey } from '../src/identity.js';
import { openTestDb, openTestFileDb } from './node-sqlite-driver.js';

describe('loadOrCreateNSPeerKey', () => {
	it('generates a key on first call and returns it on subsequent calls', async () => {
		const db = await openTestDb();
		try {
			const key1 = await loadOrCreateNSPeerKey(db);
			const key2 = await loadOrCreateNSPeerKey(db);
			expect(peerIdFromPrivateKey(key1).toString()).to.equal(peerIdFromPrivateKey(key2).toString());
		} finally {
			await db.close();
		}
	});

	it('persists the key as a BLOB under the given keyName', async () => {
		const db = await openTestDb();
		try {
			await loadOrCreateNSPeerKey(db, 'my-key');
			const row = await db.prepare('SELECT b_val, s_val FROM kv WHERE key = ?').get('my-key');
			expect(row?.b_val).to.be.instanceOf(Uint8Array);
			expect((row?.b_val as Uint8Array).length).to.be.greaterThan(0);
			expect(row?.s_val).to.equal(null);
		} finally {
			await db.close();
		}
	});

	it('survives close+reopen on a file-backed database', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'optimystic-ns-identity-'));
		const path = join(dir, 'optimystic.sqlite');
		try {
			const db1 = await openTestFileDb(path);
			const key1 = await loadOrCreateNSPeerKey(db1);
			const peerId1 = peerIdFromPrivateKey(key1).toString();
			await db1.close();

			const db2 = await openTestFileDb(path);
			const key2 = await loadOrCreateNSPeerKey(db2);
			const peerId2 = peerIdFromPrivateKey(key2).toString();
			await db2.close();

			expect(peerId2).to.equal(peerId1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('different keyNames yield different identities', async () => {
		const db = await openTestDb();
		try {
			const a = await loadOrCreateNSPeerKey(db, 'a');
			const b = await loadOrCreateNSPeerKey(db, 'b');
			expect(peerIdFromPrivateKey(a).toString()).to.not.equal(peerIdFromPrivateKey(b).toString());
		} finally {
			await db.close();
		}
	});
});
