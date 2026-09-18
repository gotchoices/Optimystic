/**
 * Ticket: a-contended-pend-refusal-is-permanent-on-a-small-cohort.
 *
 * `ClusterMember.validatePendOperations` refuses a pend whose blocks are reserved by a DIFFERENT
 * unresolved action in this member's durable storage. A reserving rival's record disappears the
 * moment it commits or cancels, so the very same pend succeeds on retry — the refusal is transient by
 * construction, never a judgement that the write is invalid. (Which records RESERVE is decided by
 * the slot each claims — the second suite below, from
 * `a-member-that-missed-a-commit-refuses-every-later-write`.)
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
import type { IPendingClaimReader } from '../src/storage/storage-repo.js';
import type { PendingClaim } from '../src/storage/pending-claim.js';
import { STUCK_RESERVATION_DISTINCT_ACTIONS } from '../src/repo/stuck-reservation.js';
import { captureLog } from './support/capture-log.js';
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
const STUCK = 'cluster-member:stuck-reservation';

const linesWith = (captured: unknown[][], tag: string): unknown[][] =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(tag));

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

/**
 * A {@link StateRepo} that also says which slot each pending record claims — the `IPendingClaimReader`
 * capability `StorageRepo` has and the plain mock above deliberately lacks. `pendings` is derived
 * from the claims so the two views cannot disagree.
 */
