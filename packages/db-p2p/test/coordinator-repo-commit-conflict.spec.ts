/**
 * Ticket: consensus-pend-refusal-commit-tier-close.
 *
 * The commit-tier acknowledgement hole: three concurrent commits race one revision, one wins
 * commit-consensus, and each loser's `ConflictRaceLostError` used to RETHROW out of
 * `CoordinatorRepo.commit`. db-core's `commitCollection` retries a THROWN commit error verbatim
 * (it treats throws as transport faults); by the retry the members have applied the winner and
 * cleared its reservation, so the re-driven commit assembles a consensus no member durably stores
 * — the writer's append fulfills, the entry exists on no node.
 *
 * The coordinator-side arms under test here:
 *  - a `ConflictRaceLostError` from commit-consensus is RETURNED as a retryable conflict
 *    (`{ success:false, conflict:true }`), exactly as `pend` already does — a returned failure is
 *    surfaced immediately as a stale loss and never verbatim-retried;
 *  - a `ValidatorRejectionError` (the member-side promise-round stale-commit reject,
 *    `ClusterMember.validateCommitRevisions`) is classified against LOCAL storage
 *    (`classifyCommitStaleRejection`): a confirmed rival at the requested revision becomes a
 *    retryable conflict carrying `staleAt`; anything unconfirmed stays a throw. Confirmation
 *    EXCLUDES the own-action-at-rev case — a commit already durable under this action must not be
 *    answered `conflict`, or the writer would rebase and re-append it (a duplicate entry).
 *
 * The signed reject text is never consulted — classification is a local re-read only.
 */

import { expect } from 'chai';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, CommitResult, ActionBlocks, MessageOptions, BlockId, ActionId, ActionRev,
	ClusterRecord, StaleFailure, RepoMessage
} from '@optimystic/db-core';
import { isConflictFailure } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { CoordinatorRepo, type ICoordinatorClusterSeam } from '../src/repo/coordinator-repo.js';
import { ConflictRaceLostError, ValidatorRejectionError } from '../src/repo/cluster-coordinator.js';
import type { ClusterClient } from '../src/cluster/client.js';

const BLOCK = 'block-commit-conflict' as BlockId;
const OUR_ACTION = 'a-loser' as ActionId;
const RIVAL_ACTION = 'a-winner' as ActionId;

const REQUEST: CommitRequest = { actionId: OUR_ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: 2 };

const keyNetwork: IKeyNetwork = {
	async findCoordinator(_key: Uint8Array, _o?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return {};
	}
};

/**
 * A storage repo whose `get` answers with the given per-block latest, optionally extended with the
 * revision→actionId capability (`getRevisionAction`). `commit` must never run — the consensus stub
 * throws before the local-commit fallback is reached.
 */
const makeStorageRepo = (
	latest: ActionRev | undefined,
	revisionAction?: (blockId: BlockId, rev: number) => Promise<ActionId | undefined>,
	getThrows?: Error
): IRepo => {
	const repo: IRepo & { getRevisionAction?: (blockId: BlockId, rev: number) => Promise<ActionId | undefined> } = {
		async get(gets: BlockGets, _o?: MessageOptions): Promise<GetBlockResults> {
			if (getThrows) throw getThrows;
			return Object.fromEntries(gets.blockIds.map(id => [id, { state: latest ? { latest } : {} }]));
		},
		async pend(_r: PendRequest, _o?: MessageOptions): Promise<PendResult> {
			throw new Error('not under test');
		},
		async cancel(_r: ActionBlocks, _o?: MessageOptions): Promise<void> { },
		async commit(_r: CommitRequest, _o?: MessageOptions): Promise<CommitResult> {
			throw new Error('storageRepo.commit must not run when consensus threw');
		}
	};
	if (revisionAction) repo.getRevisionAction = revisionAction;
	return repo;
};

