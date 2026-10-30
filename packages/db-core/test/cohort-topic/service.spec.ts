import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCohortTopicService, RENEW_BATCH_UNSUPPORTED_RECHECK_MS } from '../../src/cohort-topic/service.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { RenewBatchUnsupportedError, type ITopicRouter, type ISizeEstimator, type PeerRef, type TopicRouteKey } from '../../src/cohort-topic/ports.js';
import { bytesToB64url, encodeCohortMessage, decodeRegisterV1, decodeRenewBatchV1, decodeRenewV1 } from '../../src/cohort-topic/wire/codec.js';
import type { RegisterReplyV1, RenewBatchReplyV1, RenewReplyV1, RenewV1 } from '../../src/cohort-topic/wire/types.js';
import type { CohortGossipBus } from '../../src/cohort-topic/gossip/bus.js';
import type { MembershipVerifier } from '../../src/cohort-topic/membership/verifier.js';

const enc = new TextEncoder();
function bytes(label: string, len = 32): Uint8Array {
	return sha256(enc.encode(label)).slice(0, len);
}

const SELF = bytes('self');
const TOPIC = bytes('topic', 32);
const PRIMARY = bytes('primary', 8);
const EPOCH = bytes('epoch', 32);

const acceptedReply: RegisterReplyV1 = {
	v: 1,
	result: 'accepted',
	primary: bytesToB64url(PRIMARY),
	cohortEpoch: bytesToB64url(EPOCH),
	backups: [],
	cohortMembers: [],
};

function makeService(router: ITopicRouter, clock?: () => number) {
	return createCohortTopicService({
		self: SELF,
		clock,
		hash: createRingHash(),
		router,
		sizeEstimator: { estimate: () => ({ nEst: 1000, confidence: 1 }) } as ISizeEstimator,
		signer: {
			signRegister: async () => 'sig',
			signRenew: async () => 'sig',
		},
		gossipBus: {} as CohortGossipBus,
		verifier: {} as MembershipVerifier,
	});
}

describe('CohortTopicService / stale handle isolation', () => {
	it('withdraw on a superseded handle is a no-op and does not evict the live registration', async () => {
		let dialCallCount = 0;
		const router: ITopicRouter = {
			routeAndAct: async (_key: TopicRouteKey, _activity: Uint8Array, _opts: { wantK: number; minSigs: number }) =>
				encodeCohortMessage(acceptedReply),
			dialMember: async (_peer: PeerRef, _activity: Uint8Array) => {
				dialCallCount++;
				// withdraw tombstone is swallowed on transport failure
				throw new Error('mock-transport-fail');
			},
		};

		const service = makeService(router);
		const handleA = await service.register({ topicId: TOPIC, tier: 1 });
		const handleB = await service.register({ topicId: TOPIC, tier: 1 });

		// withdraw stale handle — must be a no-op; no tombstone, no map eviction
		await service.withdraw(handleA);
		expect(dialCallCount, 'stale withdraw must not call dialMember').to.equal(0);

		// withdraw live handle — must send tombstone
		await service.withdraw(handleB);
		expect(dialCallCount, 'live withdraw must send tombstone').to.equal(1);
	});

	it('renew on a superseded handle is a no-op and does not ping on behalf of the live registration', async () => {
		let dialCallCount = 0;
		const okRenewReply: RenewReplyV1 = { v: 1, result: 'ok' };
		const router: ITopicRouter = {
			routeAndAct: async (_key: TopicRouteKey, _activity: Uint8Array, _opts: { wantK: number; minSigs: number }) =>
				encodeCohortMessage(acceptedReply),
			dialMember: async (_peer: PeerRef, _activity: Uint8Array) => {
				dialCallCount++;
				return encodeCohortMessage(okRenewReply);
			},
		};

		const service = makeService(router);
		const handleA = await service.register({ topicId: TOPIC, tier: 1 });
		const handleB = await service.register({ topicId: TOPIC, tier: 1 });

		// renew stale handle — must be a no-op; pingLoop must not run
		await service.renew(handleA);
		expect(dialCallCount, 'stale renew must not call dialMember').to.equal(0);

		// renew live handle — must ping the primary
		await service.renew(handleB);
		expect(dialCallCount, 'live renew must call dialMember').to.equal(1);
	});

	it('a second withdraw of the same live handle is idempotent (no second tombstone)', async () => {
		let dialCallCount = 0;
		const router: ITopicRouter = {
			routeAndAct: async (_key: TopicRouteKey, _activity: Uint8Array, _opts: { wantK: number; minSigs: number }) =>
				encodeCohortMessage(acceptedReply),
			dialMember: async (_peer: PeerRef, _activity: Uint8Array) => {
				dialCallCount++;
				return encodeCohortMessage({ v: 1, result: 'ok' } as RenewReplyV1);
			},
		};

		const service = makeService(router);
		const handle = await service.register({ topicId: TOPIC, tier: 1 });

		await service.withdraw(handle);
		expect(dialCallCount, 'first withdraw sends one tombstone').to.equal(1);

		// After the map entry is gone, `renewals.get(key)` is undefined ≠ handle.renewal → no-op.
		await service.withdraw(handle);
		expect(dialCallCount, 'second withdraw must not send another tombstone').to.equal(1);
	});

	it('renew after withdraw is a no-op (the handle left the live set)', async () => {
		let renewCount = 0;
		let withdrawCount = 0;
		const router: ITopicRouter = {
			routeAndAct: async (_key: TopicRouteKey, _activity: Uint8Array, _opts: { wantK: number; minSigs: number }) =>
				encodeCohortMessage(acceptedReply),
			dialMember: async (_peer: PeerRef, activity: Uint8Array) => {
				// The withdraw tombstone and a renew both go through dialMember; the count that matters is
				// that no renew ping fires after withdraw. Decode is unnecessary — just tally the total.
				void activity;
				withdrawCount++;
				return encodeCohortMessage({ v: 1, result: 'ok' } as RenewReplyV1);
			},
		};

		const service = makeService(router);
		const handle = await service.register({ topicId: TOPIC, tier: 1 });

		await service.withdraw(handle);
		const afterWithdraw = withdrawCount;

		await service.renew(handle);
		renewCount = withdrawCount - afterWithdraw;
		expect(renewCount, 'renew after withdraw must not ping').to.equal(0);
	});
});

