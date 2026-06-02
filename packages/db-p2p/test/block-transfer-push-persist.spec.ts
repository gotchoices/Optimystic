import { expect } from 'chai';
import type { IBlock, BlockId, BlockHeader } from '@optimystic/db-core';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockTransferService, type BlockTransferRequest, type IBlockReplicaStore } from '../src/cluster/block-transfer-service.js';

/**
 * Acceptance + regression coverage for: "Churn re-replication validates but never
 * persists pushed blocks".
 *
 * spread-on-churn pushes blocks to new owners via BlockTransferClient.pushBlocks.
 * The receiving BlockTransferService.handlePush must persist accepted blocks so the
 * new owner actually holds a durable replica. The handler is exercised directly here
 * (it is private, driven via the protocol handler in production).
 */

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader
});

const pushReq = (
	blockId: string,
	block: IBlock,
	meta?: { rev: number; actionId: string }
): BlockTransferRequest => ({
	type: 'push',
	blockIds: [blockId],
	reason: 'replication',
	blockData: { [blockId]: Buffer.from(JSON.stringify(block)).toString('base64') },
	...(meta ? { blockMeta: { [blockId]: meta } } : {})
});

describe('BlockTransferService.handlePush persistence', () => {
	let rawStorage: MemoryRawStorage;
	let repo: StorageRepo;
	let service: BlockTransferService;

	beforeEach(() => {
		rawStorage = new MemoryRawStorage();
		repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
		service = new BlockTransferService({
			registrar: { handle: async () => {}, unhandle: async () => {} },
			repo
		});
	});

	it('persists pushed blocks so the new owner can serve them after churn', async () => {
		const blockId = 'block-churn-1';
		const block = makeBlock(blockId);

		// Drive the push handler directly (private, exercised via the protocol handler in prod).
		const response = await (service as any).handlePush(pushReq(blockId, block));

		// The handler reports the block as accepted...
		expect(response.blocks).to.have.property(blockId);
		expect(response.missing).to.deep.equal([]);

		// ...AND the receiving node now retains a durable, servable replica.
		const result = await repo.get({ blockIds: [blockId] });
		expect(result[blockId]?.block, 'pushed block must be durably persisted on the new owner').to.not.be.undefined;
		expect(result[blockId]?.block?.header.id).to.equal(blockId);
	});

	it('uses the source revision metadata for the replica latest when provided', async () => {
		const blockId = 'block-churn-meta';
		const block = makeBlock(blockId);

		const response = await (service as any).handlePush(pushReq(blockId, block, { rev: 7, actionId: 'a7' }));
		expect(response.blocks).to.have.property(blockId);

		const result = await repo.get({ blockIds: [blockId] });
		expect(result[blockId]?.block?.header.id).to.equal(blockId);
		// latest mirrors the source rather than being fabricated as rev 1.
		expect(result[blockId]?.state?.latest).to.deep.equal({ rev: 7, actionId: 'a7' });
	});

	it('is idempotent for a re-push with the same source metadata', async () => {
		const blockId = 'block-churn-idem';
		const block = makeBlock(blockId);
		const meta = { rev: 3, actionId: 'a3' };

		const r1 = await (service as any).handlePush(pushReq(blockId, block, meta));
		const r2 = await (service as any).handlePush(pushReq(blockId, block, meta));

		expect(r1.blocks).to.have.property(blockId);
		expect(r2.blocks).to.have.property(blockId);
		expect(r2.missing).to.deep.equal([]);

		const result = await repo.get({ blockIds: [blockId] });
		expect(result[blockId]?.block?.header.id).to.equal(blockId);
		expect(result[blockId]?.state?.latest).to.deep.equal(meta);
	});

	it('does not downgrade latest when an older revision arrives (monotonic guard)', async () => {
		const blockId = 'block-churn-mono';
		const block = makeBlock(blockId);

		// Receive rev 5 first, then a stale rev 1 push for the same block.
		await (service as any).handlePush(pushReq(blockId, block, { rev: 5, actionId: 'a5' }));
		const stale = await (service as any).handlePush(pushReq(blockId, block, { rev: 1, actionId: 'a1' }));

		// The stale push is still "accepted" (the block is durably present), but latest holds at 5.
		expect(stale.blocks).to.have.property(blockId);
		expect(stale.missing).to.deep.equal([]);

		const result = await repo.get({ blockIds: [blockId] });
		expect(result[blockId]?.block?.header.id).to.equal(blockId);
		expect(result[blockId]?.state?.latest).to.deep.equal({ rev: 5, actionId: 'a5' });
	});

	it('reports a block as missing (not accepted) when persistence fails', async () => {
		const blockId = 'block-churn-fail';
		const block = makeBlock(blockId);

		// A repo whose saveReplicatedBlock always throws (e.g. disk failure).
		const throwingRepo = {
			get: async () => ({}),
			pend: async () => ({ success: false }),
			commit: async () => ({ success: true }),
			cancel: async () => {},
			saveReplicatedBlock: async () => { throw new Error('disk full'); }
		} as unknown as IBlockReplicaStore;

		const failService = new BlockTransferService({
			registrar: { handle: async () => {}, unhandle: async () => {} },
			repo: throwingRepo
		});

		const response = await (failService as any).handlePush(pushReq(blockId, block));

		// A block that fails to persist must NOT be reported accepted, so the sender
		// does not falsely treat it as replicated.
		expect(response.blocks).to.not.have.property(blockId);
		expect(response.missing).to.deep.equal([blockId]);
	});

	it('reports a block as missing when the wire payload is not parseable', async () => {
		const blockId = 'block-churn-baddata';
		const request: BlockTransferRequest = {
			type: 'push',
			blockIds: [blockId],
			reason: 'replication',
			// Valid base64, but the decoded bytes are not JSON.
			blockData: { [blockId]: Buffer.from('not json', 'utf8').toString('base64') }
		};

		const response = await (service as any).handlePush(request);
		expect(response.blocks).to.not.have.property(blockId);
		expect(response.missing).to.deep.equal([blockId]);
	});

	it('reports missing (and does not poison storage) when the payload is valid JSON but not a block', async () => {
		const blockId = 'block-churn-null';
		const request: BlockTransferRequest = {
			type: 'push',
			blockIds: [blockId],
			reason: 'replication',
			// `null` is valid JSON, so the parse guard alone would let it through; persisting
			// it would seed metadata with no materialization and make every later get throw.
			blockData: { [blockId]: Buffer.from('null', 'utf8').toString('base64') }
		};

		const response = await (service as any).handlePush(request);
		expect(response.blocks).to.not.have.property(blockId);
		expect(response.missing).to.deep.equal([blockId]);

		// Storage was not poisoned: get returns empty rather than throwing.
		const result = await repo.get({ blockIds: [blockId] });
		expect(result[blockId]?.block ?? undefined).to.be.undefined;
	});
});
