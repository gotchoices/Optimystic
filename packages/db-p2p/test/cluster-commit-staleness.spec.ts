/**
 * Ticket: consensus-pend-refusal-commit-tier-close.
 *
 * `ClusterMember.validateCommitRevisions` — the promise-round stale-commit check that keeps a DEAD
 * rival's re-broadcast commit from assembling consensus: once a race winner commits and members
 * clear its record from the reservation table, the loser's re-driven commit meets no conflict
 * votes, and (before this check) every caught-up member abstained straight into an approval.
 *
 * The four-way rule under test, per committed block:
 *  - behind (`latest.rev < commit.rev`, or no latest) → abstain (approve) — the lagging-member
 *    tolerance pinned by coordinator-repo-commit-divergence.spec.ts stays intact;
 *  - `latest.rev === commit.rev`, SAME action → abstain (approve) — idempotent redelivery of an
 *    already-durable commit; a reject here would make the writer rebase and re-append a landed
 *    action (duplicate entry);
 *  - `latest.rev === commit.rev`, DIFFERENT action → reject (signed plain-prose reason);
 *  - `latest.rev > commit.rev` → consult the revision→actionId capability
 *    (`IRevisionActionReader.getRevisionAction`): rival → reject; own action → abstain;
 *    unknown / capability absent / read fault → abstain.
 *
 * Nothing may throw out of the vote path: read faults abstain (a member that fails to vote at all
 * is worse than one that abstains).
 */

import { expect } from 'chai';
import { clusterMember } from '../src/cluster/cluster-repo.js';
import type {
	IRepo, ClusterRecord, RepoMessage, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, CommitResult, ActionBlocks, ClusterPeers, BlockId, ActionId, ActionRev
} from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

// ─── Harness (mirrors cluster-commit-digest.spec.ts: clusterMember factory + mock repo + v1
// record driven through member.update, vote read from record.promises[self]) ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const computeMessageHash = async (message: RepoMessage): Promise<string> => {
	const hashBytes = await sha256.digest(new TextEncoder().encode(canonicalJson(message)));
	return base58btc.encode(hashBytes.digest);
};

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

const BLOCK = 'block-1' as BlockId;
const OUR_ACTION = 'a-loser' as ActionId;
const RIVAL_ACTION = 'a-winner' as ActionId;

const makeCommitRecord = async (peers: ClusterPeers, commit: CommitRequest): Promise<ClusterRecord> => {
	const message: RepoMessage = {
		operations: [{ commit }],
		coordinatingBlockIds: [commit.blockIds[0] ?? BLOCK],
		expiration: Date.now() + 30000
	};
	const messageHash = await computeMessageHash(message);
	return { messageHash, message, peers, promises: {}, commits: {} };
};

const makeCommit = (over: Partial<CommitRequest> = {}): CommitRequest => ({
	actionId: OUR_ACTION,
	blockIds: [BLOCK],
	tailId: BLOCK,
	rev: 2,
	...over
});

/**
 * A repo whose `get` answers the given per-block latest, optionally extended with the duck-typed
 * revision→actionId capability the member probes for.
 */
class StateRepo implements IRepo {
	constructor(
		private readonly latest: ActionRev | undefined,
		private readonly getThrows?: Error
	) { }
	async get(gets: BlockGets): Promise<GetBlockResults> {
		if (this.getThrows) throw this.getThrows;
		return Object.fromEntries(gets.blockIds.map(id => [id, { state: this.latest ? { latest: this.latest } : {} }]));
	}
	async pend(_request: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [] }; }
	async commit(_request: CommitRequest): Promise<CommitResult> { return { success: true }; }
	async cancel(_actionRef: ActionBlocks): Promise<void> { /* no-op */ }
}

class RevisionReaderRepo extends StateRepo {
	constructor(latest: ActionRev, private readonly revisionActions: Record<number, ActionId | undefined>) { super(latest); }
	async getRevisionAction(_blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		return this.revisionActions[rev];
	}
}

