import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { pushable } from 'it-pushable';
import type { PeerId } from '@libp2p/interface';
import type { ActionId, CommitRequest, IBlock, BlockId, BlockHeader } from '@optimystic/db-core';
import { canonicalBlockHash } from '@optimystic/db-core';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import {
	BlockTransferService,
	BlockTransferClient,
	sourceBlockCertification,
	type BlockTransferServiceInit,
	type IBlockReplicaStore,
} from '../src/cluster/block-transfer-service.js';
import { ResponseTimeoutError, RESPONSE_TIMEOUT_ERROR_CODE } from '../src/protocol-client.js';
import { makeSignedProof } from './support/commit-proof-fixtures.js';

/**
 * Default-suite (no env gate) regression for the block-transfer request→response
 * round trip through the *registered stream handler* — not a direct handlePull/
 * handlePush call. The only other coverage of the real-stream path is the env-gated
 * churn integration test; a regression in the handler's stream framing or handler
 * signature would otherwise pass `yarn test` silently (that exact framing/signature
 * bug is what this ticket chain traces back to).
 *
 * The harness is a lightweight in-memory linked duplex pair (two it-pushable byte
 * queues) so the client's encode → the service's decode/handle/encode → the client's
 * decode all run for real, without standing up libp2p. It also covers the Gap-1
 * response-deadline: a peer that dials OK but never replies must reject the client
 * with ResponseTimeoutError inside a bounded deadline rather than hanging.
 */

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader
});

/** Mirrors `support/commit-proof-fixtures.ts`'s `PROOF_THRESHOLDS.superMajorityThreshold`. */
const SUPER_MAJORITY = 0.75;

/**
 * In-memory linked duplex pair backed by two it-pushable queues. Models the libp2p
 * stream shape (`send` / `close` / `abort` / `[Symbol.asyncIterator]`) both the
 * ProtocolClient and BlockTransferService duck-type against. `clientStream.send`
 * feeds the server's input queue (and vice versa), so what one side writes the other
 * side reads. `abort(err)` ends both queues with the error so a deadline-driven
 * `stream.abort(...)` actually unblocks a blocked read (mirrors a real libp2p stream
 * rejecting its async iterator on abort).
 */
function makeLinkedPair() {
	const toServer = pushable<any>({ objectMode: true });
	const toClient = pushable<any>({ objectMode: true });

	const clientStream = {
		send: (chunk: any) => { toServer.push(chunk); },
		close: async () => { toServer.end(); },
		abort: (err?: Error) => { toServer.end(err); toClient.end(err); },
		async *[Symbol.asyncIterator]() { yield* toClient; },
	};
	const serverStream = {
		send: (chunk: any) => { toClient.push(chunk); },
		close: async () => { toClient.end(); },
		abort: (err?: Error) => { toClient.end(err); toServer.end(err); },
		async *[Symbol.asyncIterator]() { yield* toServer; },
	};
	return { clientStream, serverStream };
}

/**
 * Wires a real BlockTransferService into a mock peerNetwork. The registrar captures
 * the stream handler the service installs at start(); each connect() builds a fresh
 * linked pair, kicks off the captured handler with the server stream concurrently
 * (NOT awaited — mirrors how libp2p invokes a stream handler), and hands the client
 * stream back to the BlockTransferClient.
 *
 * The DEFAULT here is the migration posture (`requirePushCertificate: false`), and that is a
 * deliberate, reviewed choice — not inertia (ticket: backfill-proof-on-held-revision). This spec's
 * subject is the stream path: handler registration, length-prefixed framing, and the response
 * deadline. Those tests must fail for a framing reason and nothing else, so they push a bare block
 * with no certification to build. The production posture is NOT skipped here — the two
 * `certified push:` tests below pass `{}` explicitly and run the strict default end to end, with a
 * real signed proof crossing the real wire and an uncertified control that must be refused.
 */
function makeWiredNetwork(repo: IBlockReplicaStore, init: BlockTransferServiceInit = { requirePushCertificate: false }) {
	let handler: ((stream: any) => void | Promise<void>) | undefined;
	const registrar = {
		handle: async (_proto: string, h: (stream: any) => void | Promise<void>) => { handler = h; },
		unhandle: async () => { handler = undefined; },
	};
	// Most tests here pin the STREAM path (handler wiring, framing, deadlines), not certification,
	// and their pushes carry no commit proof — so they default to the migration flag. The certified
	// end-to-end tests at the bottom pass the strict default explicitly.
	const service = new BlockTransferService(
		{ registrar: registrar as any, repo, superMajorityThreshold: SUPER_MAJORITY }, init);
	const peerNetwork = {
		async connect(_peerId: PeerId, _protocol: string, _options?: any) {
			const { clientStream, serverStream } = makeLinkedPair();
			// Run the handler concurrently; a handler error aborts its own server stream.
			void Promise.resolve().then(() => handler?.(serverStream)).catch(() => { /* isolated */ });
			return clientStream;
		},
	};
	return { service, peerNetwork };
}

