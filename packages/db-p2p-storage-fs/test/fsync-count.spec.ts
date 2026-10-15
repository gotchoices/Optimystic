import assert from 'node:assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageRepo } from '@optimystic/db-p2p';
import type { BlockId, ActionId, IBlock, Transforms } from '@optimystic/db-core';
import { trackedStores } from './support/tracked-stores.js';
import { interceptHandleSync } from './support/fs-injection.js';

// ---------------------------------------------------------------------------
// The contract GitHub #37 asked for: a node's write group costs the disk one sync, however many
// blocks it touches. Every handle opened through `fs.promises.open` counts its `sync` calls — the
// log's own handle included, since it is opened on the store's first operation, after the counter
// is installed — and `StorageRepo` flushes once at the end of every group.
// ---------------------------------------------------------------------------

const makeBlock = (id: string): IBlock => ({ header: { id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId } });

const insertTransforms = (blockIds: BlockId[]): Transforms => ({
	inserts: Object.fromEntries(blockIds.map(id => [id, makeBlock(id)])),
	updates: {},
	deletes: [],
});

describe('FileRawStorage syncs the disk once per write group', () => {
	let base: string;
	let syncs = 0;
	let restore: () => void;
	const stores = trackedStores();

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-fsync-count-'));
		syncs = 0;
		restore = interceptHandleSync(() => { syncs += 1; });
	});

	afterEach(async () => {
		await stores.closeAll();
		restore();
		await fs.rm(base, { recursive: true, force: true });
	});

	/** A repo over an opened store: the open's own syncs (log header, directory) are not the group's. */
	async function openRepo(): Promise<StorageRepo> {
		const storage = stores.open(base);
		const repo = new StorageRepo(storage);
		await storage.getMetadata('warm-up' as BlockId);
		syncs = 0;
		return repo;
	}

	for (const n of [1, 8]) {
		it(`a pend and a commit touching ${n} block(s) each issue at most one sync`, async () => {
			const repo = await openRepo();
			const blockIds = Array.from({ length: n }, (_, i) => `block-${i}` as BlockId);
			const actionId = 'action-1' as ActionId;

			const pended = await repo.pend({ actionId, transforms: insertTransforms(blockIds), policy: 'c' });
			assert.strictEqual(pended.success, true);
			assert.ok(syncs <= 1, `pend of ${n} block(s) issued ${syncs} syncs`);

			syncs = 0;
			const committed = await repo.commit({ actionId, blockIds, tailId: blockIds[0]!, rev: 1 });
			assert.strictEqual(committed.success, true, JSON.stringify(committed));
			assert.ok(syncs <= 1, `commit of ${n} block(s) issued ${syncs} syncs`);
		});
	}

	it('a refused pend issues none', async () => {
		const repo = await openRepo();
		const blockId = 'contended' as BlockId;
		await repo.pend({ actionId: 'first' as ActionId, transforms: insertTransforms([blockId]), policy: 'c' });

		syncs = 0;
		const refused = await repo.pend({ actionId: 'second' as ActionId, transforms: insertTransforms([blockId]), policy: 'f' });
		assert.strictEqual(refused.success, false);
		assert.strictEqual(syncs, 0, 'a group that wrote nothing costs no sync');
	});
});
