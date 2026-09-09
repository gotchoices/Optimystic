/**
 * Ticket: cohort-pend-refusal-must-reach-the-coordinator.
 *
 * The fork this covers, in one paragraph: two writers raced for the same revision of one block. The
 * coordinating node's own member applied the losing pend cleanly, so the coordinator reported a win.
 * The OTHER cohort member had meanwhile taken the winner's pend, so when the loser's pend reached it
 * at consensus its storage refused — and that refusal stayed on that member. The writer, told it had
 * won, went on to commit; the refusing member co-signed the commit blindly (the commit round votes
 * without re-checking, and both commit-promise checks abstain for a member holding no pend of the
 * committing action); and the coordinator ended up holding a revision no one else had.
 *
 * Two arms close it, and this file drives both against REAL `ClusterMember`s over real
 * `StorageRepo`/`MemoryRawStorage`, not mocks:
 *
 *  - **Arm 1 — the return channel.** A member stamps its own conflict-shaped pend refusal onto the
 *    record it answers with (`ClusterRecord.applyOutcomes`), the coordinator collects it off the
 *    consensus broadcast, and `CoordinatorRepo.pend` answers the writer with that conflict instead of
 *    a fabricated success. The commit round never runs.
 *  - **Arm 2 — the commit-promise guard.** A member that refused an action's pend refuses to sign
 *    that action's commit while local storage still corroborates the refusal, so even a commit that
 *    somehow gets driven cannot assemble consensus.
 *
 * The race is injected exactly where it happened in the observed trace: the rival's pend lands on the
 * remote member AFTER that member has already voted on the promise round — the window in which
 * `validatePendOperations`' pending-rival check cannot see it — and only the apply-time verdict knows.
 */

import { expect } from 'chai';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { ClusterCoordinator } from '../src/repo/cluster-coordinator.js';
import { CoordinatorRepo, type ICoordinatorClusterSeam } from '../src/repo/coordinator-repo.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import type {
	ClusterRecord, ClusterPeers, ClusterConsensusConfig, IKeyNetwork, ICluster, IBlock, BlockHeader,
	BlockId, PendRequest, PendResult, RepoMessage, Signature, StaleFailure, Transforms
} from '@optimystic/db-core';
import { isConflictFailure } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

const BLOCK = 'block-race' as BlockId;
const SEED_ACTION = 'a-seed';
const LOSER_ACTION = 'a-loser';
const WINNER_ACTION = 'a-winner';
/** The revision both writers want. The block is seeded one revision below it. */
const CONTESTED_REV = 2;

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

/** Put BLOCK into storage at rev 1, so a pend at {@link CONTESTED_REV} is an ordinary update. */
const seedBlockAtRev1 = async (storage: StorageRepo): Promise<void> => {
	await storage.pend({ actionId: SEED_ACTION, transforms: { inserts: { [BLOCK]: makeBlock(BLOCK) }, updates: {}, deletes: [] }, policy: 'r' });
	const committed = await storage.commit({ actionId: SEED_ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });
	expect(committed.success, 'seed commit must land').to.equal(true);
};

