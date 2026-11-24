/**
 * Ticket: a-full-cohort-member-refuses-a-pend.
 *
 * A cohort member whose storage has filled the space its operator gave it now answers a pend with a
 * signed `out-of-space` vote instead of approving and discovering the problem when its disk fails the
 * write. The vote is transient — nobody judged the write — so it is counted apart from approvals and
 * rejections at every threshold, exactly as `conflict` and `held` are.
 *
 * The defect this guards is the one the `held` vote was created for, and it is the reason a third
 * non-counting kind had to exist rather than reusing `reject`: `maxAllowedRejections` is zero for any
 * cohort of three or fewer members at the default super-majority, so a single member's "not right now"
 * expressed as a `reject` becomes a permanent `ValidatorRejectionError` for the whole transaction.
 *
 * Three claims, over the two tiers where they are observable:
 *  - the member signs `out-of-space` (and only for a pend it would otherwise have APPROVED: a stale
 *    revision still wins, permanently, and a member with room still approves);
 *  - the member's own recomputed phase is the terminal-but-retryable one, not `Rejected`;
 *  - the writer's answer is the typed out-of-space refusal — RETURNED, not thrown — and neither a
 *    validator rejection nor a conflict-shaped `StaleFailure` the retry loop would absorb.
 */

import { expect } from 'chai';
import { localDurability, isConflictFailure, isOutOfSpaceFailure, clusterVoteVerificationPayload } from '@optimystic/db-core';
import { clusterMember } from '../src/cluster/cluster-repo.js';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { captureLog } from './support/capture-log.js';
import type {
	IRepo, ClusterRecord, RepoMessage, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, CommitResult, ActionBlocks, ClusterPeers, BlockId, ActionId, ActionRev, Signature,
	IPeerNetwork, IKeyNetwork, ICluster, ClusterConsensusConfig, WriteFailure
} from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';

const BLOCK: BlockId = 'full-cohort-block';
const OUR_ACTION = 'a-ours' as ActionId;
const RIVAL_ACTION = 'a-rival' as ActionId;

/** The whole of the pressure reading a promise vote and the solo gate read (`StoragePressureGate`). */
const pressure = (refusing: boolean) => ({ refusingNewData: (): boolean => refusing });

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const makeClusterPeers = (peerIds: readonly PeerId[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const peerId of peerIds) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url')
		};
	}
	return peers;
};

const makePend = (over: Partial<PendRequest> = {}): PendRequest => ({
	actionId: OUR_ACTION,
	rev: 2,
	transforms: { inserts: {}, updates: { [BLOCK]: [['entries', 0, 0, ['x']]] }, deletes: [] },
	policy: 'c',
	...over
});

// ─── Member tier (harness mirrors cluster-pend-held-vote.spec.ts: v1 record driven through
// member.update, the member's own vote read out of record.promises[self]) ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

const makeMessage = (pend: PendRequest): RepoMessage => ({
	operations: [{ pend }],
	coordinatingBlockIds: [BLOCK],
	expiration: Date.now() + 30000
});

/** A v1 (membership-unbound) pend record, so the spec can recompute the promise hash the member signed. */
const makePendRecord = async (peers: ClusterPeers, pend: PendRequest): Promise<ClusterRecord> => {
	const message = makeMessage(pend);
	const hashBytes = await sha256.digest(new TextEncoder().encode(canonicalJson(message)));
	return { messageHash: base58btc.encode(hashBytes.digest), message, peers, promises: {}, commits: {} };
};

/** The bytes the member signs its promise vote over — `computeClusterPromiseHash`'s v1 preimage. */
const promiseHashOf = async (record: ClusterRecord): Promise<string> => {
	const bytes = new TextEncoder().encode(record.messageHash + canonicalJson(record.message));
	return uint8ArrayToString((await sha256.digest(bytes)).digest, 'base64url');
};

/** A repo whose `get` answers the given per-block storage state — a committed latest, a rival reservation, or neither. */
class StateRepo implements IRepo {
	constructor(private readonly state: { latest?: ActionRev; pendings?: ActionId[] } = {}) { }
	async get(gets: BlockGets): Promise<GetBlockResults> {
		return Object.fromEntries(gets.blockIds.map(id => [id, { state: { ...this.state } }]));
	}
	async pend(_request: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [], durability: localDurability() }; }
	async commit(_request: CommitRequest): Promise<CommitResult> { return { success: true, durability: localDurability() }; }
	async cancel(_actionRef: ActionBlocks): Promise<void> { /* no-op */ }
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

