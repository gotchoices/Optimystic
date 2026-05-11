import { expect } from 'chai';
import { SqliteKVStore } from '../src/sqlite-kv-store.js';
import { openTestDb } from './node-sqlite-driver.js';
import type { SqliteDb } from '../src/db.js';

describe('SqliteKVStore', () => {
	let db: SqliteDb;
	let kv: SqliteKVStore;

	beforeEach(async () => {
		db = await openTestDb();
		kv = new SqliteKVStore(db, 'test:');
	});

	afterEach(async () => {
		await db.close();
	});

	it('round-trips set/get', async () => {
		await kv.set('foo', 'bar');
		expect(await kv.get('foo')).to.equal('bar');
	});

	it('returns undefined for missing keys', async () => {
		expect(await kv.get('nope')).to.equal(undefined);
	});

	it('delete() removes the key', async () => {
		await kv.set('k', 'v');
		await kv.delete('k');
		expect(await kv.get('k')).to.equal(undefined);
	});

	it('list() returns only keys under the requested prefix', async () => {
		await kv.set('coordinator/abc', '1');
		await kv.set('coordinator/def', '2');
		await kv.set('other/xyz', '3');

		const matched = await kv.list('coordinator/');
		expect(matched.sort()).to.deep.equal(['coordinator/abc', 'coordinator/def']);
	});

	it('list() does not include other instances\' keys (prefix isolation)', async () => {
		const other = new SqliteKVStore(db, 'other-prefix:');
		await kv.set('shared', 'mine');
		await other.set('shared', 'theirs');

		const mine = await kv.list('');
		expect(mine).to.deep.equal(['shared']);
		expect(await kv.get('shared')).to.equal('mine');
		expect(await other.get('shared')).to.equal('theirs');
	});

	it('list() returns [] when no keys match', async () => {
		await kv.set('a', '1');
		expect(await kv.list('z/')).to.deep.equal([]);
	});

	it('set() preserves binary identity columns on the same table', async () => {
		// Identity helper writes b_val for `peer-private-key`; KV writes s_val
		// under its prefix. The two must not clobber each other.
		await db
			.prepare('INSERT INTO kv (key, s_val, b_val) VALUES (?, NULL, ?)')
			.run('peer-private-key', new Uint8Array([1, 2, 3]));

		await kv.set('foo', 'bar');
		expect(await kv.get('foo')).to.equal('bar');

		const row = await db.prepare('SELECT b_val FROM kv WHERE key = ?').get('peer-private-key');
		expect(row?.b_val).to.be.instanceOf(Uint8Array);
		expect((row?.b_val as Uint8Array).length).to.equal(3);
	});
});