/** An update-only pend for BLOCK at the contested revision. `policy: 'r'` matches the production path. */
const pendFor = (actionId: string): PendRequest => ({
	actionId,
	rev: CONTESTED_REV,
	transforms: { updates: { [BLOCK]: [] } } as Transforms,
	policy: 'r'
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

describe('cohort pend refusal reaches the coordinator (fork root cause)', () => {
	let coordinatingPeer: KeyPair;	// "C" in the trace: runs the losing transaction
	let refusingPeer: KeyPair;		// "A" in the trace: holds the winner, refuses the loser's pend
	let members: ClusterMember[];

	beforeEach(async () => {
		coordinatingPeer = await makeKeyPair();
		refusingPeer = await makeKeyPair();
		members = [];
	});

	afterEach(() => {
		for (const member of members) member.dispose();
	});

	/**
	 * Wire a real two-member cohort behind a real `ClusterCoordinator` and `CoordinatorRepo`.
	 *
	 * `onRemoteUpdate` runs AFTER each delivery to the remote member, receiving the 1-based delivery
	 * number. That is the injection point: seeding the rival pend into the remote member's storage
	 * once delivery 1 (the promise round) has answered reproduces the observed race window exactly —
	 * too late for the promise-round rival check to see it, in time for the consensus apply to refuse.
	 */
	const buildCohort = async (onRemoteUpdate?: (delivery: number) => Promise<void>): Promise<{
		repo: CoordinatorRepo;
		coordinatingStorage: StorageRepo;
		refusingStorage: StorageRepo;
		refusingMember: ClusterMember;
	}> => {
		const coordinatingStorage = realStorageRepo();
		const refusingStorage = realStorageRepo();
		await seedBlockAtRev1(coordinatingStorage);
		await seedBlockAtRev1(refusingStorage);

		const peerNetwork = new MockPeerNetwork();
		const coordinatingMember = clusterMember({
			storageRepo: coordinatingStorage, peerNetwork,
			peerId: coordinatingPeer.peerId, privateKey: coordinatingPeer.privateKey,
			consensusConfig: cohortConfig
		});
		const refusingMember = clusterMember({
			storageRepo: refusingStorage, peerNetwork,
			peerId: refusingPeer.peerId, privateKey: refusingPeer.privateKey,
			consensusConfig: cohortConfig
		});
		members.push(coordinatingMember, refusingMember);

		const peers = makeClusterPeers([coordinatingPeer, refusingPeer]);
		const keyNetwork: IKeyNetwork = {
			async findCoordinator(): Promise<PeerId> { return coordinatingPeer.peerId; },
			async findCluster(): Promise<ClusterPeers> { return { ...peers }; }
		};

		let deliveries = 0;
		// Only the remote member is reached through a client; the coordinator invokes its own member
		// directly via `localCluster`.
		const createClusterClient = (_peerId: PeerId): ICluster => ({
			peerId: refusingPeer.peerId,
			async update(record: ClusterRecord): Promise<ClusterRecord> {
				deliveries += 1;
				const answer = await refusingMember.update(record);
				await onRemoteUpdate?.(deliveries);
				return answer;
			}
		} as unknown as ICluster);

		// `ClusterMember.peerId` is private on the class but public on the `ICluster` the node assembly
		// hands the coordinator in production, so the structural check needs one cast here.
		const localCluster = coordinatingMember as unknown as ConstructorParameters<typeof ClusterCoordinator>[3];
		const coordinator = new ClusterCoordinator(keyNetwork, createClusterClient, cohortConfig, localCluster);
		// No `localCluster` on the repo itself: the injected coordinator below is the one that holds
		// the local member, and it is the only seam `pend` reaches.
		const repo = new CoordinatorRepo(keyNetwork, createClusterClient, coordinatingStorage, cohortConfig);
		(repo as unknown as { coordinator: ICoordinatorClusterSeam }).coordinator = coordinator;

		return { repo, coordinatingStorage, refusingStorage, refusingMember };
	};

	it('answers the writer with a conflict when a NON-coordinating member refused the pend', async () => {
		let rivalSeeded = false;
		const cohort = await buildCohort(async delivery => {
			// After the remote member has cast its promise vote, before the record that makes it
			// apply arrives: the exact window the promise-round rival check cannot cover.
			if (delivery === 1 && !rivalSeeded) {
				rivalSeeded = true;
				const rival = await cohort.refusingStorage.pend(pendFor(WINNER_ACTION));
				expect(rival.success, 'the rival must genuinely take the remote member\'s reservation').to.equal(true);
			}
		});

		const result = await cohort.repo.pend(pendFor(LOSER_ACTION));

		expect(rivalSeeded, 'the race must actually have been injected').to.equal(true);
		expect(result.success, 'a pend a cohort member refused must not be reported as a win').to.equal(false);
		expect(isConflictFailure(result as StaleFailure), 'the refusal must be retryable, not a hard fault').to.equal(true);
		// The refusal carries the rival that caused it, so the writer sees a real answer rather than a
		// bare "try again".
		expect((result as StaleFailure).pending?.map(p => p.actionId)).to.deep.equal([WINNER_ACTION]);

		// And the coordinating node's OWN storage really did accept the pend — i.e. the conflict came
		// from the channel under test, not from the coordinator noticing the rival itself.
		const coordinatingState = await cohort.coordinatingStorage.get({ blockIds: [BLOCK] });
		expect(coordinatingState[BLOCK]?.state?.pendings, 'the coordinator applied the loser locally')
			.to.deep.equal([LOSER_ACTION]);
	});

	it('a commit driven anyway cannot assemble consensus (arm 2 end to end)', async () => {
		// The acceptance bar for arm 2 is deliberately weaker than arm 1's: not "a clean conflict
		// answer" but "the write fails loudly instead of silently forking the block". A writer that
		// ignored the pend conflict — or one whose refusing member applied too late for arm 1 to
		// report — drives the commit, the refusing member votes reject, super-majority becomes
		// unreachable on a two-member cohort, and no revision is taken anywhere.
		let rivalSeeded = false;
		const cohort = await buildCohort(async delivery => {
			if (delivery === 1 && !rivalSeeded) {
				rivalSeeded = true;
				await cohort.refusingStorage.pend(pendFor(WINNER_ACTION));
			}
		});
		await cohort.repo.pend(pendFor(LOSER_ACTION));

		let outcome: 'threw' | 'refused' | 'committed';
		try {
			outcome = (await cohort.repo.commit({ actionId: LOSER_ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: CONTESTED_REV })).success
				? 'committed' : 'refused';
		} catch {
			outcome = 'threw';
		}
		expect(outcome, 'the refused action must never reach a durable commit').to.not.equal('committed');

		// The block moved nowhere on either member — no fork to reconcile later.
		for (const storage of [cohort.coordinatingStorage, cohort.refusingStorage]) {
			const state = await storage.get({ blockIds: [BLOCK] });
			expect(state[BLOCK]?.state?.latest?.rev, 'no member may hold the contested revision').to.equal(1);
		}
	});

	it('still reports success when no cohort member refused (no false conflicts)', async () => {
		const cohort = await buildCohort();

		const result = await cohort.repo.pend(pendFor(LOSER_ACTION));

		expect(result.success, 'an uncontested pend must still win').to.equal(true);
		const refusingState = await cohort.refusingStorage.get({ blockIds: [BLOCK] });
		expect(refusingState[BLOCK]?.state?.pendings, 'both members hold the pend').to.deep.equal([LOSER_ACTION]);
	});
});

// ─── Arm 2: a member that refused an action's pend must not co-sign its commit ───

const canonicalJson = (value: unknown): string =>
	JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);

const computeMessageHash = async (message: RepoMessage): Promise<string> => {
	const hashBytes = await sha256.digest(new TextEncoder().encode(canonicalJson(message)));
	return base58btc.encode(hashBytes.digest);
};

const computePromiseHash = async (record: ClusterRecord): Promise<string> => {
	const hashBytes = await sha256.digest(new TextEncoder().encode(record.messageHash + canonicalJson(record.message)));
	return uint8ArrayToString(hashBytes.digest, 'base64url');
};

const computeCommitHash = async (record: ClusterRecord): Promise<string> => {
	const hashBytes = await sha256.digest(new TextEncoder().encode(record.messageHash + canonicalJson(record.message) + canonicalJson(record.promises)));
	return uint8ArrayToString(hashBytes.digest, 'base64url');
};

const makeSignedPromise = async (privateKey: PrivateKey, record: ClusterRecord): Promise<Signature> => {
	const sigBytes = await privateKey.sign(new TextEncoder().encode(await computePromiseHash(record) + ':approve'));
	return { type: 'approve', signature: uint8ArrayToString(sigBytes, 'base64url') };
};

const makeSignedCommit = async (privateKey: PrivateKey, record: ClusterRecord): Promise<Signature> => {
	const sigBytes = await privateKey.sign(new TextEncoder().encode(await computeCommitHash(record) + ':approve'));
	return { type: 'approve', signature: uint8ArrayToString(sigBytes, 'base64url') };
};

describe('a member that refused a pend will not sign that action\'s commit', () => {
	let self: KeyPair;
	let other: KeyPair;
	let member: ClusterMember;
	let storage: StorageRepo;

	/**
	 * Drive `member` through the losing action's PEND consensus so its storage refuses (a rival
	 * already holds the block), leaving the member in the state the guard reads: a retained,
	 * conflict-shaped refusal for that action.
	 */
	const driveLoserPendConsensus = async (nonce = 0): Promise<PendResult | undefined> => {
		const peers = makeClusterPeers([self, other]);
		const message: RepoMessage = {
			operations: [{ pend: pendFor(LOSER_ACTION) }],
			coordinatingBlockIds: [BLOCK],
			// The nonce only exists to give a second round its own messageHash — a redelivery of the
			// same hash short-circuits on the executed marker and never re-applies.
			expiration: Date.now() + 30000 + nonce
		};
		const base: ClusterRecord = { messageHash: await computeMessageHash(message), message, peers, promises: {}, commits: {} };
		const promised: ClusterRecord = {
			...base,
			promises: {
				[self.peerId.toString()]: await makeSignedPromise(self.privateKey, base),
				[other.peerId.toString()]: await makeSignedPromise(other.privateKey, base)
			}
		};
		// The peer's commit is already present, so the member's own commit completes the majority and
		// the same delivery carries it straight through to consensus — where it applies the pend and
		// its storage refuses.
		await member.update({
			...promised,
			commits: { [other.peerId.toString()]: await makeSignedCommit(other.privateKey, promised) }
		});
		// Read the verdict off the member's OWN retention, not off the response record: this arm must
		// not silently depend on arm 1's return channel being wired, or neutering arm 1 breaks these
		// tests in their setup and they stop testing arm 2 at all.
		return member.getExecutedPendResult(base.messageHash);
	};

	/** Drive the loser's pend to consensus and assert this member's storage refused it. */
	const refuseLoserPend = async (): Promise<void> => {
		const outcome = await driveLoserPendConsensus();
		expect(outcome?.success, 'the member\'s storage must have refused the loser\'s pend').to.equal(false);
	};

	/** A promise-round delivery of the loser's COMMIT: no votes yet, so the member must cast one. */
	const commitPromiseRecord = async (): Promise<ClusterRecord> => {
		const message: RepoMessage = {
			operations: [{ commit: { actionId: LOSER_ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: CONTESTED_REV } }],
			coordinatingBlockIds: [BLOCK],
			expiration: Date.now() + 30000
		};
		return { messageHash: await computeMessageHash(message), message, peers: makeClusterPeers([self, other]), promises: {}, commits: {} };
	};

	beforeEach(async () => {
		self = await makeKeyPair();
		other = await makeKeyPair();
		storage = realStorageRepo();
		await seedBlockAtRev1(storage);
		member = clusterMember({
			storageRepo: storage, peerNetwork: new MockPeerNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			consensusConfig: cohortConfig
		});
		// The rival that makes the loser's pend refusable, taken before the loser's pend arrives.
		const rival = await storage.pend(pendFor(WINNER_ACTION));
		expect(rival.success).to.equal(true);
	});

	afterEach(() => {
		member?.dispose();
	});

	it('votes reject on the commit of an action whose pend it refused', async () => {
		await refuseLoserPend();

		const answer = await member.update(await commitPromiseRecord());

		const vote = answer.promises[self.peerId.toString()];
		expect(vote?.type, 'the member must refuse to endorse a commit it already refused the pend for').to.equal('reject');
		expect((vote as { rejectReason?: string }).rejectReason).to.include('refused pend');
	});

	it('abstains once the refusal is no longer corroborated (cancelled rival)', async () => {
		await refuseLoserPend();
		// The rival goes away — this member's refusal is now history, and vetoing a commit the rest of
		// the cohort holds fine would be worse than abstaining. This is the condition that keeps the
		// guard from regressing the lagging-member commit tolerance.
		await storage.cancel({ actionId: WINNER_ACTION, blockIds: [BLOCK] });

		const answer = await member.update(await commitPromiseRecord());

		expect(answer.promises[self.peerId.toString()]?.type, 'an uncorroborated refusal must abstain').to.equal('approve');
	});

	it('retires the refusal once the same action’s pend later succeeds here', async () => {
		// The member refuses the loser, the rival then goes away, and a retried pend of the SAME
		// action is accepted. A third, unrelated action now reserves the block. Without retiring the
		// stale refusal the member would veto the commit of an action it is itself holding pended,
		// purely because *some* rival is present — two pending actions on one block is ordinary, and
		// the one committing legitimately won.
		await refuseLoserPend();
		await storage.cancel({ actionId: WINNER_ACTION, blockIds: [BLOCK] });
		const accepted = await driveLoserPendConsensus(1);
		expect(accepted?.success, 'the retried pend must be accepted this time').to.equal(true);
		const unrelated = await storage.pend({ ...pendFor('a-unrelated'), policy: 'c' });
		expect(unrelated.success).to.equal(true);

		const answer = await member.update(await commitPromiseRecord());

		expect(answer.promises[self.peerId.toString()]?.type, 'a retired refusal must not veto').to.equal('approve');
	});

	it('abstains for an action it simply never saw the pend of (cohort drift is not a refusal)', async () => {
		// No pend consensus at all for the loser: this member is merely behind, which every existing
		// commit-divergence tolerance depends on being an abstain.
		await storage.cancel({ actionId: WINNER_ACTION, blockIds: [BLOCK] });

		const answer = await member.update(await commitPromiseRecord());

		expect(answer.promises[self.peerId.toString()]?.type).to.equal('approve');
	});
});
