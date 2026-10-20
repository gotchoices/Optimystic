/**
 * Ticket: a-consensus-record-carries-several-collections-of-one-action.
 *
 * A consensus record may carry a batch: the pends, or the commits, of several collections written by
 * one action (`RepoMessage.operations`). A member keeps ONE verdict per record, so it must fold the
 * operations' verdicts rather than keep whichever operation it applied last. These cases drive a real
 * `ClusterMember` over a real `StorageRepo` with hand-signed two-member records, the shape the
 * coordinating node's delivery has on the other member of a two-member group.
 */

import { expect } from 'chai';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type {
	ActionId, BlockHeader, BlockId, ClusterConsensusConfig, ClusterPeers, ClusterRecord, CommitRequest,
	IBlock, IPeerNetwork, PendRequest, RepoMessage, Signature, StaleFailure, Transforms
} from '@optimystic/db-core';
import {
	clusterVoteSigningPayload, computeClusterCommitHash, computeClusterMessageHash, computeClusterPromiseHash,
	isConflictFailure, membershipDigest
} from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

/** The log tail of the first collection (a table) and of the second (one of its indexes). */
const TABLE_TAIL = 'table-tail' as BlockId;
const INDEX_TAIL = 'index-tail' as BlockId;
const ACTION = 'a-batch' as ActionId;
const RIVAL = 'a-rival' as ActionId;
/** Revisions are per collection, so the two collections of one action commit at different ones. */
const TABLE_REV = 2;
const INDEX_REV = 5;

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const makeBlock = (id: BlockId, collectionId: string): IBlock => ({ header: { id, type: 'test', collectionId } as BlockHeader });

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

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

/** Two-member group where 2/2 is both the promise super-majority and the commit majority. */
const cohortConfig: ClusterConsensusConfig & { clusterSize: number } = {
	clusterSize: 2,
	superMajorityThreshold: 0.75,
	simpleMajorityThreshold: 0.51,
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000
};

/** Commit `blockId` into storage at `rev`, so a later pend of it is an ordinary update. */
const seed = async (storage: StorageRepo, blockId: BlockId, collectionId: string, rev: number): Promise<void> => {
	const actionId = `a-seed-${blockId}` as ActionId;
	await storage.pend({ actionId, transforms: { inserts: { [blockId]: makeBlock(blockId, collectionId) }, updates: {}, deletes: [] }, policy: 'r' });
	const committed = await storage.commit({ actionId, blockIds: [blockId], tailId: blockId, rev });
	expect(committed.success, `seeding ${blockId} must land`).to.equal(true);
};

const pendOf = (actionId: ActionId, blockId: BlockId, rev: number): PendRequest => ({
	actionId,
	rev,
	transforms: { updates: { [blockId]: [] } } as Transforms,
	policy: 'r'
});

const commitOf = (blockId: BlockId, rev: number): CommitRequest => ({ actionId: ACTION, blockIds: [blockId], tailId: blockId, rev });

/** The batch's two pends: the table's and the index's, one action. */
const batchPends = (): RepoMessage['operations'] => [
	{ pend: pendOf(ACTION, TABLE_TAIL, TABLE_REV) },
	{ pend: pendOf(ACTION, INDEX_TAIL, INDEX_REV) }
];

const batchCommits = (): RepoMessage['operations'] => [
	{ commit: commitOf(TABLE_TAIL, TABLE_REV) },
	{ commit: commitOf(INDEX_TAIL, INDEX_REV) }
];