class ClaimRepo extends StateRepo implements IPendingClaimReader {
	constructor(private readonly claims: PendingClaim[], latest?: ActionRev) {
		super({ latest, pendings: claims.map(c => c.actionId) });
	}
	async listPendingClaims(_blockId: BlockId): Promise<PendingClaim[]> { return this.claims.map(c => ({ ...c })); }
	async pendingClaimOf(_blockId: BlockId, actionId: ActionId): Promise<PendingClaim | undefined> {
		const claim = this.claims.find(c => c.actionId === actionId);
		return claim && { ...claim };
	}
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

interface CastVote { signature: Signature | undefined; record: ClusterRecord; self: KeyPair; }

/** One member over `repo`, kept alive across several pends so per-member state (its stuck-reservation
 *  counter) accumulates the way it does in a running node. */
interface Voter {
	vote(pend: PendRequest): Promise<CastVote>;
	dispose(): void;
}

const memberOver = async (repo: IRepo, cohortSize = 2): Promise<Voter> => {
	const self = await makeKeyPair();
	const others = await Promise.all(Array.from({ length: cohortSize - 1 }, makeKeyPair));
	const member = clusterMember({
		storageRepo: repo,
		peerNetwork: new MockPeerNetwork(),
		peerId: self.peerId,
		privateKey: self.privateKey
	});
	const peers = makeClusterPeers([self, ...others]);
	return {
		async vote(pend) {
			const record = await makePendRecord(peers, pend);
			const result = await member.update(record);
			return { signature: result.promises[self.peerId.toString()], record, self };
		},
		dispose: () => member.dispose()
	};
};

/**
 * Drive a pend record through a fresh member backed by `repo` and return the member's own promise
 * vote alongside what it voted on, so a caller can re-derive the signed payload. `cohortSize` is the
 * record's peer count, this member included — it decides whether the vote reads the pend's base.
 */
const voteOnPend = async (repo: IRepo, pend: PendRequest, cohortSize = 2): Promise<CastVote> => {
	const voter = await memberOver(repo, cohortSize);
	try {
		return await voter.vote(pend);
	} finally {
		voter.dispose();
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

/**
 * Ticket: a-member-that-missed-a-commit-refuses-every-later-write.
 *
 * A pending record RESERVES a block only for the slot it claims (`isReservationAgainst`). A member
 * that promised a write and then missed its commit keeps that write's record; the collection moves
 * on without it; and every later pend of the block requests a revision past the record's slot. Such
 * a record is superseded and must not be answered `held` — before this the member refused every
 * later write to the block, from every writer, until something happened to read the block through
 * it. A rival claiming the requested slot or a later one still reserves, exactly as before, and a
 * repo that cannot say what slot a record claims degrades to refusing (never to admitting).
 *
 * The last arm is the member-side stuck-reservation line: the coordinator can only name a wedge its
 * own storage corroborates, so a member names, once, a same-slot reservation of its own that keeps
 * refusing distinct writers (`StuckReservationTracker`, shared with `CoordinatorRepo`).
 */
describe('ClusterMember — a pending record reserves only the slot it claims', () => {
	const LATEST_1 = { rev: 1, actionId: 'r1' as ActionId };

	it('approves over a rival record claiming a slot the pend has already moved past', async () => {
		const vote = await voteOnPend(new ClaimRepo([{ actionId: RIVAL_ACTION, rev: 2 }], LATEST_1), makePend({ rev: 3 }));
		expect(vote.signature?.type, 'a superseded record is not a reservation').to.equal('approve');
	});

	it('still holds for a rival claiming the requested slot', async () => {
		const vote = await voteOnPend(new ClaimRepo([{ actionId: RIVAL_ACTION, rev: 2 }], LATEST_1), makePend({ rev: 2 }));
		expect(vote.signature?.type).to.equal('held');
		expect(vote.signature).to.have.property('heldBy', RIVAL_ACTION);
	});

	it('still holds for a rival claiming a later slot than the one requested', async () => {
		const vote = await voteOnPend(new ClaimRepo([{ actionId: RIVAL_ACTION, rev: 3 }], LATEST_1), makePend({ rev: 2 }));
		expect(vote.signature?.type).to.equal('held');
	});

	it('holds for a record whose slot is unknown', async () => {
		const vote = await voteOnPend(new ClaimRepo([{ actionId: RIVAL_ACTION }], LATEST_1), makePend({ rev: 3 }));
		expect(vote.signature?.type, 'an unknown claim is the strongest kind').to.equal('held');
	});

	it('names only the reserving rivals, and holds on the first of them', async () => {
		const vote = await voteOnPend(
			new ClaimRepo([{ actionId: RIVAL_ACTION, rev: 2 }, { actionId: SECOND_RIVAL, rev: 3 }], LATEST_1),
			makePend({ rev: 3 })
		);
		expect(vote.signature?.type).to.equal('held');
		expect(vote.signature, 'the superseded rival is not the holder').to.have.property('heldBy', SECOND_RIVAL);
		expect(await voteVerifies(vote)).to.equal(true);
	});

	it('degrades to holding when the repo cannot say what slot a record claims', async () => {
		// The plain `StateRepo` lacks `listPendingClaims`: every rival is taken to reserve, which is the
		// refusal this member cast before claims were recorded — never an admission.
		const vote = await voteOnPend(new StateRepo({ latest: LATEST_1, pendings: [RIVAL_ACTION] }), makePend({ rev: 3 }));
		expect(vote.signature?.type).to.equal('held');
	});

	it('names, once, a same-slot reservation that keeps refusing distinct writers', async () => {
		const voter = await memberOver(new ClaimRepo([{ actionId: RIVAL_ACTION, rev: 2 }], LATEST_1));
		try {
			const pendAs = (i: number): PendRequest => makePend({ actionId: `writer-${i}` as ActionId, rev: 2 });
			const below = await captureLog('cluster-member', async () => {
				for (let i = 0; i < STUCK_RESERVATION_DISTINCT_ACTIONS - 1; i++) {
					expect((await voter.vote(pendAs(i))).signature?.type).to.equal('held');
				}
			});
			expect(linesWith(below, STUCK), 'quiet below the threshold').to.have.lengthOf(0);

			const at = await captureLog('cluster-member', async () => {
				expect((await voter.vote(pendAs(STUCK_RESERVATION_DISTINCT_ACTIONS - 1))).signature?.type).to.equal('held');
			});
			const named = linesWith(at, STUCK).map(args => args[1] as { blockId?: string; holdingActionIds?: string[]; distinctRefusedActions?: number; message?: string; peerId?: string });
			expect(named, 'said exactly once at the threshold').to.have.lengthOf(1);
			expect(named[0]!.blockId).to.equal(BLOCK);
			expect(named[0]!.holdingActionIds).to.deep.equal([RIVAL_ACTION]);
			expect(named[0]!.distinctRefusedActions).to.equal(STUCK_RESERVATION_DISTINCT_ACTIONS);
			expect(named[0]!.peerId, 'the member names itself, since several share this logger in a process').to.be.a('string');
			expect(String(named[0]!.message)).to.include(RIVAL_ACTION);

			const after = await captureLog('cluster-member', async () => {
				for (let i = 0; i < 3; i++) {
					expect((await voter.vote(pendAs(100 + i))).signature?.type).to.equal('held');
				}
			});
			expect(linesWith(after, STUCK), 'and never again for this episode').to.have.lengthOf(0);
		} finally {
			voter.dispose();
		}
	});
});

/**
 * Ticket: a-rival-pend-is-superseded-only-by-a-writer-that-built-on-it.
 *
 * In a cohort that can reach its promise bar without one member (`cohortCanMissAPend`: four members up
 * at the default 0.75), the promise vote reads the base the incoming pend declares for the block
 * (`PendRequest.baseRevs`) and treats a rival record as superseded only when that base is at or past
 * the record's slot — the writer read the block WITH the record's change in it. A pend that has moved
 * past the record's slot but declares a base below it read the block without the change (a member that
 * never held the rival's pend can serve that read), and is held. A pend naming no base, and a record
 * with no stored base, keep the revision rule.
 *
 * In a cohort that needs every member (two and three at the default threshold) the vote reads no base:
 * no member can have missed the pend the base arm guards against, and a stray record on one member —
 * a cancel that never reached it — would otherwise hold every later writer for good, since that one
 * member's hold sinks the pend.
 */
describe('ClusterMember — a rival record is superseded only by a pend that built on it', () => {
	const FOUR = 4;
	const LATEST_4 = { rev: 4, actionId: 'r4' as ActionId };
	const RIVAL_AT_5 = [{ actionId: RIVAL_ACTION, rev: 5, baseRev: 4 }];
	const withBase = (baseRev: unknown): Partial<PendRequest> => ({ rev: 6, baseRevs: { [BLOCK]: baseRev as number } });

	it('holds a pend past the record\'s slot whose declared base is below it (four members)', async () => {
		const vote = await voteOnPend(new ClaimRepo(RIVAL_AT_5, LATEST_4), makePend(withBase(4)), FOUR);
		expect(vote.signature?.type, 'the writer did not read the rival\'s change').to.equal('held');
		expect(vote.signature).to.have.property('heldBy', RIVAL_ACTION);
		expect(await voteVerifies(vote)).to.equal(true);
	});

	it('approves the same pend when its declared base is the record\'s slot', async () => {
		const vote = await voteOnPend(new ClaimRepo(RIVAL_AT_5, LATEST_4), makePend(withBase(5)), FOUR);
		expect(vote.signature?.type, 'the writer built on the rival\'s change').to.equal('approve');
	});

	it('approves the same pend when it names no base (the revision rule, unchanged)', async () => {
		const vote = await voteOnPend(new ClaimRepo(RIVAL_AT_5, LATEST_4), makePend({ rev: 6 }), FOUR);
		expect(vote.signature?.type).to.equal('approve');
	});

	it('approves over a record with no stored base — a release-shaped record keeps the revision rule', async () => {
		const vote = await voteOnPend(new ClaimRepo([{ actionId: RIVAL_ACTION, rev: 5 }], LATEST_4), makePend(withBase(4)), FOUR);
		expect(vote.signature?.type, 'a base-less record is superseded once the collection moves past its slot').to.equal('approve');
	});

	for (const cohortSize of [2, 3]) {
		it(`approves the base-below pend at ${cohortSize} members: a stray record on one member must not sink every later writer`, async () => {
			const captured = await captureLog('cluster-member', async () => {
				const vote = await voteOnPend(new ClaimRepo(RIVAL_AT_5, LATEST_4), makePend(withBase(4)), cohortSize);
				expect(vote.signature?.type, 'the revision rule: the collection moved past the record\'s slot').to.equal('approve');
			});
			expect(linesWith(captured, 'cluster-member:validation-pending-superseded'), 'and the supersession is logged').to.have.lengthOf(1);
			expect(linesWith(captured, 'cluster-member:pend-base-ignored'), 'the base is not read at all, so nothing is "ignored"').to.have.lengthOf(0);
		});
	}

	it('still holds a pend for the record\'s own slot at three members', async () => {
		const vote = await voteOnPend(new ClaimRepo(RIVAL_AT_5, LATEST_4), makePend({ rev: 5, baseRevs: { [BLOCK]: 4 } }), 3);
		expect(vote.signature?.type).to.equal('held');
	});

	it('falls back to the revision rule on a malformed base, and logs it rather than refusing', async () => {
		for (const bad of ['5', 6, 9, null]) {
			const captured = await captureLog('cluster-member', async () => {
				const vote = await voteOnPend(new ClaimRepo(RIVAL_AT_5, LATEST_4), makePend(withBase(bad)), FOUR);
				expect(vote.signature?.type, `base ${String(bad)}`).to.equal('approve');
			});
			expect(linesWith(captured, 'cluster-member:pend-base-ignored'), `base ${String(bad)} is logged`).to.have.lengthOf(1);
		}
	});

	it('ignores a base the pend attaches to an inserted block, as storage does', async () => {
		const vote = await voteOnPend(new ClaimRepo(RIVAL_AT_5, LATEST_4), makePend({
			rev: 6,
			transforms: { inserts: { [BLOCK]: { header: { id: BLOCK, type: 't', collectionId: 'c' } } as never }, updates: {}, deletes: [] },
			baseRevs: { [BLOCK]: 4 }
		}), FOUR);
		expect(vote.signature?.type, 'no base is read for an insert, so the revision rule supersedes').to.equal('approve');
	});
});
