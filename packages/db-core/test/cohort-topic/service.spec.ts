import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCohortTopicService } from '../../src/cohort-topic/service.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import type { ITopicRouter, ISizeEstimator, PeerRef, RingCoord } from '../../src/cohort-topic/ports.js';
import { bytesToB64url, encodeCohortMessage } from '../../src/cohort-topic/wire/codec.js';
import type { RegisterReplyV1, RenewReplyV1 } from '../../src/cohort-topic/wire/types.js';
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

function makeService(router: ITopicRouter) {
	return createCohortTopicService({
		self: SELF,
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
			routeAndAct: async (_key: RingCoord, _activity: Uint8Array, _opts: { wantK: number; minSigs: number }) =>
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
			routeAndAct: async (_key: RingCoord, _activity: Uint8Array, _opts: { wantK: number; minSigs: number }) =>
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
});
