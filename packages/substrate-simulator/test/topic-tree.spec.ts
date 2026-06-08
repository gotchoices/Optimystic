import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import { createRng } from '../src/rng.js';
import { generatePeers } from '../src/peer.js';
import { RingModel } from '../src/ring-model.js';
import { bytesToHex } from '../src/hex.js';
import { buildCoordLadder, deriveTopicId } from '../src/topic-addressing.js';
import { CollectingEventSink } from '../src/topic-events.js';
import { TopicTree, DEFAULT_LIFECYCLE_CONFIG } from '../src/topic-tree.js';
import { classifyAdmission, makeMemberWillingness, type Tier } from '../src/willingness.js';

const SEED = 12345;

/** Independent oracle for the steady-state depth law: ⌈log_F(N / cap_promote)⌉. */
function depthLaw(n: number, F: number, capPromote: number): number {
	return Math.ceil(Math.log(n / capPromote) / Math.log(F));
}

describe('TopicTree — depth law (smoke check; full sweep in simulator-promotion-convergence)', () => {
	it('promotion-driven tree depth converges to ⌈log_F(N/cap_promote)⌉ (±1) across a couple of N', async function () {
		this.timeout(60000);
		const ring = new RingModel();
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const topicId = deriveTopicId('depth-law');
		const topicHex = bytesToHex(topicId);
		for (const N of [1024, 16000]) {
			const expected = depthLaw(N, cfg.F, cfg.capPromote);
			const dMax = expected + 2;
			const peers = generatePeers(N, createRng(SEED));
			const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
			const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000 });
			for (const peer of peers) {
				const P = await ring.coordOf(peer.key);
				const ladder = await buildCoordLadder(ring, P, topicId, dMax);
				tree.register(topicHex, ladder, 0);
			}
			const observed = tree.maxOccupiedTier(topicHex);
			expect(Math.abs(observed - expected), `N=${N}: observed depth ${observed} vs law ${expected}`)
				.to.be.at.most(1);
		}
	});
});

describe('TopicTree — demotion hysteresis', () => {
	it('never demotes while childCohortCount > 0, even below cap_demote past T_demote', () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000, sink });
		const state = tree.ensure('topic', 'cohortA', 0, 0);

		tree.promote(state, 0);
		state.childCohortCount = 1;
		tree.setParticipants(state, 10, 0); // ≤ cap_demote → lowLoadSince = 0
		tree.startGossip();

		// Run well past sticky + T_demote: still promoted because a child cohort exists.
		world.scheduler.run(cfg.tPromoteStickyMs + cfg.tDemoteMs + 5000);
		expect(state.promoted, 'held promoted while child present').to.equal(true);
		expect(sink.countOf('Demoted')).to.equal(0);

		// Drop the child; demotion becomes eligible and fires once on the next tick.
		state.childCohortCount = 0;
		world.scheduler.run(world.scheduler.now() + cfg.tDemoteMs);
		expect(state.promoted).to.equal(false);
		expect(sink.countOf('Demoted')).to.equal(1);
	});

	it('a promoted low-load cohort waits T_demote before demoting (temporal hysteresis)', () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000, sink });
		const state = tree.ensure('topic', 'cohortD', 0, 0);

		tree.promote(state, 0);
		tree.setParticipants(state, 5, 0); // lowLoadSince = 0
		tree.startGossip();

		world.scheduler.run(cfg.tDemoteMs - 2000); // just shy of the hold
		expect(state.promoted, 'not yet demoted before T_demote').to.equal(true);
		expect(sink.countOf('Demoted')).to.equal(0);

		world.scheduler.run(cfg.tDemoteMs + 2000); // past the hold
		expect(state.promoted).to.equal(false);
		expect(sink.countOf('Demoted')).to.equal(1);
	});
});

describe('TopicTree — no promotion thrash', () => {
	it('a load barometer bouncing 5↔6 does not flap promotion (cap gap + T_demote absorb it)', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000, sink });
		const state = tree.ensure('topic', 'cohortB', 2, 0); // serving at T2

		// Participants sit above cap_promote_fast (32) — so a bucket-6 reading fast-promotes once —
		// but stay 4× above cap_demote (16), so the demotion floor is never met as the bucket dips.
		tree.setParticipants(state, 33, 0);
		tree.startGossip();

		let now = 0;
		for (let i = 0; i < 20; i++) {
			now += 1000;
			tree.setLoadBucket(state, 2, i % 2 === 0 ? 6 : 5, now);
			world.scheduler.run(now);
		}

		expect(sink.countOf('Promoted'), 'promoted exactly once').to.equal(1);
		expect(sink.countOf('Demoted'), 'never demoted').to.equal(0);
		expect(state.promoted).to.equal(true);
	});
});

describe('TopicTree — topic traffic signal', () => {
	it('rolls counters into per-minute rates, lags one gossip round, and emits TopicTraffic', () => {
		const gossip = 60_000; // one-minute window → rates equal raw counts
		const cfg = { ...DEFAULT_LIFECYCLE_CONFIG, trafficWindowMs: gossip };
		const world = createSimWorld({ seed: SEED, gossipRoundMs: gossip });
		const sink = new CollectingEventSink();
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: gossip, config: cfg, sink });
		const state = tree.ensure('topic', 'cohortC', 0, 0);

		for (let i = 0; i < 30; i++) tree.attach(state, 0);
		for (let i = 0; i < 12; i++) tree.recordQuery(state);

		// Reply path reads the gossiped view, which is still zero before the round fires.
		expect(state.traffic.arrivalsPerMin).to.equal(0);

		tree.startGossip();
		world.scheduler.run(gossip);

		expect(state.traffic.arrivalsPerMin).to.equal(30);
		expect(state.traffic.queriesPerMin).to.equal(12);
		expect(state.traffic.directParticipants).to.equal(30);

		const surfaced = tree.trafficSignal(state);
		expect(surfaced.windowSeconds).to.equal(60);
		expect(surfaced.directParticipants).to.equal(30);
		expect(sink.countOf('TopicTraffic')).to.be.greaterThan(0);

		// The reply surface reads the gossiped snapshot, never live counters: a mid-round arrival
		// is invisible to trafficSignal until the next gossip round publishes it (one-round lag on
		// the stock count, not just the rate fields).
		tree.attach(state, gossip);
		expect(state.directParticipants, 'live count moves immediately').to.equal(31);
		expect(tree.trafficSignal(state).directParticipants, 'reply still lags one round').to.equal(30);
		world.scheduler.run(gossip * 2);
		expect(tree.trafficSignal(state).directParticipants, 'next round publishes the new stock').to.equal(31);
	});
});

describe('TopicTree — metrics-stream event wiring', () => {
	it('routes NoState / UnwillingMember / UnwillingCohort through the sink', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000, sink });

		tree.recordNoState('topic', 3, 5);

		// Routed member sheds T2, a sibling serves → UnwillingMember.
		const members = [makeMemberWillingness('core'), makeMemberWillingness('core')];
		members[0]!.loadBucket[2] = 6;
		tree.recordAdmission('topic', 2, classifyAdmission(members, 2 as Tier, 0, 1), 6);

		// No core member serves T2 below quorum → UnwillingCohort.
		const edges = [makeMemberWillingness('edge'), makeMemberWillingness('edge')];
		tree.recordAdmission('topic', 2, classifyAdmission(edges, 2 as Tier, 0, 1), 7);

		expect(sink.countOf('NoState')).to.equal(1);
		expect(sink.countOf('UnwillingMember')).to.equal(1);
		expect(sink.countOf('UnwillingCohort')).to.equal(1);
	});
});