interface CastVote { signature: Signature | undefined; record: ClusterRecord; self: KeyPair; }

/**
 * Drive `pend` through one member of a cohort of `cohortSize` (this member plus silent others), whose
 * storage is `repo` and whose last pressure sample read `refusing` iff `refusing`.
 */
const voteOnPend = async (repo: IRepo, pend: PendRequest, refusing: boolean, cohortSize = 3): Promise<CastVote> => {
	const self = await makeKeyPair();
	const others = await Promise.all(Array.from({ length: cohortSize - 1 }, makeKeyPair));
	const member = clusterMember({
		storageRepo: repo,
		peerNetwork: new MockPeerNetwork(),
		peerId: self.peerId,
		privateKey: self.privateKey,
		storagePressure: pressure(refusing)
	});
	try {
		const record = await makePendRecord(makeClusterPeers([self.peerId, ...others.map(o => o.peerId)]), pend);
		const result = await member.update(record);
		return { signature: result.promises[self.peerId.toString()], record, self };
	} finally {
		member.dispose();
	}
};

/** Whether the vote verifies under the voter's own key, over the payload its variant defines. */
const voteVerifies = async ({ signature, record, self }: CastVote): Promise<boolean> => {
	if (!signature) return false;
	return await self.peerId.publicKey!.verify(
		clusterVoteVerificationPayload(await promiseHashOf(record), signature),
		uint8ArrayFromString(signature.signature, 'base64url')
	);
};

const linesWith = (captured: unknown[][], tag: string): unknown[][] =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(tag));

describe('ClusterMember — a member with no room left votes `out-of-space`', () => {
	it('signs an `out-of-space` vote, verifiable and carrying no payload', async () => {
		const vote = await voteOnPend(new StateRepo(), makePend(), true);

		expect(vote.signature?.type, 'a refusal for want of space must not be a validity judgement').to.equal('out-of-space');
		// No payload rides on it: a byte figure would be unverifiable, a publication of an operator's
		// disk, and unread. The type is the whole message, so the preimage is the bare tag.
		expect(vote.signature).to.not.have.property('rejectReason');
		expect(await voteVerifies(vote), 'the bare-tag preimage must verify').to.equal(true);
	});

	it('leaves the record in the terminal-but-retryable phase, never `Rejected`', async () => {
		// A cohort of three at the default 0.75 needs all three approvals, so `maxAllowedRejections` is
		// zero and this member's single refusal decides the record on its own. That is the exact shape
		// in which a `reject` would have become a permanent `ValidatorRejectionError`.
		const captured = await captureLog('cluster-member', async () => {
			const vote = await voteOnPend(new StateRepo(), makePend(), true);
			expect(vote.signature?.type).to.equal('out-of-space');
		});

		expect(linesWith(captured, 'cluster-member:action-conflict-superseded'), 'terminal for this record, retryable as a fresh one').to.have.lengthOf(1);
		expect(linesWith(captured, 'cluster-member:action-rejected'), 'nobody judged the write').to.have.lengthOf(0);
		expect(linesWith(captured, 'cluster-member:validation-out-of-space'), 'and an operator reads it as its own event').to.have.lengthOf(1);
	});

	it('approves the same pend when the member has room', async () => {
		const vote = await voteOnPend(new StateRepo(), makePend(), false);
		expect(vote.signature?.type).to.equal('approve');
	});

	it('still rejects — permanently — a pend whose requested revision is already taken', async () => {
		// The ordering rule, which is this gate's one real correctness requirement: reading costs no
		// storage, so a full member still judges content. A transient "I am full" in place of the stale
		// verdict would send the writer round a retry loop against content no honest member will accept.
		const vote = await voteOnPend(
			new StateRepo({ latest: { rev: 2, actionId: RIVAL_ACTION } }),
			makePend(),
			true
		);

		expect(vote.signature?.type).to.equal('reject');
		expect(vote.signature).to.have.property('rejectReason', `stale revision: block ${BLOCK} at rev 2, requested rev 2`);
	});

	it('still holds for a rival reservation, which names an actionable rival', async () => {
		// `held` wins for the other half of the same reason: it names a rival that clears when that
		// rival commits or cancels, where out-of-space names only a condition.
		const vote = await voteOnPend(new StateRepo({ pendings: [RIVAL_ACTION] }), makePend(), true);

		expect(vote.signature?.type).to.equal('held');
		expect(vote.signature).to.have.property('heldBy', RIVAL_ACTION);
	});
});

