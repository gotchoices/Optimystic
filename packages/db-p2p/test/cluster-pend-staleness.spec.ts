/**
 * Ticket: torn-action-pend-tier-carve-out (part 1 of the torn-action series).
 *
 * `ClusterMember.validatePendOperations` — the promise-round stale-revision vote on a PEND.
 *
 * A write transaction touching several blocks is committed one group at a time, so it can end up
 * with SOME blocks durably committed and the rest refused (a "torn action"). Its retry reuses the
 * SAME actionId, so the retry's pend meets its own already-committed half. Comparing revision
 * numbers alone makes that indistinguishable from a rival's win, and the writer is refused by its
 * own durable work — forever.
 *
 * The rule under test, per block carrying a requested revision:
 *  - behind (`latest.rev < pend.rev`, or no latest) → approve — lagging-member tolerance;
 *  - `latest.rev === pend.rev`, SAME action → approve — our own already-committed half;
 *  - `latest.rev === pend.rev`, DIFFERENT action → reject (signed plain-prose reason);
 *  - `latest.rev > pend.rev` → reject regardless of whose action holds it. No carve-out past
 *    `===`: the follow-on commit would take `StorageRepo.commit`'s `missedCommits` branch and
 *    refuse anyway, so approving such a pend only defers the refusal by one round trip.
 *
 * The reject prose is asserted verbatim: it is fed to `computeSigningPayload` and carried as
 * `Signature.rejectReason`, so changing the text changes signed bytes.
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

// ─── Harness (mirrors cluster-commit-staleness.spec.ts: clusterMember factory + mock repo + v1
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

const BLOCK = 'own-orphan-block' as BlockId;
const OUR_ACTION = 'a-torn' as ActionId;
const RIVAL_ACTION = 'a-winner' as ActionId;

const makePendRecord = async (peers: ClusterPeers, pend: PendRequest): Promise<ClusterRecord> => {
	const message: RepoMessage = {
		operations: [{ pend }],
		coordinatingBlockIds: [BLOCK],
		expiration: Date.now() + 30000
	};
	return { messageHash: await computeMessageHash(message), message, peers, promises: {}, commits: {} };
};

const makePend = (over: Partial<PendRequest> = {}): PendRequest => ({
	actionId: OUR_ACTION,
	rev: 1,
	transforms: { inserts: {}, updates: { [BLOCK]: [['entries', 0, 0, ['x']]] }, deletes: [] },
	policy: 'c',
	...over
});

/**
 * A repo whose `get` answers the given per-block latest. No `pendings` key, so the
 * unresolved-rival check below the stale vote abstains and only the stale vote is exercised.
 */
class StateRepo implements IRepo {
	constructor(private readonly latest: ActionRev | undefined) { }
	async get(gets: BlockGets): Promise<GetBlockResults> {
		return Object.fromEntries(gets.blockIds.map(id => [id, { state: this.latest ? { latest: this.latest } : {} }]));
	}
	async pend(_request: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [] }; }
	async commit(_request: CommitRequest): Promise<CommitResult> { return { success: true }; }
	async cancel(_actionRef: ActionBlocks): Promise<void> { /* no-op */ }
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

/**
 * Drive a pend record through a fresh member backed by `repo` and return the member's own promise
 * vote. Two declared peers (superMajority 2) keep the record in the Promising phase after our
 * single vote, so consensus never executes and only the promise-round check is exercised.
 */
const voteOnPend = async (
	repo: IRepo,
	pend: PendRequest
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
		const record = await makePendRecord(makeClusterPeers([self, other]), pend);
		const result = await member.update(record);
		const sig = result.promises[self.peerId.toString()];
		return { type: sig?.type ?? 'none', rejectReason: sig?.type === 'reject' ? sig.rejectReason : undefined };
	} finally {
		member.dispose();
	}
};

describe('ClusterMember — pend revision staleness check (promise round)', () => {
	describe('approve paths', () => {
		it('approves a re-pend of a block THIS action already committed at the requested rev', async () => {
			// The torn-action shape: our own durable half. Rejecting here refuses the writer with
			// its own work and the retry can never converge.
			const vote = await voteOnPend(new StateRepo({ rev: 1, actionId: OUR_ACTION }), makePend());
			expect(vote.type).to.equal('approve');
		});

		it('a lagging member (latest below the requested rev) approves — the pinned tolerance', async () => {
			const vote = await voteOnPend(new StateRepo({ rev: 1, actionId: RIVAL_ACTION }), makePend({ rev: 2 }));
			expect(vote.type).to.equal('approve');
		});

		it('a member that never saw the block approves', async () => {
			const vote = await voteOnPend(new StateRepo(undefined), makePend());
			expect(vote.type).to.equal('approve');
		});
	});

	describe('reject paths (rival behavior, unchanged)', () => {
		it('rejects when a DIFFERENT action holds the requested revision', async () => {
			const vote = await voteOnPend(new StateRepo({ rev: 1, actionId: RIVAL_ACTION }), makePend());
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(`stale revision: block ${BLOCK} at rev 1, requested rev 1`);
		});

		it('rejects when our own action is already PAST the requested rev — no carve-out beyond ===', async () => {
			// The follow-on commit would take StorageRepo.commit's missedCommits branch and refuse
			// anyway; approving this pend would only defer the refusal by one round trip.
			const vote = await voteOnPend(new StateRepo({ rev: 2, actionId: OUR_ACTION }), makePend());
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(`stale revision: block ${BLOCK} at rev 2, requested rev 1`);
		});
	});
});
