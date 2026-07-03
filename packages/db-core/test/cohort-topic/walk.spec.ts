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
	readonly followOn: boolean;
	readonly probe: boolean;
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
		this.probes.push({ mode: 'route', coord: key, treeTier: reg.treeTier, bootstrap: reg.bootstrap === true, followOn: reg.followOn === true, probe: reg.probe === true });
		return encodeCohortMessage(this.next());
	}

	async dialMember(member: PeerRef, activity: Uint8Array): Promise<Uint8Array> {
		const reg = decodeRegisterV1(activity);
		this.probes.push({ mode: 'dial', member: member.id, treeTier: reg.treeTier, bootstrap: reg.bootstrap === true, followOn: reg.followOn === true, probe: reg.probe === true });
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
		build: async ({ topicId, tier, treeTier, bootstrap, followOn, probe, appPayload }) => ({
			v: 1,
			topicId: bytesToB64url(topicId),
			tier,
			treeTier,
			participantCoord: bytesToB64url(self),
			ttl: 90_000,
			...(bootstrap ? { bootstrap: true } : {}),
			...(followOn ? { followOn: true } : {}),
			...(probe ? { probe: true } : {}),
			...(appPayload ? { appPayload: bytesToB64url(appPayload) } : {}),
			timestamp: 1_000,
			correlationId: bytesToB64url(bytes('corr')),
			signature: bytesToB64url(bytes('sig', 8)),
		}),
	};
}

const accepted: RegisterReplyV1 = { v: 1, result: 'accepted', primary: bytesToB64url(bytes('primary')), cohortEpoch: bytesToB64url(bytes('epoch', 32)) };
const noState: RegisterReplyV1 = { v: 1, result: 'no_state' };

/**
 * A coord-addressed router modeling a **single tier-0 cohort that has promoted but is childless, and
 * whose cold child refuses to instantiate**: the one promoted coord answers `Promoted(1)`; every other
 * coord (including the recomputed `coord_1`) answers `NoState` regardless of `followOn` — i.e. the cold
 * child's quorum is unwilling. The register walk therefore follows the redirect, re-issues once with
 * `followOn: true`, gets `NoState` again, and backs off (rather than oscillating); a probe backs off
 * immediately. This is the one-cohort tree the walk's termination discipline must bound.
 */
class SingleCohortRouter implements ITopicRouter {
	readonly probes: Probe[] = [];

	constructor(private readonly promotedCoord: RingCoord) {}

	async routeAndAct(key: RingCoord, activity: Uint8Array): Promise<Uint8Array> {
		const reg = decodeRegisterV1(activity);
		this.probes.push({ mode: 'route', coord: key, treeTier: reg.treeTier, bootstrap: reg.bootstrap === true, followOn: reg.followOn === true, probe: reg.probe === true });
		const reply: RegisterReplyV1 = bytesEqual(key, this.promotedCoord) ? { v: 1, result: 'promoted', targetTier: 1 } : noState;
		return encodeCohortMessage(reply);
	}

