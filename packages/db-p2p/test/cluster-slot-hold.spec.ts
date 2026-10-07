/**
 * Ticket: slot-hold-for-an-aged-writer.
 *
 * A member that has itself refused one action's pend as stale `SlotHoldAfterLosses` times holds the
 * next slot of every block that pend named for the action (`ClusterMember.noteStaleLoss`): until the
 * action's own pend consumes the hold or the window lapses, every OTHER action's pend of the block is
 * answered with the same `held` vote a storage reservation produces (`judgeSlotHolds`). A hold is in
 * memory, bounded by `slotHoldWindowMs`, counted from refusals this member cast and never from a
 * number the record carries.
 *
 * What this spec pins, at the member tier, with an injected clock:
 *  - the threshold (nothing is held below it, the next slot is held at it);
 *  - consume (the holder's own pend passes and the hold is gone after it);
 *  - lapse (a hold past its window refuses nobody, and the lapse is logged);
 *  - the own-revision carve-out (a redelivered pend over the holder's own committed revision passes);
 *  - a hold refuses another aged action, which is granted its own after the first commits;
 *  - a record that arrived already refused by another member counts without this member voting,
 *    and counts once however many times it is delivered;
 *  - a pend refused on one block keeps its hold on another;
 *  - no hold refusal ever feeds the stuck-reservation counter;
 *  - `slotHoldWindowMs: 0` counts, grants and checks nothing.
 */

import { expect } from 'chai';
import { localDurability, clusterVoteVerificationPayload, clusterVoteSigningPayload, SlotHoldAfterLosses } from '@optimystic/db-core';
import { clusterMember, CONFLICT_STALE_THRESHOLD_MS } from '../src/cluster/cluster-repo.js';
import { resolveClusterPolicy } from '../src/cluster/cluster-policy.js';
import { STUCK_RESERVATION_DISTINCT_ACTIONS } from '../src/repo/stuck-reservation.js';
import { captureLog } from './support/capture-log.js';
import type {
	IRepo, ClusterRecord, RepoMessage, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, CommitResult, ActionBlocks, ClusterPeers, BlockId, ActionId, ActionRev, Signature, ClusterVote
} from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';

// ─── Harness (mirrors cluster-pend-held-vote.spec.ts: clusterMember factory + mock repo + v1 record
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
const OTHER_BLOCK = 'other-block' as BlockId;
const AGED = 'a-aged' as ActionId;
const SECOND_AGED = 'a-aged-2' as ActionId;
const FRESH = 'a-fresh' as ActionId;
/** The revision a quick rival committed ahead of the aged writer: a pend requesting it is stale. */
const RIVAL_AT_5: ActionRev = { rev: 5, actionId: 'r5' as ActionId };
const WINDOW_MS = 3000;

const GRANTED = 'cluster-member:slot-hold-granted';
const REFUSED = 'cluster-member:slot-hold-refused';
const CONSUMED = 'cluster-member:slot-hold-consumed';
const LAPSED = 'cluster-member:slot-hold-expired-unconsumed';
const STUCK = 'cluster-member:stuck-reservation';

const linesWith = (captured: unknown[][], tag: string): unknown[][] =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(tag));

let pendCount = 0;

/** A pend of `blockIds` (default the one block) by `actionId` at `rev`. Each carries a fresh value, so
 *  two pends built in one millisecond are two records: the record hash covers the message, whose only
 *  other per-call field is a millisecond expiration, and a member counts one record once. */
const pendOf = (actionId: ActionId, rev: number, blockIds: BlockId[] = [BLOCK]): PendRequest => ({
	actionId,
	rev,
	transforms: { inserts: {}, updates: Object.fromEntries(blockIds.map(id => [id, [['entries', 0, 0, [`x${++pendCount}`]]]])), deletes: [] },
	policy: 'c'
});

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

const promiseHashOf = async (record: ClusterRecord): Promise<string> => {
	const bytes = new TextEncoder().encode(record.messageHash + canonicalJson(record.message));
	return uint8ArrayToString((await sha256.digest(bytes)).digest, 'base64url');
};

/** A repo whose `get` answers the same storage state for every block — mutable, so a spec can move
 *  the committed revision between votes the way a commit would. */