/** A repo wired so `commit` takes the multi-peer path and commit-consensus THROWS `error`. */
const makeRepo = (storageRepo: IRepo, error: Error): CoordinatorRepo => {
	const repo = new CoordinatorRepo(
		keyNetwork,
		((_p: PeerId) => ({} as unknown as ClusterClient)),
		storageRepo,
		{ clusterSize: 3 }
	);
	(repo as unknown as { coordinator: ICoordinatorClusterSeam }).coordinator = {
		async getClusterSize(): Promise<number> { return 3; },
		async getClusterPeerIds(): Promise<string[]> { return ['peer-1', 'peer-2', 'peer-3']; },
		async recoverTransactions(): Promise<void> { /* unused on these paths */ },
		async executeClusterTransaction(): Promise<{ record: ClusterRecord, localExecuted: boolean }> {
			throw error;
		}
	};
	return repo;
};

const rejection = (): ValidatorRejectionError =>
	new ValidatorRejectionError('validation failed', { 'peer-1': 'stale commit: block whatever' });

const expectThrows = async (repo: CoordinatorRepo, expected: Error): Promise<void> => {
	try {
		await repo.commit(REQUEST);
	} catch (err) {
		expect(err).to.equal(expected);
		return;
	}
	expect.fail('commit must rethrow when the loss is unconfirmed');
};

describe('CoordinatorRepo commit — lost races return as retryable conflicts', () => {
	it('returns a ConflictRaceLostError as a retryable conflict instead of rethrowing', async () => {
		// The observed hole: rethrowing let db-core's verbatim commit retry re-drive the dead rival
		// into a consensus no member durably stores. At throw time zero members approved and the
		// members hold the winner, so a conflict result is truthful.
		const error = new ConflictRaceLostError('3/3 member(s) hold a conflicting winner (0/3 approvals)', { 'peer-1': 'winner-hash' });
		const repo = makeRepo(makeStorageRepo(undefined), error);

		const result = await repo.commit(REQUEST);

		expect(result.success).to.equal(false);
		expect(isConflictFailure(result as StaleFailure), 'the loss must be retryable').to.equal(true);
		expect((result as StaleFailure).reason).to.equal(error.message);
		expect((result as StaleFailure).staleAt, 'a lost race is not a confirmed revision claim').to.equal(undefined);
	});

	it('classifies a validator rejection as a conflict when a rival holds the requested revision', async () => {
		// The promise-round stale-commit reject shape: latest.rev === request.rev under a different
		// action. Confirmed locally, so the writer gets a clean retryable loss with staleAt.
		const repo = makeRepo(makeStorageRepo({ rev: 2, actionId: RIVAL_ACTION }), rejection());

		const result = await repo.commit(REQUEST);

		expect(result.success).to.equal(false);
		expect(isConflictFailure(result as StaleFailure)).to.equal(true);
		expect((result as StaleFailure).staleAt).to.deep.equal({ blockId: BLOCK, rev: 2 });
	});

	it('classifies a conflict via the revision→actionId capability when latest is past the requested rev', async () => {
		// latest.rev > request.rev: latest.actionId can no longer name who took rev 2, so the
		// classifier consults getRevisionAction — a rival there confirms the loss.
		const storageRepo = makeStorageRepo(
			{ rev: 5, actionId: 'a-later' as ActionId },
			async (_b, rev) => rev === 2 ? RIVAL_ACTION : undefined
		);
		const repo = makeRepo(storageRepo, rejection());

		const result = await repo.commit(REQUEST);

		expect(result.success).to.equal(false);
		expect(isConflictFailure(result as StaleFailure)).to.equal(true);
		expect((result as StaleFailure).staleAt).to.deep.equal({ blockId: BLOCK, rev: 5 });
	});

	it('does NOT classify when the requested revision is held by our own action (latest at rev)', async () => {
		// Already durable under this action: a conflict answer would make the writer rebase and
		// re-append an action that landed — a duplicate entry. Conservative: stays a throw.
		const error = rejection();
		const repo = makeRepo(makeStorageRepo({ rev: 2, actionId: OUR_ACTION }), error);
		await expectThrows(repo, error);
	});

	it('does NOT classify when the capability shows our own action took the requested revision', async () => {
		const error = rejection();
		const storageRepo = makeStorageRepo(
			{ rev: 5, actionId: 'a-later' as ActionId },
			async () => OUR_ACTION
		);
		await expectThrows(makeRepo(storageRepo, error), error);
	});

	it('stays a throw when latest is past the requested rev and the capability is absent', async () => {
		const error = rejection();
		await expectThrows(makeRepo(makeStorageRepo({ rev: 5, actionId: 'a-later' as ActionId }), error), error);
	});

	it('stays a throw when the capability holds no record for the requested revision', async () => {
		const error = rejection();
		const storageRepo = makeStorageRepo(
			{ rev: 5, actionId: 'a-later' as ActionId },
			async () => undefined
		);
		await expectThrows(makeRepo(storageRepo, error), error);
	});

	it('stays a throw when local storage is behind the requested revision (unconfirmed)', async () => {
		const error = rejection();
		await expectThrows(makeRepo(makeStorageRepo({ rev: 1, actionId: RIVAL_ACTION }), error), error);
	});

	it('stays a throw when the confirming read itself fails', async () => {
		const error = rejection();
		const storageRepo = makeStorageRepo(undefined, undefined, new Error('read fault'));
		await expectThrows(makeRepo(storageRepo, error), error);
	});

	it('rethrows a non-validator, non-race error untouched (transport faults keep the verbatim retry)', async () => {
		const error = new Error('dial failure');
		await expectThrows(makeRepo(makeStorageRepo({ rev: 2, actionId: RIVAL_ACTION }), error), error);
	});
});

