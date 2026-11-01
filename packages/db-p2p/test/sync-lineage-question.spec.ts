import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { ActionId, ActionRev, BlockId, IBlock } from '@optimystic/db-core';
import { SyncService } from '../src/sync/service.js';
import { SyncClient } from '../src/sync/client.js';
import type { SyncRequest } from '../src/sync/protocol.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { lineageFromSyncResponse } from '../src/storage/block-archive.js';
import { makeLinkedPair } from './support/linked-duplex-pair.js';

/**
 * The lineage question on the sync protocol (`SyncRequest.lineageOf`), asked by a real `SyncClient`
 * of a real `SyncService` over a `StorageRepo`, through the service's registered handler: the answer
 * is the serving node's own verdict from its revision index, and the asker's projection reads an
 * answer that carries none as `unknown`.
 */

const BLOCK = 'block-lineage' as BlockId;
const HELD: ActionRev = { rev: 5, actionId: 'action-5' as ActionId };

const makeBlock = (): IBlock => ({
	header: { id: BLOCK, type: 'test', collectionId: 'collection-1' as BlockId }
} as IBlock);

/** A `StorageRepo` holding `BLOCK` at {@link HELD}, landed through the real pend and commit path. */
const repoHoldingBlock = async (): Promise<StorageRepo> => {
	const repo = new StorageRepo(new MemoryRawStorage());
	const pended = await repo.pend({
		actionId: HELD.actionId,
		transforms: { inserts: { [BLOCK]: makeBlock() }, updates: {}, deletes: [] },
		rev: HELD.rev,
		policy: 'c'
	});
	expect(pended.success).to.equal(true);
	const committed = await repo.commit({ actionId: HELD.actionId, blockIds: [BLOCK], tailId: BLOCK, rev: HELD.rev });
	expect(committed.success).to.equal(true);
	return repo;
};

/** A client whose every request reaches `repo`'s sync service through the service's registered handler. */
const clientOf = async (repo: StorageRepo): Promise<{ ask: (request: SyncRequest) => ReturnType<SyncClient['requestBlock']> }> => {
	let handler: ((stream: unknown) => void) | undefined;
	const registrar = {
		handle: async (_protocol: string, h: (stream: unknown) => void) => { handler = h; },
		unhandle: async () => { handler = undefined; }
	};
	await new SyncService({ registrar, repo }).start();
	const peerNetwork = {
		async connect() {
			const { clientStream, serverStream } = makeLinkedPair();
			handler!(serverStream);
			return clientStream;
		}
	};
	const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
	const client = new SyncClient(peerId, peerNetwork as never);
	return { ask: request => client.requestBlock(request) };
};

const lineageRequest = (target: ActionRev): SyncRequest =>
	({ blockId: BLOCK, blockIds: [BLOCK], rev: undefined, lineageOf: { [BLOCK]: target } });

describe('the lineage question on the sync protocol', () => {
	it('is answered from the serving node\'s own records, with no archive served beside it', async () => {
		const { ask } = await clientOf(await repoHoldingBlock());

		const held = await ask(lineageRequest(HELD));
		expect(lineageFromSyncResponse(held, BLOCK), 'the held pair').to.equal('contains');
		expect(held.answers?.[BLOCK]?.archive, 'a lineage-only request serves no bytes').to.equal(undefined);

		const other = await ask(lineageRequest({ rev: HELD.rev, actionId: 'action-elsewhere' as ActionId }));
		expect(lineageFromSyncResponse(other, BLOCK), 'another action at a held revision').to.equal('excludes');
	});

	it('leaves the lineage out of an answer that did not ask, which the asker reads as unknown', async () => {
		const { ask } = await clientOf(await repoHoldingBlock());

		const consult = await ask({ blockId: BLOCK, rev: undefined, held: {} });
		expect(consult.answers?.[BLOCK]?.archive, 'the consult is answered as before').to.not.equal(undefined);
		expect(consult.answers?.[BLOCK]).to.not.have.property('lineage');

		// The single-archive form is what a server on an older build sends back for a lineage request.
		const single = await ask({ blockId: BLOCK, rev: undefined });
		expect(single.answers).to.equal(undefined);
		expect(lineageFromSyncResponse(single, BLOCK)).to.equal('unknown');
	});
});
