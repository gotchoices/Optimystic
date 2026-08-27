import { expect } from 'chai';
import type { IRepo, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, IBlock, BlockId, BlockHeader, IPeerNetwork } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { BlockTransferCoordinator } from '../src/cluster/block-transfer.js';
import type { RebalanceEvent } from '../src/cluster/rebalance-monitor.js';
import { BlockTransferService, sourceBlockMeta, type BlockTransferRequest, type BlockTransferResponse, buildBlockTransferProtocol } from '../src/cluster/block-transfer-service.js';
import type { RestorationCoordinator } from '../src/storage/restoration-coordinator.js';
import type { BlockArchive } from '../src/storage/struct.js';

// --- Mocks ---

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader
});

class MockRepo implements IRepo {
	blocks: Map<string, IBlock> = new Map();

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		const result: GetBlockResults = {};
		for (const blockId of blockGets.blockIds) {
			const block = this.blocks.get(blockId);
			if (block) {
				result[blockId] = {
					block,
					state: { latest: { rev: 1, actionId: 'a1' } }
				} as any;
			}
		}
		return result;
	}
	async pend(_request: PendRequest): Promise<PendResult> {
		return { success: true, blockIds: [], pending: [] };
	}
	async commit(_request: CommitRequest): Promise<CommitResult> {
		return { success: true };
	}
	async cancel(_actionRef: ActionBlocks): Promise<void> {}
	async saveReplicatedBlock(blockId: string, block: IBlock): Promise<void> {
		this.blocks.set(blockId, block);
	}
}

class MockRestorationCoordinator {
	restoreCalls: string[] = [];
	/** blockId → archive or undefined */
	results: Map<string, BlockArchive | undefined> = new Map();
	delayMs = 0;

	async restore(blockId: string): Promise<BlockArchive | undefined> {
		this.restoreCalls.push(blockId);
		if (this.delayMs > 0) {
			await new Promise(r => setTimeout(r, this.delayMs));
		}
		return this.results.get(blockId);
	}
}

class MockPeerNetwork implements IPeerNetwork {
	connectCalls: Array<{ peerId: PeerId; protocol: string }> = [];
	/** Every request the client wrote to a stream, decoded — so tests can assert the wire payload. */
	sentRequests: BlockTransferRequest[] = [];
	responses: Map<string, BlockTransferResponse> = new Map();
	shouldFail = false;

	async connect(peerId: PeerId, protocol: string): Promise<any> {
		this.connectCalls.push({ peerId, protocol });
		if (this.shouldFail) {
			throw new Error('Connection failed');
		}
		// Return a mock stream
		const peerIdStr = peerId.toString();
		const response = this.responses.get(peerIdStr) ?? { blocks: {}, missing: [] };
		return createMockStream(response, this.sentRequests);
	}
}

/**
 * Create a minimal mock stream that yields a length-prefixed JSON response and records the
 * length-prefixed request the client sends. The client writes exactly one frame per stream, so
 * decoding is just "skip the varint prefix, parse the rest as JSON".
 */
function createMockStream(response: BlockTransferResponse, sentRequests: BlockTransferRequest[] = []): any {
	const responseBytes = new TextEncoder().encode(JSON.stringify(response));
	let sent = false;
	return {
		send(chunk: any) {
			const bytes: Uint8Array = chunk?.subarray ? chunk.subarray() : chunk;
			const text = new TextDecoder().decode(bytes);
			const start = text.indexOf('{');
			if (start >= 0) {
				sentRequests.push(JSON.parse(text.slice(start)) as BlockTransferRequest);
			}
		},
		close: async () => {},
		[Symbol.asyncIterator]: async function* () {
			if (!sent) {
				sent = true;
				// Length prefix (varint) + data
				const len = responseBytes.length;
				const prefix = new Uint8Array([len]);
				const combined = new Uint8Array(prefix.length + responseBytes.length);
				combined.set(prefix);
				combined.set(responseBytes, prefix.length);
				yield combined;
			}
		}
	};
}

const makeArchive = (blockId: string): BlockArchive => ({
	blockId,
	revisions: {
		1: {
			action: { actionId: 'a1', transform: { insert: makeBlock(blockId) } },
			block: makeBlock(blockId)
		}
	},
	range: [1, 2]
});

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

// --- Tests ---