	async dialMember(member: PeerRef, activity: Uint8Array): Promise<Uint8Array> {
		const reg = decodeRegisterV1(activity);
		this.probes.push({ mode: 'dial', member: member.id, treeTier: reg.treeTier, bootstrap: reg.bootstrap === true, followOn: reg.followOn === true, probe: reg.probe === true });
		return encodeCohortMessage(noState);
	}
}

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

	it('a probe of a cold topic backs off at the root and NEVER emits a bootstrap:true frame', async () => {
		const self = bytes('probe-cold-participant');
		const dMax = 1;
		// d=1 no_state → d=0 (root) no_state → a probe backs off (a register would re-issue bootstrap here).
		// Only two probes are consumed: the bootstrap re-issue is suppressed, so two replies suffice.
		const router = new ScriptedRouter([noState, noState]);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });

		const outcome = await engine.register(TOPIC, 1, undefined, { probe: true });
		expect(outcome.kind, 'a cold probe resolves to a temporal back-off, never a cold-root instantiation').to.equal('retry_later');
		expect(router.probes.map((x) => x.treeTier), 'walks inward to the root then stops — no bootstrap re-issue').to.deep.equal([1, 0]);
		expect(router.probes.every((p) => p.probe), 'every emitted frame carries probe:true').to.equal(true);
		expect(router.probes.some((p) => p.bootstrap), 'a probe never emits a bootstrap:true frame').to.equal(false);
	});

	it('the non-probe walk still re-issues bootstrap:true at the root (probe-flag does not change the register path)', async () => {
		const self = bytes('non-probe-bootstrap-participant');
		const router = new ScriptedRouter([noState, noState, accepted]); // d=1, root no_state, bootstrap re-issue accepted
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(1), self, factory: factoryFor(self) });

		const outcome = await engine.register(TOPIC, 1); // no probe opts
		expect(outcome.kind).to.equal('accepted');
		expect(router.probes.map((x) => x.treeTier)).to.deep.equal([1, 0, 0]);
		expect(router.probes[2]!.bootstrap, 'the register path re-issues bootstrap at the root').to.equal(true);
		expect(router.probes.some((p) => p.probe), 'no probe frame on the register path').to.equal(false);
	});

	it('maxSteps terminates a malformed tree that alternates NoState/Promoted at the same tier', async () => {
		// Adversarial (ticket-named): a tree that bounces a walk between an inward NoState step and an
		// outward Promoted redirect at the same tier would otherwise spin forever. The safety valve must
		// cap the probe count and surface a temporal back-off rather than loop or run the router dry.
		const self = bytes('oscillating-participant');
		const promoted1: RegisterReplyV1 = { v: 1, result: 'promoted', targetTier: 1 };
		// d=1 → no_state (→d=0); d=0 → promoted(1) (→d=1); repeat. With maxSteps=5 the engine probes 5
		// times then backs off on the 6th iteration (no reply consumed), so 5 scripted replies suffice.
		const router = new ScriptedRouter([noState, promoted1, noState, promoted1, noState]);
		const engine = createWalkEngine({
			router,
			addressing,
			dmax: fixedDMax(1),
			self,
			factory: factoryFor(self),
			config: { maxSteps: 5 },
		});
		const outcome = await engine.register(TOPIC, 1);
		expect(outcome.kind, 'pathological oscillation backs off, never loops').to.equal('retry_later');
		expect(router.probes.length, 'capped at exactly maxSteps probes').to.equal(5);
	});

	it('single tier-0 cohort, promoted but childless with an unwilling cold child: re-issues followOn once then backs off (no oscillation)', async () => {
		// The tier-0 cohort has promoted; a new registration gets Promoted(1) and recomputes coord_1, which
		// is cold. The register path re-issues ONCE at coord_1 with followOn:true (the deeper-tier cold-start
		// request). Here the cold child's quorum is unwilling (the router keeps answering NoState), so the
		// walk backs off in time — it does NOT step back inward to the promoting root and oscillate. The
		// follow-on re-issue happens exactly once (bounded by the followOnReissued latch), well within maxSteps.
		const self = bytes('single-cohort-participant');
		const dMax = 0; // a one-cohort network: d_max collapses to the root
		const promotedCoord = addressing.coord(0, self, TOPIC); // coord_0(topic), peer-independent
		const maxSteps = 6;
		const router = new SingleCohortRouter(promotedCoord);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self), config: { maxSteps } });

		const outcome = await engine.register(TOPIC, 0);
		expect(outcome.kind, 'unwilling cold child → bounded back-off, never an infinite loop').to.equal('retry_later');
		// Exactly three probes: coord_0 (Promoted), coord_1 plain (NoState), coord_1 followOn (NoState).
		expect(router.probes.map((p) => p.treeTier), 'follows the redirect then re-issues at the child — no inward oscillation').to.deep.equal([0, 1, 1]);
		expect(router.probes.length, 'terminates well within maxSteps, not by exhausting it').to.be.lessThan(maxSteps);
		expect(router.probes.filter((p) => p.followOn).length, 'exactly one follow-on re-issue').to.equal(1);
		const followOnProbe = router.probes.find((p) => p.followOn)!;
		expect(followOnProbe.treeTier, 'the follow-on re-issue is at the child tier (>= 1)').to.equal(1);
		expect(bytesEqual(router.probes[0]!.coord!, promotedCoord), 'the first probe lands on coord_0(topic)').to.be.true;
	});

	it('promoted parent + willing cold child: the register re-issues followOn once and the child instantiates → accepted', async () => {
		// The positive counterpart: the cold tier-1 child DOES instantiate on the follow-on. The walk follows
		// Promoted(1), re-registers the child plain (NoState — the cold child served nothing to the first
		// frame), then re-issues once with followOn:true, and the now-instantiated child answers accepted.
		const self = bytes('followon-happy-participant');
		const dMax = 0;
		// d=0 → Promoted(1); coord_1 plain → NoState; coord_1 followOn → accepted (child cold-started).
		const router = new ScriptedRouter([{ v: 1, result: 'promoted', targetTier: 1 }, noState, accepted]);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });

		const outcome = await engine.register(TOPIC, 0);
		expect(outcome.kind, 'the willing cold child instantiates via the follow-on path').to.equal('accepted');
		expect(router.probes.map((p) => p.treeTier), 'follow redirect (0), plain child (1), follow-on child (1) — no inward step').to.deep.equal([0, 1, 1]);
		expect(router.probes.filter((p) => p.followOn).length, 'exactly one follow-on re-issue, not a flood').to.equal(1);
		expect(router.probes[1]!.followOn, 'the FIRST child register is plain (no follow-on yet)').to.equal(false);
		expect(router.probes[2]!.followOn, 'the re-issue after the child NoState carries followOn').to.equal(true);
		expect(router.probes.some((p) => p.bootstrap), 'a follow-on cold-start never sets bootstrap').to.equal(false);
	});

	it('bounds an out-of-range promoted targetTier: 2.5 / -1 / 300 back off, never crash with a RangeError', async () => {
		// A malicious cohort replies `promoted` naming a targetTier that is a non-integer, negative, or above
		// the substrate walk-depth ceiling (DEFAULT_D_MAX_CAP = 60). Left unchecked it reaches
		// addressing.coord() → coordD, which throws a raw RangeError out of register()/lookup(). The walk must
		// instead surface a clean retry_later. Cover BOTH followPromoted modes (the self-driven caller surface
		// and the internal follow) since the guard sits before both adoption sites.
		const self = bytes('bad-target-participant');
		for (const followPromoted of [true, false]) {
			for (const targetTier of [2.5, -1, 300]) {
				const router = new ScriptedRouter([{ v: 1, result: 'promoted', targetTier }]);
				const engine = createWalkEngine({
					router, addressing, dmax: fixedDMax(1), self, factory: factoryFor(self),
					config: { followPromoted },
				});
				const outcome = await engine.register(TOPIC, 1);
				expect(outcome.kind, `targetTier=${targetTier} followPromoted=${followPromoted} → retry_later`).to.equal('retry_later');
			}
		}
	});

	it('defaults a Promoted redirect with no explicit targetTier to d+1', async () => {
		const self = bytes('default-target-participant');
		// d=1 → promoted (NO targetTier) → engine moves outward to d+1 = 2 → accepted.
		const router = new ScriptedRouter([{ v: 1, result: 'promoted' }, accepted]);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(1), self, factory: factoryFor(self) });
		const outcome = await engine.register(TOPIC, 1);
		expect(outcome.kind).to.equal('accepted');
		expect(router.probes.map((x) => x.treeTier), 'redirect with no targetTier defaults to d+1').to.deep.equal([1, 2]);
		expect(bytesEqual(router.probes[1]!.coord!, addressing.coord(2, self, TOPIC)), 'recomputes coord at tier d+1').to.be.true;
	});

	it('probe: livelock bound — promoted-but-cold child resolves to retry_later in ≤ d_max+3 RPCs', async () => {
		// Repro of the walk-layer livelock: a busy-but-unsharded topic where tier 0 answers Promoted(1)
		// and tier 1 (the cold child) answers no_state. Without the fix this oscillates for 36 RPCs
		// (maxSteps); with the fix it terminates after exactly d_max+2 = 6 RPCs.
		const self = bytes('probe-livelock-participant');
		const dMax = 4;
		const promotedCoord = addressing.coord(0, self, TOPIC); // coord_0 is peer-independent
		// Router: tier 0 always Promoted(1); everything else no_state.
		const router = new SingleCohortRouter(promotedCoord);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });

		const outcome = await engine.register(TOPIC, 1, undefined, { probe: true });
		expect(outcome.kind, 'probe of promoted-but-cold topic resolves to retry_later').to.equal('retry_later');
		// d_max + 2: inward 4→3→2→1→0 (5 RPCs) + one Promoted follow (RPC 6) + immediate exit = 6 total.
		expect(router.probes.length, 'terminates well within d_max+3').to.be.lessThanOrEqual(dMax + 3);
		expect(router.probes.some((p) => p.followOn), 'a probe never instantiates, so never emits a followOn frame').to.equal(false);
	});

	it('probe: happy path — probe accepted after following a Promoted redirect to a live child', async () => {
		// Guard against over-eager short-circuiting: a probe that walks inward through no_state, follows
		// one Promoted outward, and gets accepted at the target tier still returns accepted.
		const self = bytes('probe-happy-participant');
		const dMax = 2;
		// d=2 no_state → d=1 no_state → d=0 Promoted(1) → d=1 accepted.
		const router = new ScriptedRouter([noState, noState, { v: 1, result: 'promoted', targetTier: 1 }, accepted]);
		const engine = createWalkEngine({ router, addressing, dmax: fixedDMax(dMax), self, factory: factoryFor(self) });

		const outcome = await engine.register(TOPIC, 1, undefined, { probe: true });
		expect(outcome.kind, 'probe resolves to accepted when the promoted child is live').to.equal('accepted');
		expect(router.probes.map((x) => x.treeTier), 'walks inward then follows redirect outward').to.deep.equal([2, 1, 0, 1]);
		expect(router.probes.every((p) => p.probe), 'all frames carry probe:true').to.equal(true);
	});
});