describe('CohortTopicService / renew echoes the register correlationId', () => {
	it('a renew ping carries the accepted RegisterV1\'s correlationId (RenewV1 matches original RegisterV1)', async () => {
		let registerCorrelationId: string | undefined;
		let renewCorrelationId: string | undefined;
		const router: ITopicRouter = {
			routeAndAct: async (_key: TopicRouteKey, activity: Uint8Array, _opts: { wantK: number; minSigs: number }) => {
				// The register walk builds a fresh correlationId per probe; capture the one the cohort admits.
				registerCorrelationId = decodeRegisterV1(activity).correlationId;
				return encodeCohortMessage(acceptedReply);
			},
			dialMember: async (_peer: PeerRef, activity: Uint8Array) => {
				renewCorrelationId = decodeRenewV1(activity).correlationId;
				return encodeCohortMessage({ v: 1, result: 'ok' } as RenewReplyV1);
			},
		};

		const service = makeService(router);
		const handle = await service.register({ topicId: TOPIC, tier: 1 });
		await service.renew(handle);

		expect(registerCorrelationId, 'the register stamped a correlationId').to.be.a('string');
		expect(renewCorrelationId, 'the renew echoes the accepted register\'s correlationId').to.equal(registerCorrelationId);
	});
});

describe('CohortTopicService / moveRoot', () => {
	it('a renewal re-walk after moveRoot names the new root key', async () => {
		const OLD_ROOT = bytes('old-root', 16);
		const NEW_ROOT = bytes('new-root', 16);
		const walkedWith: (string | undefined)[] = [];
		const router: ITopicRouter = {
			routeAndAct: async (_key: TopicRouteKey, activity: Uint8Array, _opts: { wantK: number; minSigs: number }) => {
				walkedWith.push(decodeRegisterV1(activity).rootKey);
				return encodeCohortMessage(acceptedReply);
			},
			dialMember: async () => {
				throw new Error('primary unreachable');
			},
		};

		const service = makeService(router);
		const handle = await service.register({ topicId: TOPIC, tier: 1, rootKey: OLD_ROOT });
		service.moveRoot(handle, NEW_ROOT);
		walkedWith.length = 0;

		// Three failed pings with no backup to re-attach to: the renewal re-runs the register walk.
		for (let i = 0; i < 3; i++) {
			await service.renew(handle);
		}
		expect(walkedWith, 'the failover re-walked').to.not.be.empty;
		expect(walkedWith, 'every re-walk frame names the moved root').to.deep.equal(walkedWith.map(() => bytesToB64url(NEW_ROOT)));
	});
});