describe('BlockTransferCoordinator', () => {
	let repo: MockRepo;
	let peerNetwork: MockPeerNetwork;
	let restoration: MockRestorationCoordinator;
	let partitionDetector: PartitionDetector;
	let coordinator: BlockTransferCoordinator;

	beforeEach(() => {
		repo = new MockRepo();
		peerNetwork = new MockPeerNetwork();
		restoration = new MockRestorationCoordinator();
		partitionDetector = new PartitionDetector();
		coordinator = new BlockTransferCoordinator(
			repo,
			peerNetwork,
			restoration as unknown as RestorationCoordinator,
			partitionDetector,
			'',
			{ maxConcurrency: 2, transferTimeoutMs: 5000, maxRetries: 1 }
		);
	});

	describe('pullBlocks', () => {
		it('pulls blocks via RestorationCoordinator on gained responsibility', async () => {
			restoration.results.set('block-1', makeArchive('block-1'));
			restoration.results.set('block-2', makeArchive('block-2'));

			const result = await coordinator.pullBlocks(['block-1', 'block-2']);

			expect(result.succeeded).to.deep.equal(['block-1', 'block-2']);
			expect(result.failed).to.deep.equal([]);
			expect(restoration.restoreCalls).to.include('block-1');
			expect(restoration.restoreCalls).to.include('block-2');
		});

		it('reports failed pulls when restoration returns undefined', async () => {
			restoration.results.set('block-1', undefined);

			const result = await coordinator.pullBlocks(['block-1']);

			expect(result.succeeded).to.deep.equal([]);
			expect(result.failed).to.deep.equal(['block-1']);
		});

		it('retries failed pulls up to maxRetries', async () => {
			// First attempt fails, second succeeds
			let callCount = 0;
			restoration.restore = async (blockId: string) => {
				callCount++;
				if (callCount === 1) return undefined;
				return makeArchive(blockId);
			};

			const result = await coordinator.pullBlocks(['block-1']);

			expect(result.succeeded).to.deep.equal(['block-1']);
			expect(callCount).to.equal(2);
		});

		it('skips transfer during partition', async () => {
			// Simulate partition by recording many failures
			for (let i = 0; i < 10; i++) {
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
			}

			restoration.results.set('block-1', makeArchive('block-1'));

			const result = await coordinator.pullBlocks(['block-1']);

			expect(result.succeeded).to.deep.equal([]);
			expect(result.failed).to.deep.equal(['block-1']);
			expect(restoration.restoreCalls).to.have.length(0);
		});
	});

	describe('pushBlocks', () => {
		it('pushes blocks to new owners on lost responsibility', async () => {
			repo.blocks.set('block-1', makeBlock('block-1'));
			const ownerId = await makePeerId();
			const ownerIdStr = ownerId.toString();

			peerNetwork.responses.set(ownerIdStr, {
				blocks: { 'block-1': 'data' },
				missing: []
			});

			const newOwners = new Map<string, string[]>([
				['block-1', [ownerIdStr]]
			]);

			const result = await coordinator.pushBlocks(['block-1'], newOwners);

			expect(result.succeeded).to.deep.equal(['block-1']);
			expect(result.failed).to.deep.equal([]);
		});

		it('carries the source revision metadata so the replica is not fabricated at rev 1', async () => {
			// The replica must land at the SOURCE's (rev, actionId): a fabricated action id can never
			// corroborate the source in a read-repair quorum vote, so the vote would see one claimant.
			repo.blocks.set('block-1', makeBlock('block-1'));
			const ownerIdStr = (await makePeerId()).toString();
			peerNetwork.responses.set(ownerIdStr, { blocks: { 'block-1': 'data' }, missing: [] });

			await coordinator.pushBlocks(['block-1'], new Map([['block-1', [ownerIdStr]]]));

			expect(peerNetwork.sentRequests).to.have.length(1);
			expect(peerNetwork.sentRequests[0]!.blockMeta, "the source's own state.latest rides along")
				.to.deep.equal({ 'block-1': { rev: 1, actionId: 'a1' } });
		});

		it('fails push when no local data available', async () => {
			// repo has no blocks
			const ownerId = await makePeerId();

			const newOwners = new Map<string, string[]>([
				['block-1', [ownerId.toString()]]
			]);

			const result = await coordinator.pushBlocks(['block-1'], newOwners);

			expect(result.succeeded).to.deep.equal([]);
			expect(result.failed).to.deep.equal(['block-1']);
		});

		it('skips push when enablePush is false', async () => {
			const noPushCoordinator = new BlockTransferCoordinator(
				repo,
				peerNetwork,
				restoration as unknown as RestorationCoordinator,
				partitionDetector,
				'',
				{ enablePush: false }
			);

			const newOwners = new Map<string, string[]>([
				['block-1', ['some-peer']]
			]);

			const result = await noPushCoordinator.pushBlocks(['block-1'], newOwners);
			expect(result.succeeded).to.deep.equal([]);
			expect(result.failed).to.deep.equal([]);
		});

		it('skips push during partition', async () => {
			for (let i = 0; i < 10; i++) {
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
			}

			repo.blocks.set('block-1', makeBlock('block-1'));
			const newOwners = new Map<string, string[]>([
				['block-1', ['some-peer']]
			]);

			const result = await coordinator.pushBlocks(['block-1'], newOwners);

			expect(result.succeeded).to.deep.equal([]);
			expect(result.failed).to.deep.equal(['block-1']);
		});
	});

	describe('confirmReplicated (Phase B / gated-release primitive)', () => {
		it('confirms a block replicated to the floor when enough owners report it not missing', async () => {
			repo.blocks.set('block-1', makeBlock('block-1'));
			const o1 = (await makePeerId()).toString();
			const o2 = (await makePeerId()).toString();
			peerNetwork.responses.set(o1, { blocks: { 'block-1': 'data' }, missing: [] });
			peerNetwork.responses.set(o2, { blocks: { 'block-1': 'data' }, missing: [] });

			const result = await coordinator.confirmReplicated(['block-1'], new Map([['block-1', [o1, o2]]]), 2);

			expect(result.confirmed).to.deep.equal(['block-1']);
			expect(result.unconfirmed).to.deep.equal([]);
		});

		it('carries the source revision metadata on every confirming push', async () => {
			repo.blocks.set('block-1', makeBlock('block-1'));
			const o1 = (await makePeerId()).toString();
			const o2 = (await makePeerId()).toString();
			peerNetwork.responses.set(o1, { blocks: { 'block-1': 'data' }, missing: [] });
			peerNetwork.responses.set(o2, { blocks: { 'block-1': 'data' }, missing: [] });

			await coordinator.confirmReplicated(['block-1'], new Map([['block-1', [o1, o2]]]), 2);

			expect(peerNetwork.sentRequests).to.have.length(2);
			for (const request of peerNetwork.sentRequests) {
				expect(request.blockMeta).to.deep.equal({ 'block-1': { rev: 1, actionId: 'a1' } });
			}
		});

		it('leaves a block unconfirmed when fewer than floor owners hold it', async () => {
			repo.blocks.set('block-1', makeBlock('block-1'));
			const o1 = (await makePeerId()).toString();
			const o2 = (await makePeerId()).toString();
			peerNetwork.responses.set(o1, { blocks: { 'block-1': 'data' }, missing: [] });  // confirms
			peerNetwork.responses.set(o2, { blocks: {}, missing: ['block-1'] });             // does NOT confirm

			const result = await coordinator.confirmReplicated(['block-1'], new Map([['block-1', [o1, o2]]]), 2);

			expect(result.confirmed).to.deep.equal([]);
			expect(result.unconfirmed).to.deep.equal(['block-1']);
		});

		it('leaves every block unconfirmed during a detected partition (no release)', async () => {
			for (let i = 0; i < 10; i++) {
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
			}
			repo.blocks.set('block-1', makeBlock('block-1'));
			const o1 = (await makePeerId()).toString();
			peerNetwork.responses.set(o1, { blocks: { 'block-1': 'data' }, missing: [] });

			const result = await coordinator.confirmReplicated(['block-1'], new Map([['block-1', [o1]]]), 1);

			expect(result.confirmed).to.deep.equal([]);
			expect(result.unconfirmed).to.deep.equal(['block-1']);
		});

		it('leaves a block unconfirmed when it has no qualifying owners', async () => {
			repo.blocks.set('block-1', makeBlock('block-1'));
			const result = await coordinator.confirmReplicated(['block-1'], new Map([['block-1', []]]), 1);
			expect(result.confirmed).to.deep.equal([]);
			expect(result.unconfirmed).to.deep.equal(['block-1']);
		});
	});

	describe('concurrency limiting', () => {
		it('does not deadlock when all concurrent tasks retry', async function () {
			// Tighter than the 10s package default: this test is a forcing function for a
			// concurrency deadlock — if the pull ever hangs, we want a fast-fail signal.
			this.timeout(5000);
			let callCount = 0;
			restoration.restore = async (blockId: string) => {
				callCount++;
				// First round (2 calls) fail, second round succeeds
				if (callCount <= 2) return undefined;
				return makeArchive(blockId);
			};

			// maxConcurrency=2, both blocks fail on first attempt and retry
			const result = await coordinator.pullBlocks(['block-a', 'block-b']);

			expect(result.succeeded).to.have.length(2);
			expect(result.failed).to.have.length(0);
			expect(callCount).to.equal(4);
		});

		it('limits concurrent transfers to maxConcurrency', async () => {
			let maxConcurrent = 0;
			let currentConcurrent = 0;

			restoration.restore = async (blockId: string) => {
				currentConcurrent++;
				maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
				await new Promise(r => setTimeout(r, 50));
				currentConcurrent--;
				return makeArchive(blockId);
			};

			// Launch 6 pulls with maxConcurrency=2
			const result = await coordinator.pullBlocks([
				'block-1', 'block-2', 'block-3',
				'block-4', 'block-5', 'block-6'
			]);

			expect(result.succeeded).to.have.length(6);
			expect(maxConcurrent).to.be.at.most(2);
		});
	});

	describe('handleRebalanceEvent', () => {
		it('processes gained and lost blocks from a rebalance event', async () => {
			restoration.results.set('block-new', makeArchive('block-new'));
			repo.blocks.set('block-old', makeBlock('block-old'));

			const ownerId = await makePeerId();
			peerNetwork.responses.set(ownerId.toString(), {
				blocks: { 'block-old': 'data' },
				missing: []
			});

			const event: RebalanceEvent = {
				gained: ['block-new'],
				lost: ['block-old'],
				newOwners: new Map([['block-old', [ownerId.toString()]]]),
				grown: new Map(),
				floor: 1,
				triggeredAt: Date.now()
			};

			const result = await coordinator.handleRebalanceEvent(event);

			expect(restoration.restoreCalls).to.include('block-new');
			// The lost block confirmed to its single new owner (missing:[] response) → released.
			expect(result.released).to.include('block-old');
		});

		it('handles empty rebalance events', async () => {
			const event: RebalanceEvent = {
				gained: [],
				lost: [],
				newOwners: new Map(),
				grown: new Map(),
				floor: 1,
				triggeredAt: Date.now()
			};

			// Should not throw
			await coordinator.handleRebalanceEvent(event);
		});

		it('pushes a GROWN block to its newly co-responsible peer exactly once, even below the event floor', async () => {
			repo.blocks.set('block-kept', makeBlock('block-kept'));
			const newPeer = await makePeerId();
			peerNetwork.responses.set(newPeer.toString(), { blocks: { 'block-kept': 'data' }, missing: [] });

			// floor 3 but only ONE new peer: the per-block floor must clamp to the new-peer count, or
			// executeConfirm could never reach 3 and would burn maxRetries re-pushing an accepted peer.
			const event: RebalanceEvent = {
				gained: [],
				lost: [],
				newOwners: new Map(),
				grown: new Map([['block-kept', [newPeer.toString()]]]),
				floor: 3,
				triggeredAt: Date.now()
			};

			const result = await coordinator.handleRebalanceEvent(event);

			expect(result.replicated, 'the grown block confirmed on its new peer').to.deep.equal(['block-kept']);
			expect(result.underReplicated).to.deep.equal([]);
			expect(result.released, 'nothing is released off the grown arm').to.deep.equal([]);
			expect(peerNetwork.connectCalls.length, 'one clean push, no retry churn').to.equal(1);
			expect(peerNetwork.connectCalls[0]!.peerId.toString()).to.equal(newPeer.toString());
			// Floor met → the outcome the monitor records as seen: the peer, complete.
			expect(result.growth.get('block-kept')).to.deep.equal(
				{ satisfiedPeers: [newPeer.toString()], complete: true });
		});

		it('reports a grown block underReplicated when the new peer refuses to persist it', async () => {
			repo.blocks.set('block-kept', makeBlock('block-kept'));
			const newPeer = await makePeerId();
			// Receiver answers, but lists the block missing (parse/persist failure on its side).
			peerNetwork.responses.set(newPeer.toString(), { blocks: {}, missing: ['block-kept'] });

			const event: RebalanceEvent = {
				gained: [],
				lost: [],
				newOwners: new Map(),
				grown: new Map([['block-kept', [newPeer.toString()]]]),
				floor: 3,
				triggeredAt: Date.now()
			};

			const result = await coordinator.handleRebalanceEvent(event);

			expect(result.replicated).to.deep.equal([]);
			expect(result.underReplicated, 'unconfirmed grown block surfaces for the log line').to.deep.equal(['block-kept']);
			// Incomplete outcome, nothing satisfied → the monitor keeps the peer un-seen and retries.
			expect(result.growth.get('block-kept')).to.deep.equal(
				{ satisfiedPeers: [], complete: false });
		});

		it('a partially confirmed grown block reports only the confirming peers satisfied', async () => {
			repo.blocks.set('block-kept', makeBlock('block-kept'));
			const goodPeer = await makePeerId();
			const badPeer = await makePeerId();
			peerNetwork.responses.set(goodPeer.toString(), { blocks: { 'block-kept': 'data' }, missing: [] });
			peerNetwork.responses.set(badPeer.toString(), { blocks: {}, missing: ['block-kept'] });

			const event: RebalanceEvent = {
				gained: [],
				lost: [],
				newOwners: new Map(),
				grown: new Map([['block-kept', [goodPeer.toString(), badPeer.toString()]]]),
				floor: 3, // clamps to 2 (the new-peer count) per block
				triggeredAt: Date.now()
			};

			const result = await coordinator.handleRebalanceEvent(event);

			expect(result.replicated).to.deep.equal([]);
			expect(result.underReplicated).to.deep.equal(['block-kept']);
			const outcome = result.growth.get('block-kept');
			expect(outcome!.complete, 'floor unmet → incomplete').to.equal(false);
			expect(outcome!.satisfiedPeers, 'ONLY the confirming peer is satisfied — the refusing one is retried')
				.to.deep.equal([goodPeer.toString()]);
		});

		it('a grown block with no local data is reported underReplicated without dialing (gained∩grown case)', async () => {
			// The block was only just gained (nothing local yet) but the first observation also lists the
			// cohort as grown. The push finds no local bytes and no-ops — benign: those cohort peers are
			// the pull's own source.
			const newPeer = await makePeerId();

			const event: RebalanceEvent = {
				gained: [],
				lost: [],
				newOwners: new Map(),
				grown: new Map([['block-absent', [newPeer.toString()]]]),
				floor: 3,
				triggeredAt: Date.now()
			};

			const result = await coordinator.handleRebalanceEvent(event);

			expect(result.replicated).to.deep.equal([]);
			expect(result.underReplicated).to.deep.equal(['block-absent']);
			expect(peerNetwork.connectCalls.length, 'no dial without local data').to.equal(0);
			// Nothing to replicate and no dial happened: the reported peers are the pull's own source,
			// so the outcome is COMPLETE — the monitor must not turn this case into a retry loop.
			expect(result.growth.get('block-absent')).to.deep.equal(
				{ satisfiedPeers: [newPeer.toString()], complete: true });
		});

		it('leaves every grown block owed a push during a detected partition, without dialing', async () => {
			// The grown arm has its own partition guard (it drives executeConfirm directly rather than
			// going through confirmReplicated). A partition must look like any other failed push: nothing
			// satisfied, incomplete, so the monitor keeps the peer un-seen and retries.
			for (let i = 0; i < 10; i++) {
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
			}
			repo.blocks.set('block-kept', makeBlock('block-kept'));
			const newPeer = await makePeerId();
			peerNetwork.responses.set(newPeer.toString(), { blocks: { 'block-kept': 'data' }, missing: [] });

			const event: RebalanceEvent = {
				gained: [],
				lost: [],
				newOwners: new Map(),
				grown: new Map([['block-kept', [newPeer.toString()]]]),
				floor: 3,
				triggeredAt: Date.now()
			};

			const result = await coordinator.handleRebalanceEvent(event);

			expect(result.replicated).to.deep.equal([]);
			expect(result.underReplicated).to.deep.equal(['block-kept']);
			expect(peerNetwork.connectCalls.length, 'no dial during a partition').to.equal(0);
			expect(result.growth.get('block-kept')).to.deep.equal(
				{ satisfiedPeers: [], complete: false });
		});
	});

	describe('idempotent block receipt', () => {
		it('pulling a block already present locally is a no-op via restoration', async () => {
			// RestorationCoordinator returns archive (as if block exists elsewhere)
			restoration.results.set('block-1', makeArchive('block-1'));

			const result1 = await coordinator.pullBlocks(['block-1']);
			const result2 = await coordinator.pullBlocks(['block-1']);

			expect(result1.succeeded).to.deep.equal(['block-1']);
			expect(result2.succeeded).to.deep.equal(['block-1']);
		});
	});

	describe('timeout behavior', () => {
		it('times out slow transfers', async () => {
			const slowCoordinator = new BlockTransferCoordinator(
				repo,
				peerNetwork,
				restoration as unknown as RestorationCoordinator,
				partitionDetector,
				'',
				{ transferTimeoutMs: 50, maxRetries: 0 }
			);

			restoration.restore = async () => {
				await new Promise(r => setTimeout(r, 200));
				return makeArchive('block-1');
			};

			const result = await slowCoordinator.pullBlocks(['block-1']);

			expect(result.succeeded).to.deep.equal([]);
			expect(result.failed).to.deep.equal(['block-1']);
		});
	});
});

