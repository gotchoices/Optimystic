import { expect } from 'chai';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockId, ActionId, IBlock, BlockHeader, Transform } from '@optimystic/db-core';

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