// ─── Writer tier (harness mirrors coordinator-repo-stale-classification.spec.ts: mocked cohort
// members whose promise votes are scripted, driven through the real ClusterCoordinator) ───

/** What one mock cohort member answers a promise request with. */
type Answer = 'approve' | 'out-of-space';

class AnsweringClusterClient implements ICluster {
	constructor(private readonly peerIdStr: string, private readonly answer: Answer) { }

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		if (!(this.peerIdStr in record.promises)) {
			const sig: Signature = this.answer === 'out-of-space'
				? { type: 'out-of-space', signature: `psig-${this.peerIdStr.substring(0, 8)}` }
				: { type: 'approve', signature: `psig-${this.peerIdStr.substring(0, 8)}` };
			return { ...record, promises: { ...record.promises, [this.peerIdStr]: sig } };
		}
		return {
			...record,
			commits: { ...record.commits, [this.peerIdStr]: { type: 'approve', signature: `csig-${this.peerIdStr.substring(0, 8)}` } as Signature }
		};
	}
}

/** Local storage for the coordinating node: a refused pend must never reach it. */
class CountingStorageRepo implements IRepo {
	pendCalls = 0;
	async get(gets: BlockGets): Promise<GetBlockResults> {
		return Object.fromEntries(gets.blockIds.map(id => [id, { state: {} }]));
	}
	async pend(request: PendRequest): Promise<PendResult> {
		this.pendCalls++;
		return { success: true, pending: [], blockIds: Object.keys(request.transforms.updates ?? {}), durability: localDurability() };
	}
	async commit(_request: CommitRequest): Promise<CommitResult> { return { success: true, durability: localDurability() }; }
	async cancel(_actionRef: ActionBlocks): Promise<void> { /* no-op */ }
}

const cfg: Partial<ClusterConsensusConfig> & { clusterSize: number } = {
	clusterSize: 3,
	superMajorityThreshold: 0.75,
	simpleMajorityThreshold: 0.51,
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000
};

describe('CoordinatorRepo — a cohort with a full member answers out-of-space, not a rejection', function () {
	this.timeout(10000);

	it('returns the typed out-of-space refusal when one of three members has no room', async () => {
		// Three members at 0.75 need all three approvals, so one refusal is terminal for the record.
		// Before this vote existed the member had no way to say "I am full" at all; said as a `reject`
		// it would arrive here as a permanent `ValidatorRejectionError` for the whole transaction.
		const peerIds = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair()]);
		const answers: Answer[] = ['approve', 'approve', 'out-of-space'];
		const mocks = new Map(peerIds.map(({ peerId }, i) => [peerId.toString(), new AnsweringClusterClient(peerId.toString(), answers[i]!)]));
		const clusterPeers = makeClusterPeers(peerIds.map(p => p.peerId));
		const keyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!.peerId; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const storage = new CountingStorageRepo();
		const repo = new CoordinatorRepo(
			keyNetwork,
			(peerId: PeerId) => {
				const mock = mocks.get(peerId.toString());
				if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
				return mock;
			},
			storage,
			cfg
		);

		const result = await repo.pend(makePend());

		expect(result.success, 'a full cohort is a refusal, not a success').to.equal(false);
		const failure = result as WriteFailure;
		// RETURNED, not thrown: db-core retries a thrown pend verbatim as a transport fault, and a retry
		// cannot help — nothing about the revision is the problem, so a re-read and rebase would send the
		// same bytes to the same full members.
		expect(isOutOfSpaceFailure(failure), 'the writer gets the typed terminal answer').to.equal(true);
		// Not a conflict-shaped StaleFailure either, or the retry loop would absorb it and spend the
		// writer's whole budget on a round it cannot win.
		expect(isConflictFailure(failure), 'a cohort with no room is not a race a re-read can win').to.equal(false);
		expect(failure.outOfSpace?.peerIds, 'naming the member that refused').to.deep.equal([peerIds[2]!.peerId.toString()]);
		expect(failure.outOfSpace?.approvals).to.equal(2);
		expect(failure.outOfSpace?.needed).to.equal(3);
		expect(storage.pendCalls, 'a refused pend must not reach local storage').to.equal(0);
	});
});
