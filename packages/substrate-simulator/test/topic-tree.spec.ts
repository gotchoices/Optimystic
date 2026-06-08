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

describe('TopicTree — demotion cascade collapses a deep tree to the root', () => {
	const COLLAPSE_TOPIC = 'collapse-topic';

	/**
	 * A synthetic single-branch coord ladder of length `depth+1` — every participant shares it, so
	 * load builds one linear chain tier-0 → tier-`depth`. Crafted bytes (not sha256) keep the test
	 * fast and the structure exact, which is all the cascade logic needs.
	 */
	function sharedLadder(depth: number): Uint8Array[] {
		const ladder: Uint8Array[] = [];
		for (let d = 0; d <= depth; d++) {
			const coord = new Uint8Array(32);
			coord[0] = d; // distinct coord per tier
			coord[1] = 0xab; // shared branch marker
			ladder.push(coord);
		}
		return ladder;
	}

	/** Register `count` participants down one shared branch; returns the built tree. */
	function buildChain(tree: TopicTree, depth: number, count: number, now: number): void {
		const ladder = sharedLadder(depth);
		for (let i = 0; i < count; i++) {
			tree.register(COLLAPSE_TOPIC, ladder, now);
		}
	}

	it('a tree grown by load collapses to the root once load drains, childCohortCount → 0 everywhere', () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000, sink });

		// Fill three tiers (cap_promote each) plus a partial leaf → a depth-3 linear chain.
		const depth = 3;
		buildChain(tree, depth, cfg.capPromote * depth + 10, 0);

		expect(tree.maxOccupiedTier(COLLAPSE_TOPIC)).to.equal(depth);
		const built = tree.all();
		expect(built).to.have.lengthOf(depth + 1);
		// Each internal tier pins exactly one child; the leaf pins none.
		for (const s of built) {
			expect(s.childCohortCount, `tier ${s.tier} child count`).to.equal(s.tier < depth ? 1 : 0);
		}
		const originalChildCounts = built.map((s) => s.childCohortCount);

		// Drain every cohort to empty (TTL eviction → directParticipants → 0).
		for (const s of tree.all()) {
			tree.setParticipants(s, 0, 0);
		}
		tree.startGossip();

		// Past the sticky floor + T_demote, the cascade fires bottom-up: each released child frees
		// its parent on the next tick, rolling all the way to the root.
		world.scheduler.run(cfg.tPromoteStickyMs + cfg.tDemoteMs + depth * 2000);

		for (const s of tree.all()) {
			expect(s.promoted, `tier ${s.tier} demoted`).to.equal(false);
			expect(s.childCohortCount, `tier ${s.tier} child count cleared`).to.equal(0);
			expect(s.linkedToParent, `tier ${s.tier} unlinked`).to.equal(false);
		}
		expect(tree.maxOccupiedTier(COLLAPSE_TOPIC)).to.equal(0);
		// One Demoted (forwarder-state release) per cohort in the chain, root included.
		expect(sink.countOf('Demoted')).to.equal(depth + 1);

		// Re-growth re-links symmetrically: rebuilding the same load restores every child count.
		buildChain(tree, depth, cfg.capPromote * depth + 10, world.scheduler.now());
		expect(tree.maxOccupiedTier(COLLAPSE_TOPIC)).to.equal(depth);
		expect(tree.all().map((s) => s.childCohortCount)).to.deep.equal(originalChildCounts);
	});
});

describe('TopicTree — demotion cascade collapses a fan-out (multi-child) parent', () => {
	const FANOUT_TOPIC = 'fanout-topic';

	/**
	 * A two-tier ladder whose root coord is identical across branches but whose tier-1 coord differs
	 * per `branch` — so a promoted root forwards every branch's load to a *distinct* tier-1 child.
	 * The single-branch collapse test exercises a linear chain (one child per tier); this exercises
	 * the orthogonal case the unlink logic must also satisfy: one parent counting several children,
	 * each of which must release before the parent can.
	 */
	function branchLadder(branch: number): Uint8Array[] {
		const root = new Uint8Array(32);
		root[0] = 0;
		root[1] = 0xcd; // shared root marker — same coord for every branch
		const child = new Uint8Array(32);
		child[0] = 1;
		child[1] = 0xcd;
		child[2] = branch; // tier-1 coord diverges per branch
		return [root, child];
	}

	it('a parent pinned by N sibling children only demotes once every child has released', () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000, sink });

		// Promote the root (cap_promote participants all land at tier 0), then grow `branches`
		// sibling tier-1 leaves under it — each a forwarder linked into the root's child count.
		const branches = 3;
		for (let i = 0; i < cfg.capPromote; i++) {
			tree.register(FANOUT_TOPIC, branchLadder(0), 0);
		}
		for (let b = 0; b < branches; b++) {
			for (let i = 0; i < 5; i++) {
				tree.register(FANOUT_TOPIC, branchLadder(b), 0);
			}
		}

		const root = tree.get(FANOUT_TOPIC, bytesToHex(branchLadder(0)[0]!))!;
		expect(root, 'root cohort exists').to.not.equal(undefined);
		expect(root.promoted, 'root promoted').to.equal(true);
		expect(root.childCohortCount, 'root pins all branches').to.equal(branches);
		expect(tree.all(), 'root + one leaf per branch').to.have.lengthOf(branches + 1);
		// Every tier-1 child is an unpromoted-but-linked forwarder (a leaf, below cap_promote).
		for (const s of tree.all()) {
			if (s.tier === 1) {
				expect(s.promoted, 'leaf unpromoted').to.equal(false);
				expect(s.linkedToParent, 'leaf linked').to.equal(true);
			}
		}

		// Drain everything; the children release on the first eligible tick (decrementing the root
		// to zero across one tick), and only then — the following tick — does the root demote.
		for (const s of tree.all()) {
			tree.setParticipants(s, 0, 0);
		}
		tree.startGossip();
		world.scheduler.run(cfg.tPromoteStickyMs + cfg.tDemoteMs + 4000);

		expect(root.promoted, 'root demoted after all children released').to.equal(false);
		expect(root.childCohortCount, 'root child count cleared').to.equal(0);
		for (const s of tree.all()) {
			expect(s.linkedToParent, `tier ${s.tier} unlinked`).to.equal(false);
		}
		// One Demoted per cohort: every branch leaf plus the root.
		expect(sink.countOf('Demoted')).to.equal(branches + 1);
		expect(tree.maxOccupiedTier(FANOUT_TOPIC)).to.equal(0);
	});
});
