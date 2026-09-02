/**
 * Ticket: bug-member-commits-unmaterializable-revision (review pass).
 *
 * `CoordinatorRepo.commit` falls back to a local commit when its own cluster member did not
 * execute the transaction during consensus. That local commit can fail for a reason that is
 * *not* the caller's problem: the cluster already reached consensus and landed the action, this
 * peer simply cannot apply it locally. Such divergence must be reported as success, because
 * db-core's commitPhase treats any returned `success:false` as a permanent stale loss and retries
 * an action that has, in fact, already committed.
 *
 * Divergence arrives in two shapes and both must be tolerated identically:
 *   - a THROW ("Pending action … not found") — we never saw the pend;
 *   - a RETURNED `success:false` with a `missing-base-revision` reason — we saw the pend but never
 *     the revision that created the block, so `StorageRepo.internalCommit` refuses rather than
 *     record a revision it could not materialize.
 *
 * Only the throw was tolerated before the refusal existed. A genuine stale loss must still reach
 * the caller, or a real lost race would be reported as a win.
 */

import { expect } from 'chai';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, ActionBlocks, MessageOptions, BlockId, ClusterRecord, RepoMessage
} from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { CoordinatorRepo, type ICoordinatorClusterSeam } from '../src/repo/coordinator-repo.js';
import { MISSING_BASE_REVISION_REASON, type ICommitProofPersister } from '../src/storage/storage-repo.js';
import { buildBlockCommitProof, type BlockCommitProof } from '../src/cluster/commit-proof.js';
import type { ClusterClient } from '../src/cluster/client.js';

const BLOCK = 'block-commit-divergence' as BlockId;

const REQUEST: CommitRequest = { actionId: 'a-committed', blockIds: [BLOCK], tailId: BLOCK, rev: 2 };

const keyNetwork: IKeyNetwork = {
	async findCoordinator(_key: Uint8Array, _o?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return {};
	}
};

/** A record whose commits are a simple majority of approvals — i.e. the cluster DID commit. */
const makeRecord = (approvals: number, peerCount: number): ClusterRecord => {
	const peers: ClusterPeers = {};
	const commits: ClusterRecord['commits'] = {};
	for (let i = 0; i < peerCount; i++) {
		peers[`peer-${i}`] = { multiaddrs: [], publicKey: '' };
		if (i < approvals) {
			commits[`peer-${i}`] = { type: 'approve' } as ClusterRecord['commits'][string];
		}
	}
	return { messageHash: 'mh', peers, message: {} as RepoMessage, promises: {}, commits };
};

/**
 * A storage repo whose commit does whatever `commit` says; everything else is inert. Typed as the
 * proof-carrying {@link ICommitProofPersister} overload — the one `CoordinatorRepo` actually calls
 * on this path — so a test can observe the proof argument instead of it vanishing into an
 * `IRepo`-shaped double that never declared it.
 */
const makeStorageRepo = (commit: ICommitProofPersister['commit']): IRepo => ({
	async get(gets: BlockGets, _o?: MessageOptions): Promise<GetBlockResults> {
		return Object.fromEntries(gets.blockIds.map(id => [id, { state: {} }]));
	},
	async pend(_r: PendRequest, _o?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [] };
	},
	async cancel(_r: ActionBlocks, _o?: MessageOptions): Promise<void> { },
	commit
});

/**
 * A repo wired so `commit` takes the multi-peer path and its local member did NOT execute during
 * consensus — the branch that falls back to a local commit.
 */
const makeRepo = (storageRepo: IRepo, record: ClusterRecord): CoordinatorRepo => {
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
			return { record, localExecuted: false };
		}
	};
	return repo;
};

