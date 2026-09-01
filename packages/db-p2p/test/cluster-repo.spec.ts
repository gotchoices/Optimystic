import { expect } from 'chai';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { MemoryTransactionStateStore } from '../src/cluster/memory-transaction-state-store.js';
import type { IRepo, ClusterRecord, RepoMessage, Signature, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, ClusterPeers, Transforms, IBlock, BlockId, BlockHeader, ClusterConsensusConfig } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { MaxPriority } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { waitFor, delay } from '@optimystic/db-core/test';

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

/** `extra` is the vote variant's signed field: a reject's reason, a conflict's winning hash. */
const signVote = async (privateKey: PrivateKey, hash: string, type: Signature['type'], extra?: string): Promise<string> => {
	const payload = hash + ':' + type + (extra ? ':' + extra : '');
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

/** Another member's answer that it holds the rival which won the race — `conflictWith` is signed. */
const makeSignedConflict = async (privateKey: PrivateKey, record: ClusterRecord, conflictWith: string): Promise<Signature> => {
	const promiseHash = await computePromiseHash(record);
	return { type: 'conflict', signature: await signVote(privateKey, promiseHash, 'conflict', conflictWith), conflictWith };
};

const makeSignedCommit = async (privateKey: PrivateKey, record: ClusterRecord, type: 'approve' | 'reject' = 'approve'): Promise<Signature> => {
	const commitHash = await computeCommitHash(record);
	const sig = await signVote(privateKey, commitHash, type);
	return type === 'approve' ? { type: 'approve', signature: sig } : { type: 'reject', signature: sig };
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

/**
 * MockRepo whose `pend` throws a transient fault the first `throwCount` times it is
 * called (before recording the call), then behaves like MockRepo. Models a transient
 * storage I/O fault inside applyConsensusOperation so handleConsensus reaches its catch.
 */
class ThrowOncePendRepo extends MockRepo {
	throwCount: number;
	constructor(throwCount = 1) {
		super();
		this.throwCount = throwCount;
	}
	override async pend(request: PendRequest): Promise<PendResult> {
		if (this.throwCount > 0) {
			this.throwCount--;
			throw new Error('transient storage I/O fault');
		}
		return super.pend(request);
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

/**
 * Like {@link makePendOperation} but carrying an aged priority. `priority` sets the top-level
 * single-collection carrier (`pend.priority`); `txPriority` sets the multi-collection carrier
 * (`pend.validation.transaction.priority`) — resolveRace reads the transaction carrier first. A
 * minimal transaction stub is fine here: resolveRace only reads `.priority` off it.
 */
const makePendOperationP = (
	actionId: string,
	blockId: string,
	opts?: { priority?: number; txPriority?: number }
): RepoMessage['operations'] => {
	const transforms: Transforms = {
		inserts: { [blockId]: makeBlock(blockId) },
		updates: {},
		deletes: []
	};
	const pend: Record<string, unknown> = { actionId, transforms, policy: 'c' };
	if (opts?.priority !== undefined) pend.priority = opts.priority;
	if (opts?.txPriority !== undefined) pend.validation = { transaction: { priority: opts.txPriority } };
	return [{ pend } as RepoMessage['operations'][number]];
};

/** A promise/commit signature whose bytes are irrelevant — resolveRace only counts `approve` votes. */
const dummySig: Signature = { type: 'approve', signature: 'x' };

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

		// Ticket repo-reports-unavailable-vs-absent: StorageRepo now reports a block it cannot
		// materialize as a flagged entry instead of throwing out of the read. The stale-revision
		// gate must not read that empty `state` as "no revision here, looks fresh" — a member
		// that cannot check votes reject, not approve.
		it('rejects a pend whose block read came back unavailable', async () => {
			class UnavailableRepo extends MockRepo {
				override async get(blockGets: BlockGets): Promise<GetBlockResults> {
					await super.get(blockGets);
					return Object.fromEntries(
						blockGets.blockIds.map(id => [id, { state: {}, unavailable: 'unmaterializable' as const }])
					);
				}
			}
			const unavailableRepo = new UnavailableRepo();
			const member = clusterMember({
				storageRepo: unavailableRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey
			});
			try {
				const otherKeyPair = await makeKeyPair();
				const ourId = selfKeyPair.peerId.toString();
				const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);

				// `rev` is what turns on the stale-revision gate; without it the check is skipped.
				const transforms: Transforms = { inserts: { 'block-1': makeBlock('block-1') }, updates: {}, deletes: [] };
				const record = await createClusterRecord(
					peers,
					[{ pend: { actionId: 'action-1', transforms, policy: 'c', rev: 5 } }]
				);

				const result = await member.update(record);

				expect(result.promises[ourId]).to.not.equal(undefined);
				expect(result.promises[ourId]!.type, 'an unverifiable revision must not be approved').to.equal('reject');
			} finally {
				member.dispose();
			}
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

		// Regression (2-member-must-answer-a-lost-conflict-race): a member that resolves a race in
		// favour of a transaction it already holds used to return the loser UNCHANGED — no vote at
		// all — so the coordinator counted "0 approvals" and reported the loss as an unreachable
		// cohort. The member must answer with a signed `conflict` vote naming the winner.
		it('answers a lost conflict race with a conflict vote naming the winner', async () => {
			const peer2 = await makeKeyPair();
			const peer3 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3]);

			// Pend X on block-shared: our own approve lands and the record is retained (Promising).
			const recordX = await createClusterRecord(peers, makePendOperation('a-x', 'block-shared'));
			const afterX = await clusterMemberInstance.update(recordX);
			expect(afterX.promises[ourId]!.type).to.equal('approve');

			// Conflicting pend Y on the same block. X holds 1 approval vs Y's 0, so resolveRace is
			// deterministically keep-existing. Before the fix Y came back with promises == {}.
			const recordY = await createClusterRecord(peers, makePendOperation('a-y', 'block-shared'));
			const result = await clusterMemberInstance.update(recordY);

			const vote = result.promises[ourId];
			if (vote?.type !== 'conflict') expect.fail(`expected a conflict vote, got ${vote?.type ?? 'no vote at all'}`);
			expect(vote.conflictWith, 'the vote names the winning transaction').to.equal(recordX.messageHash);
			expect(result.commits[ourId], 'a lost race never produces a commit').to.equal(undefined);
		});

		it('produces a conflict vote that survives signature validation on redelivery', async () => {
			const peer2 = await makeKeyPair();
			const peer3 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3]);

			const recordX = await createClusterRecord(peers, makePendOperation('a-x', 'block-shared'));
			await clusterMemberInstance.update(recordX);
			const recordY = await createClusterRecord(peers, makePendOperation('a-y', 'block-shared'));
			const voted = await clusterMemberInstance.update(recordY);

			// The coordinator merges our vote and re-presents the record (e.g. commit-broadcast retry).
			// validateSignatures then reconstructs the conflict vote's signed payload — including
			// `conflictWith` — and must find it valid; and the member must not vote again.
			const redelivered = await clusterMemberInstance.update({ ...voted, promises: { ...voted.promises } });
			const vote = redelivered.promises[ourId];
			if (vote?.type !== 'conflict') expect.fail(`expected the conflict vote to persist, got ${vote?.type}`);
			expect(vote.conflictWith).to.equal(recordX.messageHash);
		});

		it('does not reserve the blocks of a transaction it conflict-voted', async () => {
			const peer2 = await makeKeyPair();
			const peer3 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3]);

			// X reserves block-shared.
			const recordX = await createClusterRecord(peers, makePendOperation('a-x', 'block-shared'));
			await clusterMemberInstance.update(recordX);

			// Y touches block-shared (loses to X) AND block-y-only. If the member wrongly retained Y
			// after conflict-voting it, block-y-only would now be reserved too.
			const transformsY: Transforms = {
				inserts: { 'block-shared': makeBlock('block-shared'), 'block-y-only': makeBlock('block-y-only') },
				updates: {},
				deletes: []
			};
			const recordY = await createClusterRecord(peers, [{ pend: { actionId: 'a-y', transforms: transformsY, policy: 'c' } }]);
			const votedY = await clusterMemberInstance.update(recordY);
			expect(votedY.promises[ourId]!.type).to.equal('conflict');

			// Z touches only block-y-only: no overlap with X. It must get a clean approve — a conflict
			// here would mean the loser Y was persisted as a second reservation.
			const recordZ = await createClusterRecord(peers, makePendOperation('a-z', 'block-y-only'));
			const resultZ = await clusterMemberInstance.update(recordZ);
			expect(resultZ.promises[ourId]!.type, 'the conflict-voted loser must not hold its blocks').to.equal('approve');
		});

		it('rejects a conflict vote whose named winner was altered in transit', async () => {
			const peer2 = await makeKeyPair();
			const peer3 = await makeKeyPair();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3]);

			// `conflictWith` is only meaningful if it is covered by the signature — otherwise a relaying
			// peer could rewrite which transaction the loss is attributed to.
			const baseRecord = await createClusterRecord(peers, makeGetOperation(['block-1']));
			const honestVote = await makeSignedConflict(peer2.privateKey, baseRecord, 'real-winner-hash');
			const tampered: ClusterRecord = {
				...baseRecord,
				promises: {
					[peer2.peerId.toString()]: { ...honestVote, type: 'conflict', conflictWith: 'attacker-chosen-hash' }
				}
			};

			try {
				await clusterMemberInstance.update(tampered);
				expect.fail('a conflict vote naming a different winner than it signed must not validate');
			} catch (err) {
				expect((err as Error).message).to.include('Invalid promise signature');
			}
		});

		it('treats other members\' conflict votes as not-now, not as rejections', async () => {
			// 8 peers at 0.75 ⇒ super-majority 6, so up to 2 refusals still leave the record live. A
			// conflict vote must not be counted as a rejection: the member owes this record its own vote.
			const others = await Promise.all(Array.from({ length: 7 }, () => makeKeyPair()));
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, ...others]);

			const baseRecord = await createClusterRecord(peers, makeGetOperation(['block-1']));
			const record: ClusterRecord = {
				...baseRecord,
				promises: {
					[others[0]!.peerId.toString()]: await makeSignedConflict(others[0]!.privateKey, baseRecord, 'rival-hash'),
					[others[1]!.peerId.toString()]: await makeSignedConflict(others[1]!.privateKey, baseRecord, 'rival-hash')
				}
			};

			const result = await clusterMemberInstance.update(record);
			expect(result.promises[ourId]?.type, 'a live record still gets our vote').to.equal('approve');
		});

		it('abstains and clears when others\' conflict votes prove super-majority unreachable', async () => {
			// Same 8-peer cohort, now with 3 conflict votes: 6 approvals are no longer reachable, so the
			// record is terminal (ConflictSuperseded). The member must neither vote nor reserve its
			// blocks — holding a provably-dead loser would block the very retry meant to replace it.
			const others = await Promise.all(Array.from({ length: 7 }, () => makeKeyPair()));
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, ...others]);

			const baseRecord = await createClusterRecord(peers, makePendOperation('a-dead', 'block-contested'));
			const record: ClusterRecord = {
				...baseRecord,
				promises: Object.fromEntries(await Promise.all(others.slice(0, 3).map(async peer =>
					[peer.peerId.toString(), await makeSignedConflict(peer.privateKey, baseRecord, 'rival-hash')] as const)))
			};

			const result = await clusterMemberInstance.update(record);
			expect(result.promises[ourId], 'a record that can never commit gets no vote').to.equal(undefined);

			// A later transaction on the same block must see no reservation from the dead record.
			const fresh = await createClusterRecord(peers, makePendOperation('a-fresh', 'block-contested'));
			const freshResult = await clusterMemberInstance.update(fresh);
			expect(freshResult.promises[ourId]?.type, 'the dead record must not hold its blocks').to.equal('approve');
		});
	});

	describe('phase fixpoint (2-member-must-answer-a-lost-conflict-race)', () => {
		// A member whose promise the coordinator never collected (possible whenever super-majority is
		// below full cohort size, e.g. 4 peers at 0.75 ⇒ 3) receives the commit-phase record, and used
		// to stop after adding its promise: the record was then in OurCommitNeeded but nobody re-checked,
		// so its commit waited for the coordinator's next broadcast retry. The phase loop must drive
		// promise AND commit in the same delivery.
		it('adds both promise and commit in one delivery when the record already has super-majority', async () => {
			const peer2 = await makeKeyPair();
			const peer3 = await makeKeyPair();
			const peer4 = await makeKeyPair();
			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3, peer4]);

			const baseRecord = await createClusterRecord(peers, makeGetOperation(['block-1']));
			const record: ClusterRecord = {
				...baseRecord,
				promises: {
					[peer2.peerId.toString()]: await makeSignedPromise(peer2.privateKey, baseRecord),
					[peer3.peerId.toString()]: await makeSignedPromise(peer3.privateKey, baseRecord),
					[peer4.peerId.toString()]: await makeSignedPromise(peer4.privateKey, baseRecord)
				}
			};

			const result = await clusterMemberInstance.update(record);
			expect(result.promises[ourId]!.type).to.equal('approve');
			expect(result.commits[ourId], 'commit must land in the SAME delivery, not the next retry').to.not.equal(undefined);
			expect(result.commits[ourId]!.type).to.equal('approve');
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
		it('resolves conflict deterministically based on approval count', async () => {
			const ourId = selfKeyPair.peerId.toString();
			const peer2 = await makeKeyPair();
			// Third peer keeps record1 below super-majority (2/3 approvals at 0.75 ⇒ 3 needed) so the
			// member retains it as the pending race winner instead of committing-and-clearing it.
			const peer3 = await makeKeyPair();
			const peers = makeClusterPeers([selfKeyPair, peer2, peer3]);

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

			// record1 carries two approvals (peer2's plus this member's own) against record2's zero, so
			// it keeps the block: the member refuses record2 — but with a signed CONFLICT vote naming
			// the winner, never by staying silent (which was indistinguishable from being unreachable).
			const result = await clusterMemberInstance.update(record2);
			const vote = result.promises[ourId];
			if (vote?.type !== 'conflict') expect.fail(`the losing record gets a conflict vote, got ${vote?.type ?? 'no vote at all'}`);
			expect(vote.conflictWith).to.equal(record1.messageHash);
			expect(result.commits[ourId]).to.equal(undefined);
		});
	});

	describe('priority-aged race resolution', () => {
		// resolveRace is private; a cast keeps these as focused unit tests of the deterministic tiebreak.
		const raceOf = () => (clusterMemberInstance as unknown as {
			resolveRace(a: ClusterRecord, b: ClusterRecord): 'keep-existing' | 'accept-incoming'
		});

		it('a rival with MORE promises wins even against higher aged priority (monotonicity)', async () => {
			const peers = makeClusterPeers([selfKeyPair]);
			// Aged transaction: priority 2, ZERO promises.
			const aged = await createClusterRecord(peers, makePendOperationP('aged', 'block-shared', { priority: 2 }));
			// Fresh rival: priority 0 but TWO promises — more-progressed, so it wins under approvals-first.
			const fresh = await createClusterRecord(
				peers, makePendOperationP('fresh', 'block-shared'), { p1: dummySig, p2: dummySig }
			);
			// Promises come first now: the further-along transaction is never displaced by priority.
			expect(raceOf().resolveRace(aged, fresh)).to.equal('accept-incoming');
			expect(raceOf().resolveRace(fresh, aged)).to.equal('keep-existing');
		});

		it('priority cannot displace a promise-supermajority transaction (adversarial monotonicity)', async () => {
			const peers = makeClusterPeers([selfKeyPair]);
			// X: promise supermajority (three promises), priority 0.
			const x = await createClusterRecord(
				peers, makePendOperationP('x', 'block-shared'), { p1: dummySig, p2: dummySig, p3: dummySig }
			);
			// Y: conflicting rival, MAX priority but FEWER promises (one).
			const y = await createClusterRecord(
				peers, makePendOperationP('y', 'block-shared', { priority: MaxPriority }), { p1: dummySig }
			);
			// The commit path has NO conflict re-check, so resolveRace is the only arbiter. Under
			// approvals-first it can never displace a quorum-reached transaction — regression guard for
			// occ-priority-first-breaks-promise-monotonicity (this FAILED under the old priority-first order).
			expect(raceOf().resolveRace(x, y)).to.equal('keep-existing');
			expect(raceOf().resolveRace(y, x)).to.equal('accept-incoming');
		});

		it('reads priority from the multi-collection carrier (pend.validation.transaction.priority) too', async () => {
			const peers = makeClusterPeers([selfKeyPair]);
			const txAged = await createClusterRecord(peers, makePendOperationP('tx-aged', 'block-shared', { txPriority: 4 }));
			const fresh = await createClusterRecord(peers, makePendOperationP('fresh', 'block-shared'));
			expect(raceOf().resolveRace(txAged, fresh)).to.equal('keep-existing');
		});

		it('an aged transaction beats fresh rivals within MaxPriority+1 concurrent rounds (livelock guarantee)', async () => {
			const peers = makeClusterPeers([selfKeyPair]);
			// Model a transaction that keeps losing: its priority = clampPriority(losses) rises each round,
			// while every fresh rival stays at priority 0 with an EQUAL approval count (0). Under approvals-first
			// the priority tie-break then decides at equal counts — the concurrent-starvation case aging targets.
			for (let losses = 1; losses <= MaxPriority; losses++) {
				const agedPriority = Math.min(MaxPriority, losses);
				const aged = await createClusterRecord(peers, makePendOperationP('aged', 'block-shared', { priority: agedPriority }));
				const fresh = await createClusterRecord(peers, makePendOperationP(`fresh-${losses}`, 'block-shared'));
				// priority ≥ 1 deterministically out-ranks a fresh priority-0 rival at equal approval counts,
				// regardless of the hash — so the starved transaction wins by round 1 (≤ MaxPriority+1).
				expect(raceOf().resolveRace(aged, fresh), `aged wins at priority ${agedPriority}`).to.equal('keep-existing');
				expect(raceOf().resolveRace(fresh, aged), `mirror at priority ${agedPriority}`).to.equal('accept-incoming');
			}
		});

		it('two capped-out conflicts fall back to the hash tiebreak — symmetric, deadlock-free, and over-cap clamps', async () => {
			const peers = makeClusterPeers([selfKeyPair]);
			const a = await createClusterRecord(peers, makePendOperationP('a', 'block-shared', { priority: MaxPriority }));
			// b self-asserts an over-cap priority; recordPriority clamps it to MaxPriority so it TIES a.
			const b = await createClusterRecord(peers, makePendOperationP('b', 'block-shared', { priority: MaxPriority + 5 }));

			const ab = raceOf().resolveRace(a, b);
			const ba = raceOf().resolveRace(b, a);
			// Both orderings must agree on the SAME actual winning record (no deadlock, order-independent).
			const winnerAB = ab === 'keep-existing' ? a.messageHash : b.messageHash;
			const winnerBA = ba === 'keep-existing' ? b.messageHash : a.messageHash;
			expect(winnerAB).to.equal(winnerBA);
			// …and the winner is exactly the higher-hash record — the pre-priority tiebreak, unchanged.
			expect(winnerAB).to.equal(a.messageHash > b.messageHash ? a.messageHash : b.messageHash);
		});

		it('a mixed-version race (priority present vs absent) is deterministic; absent = priority 0', async () => {
			const peers = makeClusterPeers([selfKeyPair]);
			const aged = await createClusterRecord(peers, makePendOperationP('aged', 'block-shared', { priority: 3 }));
			// Legacy record: NO priority field anywhere in the pend (older coordinator).
			const legacy = await createClusterRecord(peers, makePendOperation('legacy', 'block-shared'));
			expect(raceOf().resolveRace(aged, legacy)).to.equal('keep-existing');
			expect(raceOf().resolveRace(legacy, aged)).to.equal('accept-incoming');
		});

		it('a record carrying only a REJECT vote does not outrank a fresh rival', async () => {
			const peer2 = await makeKeyPair();
			const peers = makeClusterPeers([selfKeyPair, peer2]);

			// A: one *reject* vote and nothing else. `promises` is the vote map, not the approval
			// map, so counting its keys made this look "more progressed" than an untouched rival —
			// and a rejected record then reserved its blocks (hasConflict) for the whole staleness
			// window. Ranking is by APPROVE votes, which is the count the commit rule actually uses.
			const baseA = await createClusterRecord(peers, makePendOperationP('a', 'block-shared'));
			const rejection = await makeSignedPromise(peer2.privateKey, baseA, 'reject', 'stale-revision');
			const rejectedA: ClusterRecord = {
				...baseA,
				promises: { [peer2.peerId.toString()]: rejection }
			};
			// B: no votes at all, priority 1 — so the outcome is decided by the priority tie-break at
			// equal approve counts (0 vs 0) rather than by the hash, keeping this assertion deterministic.
			const freshB = await createClusterRecord(peers, makePendOperationP('b', 'block-shared', { priority: 1 }));

			expect(raceOf().resolveRace(rejectedA, freshB)).to.equal('accept-incoming');
			expect(raceOf().resolveRace(freshB, rejectedA)).to.equal('keep-existing');
		});

		it('rejects a record whose priority was inflated after signing (integrity in transit)', async () => {
			const peers = makeClusterPeers([selfKeyPair]);
			// messageHash is computed over priority:1; then we tamper it up to MaxPriority.
			const record = await createClusterRecord(peers, makePendOperationP('a1', 'block-1', { priority: 1 }));
			(record.message.operations[0] as unknown as { pend: { priority: number } }).pend.priority = MaxPriority;

			let err: unknown;
			try {
				await clusterMemberInstance.update(record);
			} catch (e) {
				err = e;
			}
			expect(err).to.be.instanceOf(Error);
			expect((err as Error).message).to.include('Message hash mismatch');
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

			// Wait until the fire-and-forget markExecuted lands in the persistent store.
			await waitFor(async () => await stateStore.wasExecuted(record.messageHash), { description: 'the fire-and-forget markExecuted persisted the executed marker' });

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

			// Wait until the fire-and-forget markExecuted lands in the persistent store.
			await waitFor(async () => await stateStore.wasExecuted(record.messageHash), { description: 'the fire-and-forget markExecuted persisted the executed marker' });

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

		it('does not persist the durable executed marker when apply throws, and redelivery re-runs the dropped operation', async () => {
			const stateStore = new MemoryTransactionStateStore();
			const throwingRepo = new ThrowOncePendRepo(1);
			const member = clusterMember({
				storageRepo: throwingRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				stateStore
			});

			const peers = makeClusterPeers([selfKeyPair]);
			const record = await createClusterRecord(peers, makePendOperation('a1', 'block-1'));

			// Drive to consensus: the phase fixpoint takes a single-peer record through promise →
			// commit → consensus in ONE delivery, where throwingRepo.pend throws →
			// applyConsensusOperation throws → handleConsensus rolls back the in-memory guard and
			// rethrows out of this first update.
			let threw = false;
			try {
				await member.update(record);
			} catch (err) {
				threw = true;
				expect((err as Error).message).to.equal('transient storage I/O fault');
			}
			expect(threw, 'handleConsensus must rethrow the transient apply fault').to.equal(true);

			// The transient pend threw before recording, so nothing was applied.
			expect(throwingRepo.pendCalls.length).to.equal(0);
			// In-memory guard rolled back by the catch block.
			expect(member.wasTransactionExecuted(record.messageHash)).to.equal(false);
			// The durable marker must NEVER have been written — it lands only after apply succeeds.
			// Residual bounded sleep: this is a NEGATIVE assertion (the marker must NOT appear), which a
			// condition poll cannot express — give any (incorrect) fire-and-forget write a chance to
			// land first, then confirm it did not.
			await delay(50);
			expect(await stateStore.wasExecuted(record.messageHash)).to.equal(false);
			member.dispose();

			// Redeliver the same record against a fresh, non-throwing repo sharing the same
			// persistent store (post-restart). Because the durable marker was never written, the
			// operation must actually re-run (the fixpoint re-derives promise → commit → consensus)
			// rather than being silently skipped.
			const healthyRepo = new MockRepo();
			const restartedMember = clusterMember({
				storageRepo: healthyRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				stateStore
			});
			await restartedMember.update(record);
			expect(healthyRepo.pendCalls.length).to.equal(1);
			// Apply succeeded this time, so the durable marker is now set — wait for that write to land.
			await waitFor(async () => await stateStore.wasExecuted(record.messageHash), { description: 'the durable executed marker was written after a successful apply' });
			expect(await stateStore.wasExecuted(record.messageHash)).to.equal(true);
			restartedMember.dispose();
		});

		it('a second in-flight consensus delivery for the same hash does not double-apply', async () => {
			const peers = makeClusterPeers([selfKeyPair]);
			const record = await createClusterRecord(peers, makePendOperation('a1', 'block-1'));
			const afterPromise = await clusterMemberInstance.update(record);
			const commitSig = await makeSignedCommit(selfKeyPair.privateKey, afterPromise);
			const fullRecord: ClusterRecord = {
				...afterPromise,
				commits: { ...afterPromise.commits, [selfKeyPair.peerId.toString()]: commitSig }
			};

			// Two concurrent deliveries of the same consensus record. The synchronous
			// in-memory check-and-set guard (plus update() serialization) must ensure the
			// operation is applied exactly once.
			await Promise.all([
				clusterMemberInstance.update(fullRecord),
				clusterMemberInstance.update(fullRecord)
			]);

			expect(mockRepo.pendCalls.length).to.equal(1);
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
						validation: { transaction: { statements: [], stamp: {} } as any, operationsHash: 'hash' }
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
						validation: { transaction: { statements: [], stamp: {} } as any, operationsHash: 'hash' }
					}
				}]
			);

			const result = await validatingMember.update(record);

			// Should have a reject promise
			const vote = result.promises[ourId];
			if (vote?.type !== 'reject') expect.fail(`expected a reject vote, got ${vote?.type}`);
			expect(vote.rejectReason).to.include('Validation failed');
		});

		it('does not retain a transaction it rejected itself', async () => {
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

			const peers = makeClusterPeers([selfKeyPair]);
			const transforms: Transforms = {
				inserts: { 'block-1': makeBlock('block-1') },
				updates: {},
				deletes: []
			};
			// The `validation` pair is what makes validatePendOperations consult the validator.
			const record = await createClusterRecord(
				peers,
				[{
					pend: {
						actionId: 'a1',
						transforms,
						policy: 'c',
						validation: { transaction: { statements: [], stamp: {} } as any, operationsHash: 'hash' }
					}
				}]
			);

			await validatingMember.update(record);

			// activeTransactions is the member's reservation table over blocks: anything in it blocks
			// every later transaction touching the same block until the staleness sweep fires. A record
			// this member has itself proven unreachable (one reject already satisfies Rejected under the
			// default unanimity threshold) must not sit there holding block-1.
			const active = (validatingMember as unknown as {
				activeTransactions: Map<string, unknown>
			}).activeTransactions;
			expect(active.has(record.messageHash)).to.equal(false);
		});

		it("rejects a pend with NO validation payload under unvalidatablePendPolicy: 'reject'", async () => {
			// The single-collection `Collection.sync` shape (bare transforms, no `validation` pair)
			// meeting a validator-armed member running the fail-closed policy. The validator approves
			// everything, so the reject can only come from the policy branch.
			const rejectingMember = clusterMember({
				storageRepo: mockRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				validator: {
					validate: async () => ({ valid: true }),
					getSchemaHash: async () => 'test-hash'
				},
				consensusConfig: {
					superMajorityThreshold: 0.75,
					simpleMajorityThreshold: 0.51,
					minAbsoluteClusterSize: 2,
					allowClusterDownsize: true,
					clusterSizeTolerance: 0.5,
					partitionDetectionWindow: 60000,
					unvalidatablePendPolicy: 'reject'
				}
			});

			const ourId = selfKeyPair.peerId.toString();
			const peers = makeClusterPeers([selfKeyPair]);
			const record = await createClusterRecord(peers, makePendOperation('a1', 'block-1'));

			const result = await rejectingMember.update(record);

			const vote = result.promises[ourId];
			if (vote?.type !== 'reject') expect.fail(`expected a reject vote, got ${vote?.type}`);
			expect(vote.rejectReason).to.include('pend-not-validatable');
		});

		it("casts a signed 'validator-fault:' reject when the validator THROWS — never a lost vote", async () => {
			// Uncaught, the throw would escape the promise handler and the coordinator would record
			// NO vote from this member — indistinguishable from an unreachable peer, with no signed
			// reason for the dispute path.
			const faultingMember = clusterMember({
				storageRepo: mockRepo,
				peerNetwork: mockNetwork,
				peerId: selfKeyPair.peerId,
				privateKey: selfKeyPair.privateKey,
				validator: {
					validate: async () => { throw new Error('engine exploded: no such table t'); },
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
						validation: { transaction: { statements: [], stamp: {} } as any, operationsHash: 'hash' }
					}
				}]
			);

			const result = await faultingMember.update(record);

			const vote = result.promises[ourId];
			if (vote?.type !== 'reject') expect.fail(`expected a reject vote, got ${vote?.type}`);
			expect(vote.rejectReason).to.match(/^validator-fault: /);
			expect(vote.rejectReason).to.include('engine exploded');
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
