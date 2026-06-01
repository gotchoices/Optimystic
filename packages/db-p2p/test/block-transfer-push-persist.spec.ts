import { expect } from 'chai';
import type { IBlock, BlockId, BlockHeader } from '@optimystic/db-core';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockTransferService, type BlockTransferRequest } from '../src/cluster/block-transfer-service.js';

/**
 * Reproduction for: "Churn re-replication validates but never persists pushed blocks".
 *
 * spread-on-churn pushes blocks to new owners via BlockTransferClient.pushBlocks.
 * The receiving BlockTransferService.handlePush must persist accepted blocks so the
 * new owner actually holds a durable replica. Today it only validates that the wire
 * payload is parseable JSON and echoes the id back as accepted — nothing is stored.
 */

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader
});

// SKIPPED: this is the reproduction / acceptance test for ticket
// `optimystic-churn-rereplication-persist-handlepush`. It currently fails because
// handlePush does not persist. The implement stage MUST remove `.skip` and make it pass.
describe.skip('BlockTransferService.handlePush persistence (repro)', () => {
	let rawStorage: MemoryRawStorage;
	let repo: StorageRepo;
	let service: BlockTransferService;

	beforeEach(() => {
		rawStorage = new MemoryRawStorage();
		repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
		service = new BlockTransferService(
			{
				registrar: { handle: async () => {}, unhandle: async () => {} },
				repo
			}
		);
	});

	it('persists pushed blocks so the new owner can serve them after churn', async () => {
		const blockId = 'block-churn-1';
		const block = makeBlock(blockId);
		const blockData = Buffer.from(JSON.stringify(block)).toString('base64');

		const request: BlockTransferRequest = {
			type: 'push',
			blockIds: [blockId],
			reason: 'replication',
			blockData: { [blockId]: blockData }
		};

		// Drive the push handler directly (private, exercised via the protocol handler in prod).
		const response = await (service as any).handlePush(request);

		// The handler currently reports the block as accepted...
		expect(response.blocks).to.have.property(blockId);
		expect(response.missing).to.deep.equal([]);

		// ...but the receiving node retains nothing: the resilience mechanism reported
		// success while leaving the data unreplicated.
		const result = await repo.get({ blockIds: [blockId] });
		expect(result[blockId]?.block, 'pushed block must be durably persisted on the new owner').to.not.be.undefined;
		expect(result[blockId]?.block?.header.id).to.equal(blockId);
	});
});
