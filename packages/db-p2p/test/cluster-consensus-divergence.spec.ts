import { expect } from 'chai';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import type {
	IRepo, ClusterRecord, RepoMessage, Signature, ClusterPeers, Transforms,
	IBlock, BlockId, BlockHeader, BlockGets, GetBlockResults, PendRequest,
	PendResult, CommitRequest, CommitResult, ActionBlocks
} from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

/**
 * Regression coverage for `web-e2e-tier2-cluster-tx-stream-reset-rootcause`.
 *
 * The Tier-2 web e2e sweep reuses one 3-service-peer mesh across every spec.
 * Over the mesh lifetime, cohort membership for a given block drifts (browser
 * tabs join/leave and are never pruned from the service peers' FRET keyspace),
 * so the cohort chosen for a transaction's `pend` phase need not match the one
 * for its `commit` phase. A member that lands in the *commit* cohort without
 * having seen the matching *pend* — or one that is *ahead* on the block from a
 * prior spec — used to **throw inside `handleConsensus`**, which reset the
 * cluster stream and surfaced to the coordinator as a `StreamResetError`,
 * sinking an otherwise-successful transaction.
 *
 * These tests drive `ClusterMember` straight to the consensus-execution phase
 * for those divergence conditions and assert it no longer throws (it logs and
 * defers reconciliation to the sync / lazy read-repair path), while genuinely
 * unexpected storage faults still propagate.
 */

// ─── Canonical JSON + hashing (mirrors cluster-coordinator.ts) ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

const computeMessageHash = async (message: RepoMessage): Promise<string> => {
	const msgBytes = new TextEncoder().encode(canonicalJson(message));
	const hashBytes = await sha256.digest(msgBytes);
	return base58btc.encode(hashBytes.digest);
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

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const signVote = async (privateKey: PrivateKey, hash: string, type: 'approve' | 'reject', rejectReason?: string): Promise<string> => {
	const payload = hash + ':' + type + (rejectReason ? ':' + rejectReason : '');
	const sigBytes = await privateKey.sign(new TextEncoder().encode(payload));
	return uint8ArrayToString(sigBytes, 'base64url');
};

const makeSignedPromise = async (privateKey: PrivateKey, record: ClusterRecord): Promise<Signature> => {
	const sig = await signVote(privateKey, await computePromiseHash(record), 'approve');
	return { type: 'approve', signature: sig };
};

const makeSignedCommit = async (privateKey: PrivateKey, record: ClusterRecord): Promise<Signature> => {
	const sig = await signVote(privateKey, await computeCommitHash(record), 'approve');
	return { type: 'approve', signature: sig };
};

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string): IBlock => ({ header: makeHeader(id) });

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

const makeRecord = async (
	peers: ClusterPeers,
	operations: RepoMessage['operations'],
	promises: Record<string, Signature> = {},
	commits: Record<string, Signature> = {}
): Promise<ClusterRecord> => {
	const message: RepoMessage = { operations, expiration: Date.now() + 30000 };
	const messageHash = await computeMessageHash(message);
	return { messageHash, message, peers, promises, commits };
};

const makeCommitOperation = (actionId: string, blockId: string, rev: number): RepoMessage['operations'] => [
	{ commit: { actionId, blockIds: [blockId], tailId: blockId as BlockId, rev } }
];

const makePendOperation = (actionId: string, blockId: string): RepoMessage['operations'] => {
	const transforms: Transforms = { inserts: { [blockId]: makeBlock(blockId) }, updates: {}, deletes: [] };
	return [{ pend: { actionId, transforms, policy: 'c' } }];
};

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

/** Real storage so commit/pend genuinely enforce revisions and pending-action presence. */
const realStorageRepo = (): StorageRepo => {
	const raw = new MemoryRawStorage();
	return new StorageRepo((blockId: BlockId) => new BlockStorage(blockId, raw));
};

/**
 * Builds a record already carrying enough promises + commits that the member,
 * once it adds its own commit, computes `Consensus` and executes operations.
 */
const buildConsensusCommitRecord = async (
	self: KeyPair,
	other: KeyPair,
	operations: RepoMessage['operations']
): Promise<ClusterRecord> => {
	const peers = makeClusterPeers([self, other]);
	const base = await makeRecord(peers, operations);
	const promised: ClusterRecord = {
		...base,
		promises: {
			[self.peerId.toString()]: await makeSignedPromise(self.privateKey, base),
			[other.peerId.toString()]: await makeSignedPromise(other.privateKey, base)
		}
	};
	return {
		...promised,
		commits: { [other.peerId.toString()]: await makeSignedCommit(other.privateKey, promised) }
	};
};