describe('CohortTopicService / renewal re-walk', () => {
	it('a re-walk that lands at another tree tier and primary moves the handle there', async () => {
		const NEW_PRIMARY = bytes('rewalk-primary', 8);
		const NEW_EPOCH = bytes('rewalk-epoch', 32);
		let rewalking = false;
		const router: ITopicRouter = {
			routeAndAct: async (_key: TopicRouteKey, activity: Uint8Array, _opts: { wantK: number; minSigs: number }) => {
				if (!rewalking) {
					return encodeCohortMessage(acceptedReply);
				}
				// The re-walk finds no state at the tier the registration was made at and lands at the root.
				const reply: RegisterReplyV1 = decodeRegisterV1(activity).treeTier > 0
					? { v: 1, result: 'no_state' }
					: { ...acceptedReply, primary: bytesToB64url(NEW_PRIMARY), cohortEpoch: bytesToB64url(NEW_EPOCH) };
				return encodeCohortMessage(reply);
			},
			dialMember: async () => {
				throw new Error('primary unreachable');
			},
		};

		const service = makeService(router);
		const handle = await service.register({ topicId: TOPIC, tier: 1 });
		expect(handle.treeTier, 'registered below the root').to.be.greaterThan(0);
		rewalking = true;

		// Three failed pings with no backup to re-attach to: the renewal re-runs the register walk.
		for (let i = 0; i < 3; i++) {
			await service.renew(handle);
		}
		expect(handle.treeTier, 'the handle names the tier the re-walk landed at').to.equal(0);
		expect(bytesToB64url(handle.primary), 'and its primary').to.equal(bytesToB64url(NEW_PRIMARY));
		expect(bytesToB64url(handle.cohortEpoch), 'and its epoch').to.equal(bytesToB64url(NEW_EPOCH));
	});
});