describe('BlockTransferService', () => {
	it('builds correct protocol string', () => {
		expect(buildBlockTransferProtocol()).to.equal('/db-p2p/block-transfer/1.0.0');
		expect(buildBlockTransferProtocol('/test')).to.equal('/test/db-p2p/block-transfer/1.0.0');
	});

	describe('start/stop', () => {
		it('registers and unregisters protocol handler', async () => {
			const handled: string[] = [];
			const unhandled: string[] = [];

			const service = new BlockTransferService({
				registrar: {
					handle: async (protocol: string) => { handled.push(protocol); },
					unhandle: async (protocol: string) => { unhandled.push(protocol); }
				},
				repo: new MockRepo()
			});

			await service.start();
			expect(handled).to.deep.equal(['/db-p2p/block-transfer/1.0.0']);

			await service.stop();
			expect(unhandled).to.deep.equal(['/db-p2p/block-transfer/1.0.0']);
		});

		it('is idempotent on start/stop', async () => {
			let handleCount = 0;
			const service = new BlockTransferService({
				registrar: {
					handle: async () => { handleCount++; },
					unhandle: async () => {}
				},
				repo: new MockRepo()
			});

			await service.start();
			await service.start();
			expect(handleCount).to.equal(1);

			await service.stop();
			await service.stop(); // should not throw
		});
	});
});

