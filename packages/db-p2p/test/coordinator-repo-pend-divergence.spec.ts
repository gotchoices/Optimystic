/**
 * Ticket: consensus-pend-refusal-finish-and-verify (continuation of
 * consensus-pend-refusal-is-reported-to-the-writer-as-success).
 *
 * `CoordinatorRepo.pend` used to hardcode `{ success: true }` whenever its own cluster member
 * executed the pend during consensus (`localExecuted`), even when storage's actual verdict for
 * that apply was a refusal — a rival unresolved pending action holding the blocks (`pending`), or
 * the requested revision already committed (`missing`). Every member could refuse to store the
 * pend and the writer was still told it succeeded; the write was then lost silently at commit.
 *
 * The fix threads the member's retained storage verdict (`getExecutedPendResult`) back through
 * `executeClusterTransaction` as `localPendResult`, and `pend` now returns it instead of
 * fabricating success. Deliberate deviation from the commit path: pend-consensus confers no
 * durability, so BOTH `pending`- and `missing`-carrying refusals reach the writer as retryable
 * conflicts. Only a bare-reason refusal (no pending, no missing — e.g. a local validation-hook
 * fault) stays tolerated as local divergence, because there consensus is authoritative and the
 * pend may well have landed on the rest of the cohort.
 *
 * Separately, a promise-phase pending-conflict rejection (the cohort voted the pend down because
 * a rival's durable pending record holds the blocks) surfaces as a ValidatorRejectionError, and
 * `classifyPendingConflictRejection` converts it into a retryable conflict when a local re-read
 * confirms the rival — same conservative posture as the stale classifier: unconfirmed stays a
 * throw, and the signed reject text is never consulted.
 */

import { expect } from 'chai';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, CommitResult, ActionBlocks, MessageOptions, BlockId, ClusterRecord, RepoMessage, StaleFailure
} from '@optimystic/db-core';
import { isConflictFailure } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { CoordinatorRepo, type ICoordinatorClusterSeam } from '../src/repo/coordinator-repo.js';
import { ValidatorRejectionError } from '../src/repo/cluster-coordinator.js';
import type { ClusterClient } from '../src/cluster/client.js';

const BLOCK = 'block-pend-divergence' as BlockId;

const REQUEST: PendRequest = {
	actionId: 'a-pend',
	rev: 2,
	transforms: { updates: { [BLOCK]: [] } },
	policy: 'c'
};

const keyNetwork: IKeyNetwork = {
	async findCoordinator(_key: Uint8Array, _o?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return {};
	}
};

const RECORD: ClusterRecord = {
	messageHash: 'mh', peers: {}, message: {} as RepoMessage, promises: {}, commits: {}
};

/** A storage repo whose `get` does whatever `get` says; pend/commit must never be reached. */
const makeStorageRepo = (get: (gets: BlockGets) => Promise<GetBlockResults>): IRepo => ({
	get: async (gets: BlockGets, _o?: MessageOptions) => get(gets),
	async pend(_r: PendRequest, _o?: MessageOptions): Promise<PendResult> {
		throw new Error('storageRepo.pend must not run when the member executed during consensus');
	},
	async cancel(_r: ActionBlocks, _o?: MessageOptions): Promise<void> { },
	async commit(_r: CommitRequest, _o?: MessageOptions): Promise<CommitResult> {
		throw new Error('not under test');
	}
});

/**
 * A repo wired so `pend` takes the multi-peer path and consensus either returns the given
 * `localPendResult` (with `localExecuted: true`) or throws.
 */
const makeRepo = (
	storageRepo: IRepo,
	consensus: { localPendResult?: PendResult } | { throws: Error }
): CoordinatorRepo => {
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
		async executeClusterTransaction(): Promise<{ record: ClusterRecord, localExecuted: boolean, localPendResult?: PendResult }> {
			if ('throws' in consensus) throw consensus.throws;
			return { record: RECORD, localExecuted: true, ...consensus };
		}
	};
	return repo;
};

const emptyGet = async (gets: BlockGets): Promise<GetBlockResults> =>
	Object.fromEntries(gets.blockIds.map(id => [id, { state: {} }]));

