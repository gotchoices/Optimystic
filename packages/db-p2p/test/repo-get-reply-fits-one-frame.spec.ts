import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Connection, PeerId, Stream, StreamHandler } from '@libp2p/interface';
import type { ActionId, BlockHeader, BlockId, IBlock, IPeerNetwork } from '@optimystic/db-core';
import { jsonEncodedBytes } from '@optimystic/db-core';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { RepoService } from '../src/repo/service.js';
import { RepoClient } from '../src/repo/client.js';
import { MAX_BLOCK_MESSAGE_BYTES } from '../src/protocol-limits.js';
import { makeLinkedPair } from './support/linked-duplex-pair.js';

/**
 * A remote read answers every block it names in one repo-protocol frame, which the reader's decoder
 * refuses past `MAX_BLOCK_MESSAGE_BYTES`. Two blocks that each fit a frame but not together used to
 * fail the whole read. Driven through the registered stream handler on a linked duplex pair, so the
 * client's encode, the service's decode, packing and encode, and the client's decode all run for real.
 */

const BLOCK_BYTES = 5 * 1024 * 1024;

/** A block whose JSON encodes to exactly `bytes`, padded with an ASCII payload (one byte a character). */
const makeBlockOfEncodedSize = (id: string, bytes: number): IBlock => {
	const block = { header: { id: id as BlockId, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader, payload: '' };
	return { ...block, payload: 'x'.repeat(bytes - jsonEncodedBytes(block)) } as IBlock;
};

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

/** A real `RepoService` over `repo`, reached through a peer network whose every `connect` is one linked pair to its handler. */
function wireService(repo: StorageRepo, peerId: PeerId) {
	let handler: StreamHandler | undefined;
	const registrar = {
		handle: async (_protocol: string, h: StreamHandler) => { handler = h; },
		unhandle: async () => { handler = undefined; },
	};
	const service = new RepoService({ registrar, repo, peerId });
	let connects = 0;
	const peerNetwork = {
		async connect() {
			connects++;
			const { clientStream, serverStream } = makeLinkedPair();
			// Run the handler concurrently, as libp2p does; no connection means no authenticated asker.
			void Promise.resolve().then(() => handler?.(serverStream as unknown as Stream, undefined as unknown as Connection));
			return clientStream;
		},
	};
	return { service, peerNetwork, connects: () => connects };
}

describe('a remote get reply fits one frame', () => {
	it('returns both blocks of a two-block get whose blocks together exceed the frame', async function () {
		this.timeout(30_000);
		const repo = new StorageRepo(new MemoryRawStorage());
		const blocks = {
			'get-big-a': makeBlockOfEncodedSize('get-big-a', BLOCK_BYTES),
			'get-big-b': makeBlockOfEncodedSize('get-big-b', BLOCK_BYTES),
		};
		expect(2 * BLOCK_BYTES, 'the two blocks must outgrow one frame together').to.be.greaterThan(MAX_BLOCK_MESSAGE_BYTES);
		for (const [blockId, block] of Object.entries(blocks)) {
			await repo.saveReplicatedBlock(blockId as BlockId, block, { rev: 1, actionId: 'action-1' as ActionId });
		}

		const peerId = await makePeerId();
		const { service, peerNetwork, connects } = wireService(repo, peerId);
		await service.start();
		try {
			const client = RepoClient.create(peerId, peerNetwork as unknown as IPeerNetwork);
			const results = await client.get({ blockIds: Object.keys(blocks) }, { expiration: Date.now() + 25_000 });

			for (const [blockId, block] of Object.entries(blocks)) {
				expect(results[blockId]?.block?.header.id).to.equal(blockId);
				expect(jsonEncodedBytes(results[blockId]?.block), `${blockId} arrives whole`).to.equal(jsonEncodedBytes(block));
				expect(results[blockId], 'no left-out entry reaches the caller').to.not.have.property('leftOut');
			}
			expect(connects(), 'one reply carried one block, a second round the other').to.equal(2);
		} finally {
			await service.stop();
		}
	});
});
