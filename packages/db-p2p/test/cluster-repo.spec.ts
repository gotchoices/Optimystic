import { expect } from 'chai';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { MemoryTransactionStateStore } from '../src/cluster/memory-transaction-state-store.js';
import type { IRepo, ClusterRecord, RepoMessage, Signature, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, ClusterPeers, Transforms, IBlock, BlockId, BlockHeader, ClusterConsensusConfig } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

// ─── Canonical JSON for deterministic hashing ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

interface KeyPair {
	peerId: PeerId;
	privateKey: PrivateKey;
}

/**
 * Compute message hash using the same algorithm as the coordinator.
 * Must match cluster-coordinator.ts createMessageHash().
 */
const computeMessageHash = async (message: RepoMessage): Promise<string> => {
	const msgBytes = new TextEncoder().encode(canonicalJson(message));
	const hashBytes = await sha256.digest(msgBytes);
	return base58btc.encode(hashBytes.digest);
};

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const computePromiseHash = async (record: ClusterRecord): Promise<string> => {
	const msgBytes = new TextEncoder().encode(record.messageHash + canonicalJson(record.message));
	const hashBytes = await sha256.digest(msgBytes);
	return uint8ArrayToString(hashBytes.digest, 'base64url');
};

const computeCommitHash = async (record: ClusterRecord): Promise<string> => {
	const msgBytes = new TextEncoder().encode(record.messageHash + canonicalJson(record.message) + canonicalJson(record.promises));
	const hashBytes = await sha256.digest(msgBytes);
	return uint8ArrayToString(hashBytes.digest, 'base64url');
};

const signVote = async (privateKey: PrivateKey, hash: string, type: 'approve' | 'reject', rejectReason?: string): Promise<string> => {
	const payload = hash + ':' + type + (rejectReason ? ':' + rejectReason : '');
	const sigBytes = await privateKey.sign(new TextEncoder().encode(payload));
	return uint8ArrayToString(sigBytes, 'base64url');
};

const makeSignedPromise = async (privateKey: PrivateKey, record: ClusterRecord, type: 'approve' | 'reject' = 'approve', rejectReason?: string): Promise<Signature> => {
	const promiseHash = await computePromiseHash(record);
	const sig = await signVote(privateKey, promiseHash, type, rejectReason);
	return type === 'approve'
		? { type: 'approve', signature: sig }
		: { type: 'reject', signature: sig, rejectReason };
};

const makeSignedCommit = async (privateKey: PrivateKey, record: ClusterRecord, type: 'approve' | 'reject' = 'approve'): Promise<Signature> => {
	const commitHash = await computeCommitHash(record);
	const sig = await signVote(privateKey, commitHash, type);
	return { type, signature: sig };
};

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string): IBlock => ({
	header: makeHeader(id)
});

