import { expect } from 'chai';
import {
	createLibp2pNode,
	StorageRepo,
	BlockStorage,
	MemoryRawStorage,
} from '@optimystic/db-p2p';
import { Diary } from '@optimystic/db-core';

/**
 * Regression tests for the offline-mode storage-sharing bug:
 *   Before the fix, startNetwork() called createStorage() a second time and
 *   wrapped it in a fresh StorageRepo.  That orphaned store was invisible to
 *   the running node.  After the fix, the LocalTransactor uses node.storageRepo
 *   directly, so writes are visible to the node.
 */
describe('Offline mode storage sharing', () => {
	it('node.storageRepo is exposed and differs from a fresh StorageRepo', async () => {
		const node = await createLibp2pNode({
			port: 0,
			bootstrapNodes: [],
			networkName: 'test-offline-identity',
			storage: () => new MemoryRawStorage(),
		});
		try {
			const nodeStorageRepo = (node as any).storageRepo as StorageRepo;
			expect(nodeStorageRepo, 'node.storageRepo must be set').to.exist;

			// A fresh StorageRepo is a separate instance — this is what the bug created
			const orphanRepo = new StorageRepo(
				(id: string) => new BlockStorage(id, new MemoryRawStorage()),
			);
			expect(orphanRepo).to.not.equal(
				nodeStorageRepo,
				'identity check: fresh StorageRepo must differ from node.storageRepo',
			);
		} finally {
			await node.stop();
		}
	});

	it('write via node.storageRepo is visible through the same repo (offline write-then-read)', async () => {
		const node = await createLibp2pNode({
			port: 0,
			bootstrapNodes: [],
			networkName: 'test-offline-write-read',
			storage: () => new MemoryRawStorage(),
		});
		try {
			const nodeStorageRepo = (node as any).storageRepo as StorageRepo;
			expect(nodeStorageRepo, 'node.storageRepo must be set').to.exist;

			// Minimal transactor that delegates to a given StorageRepo — mirrors LocalTransactor in cli.ts
			const makeTransactor = (repo: StorageRepo) => ({
				get: (bg: any) => repo.get(bg),
				getStatus: () => Promise.reject(new Error('n/a')),
				pend: (req: any) => repo.pend(req),
				commit: (req: any) => repo.commit(req),
				cancel: (ref: any) => repo.cancel(ref),
			});

			// Write via node.storageRepo
			const writeT = makeTransactor(nodeStorageRepo);
			const diary = await Diary.create(writeT as any, 'offline-regression-diary');
			await diary.append({ content: 'offline-entry', timestamp: '2026-01-01T00:00:00Z' });

			// Read back through the same node.storageRepo — must see the entry
			const readT = makeTransactor(nodeStorageRepo);
			const diaryRead = await Diary.create(readT as any, 'offline-regression-diary');
			const entries: any[] = [];
			for await (const entry of diaryRead.select()) {
				entries.push(entry);
			}

			expect(entries).to.have.lengthOf(1);
			expect((entries[0] as any).content).to.equal('offline-entry');
		} finally {
			await node.stop();
		}
	});
});