/**
 * Ticket: consensus-pend-refusal-commit-tier-verify2 (retained commit-verdict threading).
 *
 * The signed-but-not-yet-applied window: members drop a commit's reservation when they SIGN it,
 * which can precede applying it by a full propagation round — so a rival's commit racing the same
 * revision can assemble FULL consensus, and every member's storage then refuses the loser at apply
 * as stale. The member retains that verdict (`ClusterMember.getExecutedCommitResult`), the
 * coordinator threads it out of `executeClusterTransaction` as `localCommitResult`, and
 * `CoordinatorRepo.commit`'s locally-executed branch confirms the refusal against LOCAL storage:
 * a confirmed rival at the requested revision becomes a retryable conflict; an own-action-durable
 * or unconfirmed refusal keeps the prior fabricated-success shape (consensus is authoritative and
 * this member converges via replication).
 */
describe('CoordinatorRepo commit — locally-executed consensus consults the retained member verdict', () => {
	const RECORD: ClusterRecord = { messageHash: 'mh', peers: {}, message: {} as RepoMessage, promises: {}, commits: {} };
	/** The ahead-shaped refusal `ClusterMember` retains when apply found the revision already taken. */
	const refusal: CommitResult = { success: false, missing: [], reason: 'commit:stale missed=1' };

	/** A repo whose stubbed consensus resolves locally-executed, optionally carrying a retained verdict. */
	const makeLocalExecutedRepo = (storageRepo: IRepo, localCommitResult?: CommitResult): CoordinatorRepo => {
		const repo = new CoordinatorRepo(
			keyNetwork,
			((_p: PeerId) => ({} as unknown as ClusterClient)),
			storageRepo,
			{ clusterSize: 3 }
		);
		(repo as unknown as { coordinator: ICoordinatorClusterSeam }).coordinator = {
			async getClusterSize(): Promise<number> { return 3; },
			async getClusterPeerIds(): Promise<string[]> { return ['peer-1', 'peer-2', 'peer-3']; },
			async recoverTransactions(): Promise<void> { /* unused on these paths */ },
			async executeClusterTransaction(): Promise<{ record: ClusterRecord, localExecuted: boolean, localCommitResult?: CommitResult }> {
				return { record: RECORD, localExecuted: true, ...(localCommitResult !== undefined ? { localCommitResult } : {}) };
			}
		};
		return repo;
	};

	/** Wrap a storage repo so the test can assert whether the confirmation re-read ran at all. */
	const countingGets = (storageRepo: IRepo): { repo: IRepo, gets: () => number } => {
		let gets = 0;
		return {
			repo: {
				...storageRepo,
				async get(g: BlockGets, o?: MessageOptions): Promise<GetBlockResults> {
					gets++;
					return storageRepo.get(g, o);
				}
			},
			gets: () => gets
		};
	};

	it('returns a conflict with staleAt when the retained refusal confirms as a rival at the requested revision', async () => {
		const repo = makeLocalExecutedRepo(makeStorageRepo({ rev: 2, actionId: RIVAL_ACTION }), refusal);

		const result = await repo.commit(REQUEST);

		expect(result.success).to.equal(false);
		expect(isConflictFailure(result as StaleFailure), 'the confirmed loss must be retryable').to.equal(true);
		expect((result as StaleFailure).staleAt).to.deep.equal({ blockId: BLOCK, rev: 2 });
	});

	it('confirms the rival via the revision→actionId capability when latest is past the requested rev', async () => {
		const storageRepo = makeStorageRepo(
			{ rev: 5, actionId: 'a-later' as ActionId },
			async (_b, rev) => rev === 2 ? RIVAL_ACTION : undefined
		);
		const result = await makeLocalExecutedRepo(storageRepo, refusal).commit(REQUEST);

		expect(result.success).to.equal(false);
		expect(isConflictFailure(result as StaleFailure)).to.equal(true);
		expect((result as StaleFailure).staleAt).to.deep.equal({ blockId: BLOCK, rev: 5 });
	});

	it('keeps the fabricated success when the refusal is our own action durable at the requested revision', async () => {
		// Already durable under this action: a conflict answer would make the writer rebase and
		// re-append a landed action — a duplicate entry. The mesh spec's membership/uniqueness
		// assertions are the end-to-end guard for this arm.
		const repo = makeLocalExecutedRepo(makeStorageRepo({ rev: 2, actionId: OUR_ACTION }), refusal);
		expect((await repo.commit(REQUEST)).success).to.equal(true);
	});

	it('keeps the fabricated success when local storage is behind the requested revision (unconfirmed)', async () => {
		const repo = makeLocalExecutedRepo(makeStorageRepo({ rev: 1, actionId: RIVAL_ACTION }), refusal);
		expect((await repo.commit(REQUEST)).success).to.equal(true);
	});

	it('keeps the fabricated success when latest is past the rev and the capability is absent (unconfirmed)', async () => {
		const repo = makeLocalExecutedRepo(makeStorageRepo({ rev: 5, actionId: 'a-later' as ActionId }), refusal);
		expect((await repo.commit(REQUEST)).success).to.equal(true);
	});

	it('returns success without a confirmation re-read when the retained verdict is a success', async () => {
		const { repo: storageRepo, gets } = countingGets(makeStorageRepo({ rev: 2, actionId: OUR_ACTION }));
		const repo = makeLocalExecutedRepo(storageRepo, { success: true });

		expect((await repo.commit(REQUEST)).success).to.equal(true);
		expect(gets(), 'a retained success needs no classification read').to.equal(0);
	});

	it('keeps the prior fabricated-success shape when no verdict was retained', async () => {
		// A mock/legacy coordinator resolving localExecuted with no localCommitResult (e.g. the
		// member restarted, or the TTL pruned the verdict) keeps the old behavior exactly.
		const { repo: storageRepo, gets } = countingGets(makeStorageRepo({ rev: 2, actionId: RIVAL_ACTION }));
		const repo = makeLocalExecutedRepo(storageRepo);

		expect((await repo.commit(REQUEST)).success).to.equal(true);
		expect(gets(), 'no verdict, no classification read').to.equal(0);
	});
});