describe('ClusterMember consensus-execution divergence (stream-reset root cause)', () => {
	let mockNetwork: MockPeerNetwork;
	let self: KeyPair;
	let other: KeyPair;
	let member: ClusterMember;

	beforeEach(async () => {
		mockNetwork = new MockPeerNetwork();
		self = await makeKeyPair();
		other = await makeKeyPair();
	});

	afterEach(() => {
		member?.dispose();
	});

	it('does NOT throw when committing an action it never pended (member behind / cohort drift)', async () => {
		const storage = realStorageRepo();
		member = clusterMember({ storageRepo: storage, peerNetwork: mockNetwork, peerId: self.peerId, privateKey: self.privateKey });

		// Consensus reached on a commit for an action this member never staged a pend for.
		const record = await buildConsensusCommitRecord(self, other, makeCommitOperation('a-missing', 'block-1', 1));

		// Before the fix this rejected with "Pending action a-missing not found …",
		// resetting the cluster stream. The transaction is authoritative cluster-wide,
		// so the member must tolerate the local miss and reconcile via sync instead.
		const result = await member.update(record);
		expect(result).to.not.equal(undefined);
		expect(result.commits[self.peerId.toString()]).to.not.equal(undefined);
		// Transaction is recorded as executed so retries don't re-enter the same throw.
		expect(member.wasTransactionExecuted(record.messageHash)).to.equal(true);
	});

	it('does NOT throw when committing a revision it is already ahead of (stale / prior-spec state)', async () => {
		const storage = realStorageRepo();

		// Pre-seed local storage so block-1 is already committed at rev 2 (member is ahead).
		await storage.pend({ actionId: 'a-old', transforms: { inserts: { 'block-1': makeBlock('block-1') }, updates: {}, deletes: [] }, policy: 'c' });
		const seed = await storage.commit({ actionId: 'a-old', blockIds: ['block-1'], tailId: 'block-1' as BlockId, rev: 2 });
		expect(seed.success).to.equal(true);

		member = clusterMember({ storageRepo: storage, peerNetwork: mockNetwork, peerId: self.peerId, privateKey: self.privateKey });

		// Consensus on a *stale* commit (rev 1 < local rev 2). storage-repo returns
		// success:false (missing); the member must tolerate rather than reset the stream.
		const record = await buildConsensusCommitRecord(self, other, makeCommitOperation('a-stale', 'block-1', 1));

		const result = await member.update(record);
		expect(result).to.not.equal(undefined);
		expect(member.wasTransactionExecuted(record.messageHash)).to.equal(true);
	});

	it('still commits normally when the pending action IS present (no false tolerance)', async () => {
		const storage = realStorageRepo();
		// Stage the pending action locally, exactly as a member that saw the pend phase would have.
		await storage.pend({ actionId: 'a1', transforms: { inserts: { 'block-1': makeBlock('block-1') }, updates: {}, deletes: [] }, policy: 'c' });

		member = clusterMember({ storageRepo: storage, peerNetwork: mockNetwork, peerId: self.peerId, privateKey: self.privateKey });

		const record = await buildConsensusCommitRecord(self, other, makeCommitOperation('a1', 'block-1', 1));
		const result = await member.update(record);

		expect(result.commits[self.peerId.toString()]).to.not.equal(undefined);
		// The commit actually landed: block-1 is now at rev 1 with action a1.
		const got = await storage.get({ blockIds: ['block-1'] });
		expect(got['block-1']?.state?.latest?.rev).to.equal(1);
		expect(got['block-1']?.state?.latest?.actionId).to.equal('a1');
	});

	it('still propagates genuinely unexpected storage faults (not a blanket swallow)', async () => {
		// A storage repo whose commit throws a non-divergence error must NOT be tolerated.
		class FaultyRepo implements IRepo {
			async get(_b: BlockGets): Promise<GetBlockResults> { return {}; }
			async pend(_r: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [] }; }
			async commit(_r: CommitRequest): Promise<CommitResult> { throw new Error('simulated disk I/O failure'); }
			async cancel(_a: ActionBlocks): Promise<void> { /* no-op */ }
		}
		member = clusterMember({ storageRepo: new FaultyRepo(), peerNetwork: mockNetwork, peerId: self.peerId, privateKey: self.privateKey });

		const record = await buildConsensusCommitRecord(self, other, makeCommitOperation('a-io', 'block-1', 1));

		let threw: Error | undefined;
		try {
			await member.update(record);
		} catch (err) {
			threw = err as Error;
		}
		expect(threw, 'unexpected storage faults must still reset the stream').to.not.equal(undefined);
		expect(threw!.message).to.include('simulated disk I/O failure');
		// The executed marker is rolled back so a corrected retry can re-run.
		expect(member.wasTransactionExecuted(record.messageHash)).to.equal(false);
	});

	it('pend-phase consensus tolerates a stale pend without throwing (member ahead)', async () => {
		const storage = realStorageRepo();
		// Block already committed at rev 5 locally.
		await storage.pend({ actionId: 'seed', transforms: { inserts: { 'block-9': makeBlock('block-9') }, updates: {}, deletes: [] }, policy: 'c' });
		await storage.commit({ actionId: 'seed', blockIds: ['block-9'], tailId: 'block-9' as BlockId, rev: 5 });

		member = clusterMember({ storageRepo: storage, peerNetwork: mockNetwork, peerId: self.peerId, privateKey: self.privateKey });

		// A pend consensus for block-9 carrying an explicit stale base rev (< local 5).
		const peers = makeClusterPeers([self, other]);
		const pendOps = makePendOperation('a-stalepend', 'block-9');
		(pendOps[0] as { pend: PendRequest }).pend.rev = 1;
		const base = await makeRecord(peers, pendOps);
		const promised: ClusterRecord = {
			...base,
			promises: {
				[self.peerId.toString()]: await makeSignedPromise(self.privateKey, base),
				[other.peerId.toString()]: await makeSignedPromise(other.privateKey, base)
			}
		};
		const record: ClusterRecord = {
			...promised,
			commits: {
				[self.peerId.toString()]: await makeSignedCommit(self.privateKey, promised),
				[other.peerId.toString()]: await makeSignedCommit(other.privateKey, promised)
			}
		};

		// Reaching Consensus directly (both commits present) → handleConsensus runs the
		// stale pend. Must not throw.
		const result = await member.update(record);
		expect(result).to.not.equal(undefined);
	});
});