describe('sourceBlockMeta', () => {
	it('carries the source latest for an unpinned read', () => {
		expect(sourceBlockMeta('block-1' as BlockId, { state: { latest: { rev: 7, actionId: 'a7' } } }))
			.to.deep.equal({ 'block-1': { rev: 7, actionId: 'a7' } });
	});

	it('agreeing materializedRev is still carried', () => {
		expect(sourceBlockMeta('block-1' as BlockId,
			{ state: { latest: { rev: 7, actionId: 'a7' } }, materializedRev: 7 }))
			.to.deep.equal({ 'block-1': { rev: 7, actionId: 'a7' } });
	});

	it('drops the meta when the content is older than latest (pinned read)', () => {
		// Labelling rev-3 content as rev 7 would make every holder of it a false corroborator for a
		// revision it does not hold. Dropping the meta falls the receiver back to a rev-1 replica.
		expect(sourceBlockMeta('block-1' as BlockId,
			{ state: { latest: { rev: 7, actionId: 'a7' } }, materializedRev: 3 }))
			.to.equal(undefined);
	});

	it('is undefined when the source holds no latest', () => {
		expect(sourceBlockMeta('block-1' as BlockId, { state: {} })).to.equal(undefined);
		expect(sourceBlockMeta('block-1' as BlockId, undefined)).to.equal(undefined);
	});
});

describe('BlockTransferRequest/Response types', () => {
	it('pull request has correct shape', () => {
		const req: BlockTransferRequest = {
			type: 'pull',
			blockIds: ['block-1', 'block-2'],
			reason: 'rebalance'
		};
		expect(req.type).to.equal('pull');
		expect(req.blockIds).to.have.length(2);
	});

	it('push request includes blockData', () => {
		const req: BlockTransferRequest = {
			type: 'push',
			blockIds: ['block-1'],
			reason: 'replication',
			blockData: { 'block-1': 'base64data' }
		};
		expect(req.blockData).to.not.be.undefined;
		expect(req.blockData!['block-1']).to.equal('base64data');
	});

	it('response distinguishes found and missing blocks', () => {
		const resp: BlockTransferResponse = {
			blocks: { 'block-1': 'data' },
			missing: ['block-2']
		};
		expect(Object.keys(resp.blocks)).to.deep.equal(['block-1']);
		expect(resp.missing).to.deep.equal(['block-2']);
	});
});
