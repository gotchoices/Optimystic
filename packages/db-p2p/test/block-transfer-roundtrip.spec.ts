import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { pushable } from 'it-pushable';
import type { PeerId } from '@libp2p/interface';
import type { ActionId, CommitRequest, IBlock, BlockId, BlockHeader } from '@optimystic/db-core';
import { canonicalBlockHash, jsonEncodedBytes, MAX_BLOCK_BYTES } from '@optimystic/db-core';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import {
	BlockTransferService,
	BlockTransferClient,
	sourceBlockCertification,
	type BlockTransferServiceInit,
	type IBlockReplicaStore,
	type PushCertification,
} from '../src/cluster/block-transfer-service.js';
import { ResponseTimeoutError, RESPONSE_TIMEOUT_ERROR_CODE } from '../src/protocol-client.js';
import { makeSignedProof } from './support/commit-proof-fixtures.js';
import { makeLinkedPair } from './support/linked-duplex-pair.js';

/**
 * Default-suite (no env gate) regression for the block-transfer request→response
 * round trip through the *registered stream handler* — not a direct handlePush
 * call. The only other coverage of the real-stream path is the env-gated churn
 * integration test; a regression in the handler's stream framing or handler
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

/** A block whose JSON encodes to exactly `bytes`, padded with an ASCII payload (one byte a character). */
const makeBlockOfEncodedSize = (id: string, bytes: number): IBlock => {
	const unpadded = jsonEncodedBytes({ ...makeBlock(id), payload: '' });
	return { ...makeBlock(id), payload: 'x'.repeat(bytes - unpadded) } as IBlock;
};

/**
 * What a real source peer sends for `block` at `source`: a repo holding the block AND the cohort's
 * proof for it, read back through `sourceBlockCertification` from ONE unpinned read, as the production
 * push loop does.
 */
const certifiedSource = async (blockId: string, block: IBlock, source: { rev: number; actionId: ActionId }): Promise<PushCertification> => {
	// One raw store shared across every BlockStorage, as a real node has: a fresh store per call would
	// silently drop each write.
	const sourceRepo = new StorageRepo(new MemoryRawStorage());
	const commit: CommitRequest = {
		actionId: source.actionId,
		blockIds: [blockId as BlockId],
		tailId: blockId as BlockId,
		rev: source.rev,
		blockDigests: { [blockId]: { digest: await canonicalBlockHash(block) } }
	};
	const { proof } = await makeSignedProof(4, commit);
	await sourceRepo.saveReplicatedBlock(blockId as BlockId, block, source, proof);
	const read = await sourceRepo.get({ blockIds: [blockId as BlockId] });
	return await sourceBlockCertification(sourceRepo, blockId as BlockId, read[blockId]);
};

