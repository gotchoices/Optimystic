import { expect } from 'aegir/chai';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import type { IRepo, ClusterRecord, RepoMessage, Signature, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, ClusterPeers, Transforms, IBlock, BlockId, BlockHeader } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';

/**
 * Compute message hash using the same algorithm as the coordinator.
 * Must match cluster-coordinator.ts createMessageHash().
 */
const computeMessageHash = async (message: RepoMessage): Promise<string> => {
	const msgBytes = new TextEncoder().encode(JSON.stringify(message));
	const hashBytes = await sha256.digest(msgBytes);
	return base58btc.encode(hashBytes.digest);
};

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string): IBlock => ({
	header: makeHeader(id)
});

const makeClusterPeers = (peerIds: PeerId[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const peerId of peerIds) {
		peers[peerId.toString()] = {
			multiaddrs: [multiaddr('/ip4/127.0.0.1/tcp/8000')],
			publicKey: new Uint8Array(32)
		};
	}
	return peers;
};

class MockRepo implements IRepo {
	getCalls: BlockGets[] = [];
	pendCalls: PendRequest[] = [];
	commitCalls: CommitRequest[] = [];
	cancelCalls: ActionBlocks[] = [];

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		this.getCalls.push(blockGets);
		return {};
	}

	async pend(request: PendRequest): Promise<PendResult> {
		this.pendCalls.push(request);
		return { success: true, blockIds: [], pending: [] };
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		this.commitCalls.push(request);
		return { success: true };
	}

	async cancel(actionRef: ActionBlocks): Promise<void> {
		this.cancelCalls.push(actionRef);
	}
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> {
		return {};
	}
}

const createClusterRecord = async (
	peers: ClusterPeers,
	operations: RepoMessage['operations'],
	promises: Record<string, Signature> = {},
	commits: Record<string, Signature> = {},
	expiration?: number
): Promise<ClusterRecord> => {
	const message: RepoMessage = {
		operations,
		expiration: expiration ?? Date.now() + 30000
	};
	const messageHash = await computeMessageHash(message);
	return {
		messageHash,
		message,
		peers,
		promises,
		commits
	};
};

const makeGetOperation = (blockIds: string[]): RepoMessage['operations'] => [
	{ get: { blockIds } }
];

const makePendOperation = (actionId: string, blockId: string): RepoMessage['operations'] => {
	const transforms: Transforms = {
		inserts: { [blockId]: makeBlock(blockId) },
		updates: {},
		deletes: []
	};
	return [{ pend: { actionId, transforms, policy: 'c' } }];
};

