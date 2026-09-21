/**
 * Ticket: acknowledged-diary-commits-land-on-no-node.
 *
 * The hole, in one paragraph: a commit assembled full consensus on its cohort, and the coordinator
 * counted those votes as success — but a vote is a promise to apply, not a report of having
 * applied. Every cohort member's storage then refused the commit (they held no base for the block,
 * so `StorageRepo.internalCommit`'s fork guard declined and dropped the pending record), each one's
 * reconcile found no cohort peer holding the revision, and the writer was told its append had
 * landed while no responsible node held it.
 *
 * Two arms close it, driven here against REAL `ClusterMember`s over real
 * `StorageRepo`/`MemoryRawStorage`, a real `ClusterCoordinator` and a real `CoordinatorRepo`:
 *
 *  - **Arm A — the durability gate.** Each member stamps what its storage holds AFTER its own
 *    reconcile onto the record it answers with (`ClusterRecord.applyOutcomes[peer].commit`); the
 *    coordinator counts durable holders, its own member included, and acknowledges only a strict
 *    majority of the cohort. Otherwise it answers a retryable refusal
 *    (`COMMIT_NOT_DURABLE_REASON`) instead of a fabricated success.
 *  - **Arm B — a behind member heals from the coordinating member's copy.** In a two-member cohort
 *    the remote member applies on receipt of the commit round, which already carries the
 *    coordinator's own commit vote (ticket cluster-commit-round-carries-the-coordinators-commit-vote),
 *    so a behind remote member reconciles before anyone holds the revision and reports a refusal.
 *    `ClusterCoordinator.broadcastMergedRecord` then applies the commit on its own member and sends
 *    the merged record again to a remote member reporting a refused commit; that redelivery gives it
 *    another reconcile, against the coordinator's copy, which carries the cohort's commit proof and is
 *    therefore adoptable from a single holder.
 *  - **The mirror of Arm B** (ticket a-two-member-cohort-refuses-a-commit-both-members-hold): when
 *    the coordinating member is the one behind, the remote member has already applied in the commit
 *    round, so the coordinating member's first reconcile finds it.
 *
 * The geometry is the smallest one that shows both: a two-member cohort (2 of 2 is both the promise
 * super-majority and the durable majority), the block seeded on the coordinating member only, and
 * an update-only pend the remote member accepts even though it holds no revision of the block.
 */

import { expect } from 'chai';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { ClusterCoordinator } from '../src/repo/cluster-coordinator.js';
import { CoordinatorRepo, type ICoordinatorClusterSeam } from '../src/repo/coordinator-repo.js';
import { StorageRepo, COMMIT_NOT_DURABLE_REASON, isCommitNotDurableFailure } from '../src/storage/storage-repo.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { createReconcileBlock, type ReconcileBlockDeps } from '../src/cluster/reconcile-block.js';
import { serveBlockArchive } from '../src/storage/block-archive.js';
import type {
	ClusterRecord, ClusterPeers, ClusterConsensusConfig, IKeyNetwork, ICluster, IBlock, BlockHeader,
	BlockId, CommitRequest, PendRequest, StaleFailure, Transforms
} from '@optimystic/db-core';
import { canonicalBlockHash, isConflictFailure } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

const BLOCK = 'block-durability' as BlockId;
const SEED_ACTION = 'a-seed';
const ACTION = 'a-update';
/** The revision the commit under test claims. The block is seeded one revision below it. */
const COMMIT_REV = 2;
/**
 * The repair floor's yardstick for the remote member's reconcile. Deliberately LARGER than the
 * cohort: with `corroboratorCapacity(1, 3) = 2` a lone uncertified holder is declined, so the
 * only way the remote member can adopt the coordinator's copy is the certified single-holder path —
 * exactly what a wide production cohort with one holder depends on. A yardstick of 2 would let the
 * heal succeed by corroboration alone and prove nothing about the proof.
 */