describe('a consensus record carrying several collections of one action', () => {
	let self: KeyPair;
	let other: KeyPair;
	let storage: StorageRepo;
	let member: ClusterMember;

	beforeEach(async () => {
		self = await makeKeyPair();
		other = await makeKeyPair();
		storage = new StorageRepo(new MemoryRawStorage());
		await seed(storage, TABLE_TAIL, 'table', TABLE_REV - 1);
		await seed(storage, INDEX_TAIL, 'table/index/by-name', INDEX_REV - 1);
		member = clusterMember({
			storageRepo: storage, peerNetwork: new MockPeerNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			consensusConfig: cohortConfig
		});
	});

	afterEach(() => {
		member.dispose();
	});

	/** A v2 record of `operations` with no votes, as the coordinating node first sends it. */
	const freshRecord = async (operations: RepoMessage['operations']): Promise<ClusterRecord> => {
		const message: RepoMessage = { operations, coordinatingBlockIds: [TABLE_TAIL], expiration: Date.now() + 30000 };
		const peers = makeClusterPeers([self, other]);
		const digest = await membershipDigest(peers);
		return {
			messageHash: await computeClusterMessageHash(message, digest),
			message, peers, promises: {}, commits: {},
			membershipVersion: 2, membershipDigest: digest
		};
	};

	const sign = async (keyPair: KeyPair, hash: string): Promise<Signature> => {
		const signature = await keyPair.privateKey.sign(clusterVoteSigningPayload(hash, { type: 'approve' }));
		return { type: 'approve', signature: uint8ArrayToString(signature, 'base64url') };
	};

	/**
	 * `record` completed by the other member: its promise added, then its commit over the full promise
	 * map. Delivered, this member signs its own commit and the record reaches consensus and applies.
	 */
	const decidedByOther = async (record: ClusterRecord): Promise<ClusterRecord> => {
		const promiseHash = await computeClusterPromiseHash(record.messageHash, record.message, record.membershipDigest);
		const promises = { ...record.promises, [other.peerId.toString()]: await sign(other, promiseHash) };
		const commitHash = await computeClusterCommitHash(record.messageHash, record.message, promises, record.membershipDigest);
		return { ...record, promises, commits: { [other.peerId.toString()]: await sign(other, commitHash) } };
	};

	it('refuses the whole pend record when one collection is refused, and then the whole commit record', async () => {
		const pendRecord = await freshRecord(batchPends());
		const promised = await member.update(pendRecord);
		expect(promised.promises[self.peerId.toString()]?.type, 'nothing holds the blocks at the vote').to.equal('approve');

		// The window a deferred delivery opens: after this member's promise vote, before it applies. A
		// rival placed before the vote would draw a `held` vote and the record would never decide.
		// The rival sits on the FIRST collection, so a member keeping the last operation's verdict would
		// report the second collection's success.
		const rival = await storage.pend(pendOf(RIVAL, TABLE_TAIL, TABLE_REV));
		expect(rival.success, 'the rival takes the table tail').to.equal(true);

		await member.update(await decidedByOther(promised));

		const verdict = member.getExecutedPendResult(pendRecord.messageHash);
		expect(verdict?.success, 'one collection refused refuses the record').to.equal(false);
		expect(isConflictFailure(verdict as StaleFailure), 'the refusal is the retryable conflict').to.equal(true);
		expect((verdict as StaleFailure).pending?.map(pending => pending.actionId)).to.deep.equal([RIVAL]);

		// The action's commit, also one record for both collections, is refused at the promise vote: on
		// two members that one reject puts the record out of reach, so neither collection commits.
		const vote = (await member.update(await freshRecord(batchCommits()))).promises[self.peerId.toString()];
		expect(vote?.type).to.equal('reject');
		expect(vote?.type === 'reject' ? vote.rejectReason : undefined).to.include('refused pend');
	});

	it('commits every collection of a commit record and answers success', async () => {
		for (const operation of batchPends()) {
			if ('pend' in operation) expect((await storage.pend(operation.pend)).success).to.equal(true);
		}
		const promised = await member.update(await freshRecord(batchCommits()));
		expect(promised.promises[self.peerId.toString()]?.type).to.equal('approve');

		await member.update(await decidedByOther(promised));

		const blocks = await storage.get({ blockIds: [TABLE_TAIL, INDEX_TAIL] });
		expect(blocks[TABLE_TAIL]?.state?.latest).to.deep.equal({ actionId: ACTION, rev: TABLE_REV });
		expect(blocks[INDEX_TAIL]?.state?.latest).to.deep.equal({ actionId: ACTION, rev: INDEX_REV });
		expect(member.getExecutedCommitResult(promised.messageHash)?.success).to.equal(true);
	});

	it('answers a refused commit record when this member cannot hold one collection', async () => {
		// This member never saw the table's pend — only the index's — and has no peer to reconcile
		// from. The table's commit is the FIRST operation, so a member keeping the last operation's
		// verdict would report the index's success and count toward the durability gate for a
		// revision it does not hold.
		const [, indexPend] = batchPends();
		if (indexPend && 'pend' in indexPend) expect((await storage.pend(indexPend.pend)).success).to.equal(true);
		const promised = await member.update(await freshRecord(batchCommits()));
		expect(promised.promises[self.peerId.toString()]?.type).to.equal('approve');

		await member.update(await decidedByOther(promised));

		const blocks = await storage.get({ blockIds: [TABLE_TAIL, INDEX_TAIL] });
		expect(blocks[INDEX_TAIL]?.state?.latest, 'the index committed').to.deep.equal({ actionId: ACTION, rev: INDEX_REV });
		expect(blocks[TABLE_TAIL]?.state?.latest?.rev, 'the table did not').to.equal(TABLE_REV - 1);
		expect(member.getExecutedCommitResult(promised.messageHash)?.success, 'one collection not held refuses the record').to.equal(false);
	});
});