describe('CohortTopicService / renewMany', () => {
	it('pings to one primary travel in one batch frame, and each registration acts on its own reply', async () => {
		const OK_TOPIC = bytes('topic-ok');
		const MOVED_TOPIC = bytes('topic-moved');
		const LOST_TOPIC = bytes('topic-lost');
		const NEW_PRIMARY = bytes('moved-primary', 8);
		const NEW_EPOCH = bytes('moved-epoch', 32);
		const replyFor = (renew: RenewV1): RenewReplyV1 => {
			if (renew.topicId === bytesToB64url(MOVED_TOPIC)) {
				return { v: 1, result: 'primary_moved', newPrimary: bytesToB64url(NEW_PRIMARY), newBackups: [], cohortEpoch: bytesToB64url(NEW_EPOCH) };
			}
			return renew.topicId === bytesToB64url(LOST_TOPIC) ? { v: 1, result: 'unknown_registration' } : { v: 1, result: 'ok' };
		};
		const batches: { target: string; topics: string[] }[] = [];
		const singles: { target: string; topic: string }[] = [];
		const walked: string[] = [];
		let registering = true;
		const router: ITopicRouter = {
			routeAndAct: async (_key: TopicRouteKey, activity: Uint8Array) => {
				if (!registering) {
					walked.push(decodeRegisterV1(activity).topicId);
				}
				return encodeCohortMessage(acceptedReply);
			},
			dialMember: async (member: PeerRef, activity: Uint8Array) => {
				singles.push({ target: bytesToB64url(member.id), topic: decodeRenewV1(activity).topicId });
				return encodeCohortMessage({ v: 1, result: 'ok' } as RenewReplyV1);
			},
			dialMemberRenewBatch: async (member: PeerRef, frame: Uint8Array) => {
				const { renews } = decodeRenewBatchV1(frame);
				batches.push({ target: bytesToB64url(member.id), topics: renews.map((r) => r.topicId) });
				const reply: RenewBatchReplyV1 = { v: 1, replies: renews.map(replyFor) };
				return encodeCohortMessage(reply);
			},
		};
		const service = makeService(router);
		const ok = await service.register({ topicId: OK_TOPIC, tier: 1 });
		const moved = await service.register({ topicId: MOVED_TOPIC, tier: 1 });
		const lost = await service.register({ topicId: LOST_TOPIC, tier: 1 });
		registering = false;
		const handles = [ok, moved, lost];
		const [okB64, movedB64, lostB64] = [OK_TOPIC, MOVED_TOPIC, LOST_TOPIC].map(bytesToB64url);

		await service.renewMany(handles);
		expect(batches, 'the three pings to the shared primary went in one frame').to.deep.equal([{ target: bytesToB64url(PRIMARY), topics: [okB64, movedB64, lostB64] }]);
		expect(singles, 'and none went singly').to.be.empty;
		expect(bytesToB64url(ok.primary), 'ok keeps its primary').to.equal(bytesToB64url(PRIMARY));
		expect(bytesToB64url(moved.primary), 'primary_moved adopts the named primary').to.equal(bytesToB64url(NEW_PRIMARY));
		expect(bytesToB64url(moved.cohortEpoch), 'and epoch').to.equal(bytesToB64url(NEW_EPOCH));
		expect(bytesToB64url(lost.primary), 'unknown_registration is a strike, not a move').to.equal(bytesToB64url(PRIMARY));

		batches.length = 0;
		await service.renewMany(handles);
		await service.renewMany(handles);
		expect(batches, 'the moved registration now pings its new primary, apart from the batch').to.deep.equal([
			{ target: bytesToB64url(PRIMARY), topics: [okB64, lostB64] },
			{ target: bytesToB64url(PRIMARY), topics: [okB64, lostB64] },
		]);
		expect(singles, 'a lone ping to a primary goes singly').to.deep.equal([
			{ target: bytesToB64url(NEW_PRIMARY), topic: movedB64 },
			{ target: bytesToB64url(NEW_PRIMARY), topic: movedB64 },
		]);
		expect(walked, 'the third strike re-walked the lost registration').to.not.be.empty;
		expect(new Set(walked), 'and it alone').to.deep.equal(new Set([lostB64]));
	});

	it('a registration whose failover is still waiting on its re-walk is skipped by the next call, which still renews the others', async () => {
		const OK_TOPIC = bytes('topic-steady');
		const LOST_TOPIC = bytes('topic-failing');
		const [okB64, lostB64] = [OK_TOPIC, LOST_TOPIC].map(bytesToB64url);
		const pinged: string[][] = [];
		let registering = true;
		let walkStarted = false;
		let releaseWalk: (reply: Uint8Array) => void = () => {};
		const router: ITopicRouter = {
			routeAndAct: async () => {
				if (registering) {
					return encodeCohortMessage(acceptedReply);
				}
				walkStarted = true;
				return new Promise<Uint8Array>((resolve) => { releaseWalk = resolve; });
			},
			dialMember: async (_member: PeerRef, activity: Uint8Array) => {
				pinged.push([decodeRenewV1(activity).topicId]);
				return encodeCohortMessage({ v: 1, result: 'ok' } as RenewReplyV1);
			},
			dialMemberRenewBatch: async (_member: PeerRef, frame: Uint8Array) => {
				const { renews } = decodeRenewBatchV1(frame);
				pinged.push(renews.map((r) => r.topicId));
				const reply: RenewBatchReplyV1 = {
					v: 1,
					replies: renews.map((r): RenewReplyV1 => ({ v: 1, result: r.topicId === lostB64 ? 'unknown_registration' : 'ok' })),
				};
				return encodeCohortMessage(reply);
			},
		};
		const service = makeService(router);
		const handles = [await service.register({ topicId: OK_TOPIC, tier: 1 }), await service.register({ topicId: LOST_TOPIC, tier: 1 })];
		registering = false;

		await service.renewMany(handles);
		await service.renewMany(handles);
		const failingOver = service.renewMany(handles); // the third strike: no backups, so it re-walks — and the walk is held
		while (!walkStarted) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		pinged.length = 0;

		await service.renewMany(handles);
		expect(pinged, 'the failing-over registration sat this call out; the other was renewed without waiting for it').to.deep.equal([[okB64]]);

		releaseWalk(encodeCohortMessage(acceptedReply));
		await failingOver;
		pinged.length = 0;
		await service.renewMany(handles);
		expect(pinged, 'once its failover ended, it is renewed again').to.deep.equal([[okB64, lostB64]]);
	});

	it('a member that does not speak the batch protocol is sent the same pings singly in the same call, and singly until the recheck interval passes', async () => {
		const TOPICS = [bytes('topic-a'), bytes('topic-b')];
		let now = 1_000_000;
		let batchAttempts = 0;
		const singles: string[] = [];
		const router: ITopicRouter = {
			routeAndAct: async () => encodeCohortMessage(acceptedReply),
			dialMember: async (_member: PeerRef, activity: Uint8Array) => {
				singles.push(decodeRenewV1(activity).topicId);
				return encodeCohortMessage({ v: 1, result: 'ok' } as RenewReplyV1);
			},
			dialMemberRenewBatch: async (member: PeerRef) => {
				batchAttempts++;
				throw new RenewBatchUnsupportedError(member.id);
			},
		};
		const service = makeService(router, () => now);
		const handles = [await service.register({ topicId: TOPICS[0]!, tier: 1 }), await service.register({ topicId: TOPICS[1]!, tier: 1 })];
		const topics = TOPICS.map(bytesToB64url).sort();

		await service.renewMany(handles);
		expect(batchAttempts, 'the batch was tried').to.equal(1);
		expect([...singles].sort(), 'and its pings re-sent singly in the same call').to.deep.equal(topics);

		singles.length = 0;
		await service.renewMany(handles);
		expect(batchAttempts, 'the refusal is remembered').to.equal(1);
		expect([...singles].sort(), 'so the next call sends singly at once').to.deep.equal(topics);

		now += RENEW_BATCH_UNSUPPORTED_RECHECK_MS;
		await service.renewMany(handles);
		expect(batchAttempts, 'a batch is tried again once the recheck interval has passed').to.equal(2);
	});
});
