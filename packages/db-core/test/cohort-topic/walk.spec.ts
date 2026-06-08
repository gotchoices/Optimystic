import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createWalkEngine, type RegisterMessageFactory } from '../../src/cohort-topic/walk.js';
import { createTierAddressing } from '../../src/cohort-topic/addressing.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import type { DMaxComputer } from '../../src/cohort-topic/dmax.js';
import type { ITopicRouter, PeerRef, RingCoord } from '../../src/cohort-topic/ports.js';
import {
	bytesToB64url,
	encodeCohortMessage,
	decodeRegisterV1,
} from '../../src/cohort-topic/wire/codec.js';
import { bytesEqual } from '../../src/cohort-topic/registration/bytes.js';
import type { RegisterReplyV1 } from '../../src/cohort-topic/wire/types.js';

function bytes(label: string, len = 16): Uint8Array {
	return sha256(new TextEncoder().encode(label)).slice(0, len);
}

const TOPIC = bytes('walk-topic', 32);
const addressing = createTierAddressing(createRingHash());

/** A recorded probe — whether it was routed (by coord) or directly dialed (by member), plus the decoded register fields. */
interface Probe {
	readonly mode: 'route' | 'dial';
	readonly coord?: RingCoord;
	readonly member?: Uint8Array;
	readonly treeTier: number;
	readonly bootstrap: boolean;
}

/**
 * A scripted router: returns `replies[i]` for the i-th probe (route or dial) and records each probe.
 * The encoded reply is what FRET's `RouteAndMaybeAct` / direct dial would return on the wire.
 */
class ScriptedRouter implements ITopicRouter {
	readonly probes: Probe[] = [];
	private i = 0;

	constructor(private readonly replies: readonly RegisterReplyV1[]) {}

	async routeAndAct(key: RingCoord, activity: Uint8Array): Promise<Uint8Array> {
		const reg = decodeRegisterV1(activity);
		this.probes.push({ mode: 'route', coord: key, treeTier: reg.treeTier, bootstrap: reg.bootstrap === true });
		return encodeCohortMessage(this.next());
	}

	async dialMember(member: PeerRef, activity: Uint8Array): Promise<Uint8Array> {
		const reg = decodeRegisterV1(activity);
		this.probes.push({ mode: 'dial', member: member.id, treeTier: reg.treeTier, bootstrap: reg.bootstrap === true });
		return encodeCohortMessage(this.next());
	}

	private next(): RegisterReplyV1 {
		const reply = this.replies[this.i];
		if (reply === undefined) {
			throw new Error(`ScriptedRouter ran out of replies at probe ${this.i}`);
		}
		this.i++;
		return reply;
	}
}

function fixedDMax(d: number): DMaxComputer {
	return { dMax: () => d };
}

/** A factory that emits a deterministic signed-shaped RegisterV1 (signature/crypto are out of scope here). */
function factoryFor(self: Uint8Array): RegisterMessageFactory {
	return {
		build: async ({ topicId, tier, treeTier, bootstrap, appPayload }) => ({
			v: 1,
			topicId: bytesToB64url(topicId),
			tier,
			treeTier,
			participantCoord: bytesToB64url(self),
			ttl: 90_000,
			...(bootstrap ? { bootstrap: true } : {}),
			...(appPayload ? { appPayload: bytesToB64url(appPayload) } : {}),
			timestamp: 1_000,
			correlationId: bytesToB64url(bytes('corr')),
			signature: bytesToB64url(bytes('sig', 8)),
		}),
	};
}

const accepted: RegisterReplyV1 = { v: 1, result: 'accepted', primary: bytesToB64url(bytes('primary')), cohortEpoch: bytesToB64url(bytes('epoch', 32)) };
const noState: RegisterReplyV1 = { v: 1, result: 'no_state' };

