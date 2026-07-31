import { expect } from 'chai';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { ValidatorRejectionError } from '../src/repo/cluster-coordinator.js';
import { isConflictFailure } from '@optimystic/db-core';
import type { ClusterRecord, ClusterPeers, IKeyNetwork, ICluster, ClusterConsensusConfig, BlockId, Signature, IRepo, PendRequest, PendResult, GetBlockResults, BlockGets, StaleFailure } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';

/**
 * Locks the stale-revision classification in `CoordinatorRepo.pend`: a validator rejection that
 * local storage confirms as an optimistic-concurrency loss (`latest.rev >= request.rev`) must be
 * RETURNED as a `StaleFailure` — the shape `Collection.sync`'s bounded retry loop keys on — while
 * an unconfirmed rejection must keep THROWING `ValidatorRejectionError` (fail-fast for genuine
 * validation faults). Regression for the PartialCommitError seen when a concurrent same-rev write
 * from another node escaped as a thrown error mid multi-tree commit sweep.
 *
 * Topology: 2 mocked cluster peers with `superMajorityThreshold` 0.67 →
 * `superMajority = ceil(2 * 0.67) = 2`, `maxAllowedRejections = 0`, so a single reject vote
 * triggers the rejected-by-validators branch.
 */

const makePeerId = async (): Promise<PeerId> => {
	const pk = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(pk);
};

type Verdict = { type: 'approve' } | { type: 'reject'; reason: string };

