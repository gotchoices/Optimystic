/**
 * Ticket: bug-member-commits-unmaterializable-revision (review pass), extended by
 * acknowledged-diary-commits-land-on-no-node (the durability gate).
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
 * "The cluster landed the action" is no longer read off the votes. A commit's approve votes were
 * never evidence of storage — every member can sign and then refuse at apply — so the coordinator
 * counts the cohort's post-apply durability reports (`cohortCommitOutcomes`) and tolerates a local
 * divergence only when a strict majority of the cohort reports holding the revision. Without that
 * majority the answer is the retryable `COMMIT_NOT_DURABLE_REASON` refusal, and the local fallback
 * commit is skipped: an off-cohort coordinator's copy is a lone holder no cohort member reconciles
 * from, and a refused commit must not create one. A genuine stale loss must still reach the caller,
 * or a real lost race would be reported as a win.
 */

import { expect } from 'chai';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, CommitResult, ActionBlocks, MessageOptions, BlockId, ClusterRecord, RepoMessage, StaleFailure
} from '@optimystic/db-core';
import { isConflictFailure } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CoordinatorRepo, type ICoordinatorClusterSeam } from '../src/repo/coordinator-repo.js';
import { MISSING_BASE_REVISION_REASON, isCommitNotDurableFailure, type ICommitProofPersister } from '../src/storage/storage-repo.js';
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

/** A record over `peerIds` whose commits are approvals from the first `approvals` of them. */
const makeRecordOver = (peerIds: string[], approvals: number): ClusterRecord => {
	const peers: ClusterPeers = {};
	const commits: ClusterRecord['commits'] = {};
	peerIds.forEach((id, i) => {
		peers[id] = { multiaddrs: [], publicKey: '' };
		if (i < approvals) {
			commits[id] = { type: 'approve' } as ClusterRecord['commits'][string];
		}
	});
	return { messageHash: 'mh', peers, message: {} as RepoMessage, promises: {}, commits };
};

/** A record whose commits are a simple majority of approvals — i.e. the cluster DID vote to commit. */
const makeRecord = (approvals: number, peerCount: number): ClusterRecord =>
	makeRecordOver(Array.from({ length: peerCount }, (_, i) => `peer-${i}`), approvals);

/**
 * The cohort's post-apply durability reports: the first `holders` peers of the record report
 * holding the revision, every other peer reports a refusal. Keyed exactly as the real coordinator
 * keys them (by the peer it asked).
 */