describe('cohort-topic / walk-toward-root', () => {
	it('sparse-regime walks fan across the ring: distinct coord_{d_max} per participant, all drain to the root', async () => {
		const dMax = 3;
		// Each participant's walk: no_state at d=3,2,1 then accepted at the root (d=0).
		const replies = [noState, noState, noState, accepted];
		const startCoords: RingCoord[] = [];

		for (let p = 0; p < 8; p++) {
			const self = bytes(`participant-${p}`);
			const router = new ScriptedRouter(replies);
			const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });
			const outcome = await engine.register(TOPIC, 1);
			expect(outcome.kind, `participant ${p} attaches at the root`).to.equal('accepted');

			// Single-direction: probes step strictly inward d_max → 0, never outward, never repeating a coord.
			expect(router.probes.map((x) => x.treeTier)).to.deep.equal([3, 2, 1, 0]);
			const first = router.probes[0]!;
			expect(first.mode).to.equal('route');
			expect(first.coord, 'start coord is coord_{d_max}(self, topic)').to.satisfy((c: RingCoord) =>
				bytesEqual(c, addressing.coord(dMax, self, TOPIC)),
			);
			startCoords.push(first.coord!);
		}

		// The anti-flood claim: every participant starts its walk at a DISTINCT d_max coordinate, so the
		// sparse-regime walks fan across the ring rather than colliding on one cohort.
		const distinct = new Set(startCoords.map(bytesToB64url));
		expect(distinct.size, 'distinct start coord per participant').to.equal(8);
	});

	it('follows a Promoted redirect outward, recomputing coord at the target tier', async () => {
		const self = bytes('promoted-participant');
		const dMax = 1;
		// d=1 cold → no_state; root promoted → Promoted(1); recompute coord_1 → accepted.
		const router = new ScriptedRouter([
			noState,
			{ v: 1, result: 'promoted', targetTier: 1 },
			accepted,
		]);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });
		const outcome = await engine.register(TOPIC, 1);

		expect(outcome.kind).to.equal('accepted');
		// Inward to root, then the one outward move back to tier 1 (the redirect target).
		expect(router.probes.map((x) => x.treeTier)).to.deep.equal([1, 0, 1]);
		const coord1 = addressing.coord(1, self, TOPIC);
		expect(bytesEqual(router.probes[0]!.coord!, coord1), 'first tier-1 probe').to.be.true;
		expect(bytesEqual(router.probes[2]!.coord!, coord1), 'redirect recomputes the SAME tier-1 coord').to.be.true;
	});

	it('surfaces Promoted to the caller when followPromoted is false', async () => {
		const self = bytes('manual-driver');
		const router = new ScriptedRouter([{ v: 1, result: 'promoted', targetTier: 2 }]);
		const engine = createWalkEngine({
			router,
			addressing,
			dmax: fixedDMax(1),
			self,
			factory: factoryFor(self),
			config: { followPromoted: false },
		});
		const outcome = await engine.register(TOPIC, 1);
		expect(outcome.kind).to.equal('promoted');
		if (outcome.kind !== 'promoted') throw new Error('unreachable');
		expect(outcome.targetTier).to.equal(2);
	});

	it('UnwillingCohort backs off in time; the next register restarts at d_max, not the declined coord', async () => {
		const self = bytes('backoff-participant');
		const dMax = 2;
		// First register: no_state at d=2, then unwilling_cohort at d=1 → retry_later(5000).
		const firstRouter = new ScriptedRouter([
			noState,
			{ v: 1, result: 'unwilling_cohort', retryAfterMs: 5_000 },
		]);
		const engine1 = createWalkEngine({ router: firstRouter, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });
		const out1 = await engine1.register(TOPIC, 1);
		expect(out1.kind).to.equal('retry_later');
		if (out1.kind !== 'retry_later') throw new Error('unreachable');
		expect(out1.afterMs, 'cohort-controlled retryAfter is honored').to.equal(5_000);
		expect(firstRouter.probes.map((x) => x.treeTier)).to.deep.equal([2, 1]);

		// The caller retries after the back-off: a FRESH walk that restarts at d_max (= 2), NOT at the
		// declined coord (d = 1). Decorrelates retries across the ring (§Anti-flood claim 4).
		const secondRouter = new ScriptedRouter([accepted]);
		const engine2 = createWalkEngine({ router: secondRouter, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });
		const out2 = await engine2.register(TOPIC, 1);
		expect(out2.kind).to.equal('accepted');
		const restart = secondRouter.probes[0]!;
		expect(restart.treeTier, 'restart at d_max, not the declined tier 1').to.equal(2);
		expect(bytesEqual(restart.coord!, addressing.coord(dMax, self, TOPIC)), 'restart coord is coord_{d_max}').to.be.true;
		expect(bytesEqual(restart.coord!, firstRouter.probes[1]!.coord!), 'never re-hits the declined coord').to.be.false;
	});

	it('UnwillingMember retries a named sibling at the same coord via direct dial', async () => {
		const self = bytes('sibling-retry-participant');
		const sibling = bytes('sibling-A');
		const router = new ScriptedRouter([
			{ v: 1, result: 'unwilling_member', candidateMembers: [bytesToB64url(sibling)] },
			accepted,
		]);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(1), self, factory: factoryFor(self) });
		const outcome = await engine.register(TOPIC, 1);

		expect(outcome.kind).to.equal('accepted');
		expect(router.probes[0]!.mode).to.equal('route');
		const retry = router.probes[1]!;
		expect(retry.mode, 'sibling retry is a direct dial').to.equal('dial');
		expect(retry.treeTier, 'same coord / tier — a spatial move WITHIN the cohort').to.equal(1);
		expect(bytesEqual(retry.member!, sibling)).to.be.true;
	});

	it('treats exhausted sibling candidates as a temporal cohort decline', async () => {
		const self = bytes('exhausted-participant');
		const sib = bytesToB64url(bytes('only-sibling'));
		// Always unwilling_member; with maxMemberRetries=2 the engine gives up after 2 dials → retry_later.
		const router = new ScriptedRouter([
			{ v: 1, result: 'unwilling_member', candidateMembers: [sib] },
			{ v: 1, result: 'unwilling_member', candidateMembers: [sib] },
			{ v: 1, result: 'unwilling_member', candidateMembers: [sib] },
		]);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(1), self, factory: factoryFor(self), config: { maxMemberRetries: 2 } });
		const outcome = await engine.register(TOPIC, 1);
		expect(outcome.kind).to.equal('retry_later');
	});

	it('re-issues at the root with bootstrap:true after the root returns NoState', async () => {
		const self = bytes('bootstrap-participant');
		const dMax = 1;
		// d=1 no_state → d=0 no_state (root cold) → bootstrap re-issue at d=0 → accepted.
		const router = new ScriptedRouter([noState, noState, accepted]);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });
		const outcome = await engine.register(TOPIC, 1);

		expect(outcome.kind).to.equal('accepted');
		expect(router.probes.map((x) => x.treeTier)).to.deep.equal([1, 0, 0]);
		expect(router.probes[1]!.bootstrap, 'first root probe is a normal probe').to.be.false;
		expect(router.probes[2]!.bootstrap, 'second root probe is the bootstrap re-issue').to.be.true;
	});

	it('gives up with retry_later when even the bootstrap re-issue finds no cohort', async () => {
		const self = bytes('cold-bootstrap-participant');
		const router = new ScriptedRouter([noState, noState, noState]); // d=1, d=0, bootstrap d=0 all cold
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(1), self, factory: factoryFor(self) });
		const outcome = await engine.register(TOPIC, 1);
		expect(outcome.kind).to.equal('retry_later');
	});
});