describe('CoordinatorRepo pend — retained storage verdict after cluster consensus', () => {
	it('returns a retained refusal carrying `pending` as a retryable conflict', async () => {
		// The reproducer's first shape: every member's storage refused because a rival's unresolved
		// pending action held the blocks — the old code told the writer it won anyway.
		const refusal: PendResult = {
			success: false, pending: [{ blockId: BLOCK, actionId: 'a-rival' }], reason: 'blocks held'
		};
		const repo = makeRepo(makeStorageRepo(emptyGet), { localPendResult: refusal });

		const result = await repo.pend(REQUEST);

		expect(result.success, 'a refused pend must not be reported as a win').to.equal(false);
		expect(isConflictFailure(result as StaleFailure), 'the refusal must be retryable').to.equal(true);
		expect(result).to.deep.equal(refusal);
	});

	it('returns a retained refusal carrying `missing` as a retryable conflict', async () => {
		// The reproducer's second shape: the pend applied after the winner's commit had already
		// advanced the block, so storage refused with `missing` (latest.rev >= request.rev). For a
		// pend this can never become a win — the requested revision is already committed — so it is
		// a conflict too, deliberately unlike the commit path's missing-base tolerance.
		const refusal: PendResult = {
			success: false,
			missing: [{ actionId: 'a-winner', transforms: {} }],
			reason: 'already committed'
		};
		const repo = makeRepo(makeStorageRepo(emptyGet), { localPendResult: refusal });

		const result = await repo.pend(REQUEST);

		expect(result.success).to.equal(false);
		expect(isConflictFailure(result as StaleFailure)).to.equal(true);
		expect(result).to.deep.equal(refusal);
	});

	it('tolerates a retained bare-reason refusal as local divergence', async () => {
		// No pending, no missing: a local fault (e.g. a validation hook), not the shared
		// optimistic-concurrency scan. Consensus is authoritative and the pend may have landed on
		// the rest of the cohort, so the caller still sees success.
		const refusal: PendResult = { success: false, reason: 'local validation hook failed' };
		const repo = makeRepo(makeStorageRepo(emptyGet), { localPendResult: refusal });

		const result = await repo.pend(REQUEST);

		expect(result.success).to.equal(true);
	});

	it('returns a retained success verbatim', async () => {
		const verdict: PendResult = {
			success: true, pending: [{ blockId: BLOCK, actionId: 'a-earlier' }], blockIds: [BLOCK]
		};
		const repo = makeRepo(makeStorageRepo(emptyGet), { localPendResult: verdict });

		const result = await repo.pend(REQUEST);

		expect(result).to.deep.equal(verdict);
	});

	it('falls back to the fabricated success when no verdict was retained', async () => {
		// Older member, member restart, or retention TTL: the prior shape survives so a missing
		// verdict never turns into a spurious failure.
		const repo = makeRepo(makeStorageRepo(emptyGet), {});

		const result = await repo.pend(REQUEST);

		expect(result.success).to.equal(true);
		expect((result as { blockIds?: BlockId[] }).blockIds).to.deep.equal([BLOCK]);
	});
});

describe('CoordinatorRepo pend — promise-phase pending-conflict rejection', () => {
	const rejection = new ValidatorRejectionError(
		'Transaction rejected by validators (3/3 rejected)',
		{ 'peer-0': `pending conflict: block ${BLOCK} held by unresolved action(s) a-rival` }
	);

	it('classifies the rejection as a conflict when local storage confirms a rival pending', async () => {
		const repo = makeRepo(
			makeStorageRepo(async gets => Object.fromEntries(
				gets.blockIds.map(id => [id, { state: { pendings: ['a-rival'] } }])
			)),
			{ throws: rejection }
		);

		const result = await repo.pend(REQUEST);

		expect(result.success).to.equal(false);
		expect(isConflictFailure(result as StaleFailure)).to.equal(true);
		expect((result as StaleFailure).pending).to.deep.equal([{ blockId: BLOCK, actionId: 'a-rival' }]);
	});

	it('does not count the request\'s own actionId as a rival', async () => {
		// A redelivered pend for this same action must not confirm against itself; with no other
		// pending the rejection stays a throw.
		const repo = makeRepo(
			makeStorageRepo(async gets => Object.fromEntries(
				gets.blockIds.map(id => [id, { state: { pendings: [REQUEST.actionId] } }])
			)),
			{ throws: rejection }
		);

		try {
			await repo.pend(REQUEST);
			expect.fail('expected the rejection to propagate');
		} catch (err) {
			expect(err).to.equal(rejection);
		}
	});

	it('still throws when local storage cannot confirm any rival', async () => {
		// Same conservative posture as the stale classifier: only the remote members saw the rival,
		// so nothing is confirmed locally and fail-fast is preserved for genuine validation faults.
		const repo = makeRepo(makeStorageRepo(emptyGet), { throws: rejection });

		try {
			await repo.pend(REQUEST);
			expect.fail('expected the rejection to propagate');
		} catch (err) {
			expect(err).to.equal(rejection);
		}
	});
});