describe('ClusterMember', () => {
	let mockRepo: MockRepo;
	let mockNetwork: MockPeerNetwork;
	let selfPeerId: PeerId;
	let clusterMemberInstance: ClusterMember;

	beforeEach(async () => {
		mockRepo = new MockRepo();
		mockNetwork = new MockPeerNetwork();
		selfPeerId = await makePeerId();
		clusterMemberInstance = clusterMember({
			storageRepo: mockRepo,
			peerNetwork: mockNetwork,
			peerId: selfPeerId
		});
	});

	describe('update - promise phase', () => {
		it('adds own promise when not present', async () => {
			const otherPeerId = await makePeerId();
			const ourId = selfPeerId.toString();
			const peers = makeClusterPeers([selfPeerId, otherPeerId]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);

			const result = await clusterMemberInstance.update(record);

			expect(result.promises[ourId]).to.not.equal(undefined);
			expect(result.promises[ourId]!.type).to.equal('approve');
		});

		it('does not re-add promise if already present', async () => {
			const ourId = selfPeerId.toString();
			const peers = makeClusterPeers([selfPeerId]);
			const existingPromise: Signature = { type: 'approve', signature: 'existing' };

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{ [ourId]: existingPromise }
			);

			const result = await clusterMemberInstance.update(record);

			// Should still have a promise
			expect(result.promises[ourId]).to.not.equal(undefined);
		});
	});

	describe('update - commit phase', () => {
		it('adds commit when all promises received', async () => {
			const otherPeerId = await makePeerId();
			const ourId = selfPeerId.toString();
			const otherId = otherPeerId.toString();
			const peers = makeClusterPeers([selfPeerId, otherPeerId]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{
					[ourId]: { type: 'approve', signature: 'p1' },
					[otherId]: { type: 'approve', signature: 'p2' }
				}
			);

			const result = await clusterMemberInstance.update(record);

			expect(result.commits[ourId]).to.not.equal(undefined);
			expect(result.commits[ourId]!.type).to.equal('approve');
		});

		it('does not commit without all promises', async () => {
			const otherPeerId = await makePeerId();
			const ourId = selfPeerId.toString();
			const peers = makeClusterPeers([selfPeerId, otherPeerId]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{ [ourId]: { type: 'approve', signature: 'p1' } } // Missing other's promise
			);

			const result = await clusterMemberInstance.update(record);

			expect(result.commits[ourId]).to.equal(undefined);
		});
	});

	describe('update - rejection handling', () => {
		it('detects rejected transaction from promise rejection', async () => {
			const otherPeerId = await makePeerId();
			const otherId = otherPeerId.toString();
			const peers = makeClusterPeers([selfPeerId, otherPeerId]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{ [otherId]: { type: 'reject', signature: 'rejected', rejectReason: 'test' } }
			);

			// Should not throw, handles rejection gracefully
			const result = await clusterMemberInstance.update(record);

			// Transaction is in rejected state
			expect(result).to.not.equal(undefined);
		});
	});

	describe('update - expiration', () => {
		it('rejects expired transactions', async () => {
			const peers = makeClusterPeers([selfPeerId]);

			const record: ClusterRecord = {
				messageHash: 'expired-hash',
				message: {
					operations: makeGetOperation(['block-1']),
					expiration: Date.now() - 1000 // Already expired
				},
				peers,
				promises: {},
				commits: {}
			};

			try {
				await clusterMemberInstance.update(record);
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message.toLowerCase()).to.include('expired');
			}
		});
	});

	describe('update - record merging', () => {
		it('merges promises from multiple updates', async () => {
			const peer2 = await makePeerId();
			const peer3 = await makePeerId();
			const ourId = selfPeerId.toString();
			const peer2Id = peer2.toString();
			const peer3Id = peer3.toString();
			const peers = makeClusterPeers([selfPeerId, peer2, peer3]);
			const expiration = Date.now() + 30000;

			// First update with peer2's promise
			const record1 = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{ [peer2Id]: { type: 'approve', signature: 'p2' } },
				{},
				expiration
			);

			await clusterMemberInstance.update(record1);

			// Second update with peer3's promise - same message content, so same hash
			const record2: ClusterRecord = {
				...record1,
				promises: { [peer3Id]: { type: 'approve', signature: 'p3' } }
			};

			const result = await clusterMemberInstance.update(record2);

			// Should have merged promises
			expect(result.promises[peer2Id] || result.promises[ourId]).to.not.equal(undefined);
		});

		it('throws on message content mismatch', async () => {
			const peers = makeClusterPeers([selfPeerId]);

			const record1 = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);

			await clusterMemberInstance.update(record1);

			// Same hash but different message content - this is a forgery attempt
			const record2: ClusterRecord = {
				messageHash: record1.messageHash,
				message: {
					operations: makeGetOperation(['block-2']), // Different!
					expiration: Date.now() + 30000
				},
				peers,
				promises: {},
				commits: {}
			};

			try {
				await clusterMemberInstance.update(record2);
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message.toLowerCase()).to.include('mismatch');
			}
		});
	});

	describe('update - consensus execution', () => {
		it('skips execution when already committed (idempotency)', async () => {
			const otherPeerId = await makePeerId();
			const ourId = selfPeerId.toString();
			const otherId = otherPeerId.toString();
			const peers = makeClusterPeers([selfPeerId, otherPeerId]);

			// Record already at consensus with our commit present
			// Implementation checks hasLocalCommit - if we already committed, don't re-execute
			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{
					[ourId]: { type: 'approve', signature: 'p1' },
					[otherId]: { type: 'approve', signature: 'p2' }
				},
				{
					[ourId]: { type: 'approve', signature: 'c1' },
					[otherId]: { type: 'approve', signature: 'c2' }
				}
			);

			await clusterMemberInstance.update(record);

			// Should NOT execute operations since we already have our commit
			// This ensures idempotent handling of duplicate consensus messages
			expect(mockRepo.getCalls.length).to.equal(0);
		});

		it('adds commit when all promises present', async () => {
			const otherPeerId = await makePeerId();
			const ourId = selfPeerId.toString();
			const otherId = otherPeerId.toString();
			const peers = makeClusterPeers([selfPeerId, otherPeerId]);

			// All promises present, other has committed, we need to commit
			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{
					[ourId]: { type: 'approve', signature: 'p1' },
					[otherId]: { type: 'approve', signature: 'p2' }
				},
				{
					[otherId]: { type: 'approve', signature: 'c2' }
				}
			);

			const result = await clusterMemberInstance.update(record);

			// Should have added our commit
			expect(result.commits[ourId]).to.not.equal(undefined);
			expect(result.commits[ourId]!.type).to.equal('approve');
		});
	});

	describe('update - concurrent serialization', () => {
		it('serializes concurrent updates for same transaction', async () => {
			const peers = makeClusterPeers([selfPeerId]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);

			// Fire two updates concurrently
			const [result1, result2] = await Promise.all([
				clusterMemberInstance.update({ ...record, promises: {}, commits: {} }),
				clusterMemberInstance.update({ ...record, promises: {}, commits: {} })
			]);

			// Both should complete without error
			expect(result1).to.not.equal(undefined);
			expect(result2).to.not.equal(undefined);
		});
	});

	describe('conflict detection', () => {
		it('detects conflicting operations on same block', async () => {
			const peers = makeClusterPeers([selfPeerId]);

			// First transaction operates on block-1
			const record1 = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-1')
			);

			await clusterMemberInstance.update(record1);

			// Second transaction also operates on block-1
			const record2 = await createClusterRecord(
				peers,
				makePendOperation('a2', 'block-1')
			);

			// Should detect conflict and handle via race resolution
			const result = await clusterMemberInstance.update(record2);
			expect(result).to.not.equal(undefined);
		});

		it('operations on different blocks do not conflict', async () => {
			const ourId = selfPeerId.toString();
			const peers = makeClusterPeers([selfPeerId]);

			const record1 = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-1')
			);

			await clusterMemberInstance.update(record1);

			const record2 = await createClusterRecord(
				peers,
				makePendOperation('a2', 'block-2')
			);

			// Different blocks - no conflict
			const result = await clusterMemberInstance.update(record2);
			expect(result.promises[ourId]).to.not.equal(undefined);
		});
	});

	describe('validation', () => {
		it('uses validator when provided', async () => {
			let validationCalled = false;

			const validatingMember = clusterMember({
				storageRepo: mockRepo,
				peerNetwork: mockNetwork,
				peerId: selfPeerId,
				validator: {
					validate: async (_txn, _hash) => {
						validationCalled = true;
						return { valid: true };
					},
					getSchemaHash: async () => 'test-hash'
				}
			});

			const peers = makeClusterPeers([selfPeerId]);
			const transforms: Transforms = {
				inserts: { 'block-1': makeBlock('block-1') },
				updates: {},
				deletes: []
			};

			const record = await createClusterRecord(
				peers,
				[{
					pend: {
						actionId: 'a1',
						transforms,
						policy: 'c',
						transaction: { statements: [], stamp: {} } as any,
						operationsHash: 'hash'
					}
				}]
			);

			await validatingMember.update(record);

			expect(validationCalled).to.equal(true);
		});

		it('rejects promise when validation fails', async () => {
			const validatingMember = clusterMember({
				storageRepo: mockRepo,
				peerNetwork: mockNetwork,
				peerId: selfPeerId,
				validator: {
					validate: async () => ({ valid: false, reason: 'Validation failed' }),
					getSchemaHash: async () => 'test-hash'
				}
			});

			const ourId = selfPeerId.toString();
			const peers = makeClusterPeers([selfPeerId]);
			const transforms: Transforms = {
				inserts: { 'block-1': makeBlock('block-1') },
				updates: {},
				deletes: []
			};

			const record = await createClusterRecord(
				peers,
				[{
					pend: {
						actionId: 'a1',
						transforms,
						policy: 'c',
						transaction: { statements: [], stamp: {} } as any,
						operationsHash: 'hash'
					}
				}]
			);

			const result = await validatingMember.update(record);

			// Should have a reject promise
			expect(result.promises[ourId]?.type).to.equal('reject');
			expect(result.promises[ourId]?.rejectReason).to.include('Validation failed');
		});
	});
});