describe('BlockTransfer round trip (registered handler + real stream)', () => {
	let rawStorage: MemoryRawStorage;
	let repo: StorageRepo;
	let peerId: PeerId;

	beforeEach(async () => {
		rawStorage = new MemoryRawStorage();
		repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
		peerId = await makePeerId();
	});

	it('pull returns a stored block through the handler+stream (not a direct call)', async function () {
		this.timeout(2000);
		const blockId = 'rt-pull-1';
		const block = makeBlock(blockId);
		// Seed the receiver's storage so the pull has something to serve.
		await repo.saveReplicatedBlock(blockId as BlockId, block);

		const { service, peerNetwork } = makeWiredNetwork(repo);
		await service.start();
		try {
			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const response = await client.pullBlocks([blockId], 'replication');

			expect(response.blocks, 'block returned through the stream path').to.have.property(blockId);
			expect(response.missing).to.deep.equal([]);
			// The wire bytes decode back to the seeded block.
			const decoded = JSON.parse(Buffer.from(response.blocks[blockId]!, 'base64').toString('utf8'));
			expect(decoded.header.id).to.equal(blockId);
		} finally {
			await service.stop();
		}
	});

	it('push persists the block on the receiver through the handler+stream', async function () {
		this.timeout(2000);
		const blockId = 'rt-push-1';
		const block = makeBlock(blockId);
		const blockData = new TextEncoder().encode(JSON.stringify(block));

		const { service, peerNetwork } = makeWiredNetwork(repo);
		await service.start();
		try {
			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const response = await client.pushBlocks([blockId], [blockData], 'replication');

			// The handler accepted the block (returned in `blocks`, not `missing`)...
			expect(response.blocks).to.have.property(blockId);
			expect(response.missing).to.deep.equal([]);

			// ...AND it is durably persisted on the receiver — proves saveReplicatedBlock
			// ran through the real stream path, not just that the round trip returned.
			const result = await repo.get({ blockIds: [blockId] });
			expect(result[blockId]?.block, 'pushed block durably persisted via stream path').to.not.be.undefined;
			expect(result[blockId]?.block?.header.id).to.equal(blockId);
		} finally {
			await service.stop();
		}
	});

	it('rejects with ResponseTimeoutError when the peer dials OK but never replies', async function () {
		// Tight timeout so a regression (no response deadline) fails fast instead of
		// hanging the suite until mocha's default timeout.
		this.timeout(2000);
		const blockId = 'rt-silent-1';
		const block = makeBlock(blockId);
		const blockData = new TextEncoder().encode(JSON.stringify(block));

		// A peer that accepts the connection and reads the request but never writes a
		// reply and never closes the stream. `abort` ends the (never-fed) read queue so
		// the client's deadline can actually interrupt the otherwise-blocked read.
		const silentNetwork = {
			async connect(_peerId: PeerId, _protocol: string, _options?: any) {
				const toClient = pushable<any>({ objectMode: true });
				return {
					send: (_chunk: any) => { /* swallow the request */ },
					close: async () => { /* deliberately does NOT end the read queue */ },
					abort: (err?: Error) => { toClient.end(err); },
					async *[Symbol.asyncIterator]() { yield* toClient; },
				};
			},
		};

		const client = new BlockTransferClient(peerId, silentNetwork as any);
		const t0 = Date.now();
		let caught: unknown;
		try {
			await client.pushBlocks([blockId], [blockData], 'replication', undefined, { responseTimeoutMs: 80 });
		} catch (e) {
			caught = e;
		}
		const elapsed = Date.now() - t0;
		expect(caught, 'a silent peer must not hang the caller').to.be.instanceOf(ResponseTimeoutError);
		expect((caught as ResponseTimeoutError).code).to.equal(RESPONSE_TIMEOUT_ERROR_CODE);
		// Bounded by the response deadline, not by the mocha timeout.
		expect(elapsed).to.be.lessThan(1500);
	});

	/**
	 * The producer -> wire -> receiver chain, end to end, under the STRICT default.
	 *
	 * Every other certification test drives `handlePush` with a proof object handed to it in
	 * process. That cannot catch a proof a real sender builds correctly and the wire then mangles:
	 * the push request is JSON-serialized and the block bytes are base64'd, so anything in a
	 * `BlockCommitProof` that does not survive `JSON.parse(JSON.stringify(x))` -- or a digest
	 * computed over bytes that differ after the round trip -- would verify in a unit test and be
	 * rejected by every real peer.
	 *
	 * So: a real source repo retains a real proof, `sourceBlockCertification` reads it out exactly
	 * as the two production push sites do, `BlockTransferClient.pushBlocks` puts it on the real
	 * stream, and the receiver's own certification decides.
	 */
	it('certified push: a real proof survives the wire and the strict-default receiver accepts it', async function () {
		this.timeout(10000);
		const blockId = 'rt-certified-1';
		const block = makeBlock(blockId);
		const source = { rev: 4, actionId: 'rt-a4' as ActionId };

		// --- The source peer: a real repo holding the block AND the cohort's proof for it. ---
		// One raw store shared across every BlockStorage, as a real node has: a fresh store per
		// call would silently drop each write.
		const sourceRaw = new MemoryRawStorage();
		const sourceRepo = new StorageRepo((id) => new BlockStorage(id, sourceRaw));
		const commit: CommitRequest = {
			actionId: source.actionId,
			blockIds: [blockId as BlockId],
			tailId: blockId as BlockId,
			rev: source.rev,
			blockDigests: { [blockId]: { digest: await canonicalBlockHash(block) } }
		};
		const { proof } = await makeSignedProof(4, commit);
		await sourceRepo.saveReplicatedBlock(blockId as BlockId, block, source, proof);

		// --- What a producer sends: meta + proof from ONE unpinned read, as both push sites do. ---
		const read = await sourceRepo.get({ blockIds: [blockId as BlockId] });
		const certification = await sourceBlockCertification(sourceRepo, blockId as BlockId, read[blockId]);
		expect(certification.blockProofs?.[blockId], 'the source attaches its retained proof').to.not.be.undefined;

		// --- The receiver runs the production default: no proof, no persist. ---
		const { service, peerNetwork } = makeWiredNetwork(repo, {});
		await service.start();
		try {
			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const blockData = new TextEncoder().encode(JSON.stringify(block));
			const response = await client.pushBlocks([blockId], [blockData], 'replication', certification);

			expect(response.blocks, 'the certified push is accepted over the real stream').to.have.property(blockId);
			expect(response.missing).to.deep.equal([]);

			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.block?.header.id, 'durably persisted').to.equal(blockId);
			expect(result[blockId]?.state?.latest, 'at the source revision').to.deep.equal(source);
			expect(await repo.getBlockProof(blockId as BlockId, source.rev),
				'and the receiver retained the proof it verified').to.deep.equal(certification.blockProofs![blockId]);
		} finally {
			await service.stop();
		}
	});

	it('certified push: the same strict-default receiver refuses a source that holds no proof', async function () {
		this.timeout(10000);
		// The control for the test above: identical path, identical receiver, only the source's
		// retained proof removed -- so the acceptance there cannot be the flag being off.
		const blockId = 'rt-uncertified-1';
		const block = makeBlock(blockId);
		const source = { rev: 4, actionId: 'rt-a4' as ActionId };

		// One raw store shared across every BlockStorage, as a real node has: a fresh store per
		// call would silently drop each write.
		const sourceRaw = new MemoryRawStorage();
		const sourceRepo = new StorageRepo((id) => new BlockStorage(id, sourceRaw));
		await sourceRepo.saveReplicatedBlock(blockId as BlockId, block, source);

		const read = await sourceRepo.get({ blockIds: [blockId as BlockId] });
		const certification = await sourceBlockCertification(sourceRepo, blockId as BlockId, read[blockId]);
		expect(certification.blockProofs, 'nothing to attach').to.be.undefined;
		expect(certification.blockMeta, 'but the revision metadata still travels').to.not.be.undefined;

		const { service, peerNetwork } = makeWiredNetwork(repo, {});
		await service.start();
		try {
			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const blockData = new TextEncoder().encode(JSON.stringify(block));
			const response = await client.pushBlocks([blockId], [blockData], 'replication', certification);

			expect(response.missing, 'refused end to end').to.deep.equal([blockId]);
			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.block ?? undefined, 'nothing persisted').to.be.undefined;
		} finally {
			await service.stop();
		}
	});
});