/** Mirrors `support/commit-proof-fixtures.ts`'s `PROOF_THRESHOLDS.superMajorityThreshold`. */
const SUPER_MAJORITY = 0.75;

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
		repo = new StorageRepo(rawStorage);
		peerId = await makePeerId();
	});

	it('push persists the block on the receiver through the handler+stream', async function () {
		this.timeout(2000);
		const blockId = 'rt-push-1';
		const block = makeBlock(blockId);

		const { service, peerNetwork } = makeWiredNetwork(repo);
		await service.start();
		try {
			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const response = await client.pushBlocks({ [blockId]: block }, 'replication');

			// The handler accepted the block (listed in `accepted`, not `missing`)...
			expect(response.accepted).to.deep.equal([blockId]);
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
			await client.pushBlocks({ [blockId]: block }, 'replication', undefined, { responseTimeoutMs: 80 });
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
	 * the push request, block included, is JSON-serialized, so anything in a `BlockCommitProof` that
	 * does not survive `JSON.parse(JSON.stringify(x))` -- or a digest computed over a block that
	 * differs after the round trip -- would verify in a unit test and be rejected by every real peer.
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

		const certification = await certifiedSource(blockId, block, source);
		expect(certification.blockProofs?.[blockId], 'the source attaches its retained proof').to.not.be.undefined;

		// --- The receiver runs the production default: no proof, no persist. ---
		const { service, peerNetwork } = makeWiredNetwork(repo, {});
		await service.start();
		try {
			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const response = await client.pushBlocks({ [blockId]: block }, 'replication', certification);

			expect(response.accepted, 'the certified push is accepted over the real stream').to.deep.equal([blockId]);
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

		const sourceRepo = new StorageRepo(new MemoryRawStorage());
		await sourceRepo.saveReplicatedBlock(blockId as BlockId, block, source);

		const read = await sourceRepo.get({ blockIds: [blockId as BlockId] });
		const certification = await sourceBlockCertification(sourceRepo, blockId as BlockId, read[blockId]);
		expect(certification.blockProofs, 'nothing to attach').to.be.undefined;
		expect(certification.blockMeta, 'but the revision metadata still travels').to.not.be.undefined;

		const { service, peerNetwork } = makeWiredNetwork(repo, {});
		await service.start();
		try {
			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const response = await client.pushBlocks({ [blockId]: block }, 'replication', certification);

			expect(response.missing, 'refused end to end').to.deep.equal([blockId]);
			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.block ?? undefined, 'nothing persisted').to.be.undefined;
		} finally {
			await service.stop();
		}
	});

	/**
	 * The largest block the size limit allows, pushed certified to a strict-default receiver. Base64
	 * made a push a third larger than the block, so the client refused this request before dialing
	 * (`MessageTooLargeError`: 7.5 MiB of block became 10 MiB of request against the 8 MiB frame). As
	 * a JSON value, the block plus its revision metadata and commit proof fits one frame.
	 */
	it('a certified push of a block at MAX_BLOCK_BYTES fits one frame and is persisted', async function () {
		this.timeout(30000);
		const blockId = 'rt-largest-1';
		const block = makeBlockOfEncodedSize(blockId, MAX_BLOCK_BYTES);
		expect(jsonEncodedBytes(block), 'precondition: the block is exactly at the limit').to.equal(MAX_BLOCK_BYTES);
		const source = { rev: 4, actionId: 'rt-a4' as ActionId };
		const certification = await certifiedSource(blockId, block, source);

		const { service, peerNetwork } = makeWiredNetwork(repo, {});
		await service.start();
		try {
			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const response = await client.pushBlocks({ [blockId]: block }, 'replication', certification);

			expect(response.accepted).to.deep.equal([blockId]);
			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.state?.latest, 'persisted at the source revision').to.deep.equal(source);
			expect(jsonEncodedBytes(result[blockId]?.block), 'and whole').to.equal(MAX_BLOCK_BYTES);
		} finally {
			await service.stop();
		}
	});

	/**
	 * Reproduces the Hermes/React Native condition in Node: `globalThis.Buffer` does not exist
	 * unless a host app happens to install a polyfill (see readme.md § React Native). Deletes the
	 * global for the duration of one push through the real handler+stream path, so a regression that
	 * reaches for `Buffer` anywhere in that path (service, client, or the `it-length-prefixed`/
	 * `it-pipe` framing in between) throws `ReferenceError: Buffer is not defined` here instead of
	 * silently only failing on-device.
	 */
	it('completes a push with globalThis.Buffer deleted (Hermes/React Native condition)', async function () {
		this.timeout(2000);
		const blockId = 'rt-nobuffer-push';

		const { service, peerNetwork } = makeWiredNetwork(repo);
		await service.start();
		const savedBuffer = (globalThis as any).Buffer;
		try {
			delete (globalThis as any).Buffer;
			expect(typeof (globalThis as any).Buffer, 'precondition: the global is actually gone').to.equal('undefined');

			const client = new BlockTransferClient(peerId, peerNetwork as any);
			const response = await client.pushBlocks({ [blockId]: makeBlock(blockId) }, 'replication');
			expect(response.accepted).to.deep.equal([blockId]);
			expect(response.missing).to.deep.equal([]);

			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.block?.header.id, 'pushed block durably persisted with no global Buffer')
				.to.equal(blockId);
		} finally {
			(globalThis as any).Buffer = savedBuffer;
			await service.stop();
		}
	});
});
