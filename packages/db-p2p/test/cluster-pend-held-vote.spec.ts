/**
 * Ticket: a-contended-pend-refusal-is-permanent-on-a-small-cohort.
 *
 * `ClusterMember.validatePendOperations` refuses a pend whose blocks are reserved by a DIFFERENT
 * unresolved action in this member's durable storage. That reservation disappears the moment the
 * rival commits or cancels, so the very same pend succeeds on retry — the refusal is transient by
 * construction, never a judgement that the write is invalid.
 *
 * It used to be answered with a `reject` vote all the same, which the coordinator counts toward a
 * permanent-failure threshold. On a cohort of three or fewer members that threshold allows zero
 * rejections at the default super-majority, so one member saying "someone else is holding this right
 * now" became `ValidatorRejectionError` for the whole transaction.
 *
 * What this spec pins, at the member tier:
 *  - the pending-conflict refusal produces a `held` vote, never a `reject`;
 *  - `heldBy` carries the rival's ACTION id as structured data, and is covered by the signature — so
 *    no relay can rewrite the claim, and no consumer has to parse it out of the prose reason;
 *  - the prose reason itself is unchanged (it is signed, so its bytes are wire contract);
 *  - the self-exclusion and the precedence of the permanent stale-revision refusal both still hold.
 */

import { expect } from 'chai';
import { localDurability, clusterVoteVerificationPayload } from '@optimystic/db-core';
import { clusterMember } from '../src/cluster/cluster-repo.js';
import type {
	IRepo, ClusterRecord, RepoMessage, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, CommitResult, ActionBlocks, ClusterPeers, BlockId, ActionId, ActionRev, Signature
} from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';

// ─── Harness (mirrors cluster-pend-staleness.spec.ts: clusterMember factory + mock repo + v1 record
// driven through member.update, vote read from record.promises[self]) ───

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

const BLOCK = 'held-block' as BlockId;
const OUR_ACTION = 'a-ours' as ActionId;
const RIVAL_ACTION = 'a-rival' as ActionId;
const SECOND_RIVAL = 'a-rival-2' as ActionId;

const makePend = (over: Partial<PendRequest> = {}): PendRequest => ({
	actionId: OUR_ACTION,
	rev: 2,
	transforms: { inserts: {}, updates: { [BLOCK]: [['entries', 0, 0, ['x']]] }, deletes: [] },
	policy: 'c',
	...over
});

const makeMessage = (pend: PendRequest): RepoMessage => ({
	operations: [{ pend }],
	coordinatingBlockIds: [BLOCK],
	expiration: Date.now() + 30000
});

/**
 * A v1 (membership-unbound) pend record, so both hashes below have the legacy preimage and the spec
 * can recompute the promise hash the member signed without reaching into the member.
 */
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

/** A repo whose `get` answers the given per-block storage state — a rival reservation, a latest, or both. */
class StateRepo implements IRepo {
	constructor(private readonly state: { latest?: ActionRev; pendings?: ActionId[] }) { }
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
 * Drive a pend record through a fresh member backed by `repo` and return the member's own promise
 * vote alongside what it voted on, so a caller can re-derive the signed payload.
 */
const voteOnPend = async (repo: IRepo, pend: PendRequest): Promise<CastVote> => {
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

describe('ClusterMember — a pend queued behind a live reservation votes `held`, not `reject`', () => {
	it('answers a rival unresolved pending action with a `held` vote naming it', async () => {
		const vote = await voteOnPend(new StateRepo({ pendings: [RIVAL_ACTION] }), makePend());

		expect(vote.signature?.type, 'a transient refusal must not be a validity judgement').to.equal('held');
		expect(vote.signature).to.have.property('heldBy', RIVAL_ACTION);
		// The prose reason is unchanged from when this was a reject: it is signed, so its bytes are
		// wire contract, and `heldBy` is the structured form of the same fact rather than a rewording.
		expect(vote.signature).to.not.have.property('rejectReason');
	});

	it('covers `heldBy` with the signature, so the claim cannot be rewritten in transit', async () => {
		const vote = await voteOnPend(new StateRepo({ pendings: [RIVAL_ACTION] }), makePend());

		expect(await voteVerifies(vote), 'the vote must verify over the payload including heldBy').to.equal(true);

		// The point of folding it in: swap the named rival and the same signature no longer verifies.
		const cast = vote.signature;
		if (cast?.type !== 'held') throw new Error(`expected a held vote, got ${cast?.type ?? 'none'}`);
		const tampered: CastVote = { ...vote, signature: { ...cast, heldBy: SECOND_RIVAL } };
		expect(await voteVerifies(tampered), 'a rewritten heldBy must fail verification').to.equal(false);
	});

	it('names the rival the refusal returned on when several hold the block', async () => {
		// Storage can list more than one unresolved action. The signed field carries one action id and
		// no encoding scheme, so it names the same rival the prose reason leads with.
		const vote = await voteOnPend(new StateRepo({ pendings: [RIVAL_ACTION, SECOND_RIVAL] }), makePend());

		expect(vote.signature?.type).to.equal('held');
		expect(vote.signature).to.have.property('heldBy', RIVAL_ACTION);
		expect(await voteVerifies(vote)).to.equal(true);
	});

	it('approves a redelivered pend for the action that holds the block itself', async () => {
		// Self-exclusion, unchanged: our own reservation is not a rival, or a redelivery of our own
		// pend would refuse the writer with its own work.
		const vote = await voteOnPend(new StateRepo({ pendings: [OUR_ACTION] }), makePend());

		expect(vote.signature?.type).to.equal('approve');
	});

	it('still rejects — permanently — when the requested revision is already taken', async () => {
		// Both conditions at once. A stale revision can never succeed on retry however the reservation
		// resolves, so the permanent refusal must win over the transient one.
		const vote = await voteOnPend(
			new StateRepo({ latest: { rev: 2, actionId: RIVAL_ACTION }, pendings: [RIVAL_ACTION] }),
			makePend()
		);

		expect(vote.signature?.type).to.equal('reject');
		expect(vote.signature).to.have.property(
			'rejectReason',
			`stale revision: block ${BLOCK} at rev 2, requested rev 2`
		);
	});
});