const REPAIR_YARDSTICK = 3;

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const makeHeader = (id: string): BlockHeader => ({ id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId });
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

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

const realStorageRepo = (): StorageRepo => {
	const raw = new MemoryRawStorage();
	return new StorageRepo((blockId: BlockId) => new BlockStorage(blockId, raw));
};

/** Put BLOCK into storage at rev 1, so a pend at {@link COMMIT_REV} is an ordinary update. */
const seedBlockAtRev1 = async (storage: StorageRepo): Promise<void> => {
	await storage.pend({ actionId: SEED_ACTION, transforms: { inserts: { [BLOCK]: makeBlock(BLOCK) }, updates: {}, deletes: [] }, policy: 'r' });
	const committed = await storage.commit({ actionId: SEED_ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });
	expect(committed.success, 'seed commit must land').to.equal(true);
};

/** An update-only pend for BLOCK at the committing revision. `policy: 'r'` matches the production path. */
const pendRequest: PendRequest = {
	actionId: ACTION,
	rev: COMMIT_REV,
	transforms: { updates: { [BLOCK]: [] } } as Transforms,
	policy: 'r'
};

/**
 * The commit under test. `baseRev` is what arms `internalCommit`'s fork guard on a member holding no
 * revision of the block; `digest` is what lets a member that materializes the declared content
 * retain the cohort's commit proof (the empty update leaves the seeded block unchanged).
 */
const commitRequest = async (): Promise<CommitRequest> => ({
	actionId: ACTION,
	blockIds: [BLOCK],
	tailId: BLOCK,
	rev: COMMIT_REV,
	blockDigests: { [BLOCK]: { digest: await canonicalBlockHash(makeBlock(BLOCK)), baseRev: 1 } }
});

/** Two-member cohort where 2/2 is both the promise super-majority and the commit majority. */
const cohortConfig: ClusterConsensusConfig & { clusterSize: number } = {
	clusterSize: 2,
	superMajorityThreshold: 0.75,	// ceil(2 * 0.75) = 2
	simpleMajorityThreshold: 0.51,	// floor(2 * 0.51) + 1 = 2
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000
};

const latestOf = async (storage: StorageRepo) =>
	(await storage.get({ blockIds: [BLOCK] }))[BLOCK]?.state?.latest;

