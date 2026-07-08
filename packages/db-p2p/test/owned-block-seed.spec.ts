import { expect } from 'chai';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { seedOwnedBlocksFromStorage } from '../src/owned-block-seed.js';
import type { IRawStorage } from '../src/storage/i-raw-storage.js';
import type { BlockMetadata } from '../src/storage/struct.js';
import type { BlockId, ActionId } from '@optimystic/db-core';

const makeMeta = (rev: number): BlockMetadata => ({ ranges: [[1, rev]], latest: { rev, actionId: `tx:a${rev}` as ActionId } });

async function populate(storage: MemoryRawStorage, ids: string[]): Promise<void> {
	let rev = 1;
	for (const id of ids) await storage.saveMetadata(id as BlockId, makeMeta(rev++));
}

const neverStopping = () => false;

describe('seedOwnedBlocksFromStorage', () => {
	it('adds every durable block id to the shared set', async () => {
		const storage = new MemoryRawStorage();
		await populate(storage, ['b1', 'b2', 'b3']);
		const ownedBlocks = new Set<string>();

		await seedOwnedBlocksFromStorage(storage, ownedBlocks, neverStopping);

		expect(ownedBlocks).to.deep.equal(new Set(['b1', 'b2', 'b3']));
	});

	it('excludes a pending-only block (no metadata → not enumerated)', async () => {
		const storage = new MemoryRawStorage();
		await populate(storage, ['committed']);
		await storage.savePendingTransaction('pending-only' as BlockId, 'tx:x' as ActionId, { delete: true });
		const ownedBlocks = new Set<string>();

		await seedOwnedBlocksFromStorage(storage, ownedBlocks, neverStopping);

		expect(ownedBlocks).to.deep.equal(new Set(['committed']));
	});

	it('is idempotent and unions with a pre-populated set (mirrors feed/scan overlap)', async () => {
		const storage = new MemoryRawStorage();
		await populate(storage, ['b1', 'b2']);
		// b1 already present (as if the live feed added it mid-scan); b-live is feed-only.
		const ownedBlocks = new Set<string>(['b1', 'b-live']);

		await seedOwnedBlocksFromStorage(storage, ownedBlocks, neverStopping);

		expect(ownedBlocks).to.deep.equal(new Set(['b1', 'b2', 'b-live']));
	});

	it('stops early when isStopping flips, leaving the scan partial', async () => {
		const storage = new MemoryRawStorage();
		await populate(storage, ['b1', 'b2', 'b3']);
		const ownedBlocks = new Set<string>();
		// false on the first check (b1 added), true thereafter → loop breaks before b2.
		let calls = 0;
		const isStopping = () => calls++ >= 1;

		await seedOwnedBlocksFromStorage(storage, ownedBlocks, isStopping);

		expect(ownedBlocks.size).to.equal(1);
		expect(ownedBlocks.has('b1')).to.equal(true);
	});

	it('is a no-op when the backend does not implement listBlockIds', async () => {
		const noEnum = {} as Pick<IRawStorage, 'listBlockIds'>;
		const ownedBlocks = new Set<string>();

		await seedOwnedBlocksFromStorage(noEnum, ownedBlocks, neverStopping);

		expect(ownedBlocks.size).to.equal(0);
	});

	it('yields cooperatively without dropping ids (small yieldEvery exercises the yield path)', async () => {
		const storage = new MemoryRawStorage();
		await populate(storage, ['b1', 'b2', 'b3', 'b4', 'b5']);
		const ownedBlocks = new Set<string>();

		await seedOwnedBlocksFromStorage(storage, ownedBlocks, neverStopping, 1);

		expect(ownedBlocks).to.deep.equal(new Set(['b1', 'b2', 'b3', 'b4', 'b5']));
	});
});
