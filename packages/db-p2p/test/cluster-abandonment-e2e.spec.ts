import { expect } from 'chai';
import { ClusterCoordinator } from '../src/repo/cluster-coordinator.js';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { computeClusterMessageHash, computeClusterPromiseHash, membershipDigest } from '@optimystic/db-core';
import type {
	ActionBlocks, BlockGets, BlockHeader, BlockId, ClusterConsensusConfig, ClusterPeers, ClusterRecord,
	CommitRequest, CommitResult, GetBlockResults, IBlock, IKeyNetwork, IPeerNetwork, IRepo, PendRequest,
	PendResult, RepoMessage, Signature, Transforms
} from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { waitFor } from '@optimystic/db-core/test';
import type { IPeerReputation } from '../src/reputation/types.js';
import { PenaltyReason } from '../src/reputation/types.js';

/**
 * End-to-end proof for `1-abandoned-pend-holds-the-block`: a coordinator that abandons a
 * transaction its validators rejected must free the blocks that transaction reserved on every
 * member — immediately, not after the member's 2 s staleness sweep.
 *
 * The other two specs for this fix each cover one unit (`cluster-repo.spec.ts` for the member's
 * own-reject retention and the approval-count race order; `cluster-coordinator-supermajority.spec.ts`
 * for the coordinator's broadcast against a mock cohort). Neither drives the reported symptom, and
 * neither runs the broadcast into a REAL `ClusterMember` — so neither would notice if the replayed
 * record tripped merge validation or equivocation detection instead of clearing. This one wires a
 * real member behind the coordinator and asserts the retry gets through.
 */

interface KeyPair {
	peerId: PeerId;
	privateKey: PrivateKey;
}

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId } satisfies BlockHeader
});

const makePendMessage = (actionId: string, blockId: string): RepoMessage => {
	const transforms: Transforms = { inserts: { [blockId]: makeBlock(blockId) }, updates: {}, deletes: [] };
	return {
		operations: [{ pend: { actionId, transforms, policy: 'c' } }],
		expiration: Date.now() + 30000
	};
};

class MockRepo implements IRepo {
	async get(_blockGets: BlockGets): Promise<GetBlockResults> { return {}; }
	async pend(_request: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [] }; }
	async commit(_request: CommitRequest): Promise<CommitResult> { return { success: true }; }
	async cancel(_actionRef: ActionBlocks): Promise<void> { }
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

/** Records every penalty the member reports, so the replay can be shown to be penalty-free. */
class RecordingReputation implements IPeerReputation {
	readonly penalties: { peerId: string; reason: PenaltyReason }[] = [];
	reportPeer(peerId: string, reason: PenaltyReason): void { this.penalties.push({ peerId, reason }); }
	recordSuccess(): void { }
	getScore(): number { return 0; }
	isBanned(): boolean { return false; }
	isDeprioritized(): boolean { return false; }
	getReputation(): any { return {}; }
	getAllReputations(): Map<string, any> { return new Map(); }
	resetPeer(): void { }
}

/**
 * The remote half of the cohort. Signs a REAL reject with its own key, because the record travels
 * back through a real member's `validateSignatures` — a stub signature would be thrown out before
 * the phase is ever computed, and the test would pass for the wrong reason.
 */
class RejectingPeer {
	constructor(private readonly key: KeyPair) { }

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		const peerIdStr = this.key.peerId.toString();
		if (peerIdStr in record.promises) return record;
		const promiseHash = await computeClusterPromiseHash(record.messageHash, record.message, record.membershipDigest);
		const rejectReason = 'stale-revision';
		const sigBytes = await this.key.privateKey.sign(new TextEncoder().encode(`${promiseHash}:reject:${rejectReason}`));
		const signature: Signature = {
			type: 'reject',
			signature: uint8ArrayToString(sigBytes, 'base64url'),
			rejectReason
		};
		return { ...record, promises: { ...record.promises, [peerIdStr]: signature } };
	}
}

const cfg: ClusterConsensusConfig & { clusterSize: number } = {
	clusterSize: 2,
	// 2 peers × 0.75 ⇒ superMajority 2 ⇒ maxAllowedRejections 0, so the single reject below is
	// terminal and the coordinator takes its `rejected-by-validators` path.
	superMajorityThreshold: 0.75,
	simpleMajorityThreshold: 0.51,
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000
};

describe('abandonment frees the block end-to-end (1-abandoned-pend-holds-the-block)', function () {
	this.timeout(10000);

	let member: ClusterMember;

	afterEach(() => {
		member?.dispose();
	});

	it('lets a retry through on a block the abandoned transaction had reserved', async () => {
		const localKey = await makeKeyPair();
		const remoteKey = await makeKeyPair();
		const reputation = new RecordingReputation();
		member = clusterMember({
			storageRepo: new MockRepo(),
			peerNetwork: new MockPeerNetwork(),
			peerId: localKey.peerId,
			privateKey: localKey.privateKey,
			reputation,
			consensusConfig: cfg
		});

		const peers: ClusterPeers = {};
		for (const { peerId } of [localKey, remoteKey]) {
			peers[peerId.toString()] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url')
			};
		}

		const remote = new RejectingPeer(remoteKey);
		const keyNetwork = {
			async findCoordinator() { return localKey.peerId; },
			async findCluster() { return { ...peers }; }
		} as unknown as IKeyNetwork;
		const coordinator = new ClusterCoordinator(
			keyNetwork,
			(() => remote) as any,
			cfg,
			// Same adapter shape `CoordinatorRepo` builds in production: `ClusterMember.peerId` is
			// private, so the local reference is assembled from bound methods plus the id.
			{ update: member.update.bind(member), peerId: localKey.peerId }
		);

		// The doomed transaction. The local member approves it, so it lands in that member's
		// `activeTransactions` — its reservation table over blocks — holding block-1.
		const doomed = makePendMessage('doomed', 'block-1');
		let caught: Error | undefined;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, doomed);
		} catch (err) {
			caught = err as Error;
		}
		expect(caught, 'the remote reject must sink the transaction').to.be.instanceOf(Error);

		// The broadcast is fire-and-forget, so the throw above does not wait on it.
		const active = (member as unknown as { activeTransactions: Map<string, unknown> }).activeTransactions;
		await waitFor(() => active.size === 0, {
			description: 'the member drops the abandoned transaction from its reservation table'
		});

		// The symptom the ticket reports: the retry. Pre-fix the member still held the doomed
		// transaction (one approval vs the retry's zero), so `hasConflict` kept the retry out and it
		// withheld its vote for the whole 2 s staleness window.
		const retry = makePendMessage('retry', 'block-1');
		const digest = await membershipDigest(peers);
		const retryRecord: ClusterRecord = {
			messageHash: await computeClusterMessageHash(retry, digest),
			message: retry,
			peers,
			membershipVersion: 2,
			membershipDigest: digest,
			promises: {},
			commits: {}
		};
		const voted = await member.update(retryRecord);
		expect(voted.promises[localKey.peerId.toString()]?.type,
			'block-1 must be free the moment the abandonment lands').to.equal('approve');

		// Replaying a record whose votes the member already holds must be a plain no-op: identical
		// signatures are not a vote change, so `detectEquivocation` must not penalize the sender.
		expect(reputation.penalties, 'the replayed record must not look like misbehavior').to.deep.equal([]);
	});
});