describe('commit durability quorum (an acknowledged commit lands on a durable majority)', () => {
	let coordinatingPeer: KeyPair;
	let remotePeer: KeyPair;
	let members: ClusterMember[];

	beforeEach(async () => {
		coordinatingPeer = await makeKeyPair();
		remotePeer = await makeKeyPair();
		members = [];
	});

	afterEach(() => {
		for (const member of members) member.dispose();
	});

	/**
	 * Wire a real two-member cohort behind a real `ClusterCoordinator` and `CoordinatorRepo`.
	 *
	 * `seedRemote` / `seedCoordinating` decide which members hold the block at all (the coordinating
	 * member does unless told otherwise). `reconcileFromCoordinator` gives the remote member the
	 * production reconcile path, served straight out of the coordinating member's storage through
	 * `serveBlockArchive` — the same function a real peer answers a fetch with, proof included.
	 * `coordinatingReconcilesFromRemote` is the mirror: the coordinating member reconciles from the
	 * remote member's storage, and `coordinatingFetches` counts the archive fetches it made.
	 *
	 * The client through which the remote member is reached also witnesses the delivery order: on
	 * the first delivery that carries the commit transaction's full commit set, it records —
	 * synchronously, before forwarding — whether the coordinating member had already retained its own
	 * verdict for that transaction. The commit round carries only the coordinator's commit, so that
	 * delivery is the redelivery a remote member gets after it applied, and the witness is true only
	 * when the coordinator applied on its own member, and awaited it, before sending it.
	 */
	const buildCohort = async (opts: {
		seedRemote: boolean;
		reconcileFromCoordinator: boolean;
		seedCoordinating?: boolean;
		coordinatingReconcilesFromRemote?: boolean;
		/** Let `CoordinatorRepo`'s own constructor wire its coordinator to the local member, as a node does. */
		productionWiring?: boolean;
	}): Promise<{
		repo: CoordinatorRepo;
		coordinatingStorage: StorageRepo;
		remoteStorage: StorageRepo;
		/** `undefined` until the commit transaction's consensus record reached the remote member. */
		localAppliedBeforeRemoteDelivery: () => boolean | undefined;
		/** Archive fetches the coordinating member's reconcile made (mirror geometry only). */
		coordinatingFetches: () => number;
	}> => {
		const coordinatingStorage = realStorageRepo();
		const remoteStorage = realStorageRepo();
		if (opts.seedCoordinating ?? true) await seedBlockAtRev1(coordinatingStorage);
		if (opts.seedRemote) await seedBlockAtRev1(remoteStorage);

		const peerNetwork = new MockPeerNetwork();
		let coordinatingFetches = 0;
		const coordinatingReconcileDeps: ReconcileBlockDeps = {
			selfPeerId: coordinatingPeer.peerId.toString(),
			fetchArchive: async (peerIdStr, blockId) => {
				coordinatingFetches++;
				return peerIdStr === remotePeer.peerId.toString() ? await serveBlockArchive(remoteStorage, blockId) : undefined;
			},
			saveReplicatedBlock: (blockId, block, source, verifiedProof) =>
				coordinatingStorage.saveReplicatedBlock(blockId, block, source, verifiedProof),
			simpleMajorityThreshold: cohortConfig.simpleMajorityThreshold,
			superMajorityThreshold: cohortConfig.superMajorityThreshold,
			repairCorroborationClusterSize: REPAIR_YARDSTICK
		};
		const coordinatingMember = clusterMember({
			storageRepo: coordinatingStorage, peerNetwork,
			peerId: coordinatingPeer.peerId, privateKey: coordinatingPeer.privateKey,
			consensusConfig: cohortConfig,
			...(opts.coordinatingReconcilesFromRemote ? { reconcileBlock: createReconcileBlock(coordinatingReconcileDeps) } : {})
		});
		const reconcileDeps: ReconcileBlockDeps = {
			selfPeerId: remotePeer.peerId.toString(),
			fetchArchive: async (peerIdStr, blockId) =>
				peerIdStr === coordinatingPeer.peerId.toString() ? await serveBlockArchive(coordinatingStorage, blockId) : undefined,
			saveReplicatedBlock: (blockId, block, source, verifiedProof) =>
				remoteStorage.saveReplicatedBlock(blockId, block, source, verifiedProof),
			simpleMajorityThreshold: cohortConfig.simpleMajorityThreshold,
			superMajorityThreshold: cohortConfig.superMajorityThreshold,
			repairCorroborationClusterSize: REPAIR_YARDSTICK
		};
		const remoteMember = clusterMember({
			storageRepo: remoteStorage, peerNetwork,
			peerId: remotePeer.peerId, privateKey: remotePeer.privateKey,
			consensusConfig: cohortConfig,
			...(opts.reconcileFromCoordinator ? { reconcileBlock: createReconcileBlock(reconcileDeps) } : {})
		});
		members.push(coordinatingMember, remoteMember);

		const peers = makeClusterPeers([coordinatingPeer, remotePeer]);
		const keyNetwork: IKeyNetwork = {
			async findCoordinator(): Promise<PeerId> { return coordinatingPeer.peerId; },
			async findCluster(): Promise<ClusterPeers> { return { ...peers }; }
		};

		let localAppliedBeforeRemoteDelivery: boolean | undefined;
		// Only the remote member is reached through a client; the coordinator invokes its own member
		// directly via `localCluster`.
		const createClusterClient = (_peerId: PeerId): ICluster => ({
			peerId: remotePeer.peerId,
			async update(record: ClusterRecord): Promise<ClusterRecord> {
				const isCommitTransaction = record.message.operations.some(op => 'commit' in op);
				const carriesConsensus = Object.keys(record.commits).length >= 2;
				if (isCommitTransaction && carriesConsensus && localAppliedBeforeRemoteDelivery === undefined) {
					localAppliedBeforeRemoteDelivery = coordinatingMember.getExecutedCommitResult(record.messageHash) !== undefined;
				}
				return remoteMember.update(record);
			}
		} as unknown as ICluster);

		// `ClusterMember.peerId` is private on the class but public on the `ICluster` the node assembly
		// hands the coordinator in production, so the structural check needs one cast here.
		let repo: CoordinatorRepo;
		if (opts.productionWiring) {
			const member = coordinatingMember as unknown as ConstructorParameters<typeof CoordinatorRepo>[4];
			repo = new CoordinatorRepo(keyNetwork, createClusterClient, coordinatingStorage, cohortConfig, member, coordinatingPeer.peerId);
		} else {
			const localCluster = coordinatingMember as unknown as ConstructorParameters<typeof ClusterCoordinator>[3];
			const coordinator = new ClusterCoordinator(keyNetwork, createClusterClient, cohortConfig, localCluster);
			repo = new CoordinatorRepo(keyNetwork, createClusterClient, coordinatingStorage, cohortConfig);
			(repo as unknown as { coordinator: ICoordinatorClusterSeam }).coordinator = coordinator;
		}

		return {
			repo, coordinatingStorage, remoteStorage,
			localAppliedBeforeRemoteDelivery: () => localAppliedBeforeRemoteDelivery,
			coordinatingFetches: () => coordinatingFetches
		};
	};

	/** Drive the update's pend through the cohort; both members accept it today, holder or not. */
	const pendAccepted = async (repo: CoordinatorRepo): Promise<void> => {
		const pended = await repo.pend(pendRequest);
		expect(pended.success, 'the update-only pend must be accepted by both members').to.equal(true);
	};

	it('refuses the commit when the remote member cannot hold the revision (no reconcile path)', async () => {
		// The observed shape, minus the heal: the remote member accepted the pend, its commit is
		// refused by the fork guard (no local base for the declared one), it has no reconcile
		// callback, and the coordinating member is the only holder — 1 of 2 is not a majority.
		const cohort = await buildCohort({ seedRemote: false, reconcileFromCoordinator: false });
		await pendAccepted(cohort.repo);

		const result = await cohort.repo.commit(await commitRequest());

		expect(result.success, 'a commit no durable majority holds must not be acknowledged').to.equal(false);
		expect(isConflictFailure(result as StaleFailure), 'the refusal must be retryable, not a hard fault').to.equal(true);
		expect(isCommitNotDurableFailure(result), 'the refusal names the durability gate').to.equal(true);
		expect((result as StaleFailure).reason).to.match(new RegExp(`^${COMMIT_NOT_DURABLE_REASON}`));
		expect(await latestOf(cohort.remoteStorage), 'the remote member still holds nothing').to.equal(undefined);
	});

	it('acknowledges once the remote member restores the revision from the coordinating member', async () => {
		// Same geometry with the production reconcile path wired. The remote member applies on receipt
		// of the commit round, before the coordinator holds anything, so its first reconcile finds no
		// holder. It heals on the redelivery the coordinator sends it after applying on its own member
		// — the delivery order this arm witnesses — and can adopt that single holder only because its
		// copy carries the cohort's verified commit proof.
		const cohort = await buildCohort({ seedRemote: false, reconcileFromCoordinator: true });
		await pendAccepted(cohort.repo);

		const result = await cohort.repo.commit(await commitRequest());

		expect(cohort.localAppliedBeforeRemoteDelivery(),
			'the coordinating member must have applied the commit before the merged record reached the remote member').to.equal(true);
		expect(result.success, 'both members hold the revision, so the commit is durable at a majority').to.equal(true);
		expect(await latestOf(cohort.remoteStorage), 'the remote member restored the committed revision')
			.to.deep.equal({ actionId: ACTION, rev: COMMIT_REV });
		expect(await cohort.remoteStorage.getBlockProof(BLOCK, COMMIT_REV),
			'the restore came through the certified single-holder path, so the proof was retained').to.not.equal(undefined);
	});

	it('still acknowledges an ordinary commit both members hold (no false refusals)', async () => {
		const cohort = await buildCohort({ seedRemote: true, reconcileFromCoordinator: false });
		await pendAccepted(cohort.repo);

		const result = await cohort.repo.commit(await commitRequest());

		expect(result.success, 'an ordinary commit must still be acknowledged').to.equal(true);
		for (const storage of [cohort.coordinatingStorage, cohort.remoteStorage]) {
			expect(await latestOf(storage)).to.deep.equal({ actionId: ACTION, rev: COMMIT_REV });
		}
	});
	/**
	 * Ticket: a-two-member-cohort-refuses-a-commit-both-members-hold.
	 *
	 * The mirror of Arm B: the COORDINATING member is the one lacking the base. When its own delivery
	 * came first, its reconcile ran while no remote member had applied yet, found no holder, and
	 * retained a refusal, so the write was refused as not durable although both members ended up
	 * holding it. Now the remote member applies on receipt of the commit round, before the coordinating
	 * member applies, so the coordinating member's first reconcile finds the remote copy — which
	 * carries the cohort's commit proof and is adoptable from that single holder — and the second
	 * reconcile `broadcastMergedRecord` keeps for cohorts where no remote member applied first is
	 * not needed.
	 */
	it('acknowledges when the coordinating member is the one behind and reconciles from the remote member that applied first', async () => {
		// Wired the way a node wires it: the coordinator reaches the member's second reconcile only
		// through the seam `CoordinatorRepo` builds from its `localCluster`.
		const cohort = await buildCohort({
			seedRemote: true, seedCoordinating: false,
			reconcileFromCoordinator: false, coordinatingReconcilesFromRemote: true,
			productionWiring: true
		});
		await pendAccepted(cohort.repo);

		const result = await cohort.repo.commit(await commitRequest());

		expect(result.success, `both members hold the revision, so the commit is durable at a majority (got ${JSON.stringify(result)})`).to.equal(true);
		expect(await latestOf(cohort.coordinatingStorage), 'the coordinating member restored the committed revision')
			.to.deep.equal({ actionId: ACTION, rev: COMMIT_REV });
		expect(await cohort.coordinatingStorage.getBlockProof(BLOCK, COMMIT_REV),
			'the restore came through the certified single-holder path, so the proof was retained').to.not.equal(undefined);
		expect(await latestOf(cohort.remoteStorage)).to.deep.equal({ actionId: ACTION, rev: COMMIT_REV });
		expect(cohort.coordinatingFetches(), 'the reconcile during the local apply already found the remote member\'s copy').to.equal(1);
	});

	it('does not reconcile the coordinating member again when no remote member holds the revision', async () => {
		// Neither member holds the block, so both refuse and nobody can serve it: the second reconcile
		// would be a wasted round trip, and the refusal must stand.
		const cohort = await buildCohort({
			seedRemote: false, seedCoordinating: false,
			reconcileFromCoordinator: false, coordinatingReconcilesFromRemote: true
		});
		await pendAccepted(cohort.repo);

		const result = await cohort.repo.commit(await commitRequest());

		expect(result.success, 'a commit no member holds must not be acknowledged').to.equal(false);
		expect(isCommitNotDurableFailure(result), 'the refusal names the durability gate').to.equal(true);
		expect(cohort.coordinatingFetches(), 'only the reconcile during the local apply ran').to.equal(1);
		expect(await latestOf(cohort.coordinatingStorage)).to.equal(undefined);
	});
});
