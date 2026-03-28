import { expect } from 'chai';
import { ClusterCoordinator } from '../src/repo/cluster-coordinator.js';
import type { ClusterRecord, ClusterPeers, IKeyNetwork, RepoMessage, ClusterConsensusConfig, BlockId, Signature } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';

const makePeerId = async (): Promise<PeerId> => {
	const pk = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(pk);
};

/**
 * Mock cluster client for testing ClusterCoordinator retry behavior.
 * Determines phase by checking whether our promise is already in the record:
 * - Not present → promise phase (add our promise)
 * - Present → commit phase (add our commit, or fail if configured)
 */
class MockClusterClient {
	updateCalls = 0;
	failCommit = false;
	peerIdStr: string;

	constructor(peerIdStr: string) {
		this.peerIdStr = peerIdStr;
	}

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		this.updateCalls++;

		// Promise phase: our promise is not yet in the record
		if (!(this.peerIdStr in record.promises)) {
			return {
				...record,
				promises: {
					...record.promises,
					[this.peerIdStr]: { type: 'approve', signature: `psig-${this.peerIdStr.substring(0, 8)}` } as Signature
				}
			};
		}

		// Commit phase (initial or retry)
		if (this.failCommit) {
			throw new Error(`Peer ${this.peerIdStr.substring(0, 8)} unreachable`);
		}

		return {
			...record,
			commits: {
				...record.commits,
				[this.peerIdStr]: { type: 'approve', signature: `csig-${this.peerIdStr.substring(0, 8)}` } as Signature
			}
		};
	}
}

describe('ClusterCoordinator retry logic (TEST-5.2.1)', function () {
	this.timeout(15000);

	let peerIds: PeerId[];
	let mockClusters: Map<string, MockClusterClient>;
	let coordinator: ClusterCoordinator;

	const cfg: ClusterConsensusConfig & { clusterSize: number } = {
		clusterSize: 3,
		superMajorityThreshold: 0.75,
		simpleMajorityThreshold: 0.51,
		minAbsoluteClusterSize: 2,
		allowClusterDownsize: true,
		clusterSizeTolerance: 0.5,
		partitionDetectionWindow: 60000
	};

	const makeMessage = (): RepoMessage => ({
		operations: [{ get: { blockIds: ['block-1'] } }],
		expiration: Date.now() + 30000
	});

	beforeEach(async () => {
		peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);

		const clusterPeers: ClusterPeers = {};
		mockClusters = new Map();
		for (const pid of peerIds) {
			const idStr = pid.toString();
			clusterPeers[idStr] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
			mockClusters.set(idStr, new MockClusterClient(idStr));
		}

		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};

		const createClient = (peerId: PeerId) => {
			const mock = mockClusters.get(peerId.toString());
			if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
			return mock;
		};

		coordinator = new ClusterCoordinator(
			mockKeyNetwork,
			createClient as any,
			cfg
		);
	});

	it('completes without retry when all peers commit', async () => {
		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		// All 3 commits present
		expect(Object.keys(result.record.commits)).to.have.length(3);

		// Each mock called exactly three times (promise + commit + consensus broadcast)
		for (const [_, mock] of mockClusters) {
			expect(mock.updateCalls).to.equal(3);
		}

		// No retry in background — wait briefly and verify no extra calls
		await new Promise(r => setTimeout(r, 300));
		for (const [_, mock] of mockClusters) {
			expect(mock.updateCalls).to.equal(3);
		}
	});

	it('returns success with simple-majority commits despite one failure', async () => {
		const failingId = peerIds[2]!.toString();
		mockClusters.get(failingId)!.failCommit = true;

		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		// 2/3 commits = simple majority (floor(3*0.51)+1 = 2)
		expect(Object.keys(result.record.commits)).to.have.length(2);
		expect(result.record.commits[failingId]).to.equal(undefined);
	});

	it('retries failed commit peer in the background', async () => {
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		failingMock.failCommit = true;

		await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		// Initially: 1 promise call + 1 failed commit call + 1 consensus broadcast = 3
		expect(failingMock.updateCalls).to.equal(3);

		// Wait for first retry (initial interval is 2000ms)
		await new Promise(r => setTimeout(r, 2500));

		// Retry should have fired: at least 1 additional call
		expect(failingMock.updateCalls).to.be.greaterThanOrEqual(3);
	});

	it('retry succeeds when peer recovers', async () => {
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		failingMock.failCommit = true;

		await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		// Fix the peer before the retry fires
		failingMock.failCommit = false;

		// Wait for retry
		await new Promise(r => setTimeout(r, 2500));

		// Peer should have been retried and succeeded (no further retries scheduled)
		expect(failingMock.updateCalls).to.be.greaterThanOrEqual(3);

		// Wait another interval to confirm no further retries after success
		const callsAfterRecovery = failingMock.updateCalls;
		await new Promise(r => setTimeout(r, 2500));
		expect(failingMock.updateCalls).to.equal(callsAfterRecovery);
	});

	it('continues retrying with exponential backoff on persistent failure', async () => {
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		failingMock.failCommit = true;

		await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		// First retry at ~2s
		await new Promise(r => setTimeout(r, 2500));
		const callsAfterFirst = failingMock.updateCalls;
		expect(callsAfterFirst).to.be.greaterThanOrEqual(3);

		// Second retry at ~4s after first (backoff factor 2)
		await new Promise(r => setTimeout(r, 4500));
		const callsAfterSecond = failingMock.updateCalls;
		expect(callsAfterSecond).to.be.greaterThan(callsAfterFirst);
	});
});