const durableReports = (record: ClusterRecord, holders: number): { [peerId: string]: CommitResult } => {
	const reports: { [peerId: string]: CommitResult } = {};
	Object.keys(record.peers).forEach((id, i) => {
		reports[id] = i < holders
			? { success: true }
			: { success: false, reason: `${MISSING_BASE_REVISION_REASON}: block ${BLOCK} cannot materialize rev 2` };
	});
	return reports;
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

/** Wrap a storage repo so a test can assert whether the fallback commit ran at all. */
const countingCommits = (storageRepo: IRepo): { repo: IRepo; commits: () => number } => {
	let commits = 0;
	return {
		repo: {
			...storageRepo,
			async commit(r: CommitRequest, o?: MessageOptions, proof?: BlockCommitProof): Promise<CommitResult> {
				commits++;
				return (storageRepo as IRepo & ICommitProofPersister).commit(r, o, proof);
			}
		},
		commits: () => commits
	};
};

/**
 * A repo wired so `commit` takes the multi-peer path and its local member did NOT execute during
 * consensus — the branch that falls back to a local commit. `reports` are the other cohort members'
 * durability reports the consensus double hands back; `localPeerId` (and the key network that
 * places it in every cohort) makes this node a member of the cohort the record names.
 */
const makeRepo = (
	storageRepo: IRepo, record: ClusterRecord, reports?: { [peerId: string]: CommitResult }, localPeerId?: PeerId
): CoordinatorRepo => {
	const peerIds = Object.keys(record.peers);
	const network: IKeyNetwork = localPeerId === undefined ? keyNetwork : {
		...keyNetwork,
		async findCluster(): Promise<ClusterPeers> { return { ...record.peers }; }
	};
	const repo = new CoordinatorRepo(
		network,
		((_p: PeerId) => ({} as unknown as ClusterClient)),
		storageRepo,
		{ clusterSize: 3 },
		undefined,
		localPeerId
	);
	(repo as unknown as { coordinator: ICoordinatorClusterSeam }).coordinator = {
		async getClusterSize(): Promise<number> { return peerIds.length; },
		async getClusterPeerIds(): Promise<string[]> { return peerIds; },
		async recoverTransactions(): Promise<void> { /* unused on these paths */ },
		async executeClusterTransaction(): Promise<{ record: ClusterRecord, localExecuted: boolean, cohortCommitOutcomes?: { [peerId: string]: CommitResult } }> {
			return { record, localExecuted: false, ...(reports === undefined ? {} : { cohortCommitOutcomes: reports }) };
		}
	};
	return repo;
};

const missingBaseRefusal = async (): Promise<CommitResult> => ({
	success: false,
	reason: `${MISSING_BASE_REVISION_REASON}: block ${BLOCK} cannot materialize rev 2 — no committed revision to apply the transform to`
});

const missingPendThrow = async (): Promise<CommitResult> => {
	throw new Error(`Pending action a-committed not found for block(s): ${BLOCK}`);
};

describe('CoordinatorRepo commit — local divergence after cluster consensus', () => {
	it('reports success when the local commit REFUSES for a missing base and a durable majority holds the revision', async () => {
		// The regression this guards: the refusal is a returned success:false, so it bypassed the
		// tolerance that only ever wrapped a throw, and surfaced a landed transaction as stale.
		const record = makeRecord(2, 3);
		const repo = makeRepo(makeStorageRepo(missingBaseRefusal), record, durableReports(record, 2));

		const result = await repo.commit(REQUEST);

		expect(result.success, 'a cluster-committed action must not be reported as a stale loss').to.equal(true);
	});

	it('reports success when the local commit THROWS for a missing pend and a durable majority holds the revision', async () => {
		// The pre-existing tolerance, previously unpinned by any spec.
		const record = makeRecord(2, 3);
		const repo = makeRepo(makeStorageRepo(missingPendThrow), record, durableReports(record, 2));

		expect((await repo.commit(REQUEST)).success).to.equal(true);
	});

	it('still returns a genuine stale loss to the caller', async () => {
		// success:false WITHOUT a missing-base reason is a real lost race: someone committed a newer
		// revision. Tolerating it would report a write that never landed as a win.
		const record = makeRecord(3, 3);
		const repo = makeRepo(
			makeStorageRepo(async () => ({ success: false, missing: [], reason: 'stale' })),
			record, durableReports(record, 3)
		);

		const result = await repo.commit(REQUEST);

		expect(result.success).to.equal(false);
		expect((result as { reason?: string }).reason).to.equal('stale');
	});

	it('does NOT tolerate a missing-base refusal when the cluster did not reach consensus', async () => {
		// No majority approved, so nothing is known to have landed — the caller must see a failure
		// rather than a fabricated success. (With no durable reports either, the durability gate
		// refuses before the local commit is even attempted; see the gate cases below.)
		const repo = makeRepo(makeStorageRepo(missingBaseRefusal), makeRecord(1, 3));

		expect((await repo.commit(REQUEST)).success).to.equal(false);
	});
});

/**
 * Ticket: acknowledged-diary-commits-land-on-no-node.
 *
 * The durability gate on the fallback arm. Every member can sign a commit and then refuse it at
 * apply — no base for the block, a missed pend — and the coordinator used to count the votes as
 * success while no responsible node held the revision. Now it counts the cohort's post-apply
 * durability reports, and a divergence is tolerated only on a durable majority.
 */
describe('CoordinatorRepo commit — the fallback arm needs a durable majority, not a vote majority', () => {
	const expectNotDurable = (result: CommitResult): void => {
		expect(result.success).to.equal(false);
		expect(isCommitNotDurableFailure(result), 'the refusal names the durability gate').to.equal(true);
		expect(isConflictFailure(result as StaleFailure), 'the refusal must be retryable — the members dropped their pendings').to.equal(true);
	};

	it('refuses when every member approved but no member reports holding the revision, and skips the local commit', async () => {
		// The observed shape: full consensus, every member's storage refused at apply, the
		// coordinator is not in the cohort. Acknowledging would report a write that exists nowhere;
		// committing locally would create the lone off-cohort holder that seeded the bad placement.
		const { repo: storageRepo, commits } = countingCommits(makeStorageRepo(async () => ({ success: true })));
		const record = makeRecord(3, 3);
		const repo = makeRepo(storageRepo, record, durableReports(record, 0));

		expectNotDurable(await repo.commit(REQUEST));
		expect(commits(), 'a refused commit must not seed a lone off-cohort copy').to.equal(0);
	});

	it('counts durable reports, not approvals', async () => {
		// Three approvals, one holder: 1 of 3 is not a majority whatever the votes said.
		const record = makeRecord(3, 3);
		const repo = makeRepo(makeStorageRepo(async () => ({ success: true })), record, durableReports(record, 1));

		expectNotDurable(await repo.commit(REQUEST));
	});

	it('a coordinator inside the cohort counts its own successful fallback commit', async () => {
		// Self is one of the three cohort members but its member did not execute; one other member
		// holds the revision, and this node's fallback commit lands — 2 of 3.
		const self = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		const record = makeRecordOver([self.toString(), 'peer-1', 'peer-2'], 3);
		const reports = { 'peer-1': { success: true } as CommitResult, 'peer-2': { success: false, reason: 'behind' } as CommitResult };
		const { repo: storageRepo, commits } = countingCommits(makeStorageRepo(async () => ({ success: true })));
		const repo = makeRepo(storageRepo, record, reports, self);

		expect((await repo.commit(REQUEST)).success).to.equal(true);
		expect(commits(), 'the fallback commit ran because self could complete the majority').to.equal(1);
	});

	it('a coordinator inside the cohort whose fallback commit diverges is not a holder', async () => {
		// Same geometry, but this node holds nothing either: the one remote holder is 1 of 3.
		const self = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		const record = makeRecordOver([self.toString(), 'peer-1', 'peer-2'], 3);
		const reports = { 'peer-1': { success: true } as CommitResult, 'peer-2': { success: false, reason: 'behind' } as CommitResult };
		const repo = makeRepo(makeStorageRepo(missingPendThrow), record, reports, self);

		expectNotDurable(await repo.commit(REQUEST));
	});

	it('a coordinator inside the cohort skips the fallback commit when even its own success could not reach a majority', async () => {
		const self = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		const record = makeRecordOver([self.toString(), 'peer-1', 'peer-2'], 3);
		const { repo: storageRepo, commits } = countingCommits(makeStorageRepo(async () => ({ success: true })));
		const repo = makeRepo(storageRepo, record, durableReports(record, 0), self);

		expectNotDurable(await repo.commit(REQUEST));
		expect(commits(), 'nothing could make this durable, so the local copy is not written').to.equal(0);
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
			record, durableReports(record, 3)
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