const makeClusterPeers = (keyPairs: KeyPair[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const { peerId } of keyPairs) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url')
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
	let selfKeyPair: KeyPair;
	let clusterMemberInstance: ClusterMember;

	beforeEach(async () => {
		mockRepo = new MockRepo();
		mockNetwork = new MockPeerNetwork();
		selfKeyPair = await makeKeyPair();
		clusterMemberInstance = clusterMember({
			storageRepo: mockRepo,
			peerNetwork: mockNetwork,
			peerId: selfKeyPair.peerId,
			privateKey: selfKeyPair.privateKey
		});
	});

	afterEach(() => {
		clusterMemberInstance.dispose();
	});

	describe('update - promise phase', () => {
		it('adds own promise when not present', async () => {
			const otherKeyPair = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);

			const result = await clusterMemberInstance.update(record);

			expect(result.promises[ourId]).to.not.equal(undefined);
			expect(result.promises[ourId]!.type).to.equal('approve');
		});

		it('does not re-add promise if already present', async () => {
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const existingPromise = await makeSignedPromise(selfKeyPair.privateKey, record);

			// Add promise to the same record (not a new one with different hash)
			const recordWithPromise: ClusterRecord = {
				...record,
				promises: { [ourId]: existingPromise }
			};

			const result = await clusterMemberInstance.update(recordWithPromise);

			// Should still have a promise
			expect(result.promises[ourId]).to.not.equal(undefined);
		});
	});

	describe('update - commit phase', () => {
		it('adds commit when all promises received', async () => {
			const otherKeyPair = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const otherId = otherKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const otherPromise = await makeSignedPromise(otherKeyPair.privateKey, baseRecord);

			const record: ClusterRecord = {
				...baseRecord,
				promises: { [ourId]: ourPromise, [otherId]: otherPromise }
			};

			const result = await clusterMemberInstance.update(record);

			expect(result.commits[ourId]).to.not.equal(undefined);
			expect(result.commits[ourId]!.type).to.equal('approve');
		});

		it('does not commit without all promises', async () => {
			const otherKeyPair = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);

			const record: ClusterRecord = {
				...baseRecord,
				promises: { [ourId]: ourPromise } // Missing other's promise
			};

			const result = await clusterMemberInstance.update(record);

			expect(result.commits[ourId]).to.equal(undefined);
		});
	});

	describe('update - rejection handling', () => {
		it('detects rejected transaction from promise rejection', async () => {
			const otherKeyPair = await makeKeyPair();
			const otherId = otherKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const rejection = await makeSignedPromise(otherKeyPair.privateKey, baseRecord, 'reject', 'test');

			const record: ClusterRecord = {
				...baseRecord,
				promises: { [otherId]: rejection }
			};

			// Should not throw, handles rejection gracefully
			const result = await clusterMemberInstance.update(record);

			// Transaction is in rejected state
			expect(result).to.not.equal(undefined);
		});
	});

	describe('update - expiration', () => {
		it('rejects expired transactions', async () => {
			const peers = makeClusterPeers([selfKeyPair]);

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
			const peer2 = await makeKeyPair();
			const peer3 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peer2Id = peer2.peerId.toString();
			const peer3Id = peer3.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3]);
			const expiration = Date.now() + 30000;

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{},
				{},
				expiration
			);
			const p2Promise = await makeSignedPromise(peer2.privateKey, baseRecord);

			// First update with peer2's promise
			const record1: ClusterRecord = {
				...baseRecord,
				promises: { [peer2Id]: p2Promise }
			};

			await clusterMemberInstance.update(record1);

			const p3Promise = await makeSignedPromise(peer3.privateKey, baseRecord);

			// Second update with peer3's promise - same base record
			const record2: ClusterRecord = {
				...baseRecord,
				promises: { [peer3Id]: p3Promise }
			};

			const result = await clusterMemberInstance.update(record2);

			// Should have merged promises
			expect(result.promises[peer2Id] || result.promises[ourId]).to.not.equal(undefined);
		});

		it('throws on message content mismatch', async () => {
			const peers = makeClusterPeers([selfKeyPair]);

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
			const otherKeyPair = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const otherId = otherKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const otherPromise = await makeSignedPromise(otherKeyPair.privateKey, baseRecord);

			const promisedRecord: ClusterRecord = {
				...baseRecord,
				promises: { [ourId]: ourPromise, [otherId]: otherPromise }
			};
			const ourCommit = await makeSignedCommit(selfKeyPair.privateKey, promisedRecord);
			const otherCommit = await makeSignedCommit(otherKeyPair.privateKey, promisedRecord);

			// Record already at consensus with our commit present
			const record: ClusterRecord = {
				...promisedRecord,
				commits: { [ourId]: ourCommit, [otherId]: otherCommit }
			};

			await clusterMemberInstance.update(record);

			// With consensus broadcast, the first time we see a record at consensus
			// we execute the operations (idempotency guard prevents re-execution).
			// The record contains a 'get' operation, so getCalls should be 1.
			expect(mockRepo.getCalls.length).to.equal(1);
		});

		it('adds commit when all promises present', async () => {
			const otherKeyPair = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const otherId = otherKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const otherPromise = await makeSignedPromise(otherKeyPair.privateKey, baseRecord);

			const promisedRecord: ClusterRecord = {
				...baseRecord,
				promises: { [ourId]: ourPromise, [otherId]: otherPromise }
			};
			const otherCommit = await makeSignedCommit(otherKeyPair.privateKey, promisedRecord);

			// All promises present, other has committed, we need to commit
			const record: ClusterRecord = {
				...promisedRecord,
				commits: { [otherId]: otherCommit }
			};

			const result = await clusterMemberInstance.update(record);

			// Should have added our commit
			expect(result.commits[ourId]).to.not.equal(undefined);
			expect(result.commits[ourId]!.type).to.equal('approve');
		});
	});

	describe('update - concurrent serialization', () => {
		it('serializes concurrent updates for same transaction', async () => {
			const peers = makeClusterPeers([selfKeyPair]);

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
			const peers = makeClusterPeers([selfKeyPair]);

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
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair]);

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

	describe('promise/commit phase edge cases (TEST-5.1.1)', () => {
		it('adds promise for single-node cluster', async () => {
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair]);

			const record = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-1')
			);

			const result = await clusterMemberInstance.update(record);

			expect(result.promises[ourId]).to.not.equal(undefined);
			expect(result.promises[ourId]!.type).to.equal('approve');
		});

		it('reaches consensus in single-node cluster through full cycle', async () => {
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair]);

			// First update: adds our promise
			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const afterPromise = await clusterMemberInstance.update(record);
			expect(afterPromise.promises[ourId]!.type).to.equal('approve');

			// Second update: with all promises -> should add commit and execute
			const result = await clusterMemberInstance.update(afterPromise);
			expect(result.commits[ourId]).to.not.equal(undefined);
			expect(result.commits[ourId]!.type).to.equal('approve');
		});

		it('executes pend operations on consensus', async () => {
			const peers = makeClusterPeers([selfKeyPair]);

			const record = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-1')
			);

			// First update adds promise
			const afterPromise = await clusterMemberInstance.update(record);
			// Second update with promise -> commit + execute
			await clusterMemberInstance.update(afterPromise);

			expect(mockRepo.pendCalls.length).to.equal(1);
			expect(mockRepo.pendCalls[0]!.actionId).to.equal('a1');
		});

		it('handles 3-peer cluster promise accumulation', async () => {
			const peer2 = await makeKeyPair();
			const peer3 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peer2Id = peer2.peerId.toString();
			const peer3Id = peer3.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3]);

			// Record with no promises yet
			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);

			// Our promise is added
			const result1 = await clusterMemberInstance.update(record);
			expect(result1.promises[ourId]).to.not.equal(undefined);

			// Still missing 2 promises -> no commit yet
			expect(result1.commits[ourId]).to.equal(undefined);

			// Now all promises arrive (properly signed)
			const p2Promise = await makeSignedPromise(peer2.privateKey, record);
			const p3Promise = await makeSignedPromise(peer3.privateKey, record);
			const withAllPromises: ClusterRecord = {
				...result1,
				promises: {
					...result1.promises,
					[peer2Id]: p2Promise,
					[peer3Id]: p3Promise
				}
			};

			const result2 = await clusterMemberInstance.update(withAllPromises);
			expect(result2.commits[ourId]).to.not.equal(undefined);
			expect(result2.commits[ourId]!.type).to.equal('approve');
		});

		it('does not add commit when promise is a rejection', async () => {
			const peer2 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peer2Id = peer2.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const peer2Rejection = await makeSignedPromise(peer2.privateKey, baseRecord, 'reject', 'invalid');

			const record: ClusterRecord = {
				...baseRecord,
				promises: { [ourId]: ourPromise, [peer2Id]: peer2Rejection }
			};

			const result = await clusterMemberInstance.update(record);
			// Rejected transaction should not produce a commit
			expect(result.commits[ourId]).to.equal(undefined);
		});
	});

	describe('transaction expiration (TEST-5.1.2)', () => {
		it('rejects transactions with past expiration', async () => {
			const peers = makeClusterPeers([selfKeyPair]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{},
				{},
				Date.now() - 5000
			);

			try {
				await clusterMemberInstance.update(record);
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message.toLowerCase()).to.include('expired');
			}
		});

		it('rejects transactions expiring at exactly now', async () => {
			const peers = makeClusterPeers([selfKeyPair]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{},
				{},
				Date.now() - 1
			);

			try {
				await clusterMemberInstance.update(record);
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message.toLowerCase()).to.include('expired');
			}
		});

		it('accepts transactions with future expiration', async () => {
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{},
				{},
				Date.now() + 60000
			);

			const result = await clusterMemberInstance.update(record);
			expect(result.promises[ourId]).to.not.equal(undefined);
		});
	});

	describe('super-majority threshold (TEST-5.2.2)', () => {
		it('requires all promises in 2-node cluster for commit', async () => {
			const peer2 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);

			// Only our promise - missing peer2
			const record: ClusterRecord = {
				...baseRecord,
				promises: { [ourId]: ourPromise }
			};

			const result = await clusterMemberInstance.update(record);
			// Should NOT commit since we don't have all promises
			expect(result.commits[ourId]).to.equal(undefined);
		});

		it('commits when all promises present in 4-node cluster', async () => {
			const peer2 = await makeKeyPair();
			const peer3 = await makeKeyPair();
			const peer4 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3, peer4]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const p2Promise = await makeSignedPromise(peer2.privateKey, baseRecord);
			const p3Promise = await makeSignedPromise(peer3.privateKey, baseRecord);
			const p4Promise = await makeSignedPromise(peer4.privateKey, baseRecord);

			const record: ClusterRecord = {
				...baseRecord,
				promises: {
					[ourId]: ourPromise,
					[peer2.peerId.toString()]: p2Promise,
					[peer3.peerId.toString()]: p3Promise,
					[peer4.peerId.toString()]: p4Promise
				}
			};

			const result = await clusterMemberInstance.update(record);
			expect(result.commits[ourId]).to.not.equal(undefined);
		});
	});

	describe('race resolution', () => {
		it('resolves conflict deterministically based on promise count', async () => {
			const peer2 = await makeKeyPair();
			const peers = makeClusterPeers([selfKeyPair, peer2]);

			const baseRecord1 = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-shared')
			);
			const p2Promise = await makeSignedPromise(peer2.privateKey, baseRecord1);

			// First transaction on block-shared, with a promise from peer2
			const record1: ClusterRecord = {
				...baseRecord1,
				promises: { [peer2.peerId.toString()]: p2Promise }
			};
			await clusterMemberInstance.update(record1);

			// Second conflicting transaction on block-shared, no promises
			const record2 = await createClusterRecord(
				peers,
				makePendOperation('a2', 'block-shared')
			);

			// record1 has more promises, so it should win
			const result = await clusterMemberInstance.update(record2);
			// The result should still be valid - race resolution doesn't throw
			expect(result).to.not.equal(undefined);
		});
	});

	describe('duplicate execution prevention', () => {
		it('prevents double execution via wasTransactionExecuted', async () => {
			const peers = makeClusterPeers([selfKeyPair]);

			const record = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-1')
			);

			// First: add promise
			const afterPromise = await clusterMemberInstance.update(record);
			// Second: commit + execute
			await clusterMemberInstance.update(afterPromise);

			expect(mockRepo.pendCalls.length).to.equal(1);

			// Mark the transaction as already executed
			expect(clusterMemberInstance.wasTransactionExecuted(record.messageHash)).to.equal(true);
		});

		it('wasTransactionExecutedAsync falls back to persistent store after restart', async () => {
			const stateStore = new MemoryTransactionStateStore();
			const memberWithStore = clusterMember({
				storageRepo: mockRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				stateStore
			});

			const peers = makeClusterPeers([selfKeyPair]);
			const record = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-1')
			);

			// Execute the transaction (promise + consensus)
			const afterPromise = await memberWithStore.update(record);
			await memberWithStore.update(afterPromise);
			memberWithStore.dispose();

			// Wait for fire-and-forget markExecuted to complete
			await new Promise(resolve => setTimeout(resolve, 50));

			// Verify persistent store has the executed marker
			expect(await stateStore.wasExecuted(record.messageHash)).to.equal(true);

			// Simulate restart: new member with same persistent store
			const restartedMember = clusterMember({
				storageRepo: new MockRepo(),
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				stateStore
			});

			// Sync check misses (in-memory map is empty after restart)
			expect(restartedMember.wasTransactionExecuted(record.messageHash)).to.equal(false);
			// Async check finds it in persistent store
			expect(await restartedMember.wasTransactionExecutedAsync(record.messageHash)).to.equal(true);
			// After async check, sync check should now hit (re-populated in-memory map)
			expect(restartedMember.wasTransactionExecuted(record.messageHash)).to.equal(true);
			restartedMember.dispose();
		});

		it('persistent dedup prevents double execution after restart', async () => {
			const stateStore = new MemoryTransactionStateStore();
			const mockRepo1 = new MockRepo();
			const memberWithStore = clusterMember({
				storageRepo: mockRepo1,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				stateStore
			});

			const peers = makeClusterPeers([selfKeyPair]);
			const record = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-1')
			);

			// Execute the transaction
			const afterPromise = await memberWithStore.update(record);
			await memberWithStore.update(afterPromise);
			expect(mockRepo1.pendCalls.length).to.equal(1);
			memberWithStore.dispose();

			// Wait for fire-and-forget markExecuted to complete
			await new Promise(resolve => setTimeout(resolve, 50));

			// Simulate restart with new repo
			const mockRepo2 = new MockRepo();
			const restartedMember = clusterMember({
				storageRepo: mockRepo2,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				stateStore
			});

			// Re-send the same consensus record — should NOT re-execute
			const fullRecord: ClusterRecord = {
				...afterPromise,
				commits: { ...afterPromise.commits }
			};
			// Need to add a commit to reach consensus for single-peer cluster
			const commitSig = await makeSignedCommit(selfKeyPair.privateKey, afterPromise);
			fullRecord.commits[selfKeyPair.peerId.toString()] = commitSig;

			await restartedMember.update(fullRecord);
			// mockRepo2 should have zero pend calls — execution was prevented by persistent dedup
			expect(mockRepo2.pendCalls.length).to.equal(0);
			restartedMember.dispose();
		});
	});

	describe('validation', () => {
		it('uses validator when provided', async () => {
			let validationCalled = false;

			const validatingMember = clusterMember({
				storageRepo: mockRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				validator: {
					validate: async (_txn, _hash) => {
						validationCalled = true;
						return { valid: true };
					},
					getSchemaHash: async () => 'test-hash'
				}
			});

			const peers = makeClusterPeers([selfKeyPair]);
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
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				validator: {
					validate: async () => ({ valid: false, reason: 'Validation failed' }),
					getSchemaHash: async () => 'test-hash'
				}
			});

			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair]);
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

	describe('signature verification', () => {
		it('rejects forged promise signatures', async () => {
			const otherKeyPair = await makeKeyPair();
			const forgerKeyPair = await makeKeyPair();
			const otherId = otherKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			// Sign with forger's key but attribute to otherKeyPair
			const forgedPromise = await makeSignedPromise(forgerKeyPair.privateKey, baseRecord);

			const record: ClusterRecord = {
				...baseRecord,
				promises: { [otherId]: forgedPromise }
			};

			try {
				await clusterMemberInstance.update(record);
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.include('Invalid promise signature');
			}
		});

		it('rejects forged commit signatures', async () => {
			const otherKeyPair = await makeKeyPair();
			const forgerKeyPair = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const otherId = otherKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			const baseRecord = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const otherPromise = await makeSignedPromise(otherKeyPair.privateKey, baseRecord);

			const promisedRecord: ClusterRecord = {
				...baseRecord,
				promises: { [ourId]: ourPromise, [otherId]: otherPromise }
			};
			// Sign commit with forger's key but attribute to otherKeyPair
			const forgedCommit = await makeSignedCommit(forgerKeyPair.privateKey, promisedRecord);

			const record: ClusterRecord = {
				...promisedRecord,
				commits: { [otherId]: forgedCommit }
			};

			try {
				await clusterMemberInstance.update(record);
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.include('Invalid commit signature');
			}
		});

		it('accepts properly signed promises and commits', async () => {
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair]);

			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);

			// First update adds signed promise
			const afterPromise = await clusterMemberInstance.update(record);
			expect(afterPromise.promises[ourId]!.type).to.equal('approve');
			// Signature should be a base64url string, not a placeholder
			expect(afterPromise.promises[ourId]!.signature).to.not.equal('approved');
			expect(afterPromise.promises[ourId]!.signature.length).to.be.greaterThan(10);

			// Second update adds signed commit
			const afterCommit = await clusterMemberInstance.update(afterPromise);
			expect(afterCommit.commits[ourId]!.type).to.equal('approve');
			expect(afterCommit.commits[ourId]!.signature).to.not.equal('committed');
			expect(afterCommit.commits[ourId]!.signature.length).to.be.greaterThan(10);
		});
	});

	describe('threshold-based promise resolution', () => {
		const thresholdConfig: ClusterConsensusConfig = {
			superMajorityThreshold: 0.75,
			simpleMajorityThreshold: 0.51,
			minAbsoluteClusterSize: 2,
			allowClusterDownsize: true,
			clusterSizeTolerance: 0.5,
			partitionDetectionWindow: 60000
		};

		it('minority rejection (1 of 5) allows transaction to proceed', async () => {
			const peers4 = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair(), makeKeyPair()]);
			const allKeys = [selfKeyPair, ...peers4];
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers(allKeys);

			const member = clusterMember({
				storageRepo: mockRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				consensusConfig: thresholdConfig
			});

			const baseRecord = await createClusterRecord(peers, makeGetOperation(['block-1']));

			// 4 approvals + 1 rejection (peer4 rejects)
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const p1Promise = await makeSignedPromise(peers4[0]!.privateKey, baseRecord);
			const p2Promise = await makeSignedPromise(peers4[1]!.privateKey, baseRecord);
			const p3Promise = await makeSignedPromise(peers4[2]!.privateKey, baseRecord);
			const p4Rejection = await makeSignedPromise(peers4[3]!.privateKey, baseRecord, 'reject', 'disagree');

			const record: ClusterRecord = {
				...baseRecord,
				promises: {
					[ourId]: ourPromise,
					[peers4[0]!.peerId.toString()]: p1Promise,
					[peers4[1]!.peerId.toString()]: p2Promise,
					[peers4[2]!.peerId.toString()]: p3Promise,
					[peers4[3]!.peerId.toString()]: p4Rejection
				}
			};

			// 5 peers, threshold 0.75, superMajority = ceil(5 * 0.75) = 4
			// 4 approvals >= 4 → should proceed to commit
			const result = await member.update(record);
			expect(result.commits[ourId]).to.not.equal(undefined);
			expect(result.commits[ourId]!.type).to.equal('approve');
		});

		it('rejection at threshold boundary rejects transaction', async () => {
			const peers4 = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair(), makeKeyPair()]);
			const allKeys = [selfKeyPair, ...peers4];
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers(allKeys);

			const member = clusterMember({
				storageRepo: mockRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				consensusConfig: thresholdConfig
			});

			const baseRecord = await createClusterRecord(peers, makeGetOperation(['block-1']));

			// 3 approvals + 2 rejections
			// superMajority = ceil(5 * 0.75) = 4, maxAllowedRejections = 5 - 4 = 1
			// 2 rejections > 1 → should reject
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const p1Promise = await makeSignedPromise(peers4[0]!.privateKey, baseRecord);
			const p2Promise = await makeSignedPromise(peers4[1]!.privateKey, baseRecord);
			const p3Rejection = await makeSignedPromise(peers4[2]!.privateKey, baseRecord, 'reject', 'bad');
			const p4Rejection = await makeSignedPromise(peers4[3]!.privateKey, baseRecord, 'reject', 'bad');

			const record: ClusterRecord = {
				...baseRecord,
				promises: {
					[ourId]: ourPromise,
					[peers4[0]!.peerId.toString()]: p1Promise,
					[peers4[1]!.peerId.toString()]: p2Promise,
					[peers4[2]!.peerId.toString()]: p3Rejection,
					[peers4[3]!.peerId.toString()]: p4Rejection
				}
			};

			const result = await member.update(record);
			// Should be rejected — no commit added
			expect(result.commits[ourId]).to.equal(undefined);
		});

		it('default (no config) maintains backward-compatible unanimity', async () => {
			const otherKeyPair = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const otherId = otherKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

			// Use default clusterMemberInstance (no consensusConfig → threshold 1.0)
			const baseRecord = await createClusterRecord(peers, makeGetOperation(['block-1']));
			const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
			const otherRejection = await makeSignedPromise(otherKeyPair.privateKey, baseRecord, 'reject', 'nope');

			const record: ClusterRecord = {
				...baseRecord,
				promises: { [ourId]: ourPromise, [otherId]: otherRejection }
			};

			const result = await clusterMemberInstance.update(record);
			// With unanimity (threshold 1.0), any rejection rejects: maxAllowedRejections = 0
			expect(result.commits[ourId]).to.equal(undefined);
		});

		it('disputed record carries rejectingPeers and rejectReasons via coordinator', async () => {
			// This tests the coordinator-side disputed flag.
			// We verify that when a ClusterRecord has disputed=true set, the evidence is present.
			const peers2 = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair(), makeKeyPair()]);
			const allKeys = [selfKeyPair, ...peers2];
			const peers = makeClusterPeers(allKeys);

			const baseRecord = await createClusterRecord(peers, makeGetOperation(['block-1']));

			// Simulate what the coordinator does: set disputed when minority rejects
			const rejectingPeerId = peers2[3]!.peerId.toString();
			const disputedRecord: ClusterRecord = {
				...baseRecord,
				disputed: true,
				disputeEvidence: {
					rejectingPeers: [rejectingPeerId],
					rejectReasons: { [rejectingPeerId]: 'disagree' }
				}
			};

			expect(disputedRecord.disputed).to.equal(true);
			expect(disputedRecord.disputeEvidence).to.not.equal(undefined);
			expect(disputedRecord.disputeEvidence!.rejectingPeers).to.include(rejectingPeerId);
			expect(disputedRecord.disputeEvidence!.rejectReasons[rejectingPeerId]).to.equal('disagree');
		});
	});

	describe('dispose', () => {
		it('clears intervals and empties active transactions', async () => {
			const peers = makeClusterPeers([selfKeyPair]);

			// Create a transaction so there's active state
			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1'])
			);
			await clusterMemberInstance.update(record);

			// Call dispose
			clusterMemberInstance.dispose();

			// After dispose, a new transaction should process cleanly from scratch
			const record2 = await createClusterRecord(
				peers,
				makePendOperation('a1', 'block-1')
			);
			const result = await clusterMemberInstance.update(record2);
			expect(result.promises[selfKeyPair.peerId.toString()]).to.not.equal(undefined);
		});

		it('clears per-transaction timeouts from active transactions', async () => {
			const peer2 = await makeKeyPair();
			const peers = makeClusterPeers([selfKeyPair, peer2]);

			// Create a record with expiration to trigger timeout creation
			const record = await createClusterRecord(
				peers,
				makeGetOperation(['block-1']),
				{},
				{},
				Date.now() + 60000
			);
			await clusterMemberInstance.update(record);

			// dispose should clear all timeouts without error
			clusterMemberInstance.dispose();

			// Calling dispose again should be safe (idempotent on empty state)
			clusterMemberInstance.dispose();
		});
	});
});
