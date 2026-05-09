import 'fake-indexeddb/auto';
import { expect } from 'chai';
import { IndexedDBKVStore } from '../src/indexeddb-kv-store.js';
import { openOptimysticWebDb, type OptimysticWebDBHandle } from '../src/db.js';

let dbCounter = 0;
async function freshDb(): Promise<OptimysticWebDBHandle> {
	return openOptimysticWebDb(`optimystic-test-kv-${++dbCounter}-${Math.random().toString(36).slice(2)}`);
}

describe('IndexedDBKVStore', () => {
	let db: OptimysticWebDBHandle;
	let kv: IndexedDBKVStore;

	beforeEach(async () => {
		db = await freshDb();
		kv = new IndexedDBKVStore(db, 'test:');
	});

	afterEach(() => {
		db.close();
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
		const other = new IndexedDBKVStore(db, 'other-prefix:');
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
});