class StateRepo implements IRepo {
	constructor(public state: { latest?: ActionRev; pendings?: ActionId[] }) { }
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

/** One member over `repo` with an injected clock, kept alive across pends so its holds and counts
 *  accumulate the way they do in a running node. */
interface Voter {
	vote(pend: PendRequest): Promise<CastVote>;
	/** `pend` as a record the OTHER member has already refused as stale — terminal on arrival at a
	 *  two-member cohort, so this member never votes on it. */
	refusedElsewhere(pend: PendRequest): Promise<ClusterRecord>;
	/** Deliver a prebuilt record and return this member's own vote on it, if it cast one. */
	deliver(record: ClusterRecord): Promise<Signature | undefined>;
	/** Move the member's clock forward. Seeded from real time, since only the hold and the
	 *  reservation table read it. */
	advance(ms: number): void;
	/**
	 * Age an APPROVED record out of the member's in-memory reservation table. A member keeps a record
	 * it approved until it signs the commit (a round trip later in a running cohort), and until then
	 * every other pend of the block loses `findConflict` to it ahead of validation. This harness
	 * never runs the commit round, so the sweep that `CONFLICT_STALE_THRESHOLD_MS` arms stands in for
	 * it. Refused records are never kept, so only an approval needs this.
	 */
	settle(): void;
	dispose(): void;
}

const memberOver = async (repo: IRepo, slotHoldWindowMs = WINDOW_MS): Promise<Voter> => {
	const self = await makeKeyPair();
	const other = await makeKeyPair();
	const clock = { now: Date.now() };
	const member = clusterMember({
		storageRepo: repo,
		peerNetwork: new MockPeerNetwork(),
		peerId: self.peerId,
		privateKey: self.privateKey,
		consensusConfig: resolveClusterPolicy({ clusterPolicy: { slotHoldWindowMs } }),
		now: () => clock.now
	});
	const peers = makeClusterPeers([self, other]);
	return {
		async vote(pend) {
			const record = await makePendRecord(peers, pend);
			const result = await member.update(record);
			return { signature: result.promises[self.peerId.toString()], record, self };
		},
		async refusedElsewhere(pend) {
			const record = await makePendRecord(peers, pend);
			const reject: ClusterVote = { type: 'reject', rejectReason: 'stale revision: refused by the coordinating member' };
			const signature = await other.privateKey.sign(clusterVoteSigningPayload(await promiseHashOf(record), reject));
			record.promises[other.peerId.toString()] = { ...reject, signature: uint8ArrayToString(signature, 'base64url') };
			return record;
		},
		async deliver(record) {
			const result = await member.update(record);
			return result.promises[self.peerId.toString()];
		},
		advance: ms => { clock.now += ms; },
		settle: () => { clock.now += CONFLICT_STALE_THRESHOLD_MS + 1; },
		dispose: () => member.dispose()
	};
};

const voteVerifies = async ({ signature, record, self }: CastVote): Promise<boolean> => {
	if (!signature) return false;
	return await self.peerId.publicKey!.verify(
		clusterVoteVerificationPayload(await promiseHashOf(record), signature),
		uint8ArrayFromString(signature.signature, 'base64url')
	);
};

/** Drive `actionId` through `count` stale refusals of `blockIds` — a pend at the revision the rival
 *  already committed — and assert each was refused as stale. */
const loseStale = async (voter: Voter, actionId: ActionId, count: number, blockIds: BlockId[] = [BLOCK]): Promise<void> => {
	for (let i = 0; i < count; i++) {
		const vote = await voter.vote(pendOf(actionId, RIVAL_AT_5.rev, blockIds));
		expect(vote.signature?.type, `${actionId} loss ${i + 1}`).to.equal('reject');
		expect(String((vote.signature as { rejectReason?: string }).rejectReason)).to.include('stale revision');
	}
};

const withVoter = async (fn: (voter: Voter, repo: StateRepo) => Promise<void>, slotHoldWindowMs = WINDOW_MS): Promise<void> => {
	const repo = new StateRepo({ latest: RIVAL_AT_5 });
	const voter = await memberOver(repo, slotHoldWindowMs);
	try {
		await fn(voter, repo);
	} finally {
		voter.dispose();
	}
};

describe('ClusterMember — a slot is held for a writer this member has refused as stale enough times', () => {
	it('holds nothing below the threshold: a fresh pend is approved after one loss short of it', async () => {
		await withVoter(async voter => {
			const captured = await captureLog('cluster-member', async () => {
				await loseStale(voter, AGED, SlotHoldAfterLosses - 1);
			});
			expect(linesWith(captured, GRANTED), 'no grant below the threshold').to.have.lengthOf(0);

			const fresh = await voter.vote(pendOf(FRESH, 6));
			expect(fresh.signature?.type, 'two losses are an ordinary lost race').to.equal('approve');
		});
	});

	it('holds the next slot at the threshold: a fresh pend is answered held naming the aged action', async () => {
		await withVoter(async voter => {
			await loseStale(voter, AGED, SlotHoldAfterLosses - 1);
			const atThreshold = await captureLog('cluster-member', async () => {
				await loseStale(voter, AGED, 1);
			});
			const granted = linesWith(atThreshold, GRANTED).map(args => args[1] as { blockId?: string; actionId?: string; losses?: number; windowMs?: number });
			expect(granted, 'granted once, on the loss that crosses the threshold').to.have.lengthOf(1);
			expect(granted[0]).to.include({ blockId: BLOCK, actionId: AGED, losses: SlotHoldAfterLosses, windowMs: WINDOW_MS });

			const refused = await captureLog('cluster-member', async () => {
				const fresh = await voter.vote(pendOf(FRESH, 6));
				expect(fresh.signature?.type, 'the hold is the same transient answer a reservation gives').to.equal('held');
				expect(fresh.signature).to.have.property('heldBy', AGED);
				expect(await voteVerifies(fresh), 'and it is signed like one').to.equal(true);
			});
			expect(linesWith(refused, REFUSED)).to.have.lengthOf(1);
		});
	});

	it('is consumed by the holder\'s own pend, after which a fresh pend is approved', async () => {
		await withVoter(async voter => {
			await loseStale(voter, AGED, SlotHoldAfterLosses);

			const consumed = await captureLog('cluster-member', async () => {
				const own = await voter.vote(pendOf(AGED, 6));
				expect(own.signature?.type, 'the clear chance the hold exists to give').to.equal('approve');
			});
			expect(linesWith(consumed, CONSUMED).map(args => (args[1] as { blockId?: string }).blockId)).to.deep.equal([BLOCK]);

			voter.settle();
			const fresh = await voter.vote(pendOf(FRESH, 6));
			expect(fresh.signature?.type, 'nothing stands on the block once consumed').to.equal('approve');
		});
	});

	it('lapses unconsumed: past the window a fresh pend is approved and the lapse is logged', async () => {
		await withVoter(async voter => {
			await loseStale(voter, AGED, SlotHoldAfterLosses);
			voter.advance(WINDOW_MS - 1);
			expect((await voter.vote(pendOf(FRESH, 6))).signature?.type, 'still inside the window').to.equal('held');

			voter.advance(1);
			const lapsed = await captureLog('cluster-member', async () => {
				const fresh = await voter.vote(pendOf(FRESH, 6));
				expect(fresh.signature?.type, 'the holder did not come back in time').to.equal('approve');
			});
			const lines = linesWith(lapsed, LAPSED).map(args => args[1] as { blockId?: string; actionId?: string });
			expect(lines, 'the lapse is the tripwire count for a per-block cooldown').to.have.lengthOf(1);
			expect(lines[0]).to.include({ blockId: BLOCK, actionId: AGED });
		});
	});

	it('never refuses its own action: a redelivered pend over the holder\'s own committed revision passes', async () => {
		await withVoter(async (voter, repo) => {
			await loseStale(voter, AGED, SlotHoldAfterLosses);
			// The aged pend landed elsewhere and this delivery is its redelivery over its own revision:
			// the own-revision carve-out keeps it approvable, and the hold is consumed rather than refusing it.
			repo.state = { latest: { rev: 6, actionId: AGED } };
			const own = await voter.vote(pendOf(AGED, 6));
			expect(own.signature?.type).to.equal('approve');

			voter.settle();
			const fresh = await voter.vote(pendOf(FRESH, 7));
			expect(fresh.signature?.type, 'the redelivery consumed the hold').to.equal('approve');
		});
	});

	it('refuses a second aged action while the first holds, and holds for the second once the first has committed', async () => {
		await withVoter(async (voter, repo) => {
			await loseStale(voter, AGED, SlotHoldAfterLosses);
			const secondLoses = await captureLog('cluster-member', async () => {
				await loseStale(voter, SECOND_AGED, SlotHoldAfterLosses);
			});
			expect(linesWith(secondLoses, GRANTED), 'a block held for another action keeps that hold').to.have.lengthOf(0);

			const second = await voter.vote(pendOf(SECOND_AGED, 6));
			expect(second.signature?.type, 'the second aged writer is refused by the first\'s hold like any rival').to.equal('held');
			expect(second.signature).to.have.property('heldBy', AGED);

			expect((await voter.vote(pendOf(AGED, 6))).signature?.type, 'the first consumes').to.equal('approve');
			// The first's commit moves the block past the second's requested revision: one more stale
			// loss for the second, and this time the block is free to hold for it.
			voter.settle();
			repo.state = { latest: { rev: 6, actionId: AGED } };
			const regrant = await captureLog('cluster-member', async () => {
				const stale = await voter.vote(pendOf(SECOND_AGED, 6));
				expect(stale.signature?.type).to.equal('reject');
			});
			expect(linesWith(regrant, GRANTED).map(args => (args[1] as { actionId?: string }).actionId)).to.deep.equal([SECOND_AGED]);

			const fresh = await voter.vote(pendOf(FRESH, 7));
			expect(fresh.signature?.type).to.equal('held');
			expect(fresh.signature).to.have.property('heldBy', SECOND_AGED);
		});
	});

	it('counts a record that arrived already refused by another member, without voting on it', async () => {
		// On a two- or three-member cohort the coordinating member's stale reject is terminal before
		// anyone else votes, and the coordinator is picked per block — so this member's count must not
		// depend on having cast the refusal itself, or a log tail rolling over mid-cycle would split
		// the writer's losses across members and no member would ever hold (measured on the mesh).
		await withVoter(async voter => {
			for (let i = 0; i < SlotHoldAfterLosses; i++) {
				const record = await voter.refusedElsewhere(pendOf(AGED, RIVAL_AT_5.rev));
				expect(await voter.deliver(record), `delivery ${i + 1} casts no vote`).to.equal(undefined);
			}
			const fresh = await voter.vote(pendOf(FRESH, 6));
			expect(fresh.signature?.type, 'the losses counted though this member coordinated none of them').to.equal('held');
			expect(fresh.signature).to.have.property('heldBy', AGED);
		});
	});

	it('counts one record once, however many times it is delivered', async () => {
		// The abandonment broadcast re-sends a refused record to every member; a member that cast no
		// vote on it would otherwise count it on each delivery.
		await withVoter(async voter => {
			const record = await voter.refusedElsewhere(pendOf(AGED, RIVAL_AT_5.rev));
			for (let i = 0; i < SlotHoldAfterLosses + 1; i++) {
				await voter.deliver(record);
			}
			expect((await voter.vote(pendOf(FRESH, 6))).signature?.type, 'one record is one loss').to.equal('approve');
		});
	});

	it('keeps a pend\'s hold on one block when the pend is refused on another', async () => {
		await withVoter(async voter => {
			await loseStale(voter, AGED, SlotHoldAfterLosses, [BLOCK]);
			await loseStale(voter, SECOND_AGED, SlotHoldAfterLosses, [OTHER_BLOCK]);

			const refusedOnOther = await captureLog('cluster-member', async () => {
				const aged = await voter.vote(pendOf(AGED, 6, [BLOCK, OTHER_BLOCK]));
				expect(aged.signature?.type, 'the other block is held for the second action').to.equal('held');
				expect(aged.signature).to.have.property('heldBy', SECOND_AGED);
			});
			expect(linesWith(refusedOnOther, CONSUMED), 'a refused pend consumes nothing').to.have.lengthOf(0);

			const fresh = await voter.vote(pendOf(FRESH, 6, [BLOCK]));
			expect(fresh.signature?.type, 'the first block is still held for the aged action').to.equal('held');
			expect(fresh.signature).to.have.property('heldBy', AGED);
		});
	});

	it('never names a stuck reservation, however many distinct writers a hold refuses', async () => {
		await withVoter(async voter => {
			await loseStale(voter, AGED, SlotHoldAfterLosses);
			const captured = await captureLog('cluster-member', async () => {
				for (let i = 0; i < STUCK_RESERVATION_DISTINCT_ACTIONS + 2; i++) {
					const vote = await voter.vote(pendOf(`writer-${i}` as ActionId, 6));
					expect(vote.signature?.type, `writer-${i}`).to.equal('held');
				}
			});
			expect(linesWith(captured, STUCK), 'a hold is not a storage record and is never stuck').to.have.lengthOf(0);
			expect(linesWith(captured, REFUSED)).to.have.lengthOf(STUCK_RESERVATION_DISTINCT_ACTIONS + 2);
		});
	});

	it('counts, grants and checks nothing when the window is 0', async () => {
		await withVoter(async voter => {
			const captured = await captureLog('cluster-member', async () => {
				await loseStale(voter, AGED, SlotHoldAfterLosses + 1);
				const fresh = await voter.vote(pendOf(FRESH, 6));
				expect(fresh.signature?.type, 'the vote path is today\'s').to.equal('approve');
			});
			expect(linesWith(captured, GRANTED)).to.have.lengthOf(0);
			expect(linesWith(captured, REFUSED)).to.have.lengthOf(0);
		}, 0);
	});
});