class ThrowingRevisionReaderRepo extends StateRepo {
	async getRevisionAction(): Promise<ActionId | undefined> {
		throw new Error('injected revision-read fault');
	}
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

/**
 * Drive `record` through a fresh member backed by `repo` and return the member's own promise vote.
 * Two declared peers (superMajority 2) keep the record in the Promising phase after our single
 * vote, so consensus never executes and only the promise-round check is exercised.
 */
const voteOnCommit = async (
	repo: IRepo,
	commit: CommitRequest
): Promise<{ type: string; rejectReason?: string }> => {
	const self = await makeKeyPair();
	const other = await makeKeyPair();
	const member = clusterMember({
		storageRepo: repo,
		peerNetwork: new MockPeerNetwork(),
		peerId: self.peerId,
		privateKey: self.privateKey
	});
	try {
		const record = await makeCommitRecord(makeClusterPeers([self, other]), commit);
		const result = await member.update(record);
		const sig = result.promises[self.peerId.toString()];
		return { type: sig?.type ?? 'none', rejectReason: sig?.type === 'reject' ? sig.rejectReason : undefined };
	} finally {
		member.dispose();
	}
};

const STALE_REASON = `stale commit: block ${BLOCK} rev 2 committed by a different action`;

describe('ClusterMember — commit revision staleness check (promise round)', () => {
	describe('reject paths', () => {
		it('rejects a commit whose revision this member already holds under a different action', async () => {
			// The trace's exact shape: the member applied the race winner at rev 2; the dead rival's
			// re-driven commit for the same rev must meet a reject, not an abstain-approve.
			const vote = await voteOnCommit(new StateRepo({ rev: 2, actionId: RIVAL_ACTION }), makeCommit());
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(STALE_REASON);
		});

		it('rejects via the revision→actionId capability when latest is already past the requested rev', async () => {
			// latest.rev = 5 cannot name who took rev 2; the capability can, and names a rival.
			const repo = new RevisionReaderRepo({ rev: 5, actionId: 'a-later' as ActionId }, { 2: RIVAL_ACTION });
			const vote = await voteOnCommit(repo, makeCommit());
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(STALE_REASON);
		});
	});

	describe('abstain paths (member approves exactly as before the check existed)', () => {
		it('approves an idempotent redelivery — this member holds the SAME action at the requested rev', async () => {
			// MUST NOT reject: classifying this to conflict would make the writer rebase and
			// re-append an already-committed action at a new revision — a duplicate log entry.
			const vote = await voteOnCommit(new StateRepo({ rev: 2, actionId: OUR_ACTION }), makeCommit());
			expect(vote.type).to.equal('approve');
		});

		it('a lagging member (latest below the requested rev) abstains — the pinned commit tolerance', async () => {
			const vote = await voteOnCommit(new StateRepo({ rev: 1, actionId: RIVAL_ACTION }), makeCommit());
			expect(vote.type).to.equal('approve');
		});

		it('a member that never saw the block abstains', async () => {
			const vote = await voteOnCommit(new StateRepo(undefined), makeCommit());
			expect(vote.type).to.equal('approve');
		});

		it('abstains past the requested rev when the capability shows our own action took it', async () => {
			// Already durable, history moved on — same duplicate-entry hazard as the at-rev case.
			const repo = new RevisionReaderRepo({ rev: 5, actionId: 'a-later' as ActionId }, { 2: OUR_ACTION });
			const vote = await voteOnCommit(repo, makeCommit());
			expect(vote.type).to.equal('approve');
		});

		it('abstains past the requested rev when the capability holds no record (truncated history)', async () => {
			const repo = new RevisionReaderRepo({ rev: 5, actionId: 'a-later' as ActionId }, {});
			const vote = await voteOnCommit(repo, makeCommit());
			expect(vote.type).to.equal('approve');
		});

		it('abstains past the requested rev when the repo lacks the capability (back-compat)', async () => {
			const vote = await voteOnCommit(new StateRepo({ rev: 5, actionId: 'a-later' as ActionId }), makeCommit());
			expect(vote.type).to.equal('approve');
		});

		it('a throwing capability is an abstain, never a rejection or an escape out of the vote path', async () => {
			const vote = await voteOnCommit(
				new ThrowingRevisionReaderRepo({ rev: 5, actionId: 'a-later' as ActionId }),
				makeCommit()
			);
			expect(vote.type).to.equal('approve');
		});

		it('a throwing state read is an abstain, never an escape out of the vote path', async () => {
			const vote = await voteOnCommit(new StateRepo(undefined, new Error('injected get fault')), makeCommit());
			expect(vote.type).to.equal('approve');
		});
	});
});