/** Promise phase: votes per verdict. Commit phase (promise already present): always approves. */
class MockClusterClient implements ICluster {
	constructor(
		private readonly peerIdStr: string,
		public verdict: Verdict
	) { }

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		if (!(this.peerIdStr in record.promises)) {
			const sig: Signature = this.verdict.type === 'reject'
				? { type: 'reject', signature: `psig-${this.peerIdStr.substring(0, 8)}`, rejectReason: this.verdict.reason }
				: { type: 'approve', signature: `psig-${this.peerIdStr.substring(0, 8)}` };
			return {
				...record,
				promises: { ...record.promises, [this.peerIdStr]: sig }
			};
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

/**
 * Local storage stub. `latestRev` drives the classification re-read: undefined → no `latest`
 * (nothing committed locally), a number → `state.latest.rev`. `revByBlock` overrides it per block
 * so a multi-block request can have only some of its blocks stale. `getError` forces the re-read to
 * fail (classification must then conservatively rethrow).
 */
class MockStorageRepo implements IRepo {
	latestRev: number | undefined;
	revByBlock: Record<BlockId, number> | undefined;
	getError: Error | undefined;
	getCalls = 0;
	pendCalls = 0;

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		this.getCalls++;
		if (this.getError) throw this.getError;
		return Object.fromEntries(blockGets.blockIds.map(id => {
			const rev = this.revByBlock?.[id] ?? this.latestRev;
			return [id, { state: rev === undefined ? {} : { latest: { actionId: 'prior-action', rev } } }];
		}));
	}

	async pend(request: PendRequest): Promise<PendResult> {
		this.pendCalls++;
		return { success: true, pending: [], blockIds: Object.keys(request.transforms.updates ?? {}) };
	}

	async cancel(): Promise<void> { }

	async commit(): Promise<never> {
		throw new Error('commit not expected in these scenarios');
	}
}

const cfg: Partial<ClusterConsensusConfig> & { clusterSize: number } = {
	clusterSize: 2,
	superMajorityThreshold: 0.67,
	simpleMajorityThreshold: 0.51,
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000
};

const BLOCK_ID: BlockId = 'block-1';
const BLOCK_ID_2: BlockId = 'block-2';

const makePendRequest = (rev: number | undefined, blockIds: BlockId[] = [BLOCK_ID]): PendRequest => ({
	actionId: `action-rev-${rev ?? 'none'}`,
	rev,
	transforms: { updates: Object.fromEntries(blockIds.map(id => [id, []])), inserts: {}, deletes: [] },
	policy: 'c'
});

describe('CoordinatorRepo stale-revision classification (pend)', function () {
	this.timeout(10000);

	let mocks: Map<string, MockClusterClient>;
	let storage: MockStorageRepo;
	let repo: CoordinatorRepo;

	const setVerdicts = (a: Verdict, b: Verdict): void => {
		const clients = Array.from(mocks.values());
		clients[0]!.verdict = a;
		clients[1]!.verdict = b;
	};

	beforeEach(async () => {
		const peerIds = await Promise.all([makePeerId(), makePeerId()]);
		const clusterPeers: ClusterPeers = {};
		for (const pid of peerIds) {
			clusterPeers[pid.toString()] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
		}
		mocks = new Map(peerIds.map(pid => [
			pid.toString(),
			new MockClusterClient(pid.toString(), { type: 'approve' })
		]));

		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const createClient = (peerId: PeerId): ICluster => {
			const mock = mocks.get(peerId.toString());
			if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
			return mock;
		};

		storage = new MockStorageRepo();
		// No localPeerId → verifyResponsibility passes trivially; no localCluster → the
		// storage stub receives the post-consensus pend on success paths.
		repo = new CoordinatorRepo(mockKeyNetwork, createClient, storage, cfg);
	});

	it('returns StaleFailure when local storage confirms the requested rev is taken, then succeeds on retry at the next rev', async () => {
		setVerdicts({ type: 'approve' }, { type: 'reject', reason: 'stale revision: block block-1 at rev 1, requested rev 1' });
		storage.latestRev = 1;

		const result = await repo.pend(makePendRequest(1));
		expect(result.success, 'confirmed stale loss must be a returned failure, not a throw').to.equal(false);
		expect((result as StaleFailure).reason).to.match(/stale revision/);
		// The confirmation is a local re-read, so there is no `missing` evidence to infer from —
		// `conflict` is what tells the multi-collection writer this is worth retrying.
		expect((result as StaleFailure).conflict, 'confirmed loss must be flagged retryable').to.equal(true);
		expect(isConflictFailure(result as StaleFailure)).to.equal(true);
		expect(storage.getCalls, 'classification re-reads local storage').to.be.greaterThan(0);
		expect(storage.pendCalls, 'a rejected pend must not reach local storage').to.equal(0);

		// The loser's retry: re-pend at the next rev with the conflict gone.
		setVerdicts({ type: 'approve' }, { type: 'approve' });
		const retried = await repo.pend(makePendRequest(2));
		expect(retried.success, 'retry at the next rev succeeds').to.equal(true);
		expect(storage.pendCalls).to.equal(1);
	});

	it('scans every affected block and confirms one whose rev is strictly ahead of the request', async () => {
		setVerdicts({ type: 'approve' }, { type: 'reject', reason: 'stale revision: block block-2 at rev 5, requested rev 3' });
		// First block is behind the request (no confirmation there); only the second is stale, and by
		// more than one revision — exercises both the loop and the `>=` (not `===`) comparison.
		storage.revByBlock = { [BLOCK_ID]: 2, [BLOCK_ID_2]: 5 };

		const result = await repo.pend(makePendRequest(3, [BLOCK_ID, BLOCK_ID_2]));
		expect(result.success).to.equal(false);
		expect((result as StaleFailure).reason, 'reason names the stale block, not the first-scanned one')
			.to.equal(`stale revision: block ${BLOCK_ID_2} at rev 5, requested rev 3`);
		expect((result as StaleFailure).conflict).to.equal(true);
	});

	it('rethrows ValidatorRejectionError when local storage cannot confirm staleness', async () => {
		setVerdicts({ type: 'approve' }, { type: 'reject', reason: 'operations hash mismatch' });
		storage.latestRev = 0; // behind the requested rev → no local confirmation

		let caught: unknown;
		try {
			await repo.pend(makePendRequest(1));
		} catch (err) {
			caught = err;
		}
		expect(caught, 'unconfirmed rejection must fail fast').to.be.instanceOf(ValidatorRejectionError);
		expect((caught as ValidatorRejectionError).message).to.match(/rejected by validators/);
		expect(Object.values((caught as ValidatorRejectionError).rejectReasons)).to.deep.equal(['operations hash mismatch']);
	});

	it('rethrows when the request carries no rev (nothing to compare against)', async () => {
		setVerdicts({ type: 'reject', reason: 'stale revision: block block-1 at rev 1, requested rev 1' }, { type: 'approve' });
		storage.latestRev = 5;

		let caught: unknown;
		try {
			await repo.pend(makePendRequest(undefined));
		} catch (err) {
			caught = err;
		}
		expect(caught).to.be.instanceOf(ValidatorRejectionError);
		expect(storage.getCalls, 'no rev → classification skips the re-read').to.equal(0);
	});

	it('rethrows when the classification re-read itself fails', async () => {
		setVerdicts({ type: 'approve' }, { type: 'reject', reason: 'stale revision: block block-1 at rev 1, requested rev 1' });
		storage.latestRev = 1;
		storage.getError = new Error('storage unavailable');

		let caught: unknown;
		try {
			await repo.pend(makePendRequest(1));
		} catch (err) {
			caught = err;
		}
		expect(caught, 'read failure during classification must not fabricate a stale result').to.be.instanceOf(ValidatorRejectionError);
	});
});
