import { expect } from 'chai';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockMetadata } from '../src/storage/struct.js';
import type { BlockId, ActionId, IBlock, BlockHeader, Transform } from '@optimystic/db-core';

const makeMeta = (rev: number): BlockMetadata => ({ ranges: [[1, rev]], latest: { rev, actionId: `tx:a${rev}` as ActionId } });

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string, data?: Record<string, unknown>): IBlock => ({
	header: makeHeader(id),
	...data
});

describe('MemoryRawStorage clone-on-store invariants', () => {
	let storage: MemoryRawStorage;

	beforeEach(() => {
		storage = new MemoryRawStorage();
	});

	it('saveTransaction stores a clone — a later caller mutation does not corrupt stored state', async () => {
		const blockId = 'block-1' as BlockId;
		const actionId = 'action-1' as ActionId;
		const transform: Transform = { insert: makeBlock('block-1', { items: ['original'] }) };

		await storage.saveTransaction(blockId, actionId, transform);

		// Mutate the caller's reference AFTER saving — this must not reach stored state.
		(transform.insert as IBlock & { items: string[] }).items.push('mutated');
		transform.delete = true;

		const stored = await storage.getTransaction(blockId, actionId);
		expect(stored).to.not.equal(undefined);
		expect((stored!.insert as IBlock & { items: string[] }).items).to.deep.equal(['original']);
		expect(stored!.delete).to.equal(undefined);
	});
});

describe('MemoryRawStorage listBlockIds', () => {
	let storage: MemoryRawStorage;

	beforeEach(() => {
		storage = new MemoryRawStorage();
	});

	async function collect(): Promise<Set<string>> {
		const out = new Set<string>();
		for await (const id of storage.listBlockIds()) out.add(id);
		return out;
	}

	it('yields exactly the block ids that have metadata', async () => {
		await storage.saveMetadata('b1' as BlockId, makeMeta(1));
		await storage.saveMetadata('b2' as BlockId, makeMeta(2));
		await storage.saveMetadata('b3' as BlockId, makeMeta(3));

		expect(await collect()).to.deep.equal(new Set(['b1', 'b2', 'b3']));
	});

	it('excludes a pending-only block (no metadata)', async () => {
		await storage.saveMetadata('committed' as BlockId, makeMeta(1));
		// Pended but never committed → no metadata record → must not be enumerated.
		await storage.savePendingTransaction('pending-only' as BlockId, 'tx:x' as ActionId, { delete: true });

		expect(await collect()).to.deep.equal(new Set(['committed']));
	});

	it('yields nothing for an empty store', async () => {
		expect(await collect()).to.deep.equal(new Set());
	});
});