describe('CoordinatorRepo commit — local divergence after cluster consensus', () => {
	it('reports success when the local commit REFUSES for a missing base and the cluster committed', async () => {
		// The regression this guards: the refusal is a returned success:false, so it bypassed the
		// tolerance that only ever wrapped a throw, and surfaced a landed transaction as stale.
		const repo = makeRepo(
			makeStorageRepo(async () => ({
				success: false,
				reason: `${MISSING_BASE_REVISION_REASON}: block ${BLOCK} cannot materialize rev 2 — no committed revision to apply the transform to`
			})),
			makeRecord(2, 3)
		);

		const result = await repo.commit(REQUEST);

		expect(result.success, 'a cluster-committed action must not be reported as a stale loss').to.equal(true);
	});

	it('reports success when the local commit THROWS for a missing pend and the cluster committed', async () => {
		// The pre-existing tolerance, previously unpinned by any spec.
		const repo = makeRepo(
			makeStorageRepo(async () => { throw new Error(`Pending action a-committed not found for block(s): ${BLOCK}`); }),
			makeRecord(2, 3)
		);

		expect((await repo.commit(REQUEST)).success).to.equal(true);
	});

	it('still returns a genuine stale loss to the caller', async () => {
		// success:false WITHOUT a missing-base reason is a real lost race: someone committed a newer
		// revision. Tolerating it would report a write that never landed as a win.
		const repo = makeRepo(
			makeStorageRepo(async () => ({ success: false, missing: [], reason: 'stale' })),
			makeRecord(3, 3)
		);

		const result = await repo.commit(REQUEST);

		expect(result.success).to.equal(false);
		expect((result as { reason?: string }).reason).to.equal('stale');
	});

	it('does NOT tolerate a missing-base refusal when the cluster did not reach consensus', async () => {
		// No majority approved, so nothing is known to have landed — the caller must see the failure
		// rather than a fabricated success.
		const repo = makeRepo(
			makeStorageRepo(async () => ({ success: false, reason: `${MISSING_BASE_REVISION_REASON}: nope` })),
			makeRecord(1, 3)
		);

		expect((await repo.commit(REQUEST)).success).to.equal(false);
	});
});

/**
 * The same fallback branch, viewed from the proof side. It is the sibling of the solo-cohort mint
 * (`coordinator-repo-solo-commit-proof.spec.ts`): a solo commit self-signs, whereas here consensus
 * genuinely ran on the cohort, so the record's REAL votes are what must reach storage — self-signing
 * would be a false statement about who committed. Without a proof the fallback writes a revision no
 * receiver will ever accept by push.
 *
 * These tests pin the THREADING, not the cryptography: the records here carry unsigned placeholder
 * votes, which is all `buildBlockCommitProof`'s projection reads. Whether a projected proof verifies
 * is `commit-proof.spec.ts`'s subject.
 */
describe('CoordinatorRepo commit — the local fallback carries the consensus record\'s proof', () => {
	/** Capture every proof argument `CoordinatorRepo` hands to storage on the fallback commit. */
	const commitWithProofCapture = (record: ClusterRecord) => {
		const proofs: (BlockCommitProof | undefined)[] = [];
		const repo = makeRepo(
			makeStorageRepo(async (_request, _options, proof) => { proofs.push(proof); return { success: true }; }),
			record
		);
		return { repo, proofs };
	};

	it('passes the projection of a membership-v2 record', async () => {
		const record = { ...makeRecord(3, 3), membershipVersion: 2 as const, membershipDigest: 'md' };
		const { repo, proofs } = commitWithProofCapture(record);

		expect((await repo.commit(REQUEST)).success).to.equal(true);

		expect(proofs, 'exactly one fallback commit').to.have.length(1);
		expect(proofs[0], 'storage must receive the record\'s own projection, not a re-derived one')
			.to.deep.equal(buildBlockCommitProof(record));
		expect(proofs[0]!.peerIds, 'the proof binds the whole committing cohort, not just this node')
			.to.deep.equal(['peer-0', 'peer-1', 'peer-2']);
	});

	it('passes undefined for a v1 / unversioned record instead of an uncertifiable half-proof', async () => {
		// A pre-v2 record's hashes bind no peer set, so its signer list is unbound and no verifier can
		// ever accept it. Storage must be handed nothing rather than something that looks like evidence.
		const { repo, proofs } = commitWithProofCapture(makeRecord(3, 3));

		expect((await repo.commit(REQUEST)).success).to.equal(true);

		expect(proofs).to.deep.equal([undefined]);
	});
});
