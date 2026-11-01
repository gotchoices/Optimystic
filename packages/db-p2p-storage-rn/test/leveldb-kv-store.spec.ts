import { expect } from 'chai';
import { LevelDBKVStore } from '../src/leveldb-kv-store.js';
import { TAG_KV } from '../src/keys.js';
import { openTestDb, type TestDbHandle } from './classic-level-driver.js';
import { spyBatchWrites } from './support/spy-batch-writes.js';

describe('LevelDBKVStore', () => {
	let handle: TestDbHandle;
	let kv: LevelDBKVStore;

	beforeEach(async () => {
		handle = await openTestDb();
		kv = new LevelDBKVStore(handle.db, 'test:');
	});

	afterEach(async () => {
		// Closed before the handle: a write still held would otherwise be flushed by the idle timer onto a closed handle.
		await kv.close();
		await handle.cleanup();
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
		const other = new LevelDBKVStore(handle.db, 'other-prefix:');
		try {
			await kv.set('shared', 'mine');
			await other.set('shared', 'theirs');
			await kv.flush();
			await other.flush();

			const mine = await kv.list('');
			expect(mine).to.deep.equal(['shared']);
			expect(await kv.get('shared')).to.equal('mine');
			expect(await other.get('shared')).to.equal('theirs');
		} finally {
			await other.close();
		}
	});

	it('list() returns [] when no keys match', async () => {
		await kv.set('a', '1');
		expect(await kv.list('z/')).to.deep.equal([]);
	});

	it('flush() commits the writes since the last flush as one synced batch on the kv tag', async () => {
		const { db: spied, writes } = spyBatchWrites(handle.db);
		const store = new LevelDBKVStore(spied, 'test:');
		try {
			await store.set('a', '1');
			await store.set('b', '2');
			await store.delete('a');
			expect(writes, 'nothing reaches the store before a flush').to.deep.equal([]);
			expect(await store.get('b'), 'the overlay serves the write meanwhile').to.equal('2');

			await store.flush();
			expect(writes).to.deep.equal([{ sync: true, tags: [TAG_KV] }]);
			expect(await kv.get('b'), 'read back by a store with an empty overlay').to.equal('2');
			expect(await kv.get('a'), 'the delete landed in the same batch').to.equal(undefined);
			await store.flush();
			expect(writes.length, 'nothing written since the last flush, nothing committed').to.equal(1);
		} finally {
			await store.close();
		}
	});
});
