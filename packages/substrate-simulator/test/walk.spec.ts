import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import { createRng } from '../src/rng.js';
import { generatePeers } from '../src/peer.js';
import { RingModel, type RingCoord } from '../src/ring-model.js';
import { bytesToHex } from '../src/hex.js';
import { buildCoordLadder, deriveTopicId } from '../src/topic-addressing.js';
import { computeDMax, DEFAULT_DMAX_CONFIG } from '../src/size-model.js';
import { CollectingEventSink } from '../src/topic-events.js';
import { TopicTree, DEFAULT_LIFECYCLE_CONFIG } from '../src/topic-tree.js';
import type { PeerRef } from '../src/types.js';
import { ParticipantWalk, rateLimitedStagger, type WalkAdmission, type WalkTrace } from '../src/walk.js';
import {
	distinctStartCoords,
	peakAcceptedPerSecond,
	peakAcceptedInWindow,
	acceptedAtTier,
	hopPercentile,
	outwardMovesArePromoted,
	unwillingRetriesRestartAtDMax
} from '../src/walk-metrics.js';

const SEED = 90909;
const T_REJOIN_JITTER = 30_000;

/** A throwaway peer whose id labels the walk; the latency model ignores its key. */
function peer(i: number): PeerRef {
	return { id: `p${i}`, key: new Uint8Array(32) };
}

/**
 * A synthetic coord ladder with one byte-crafted coord per tier — fast (no sha256), and lets a test
 * control exactly which tiers participants share. `prefixes[d]` selects the tier-`d` cohort; the
 * tier byte keeps coords distinct across tiers even when the prefix repeats.
 */
function ladderOf(prefixes: number[], marker: number): RingCoord[] {
	return prefixes.map((prefix, tier) => {
		const c = new Uint8Array(32);
		c[0] = tier;
		c[1] = marker;
		c[2] = prefix & 0xff;
		c[3] = (prefix >>> 8) & 0xff;
		return c;
	});
}

/** Run all `walks` to completion, collecting their traces in completion order. */
function collect(walks: ParticipantWalk[]): WalkTrace[] {
	return walks.map((w) => w.trace());
}

describe('ParticipantWalk — claim 1: cold-start storm avoidance (sparse fan-out)', () => {
	it('walks start at distinct coord_{d_max} and fan across the ring, all landing at the root', async function () {
		this.timeout(20000);
		// Large d_max (network is big) but a *sparse* topic (N ≪ cap_promote): each participant's
		// coord_{d_max} differs by peer-ID prefix, so walks fan across the ring instead of colliding.
		const ring = new RingModel();
		const N = 40; // < cap_promote (64): the topic stays at the root, no promotion
		const dMax = 4; // 16-bit prefix space → distinct starts almost surely
		const peers = generatePeers(N, createRng(SEED));
		const topicId = deriveTopicId('sparse');
		const topicHex = bytesToHex(topicId);
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000 });

		const walks: ParticipantWalk[] = [];
		for (const p of peers) {
			const P = await ring.coordOf(p.key);
			const ladder = await buildCoordLadder(ring, P, topicId, dMax);
			const w = new ParticipantWalk({ scheduler: world.scheduler, tree, participant: p, topicId: topicHex, ladder });
			walks.push(w);
			w.start();
		}
		world.scheduler.run();

		const traces = collect(walks);
		// Distinct starts ≈ participant count (the fan-out): walks do not all begin at one coord.
		expect(distinctStartCoords(traces)).to.be.at.least(Math.ceil(0.95 * N));
		// Sparse regime: every walk drains to the root and attaches there.
		expect(traces.every((t) => t.landingTier === 0)).to.equal(true);
		expect(traces.every((t) => t.outcome === 'accepted' || t.outcome === 'cold-root')).to.equal(true);
		// Exactly one walk cold-bootstraps the root; the rest find it already instantiated.
		expect(traces.filter((t) => t.outcome === 'cold-root')).to.have.lengthOf(1);
	});
});

describe('ParticipantWalk — hop count O(log N)', () => {
	it('hot regime resolves in 1 RPC (p50 = 1, p95 ≤ 2) without touching the root, across N', () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		for (const N of [100, 1000]) {
			const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
			const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000 });
			const topicHex = 'hot';
			// Hot steady state: each participant's d_max cohort already exists (its prefix tier is
			// instantiated). The first probe at d_max hits it and registration succeeds in one RPC.
			const walks: ParticipantWalk[] = [];
			for (let i = 0; i < N; i++) {
				const ladder = ladderOf([0, i], 0x10);
				tree.ensure(topicHex, bytesToHex(ladder[1]!), 1, 0); // pre-seed the d_max cohort
				const w = new ParticipantWalk({ scheduler: world.scheduler, tree, participant: peer(i), topicId: topicHex, ladder });
				walks.push(w);
				w.start();
			}
			world.scheduler.run();
			const traces = collect(walks);
			expect(hopPercentile(traces, 50), `N=${N} p50`).to.equal(1);
			expect(hopPercentile(traces, 95), `N=${N} p95`).to.be.at.most(2);
			expect(traces.every((t) => t.landingTier === 1), `N=${N} landed at d_max`).to.equal(true);
			void cfg;
		}
	});

	it('cold worst-case hop count is d_max + 2 and d_max grows as ⌊log_F N⌋ − 1 (O(log_F N))', () => {
		const cfg = DEFAULT_DMAX_CONFIG; // F = 16
		const Ns = [100, 1000, 10000, 100000];
		const hopsByN: number[] = [];
		const dMaxByN: number[] = [];
		for (const N of Ns) {
			const dMax = computeDMax(N, 1.0, cfg);
			dMaxByN.push(dMax);
			const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
			const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000 });
			const ladder = ladderOf(new Array(dMax + 1).fill(0), 0x20);
			const w = new ParticipantWalk({ scheduler: world.scheduler, tree, participant: peer(0), topicId: `cold${N}`, ladder });
			w.start();
			world.scheduler.run();
			const t = w.trace();
			// Cold topic: probe every tier inward (d_max+1 NoState), then bootstrap the root (+1).
			expect(t.hops, `N=${N} cold hops`).to.equal(dMax + 2);
			expect(t.outcome).to.equal('cold-root');
			hopsByN.push(t.hops);
		}
		// d_max — and therefore worst-case hops — grows logarithmically: ⌊log_16 N⌋ − 1 over the sweep.
		expect(dMaxByN).to.deep.equal([0, 1, 2, 3]);
		expect(hopsByN).to.deep.equal([2, 3, 4, 5]);
		// A 1000× growth in N adds only 3 hops — the defining O(log N) shape.
		expect(hopsByN[hopsByN.length - 1]! - hopsByN[0]!).to.equal(dMaxByN[dMaxByN.length - 1]! - dMaxByN[0]!);
	});
});

describe('ParticipantWalk — claim 2: re-registration storm bound (jitter spreading)', () => {
	function runBurst(offsets: number[], M: number): WalkTrace[] {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		// Disable promotion on this tree (huge cap_promote — also disables slope pre-promotion) so we
		// measure the *pure* inbound rate the jitter shapes; the complementary promote valve is claim 5.
		const tree = new TopicTree({
			scheduler: world.scheduler,
			gossipRoundMs: 1000,
			config: { ...DEFAULT_LIFECYCLE_CONFIG, capPromote: 1_000_000, capPromoteFast: 1_000_000 }
		});
		const topicHex = 'rejoin';
		// One replacement cohort absorbs all M re-registrations (shared d_max coord), pre-seeded so
		// each walk resolves in one hop.
		const sharedLadder = ladderOf([0, 0], 0x30);
		tree.ensure(topicHex, bytesToHex(sharedLadder[1]!), 1, 0);
		const walks: ParticipantWalk[] = [];
		for (let i = 0; i < M; i++) {
			const w = new ParticipantWalk({ scheduler: world.scheduler, tree, participant: peer(i), topicId: topicHex, ladder: sharedLadder });
			walks.push(w);
			world.scheduler.scheduleAt(offsets[i]!, () => w.start());
		}
		world.scheduler.run();
		return collect(walks);
	}

	it('jitter caps the inbound rate at cap_promote / T_rejoin_jitter; an unstaggered burst spikes', () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const M = 60; // < cap_promote (64): no promotion confounds the measurement
		const windowSec = T_REJOIN_JITTER / 1000;
		const ratePerSecBound = Math.ceil(cfg.capPromote / windowSec); // ⌈64/30⌉ = 3

		// Spread M re-registrations over T_rejoin_jitter at rate cap_promote/window.
		const jittered = runBurst(rateLimitedStagger(M, cfg.capPromote, T_REJOIN_JITTER), M);
		expect(peakAcceptedPerSecond(jittered), 'jittered peak/sec within bound').to.be.at.most(ratePerSecBound);
		// Inbound over any T_rejoin_jitter window stays within one cohort's promote budget.
		expect(peakAcceptedInWindow(jittered, T_REJOIN_JITTER), 'inbound per window ≤ cap_promote').to.be.at.most(cfg.capPromote);
		expect(jittered.every((t) => t.outcome === 'accepted')).to.equal(true);

		// Contrast: with no jitter every participant lands in the same second — the storm jitter prevents.
		const unstaggered = runBurst(new Array(M).fill(0), M);
		expect(peakAcceptedPerSecond(unstaggered), 'unstaggered spikes the whole burst into one second').to.equal(M);
		expect(peakAcceptedPerSecond(unstaggered)).to.be.greaterThan(ratePerSecBound);
	});
});

describe('ParticipantWalk — claim 5: promotion-flap prevention (promotion cap under burst)', () => {
	it('a bursting cohort accepts at most cap_promote, promotes, and bounces the rest with Promoted', () => {
		const cfg = DEFAULT_LIFECYCLE_CONFIG;
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000, sink });
		const topicHex = 'burst';
		const M = 200; // ≫ cap_promote
		// Shared root coord, distinct tier-1 coord per participant → the root absorbs the burst, then
		// promotes and forwards the overflow to F-sharded tier-1 leaves (each well under cap_promote).
		tree.ensure(topicHex, bytesToHex(ladderOf([0, 0], 0x40)[0]!), 0, 0); // pre-seed root (no bootstrap storm)
		const walks: ParticipantWalk[] = [];
		for (let i = 0; i < M; i++) {
			const ladder = ladderOf([0, i], 0x40);
			const w = new ParticipantWalk({ scheduler: world.scheduler, tree, participant: peer(i), topicId: topicHex, ladder, sink });
			walks.push(w);
			w.start();
		}
		world.scheduler.run();

		const traces = collect(walks);
		const root = tree.get(topicHex, bytesToHex(ladderOf([0, 0], 0x40)[0]!))!;
		// The bursting cohort accepts exactly cap_promote, then promotes (sticky → never flaps back).
		expect(acceptedAtTier(traces, 0), 'root accepts capped at cap_promote').to.equal(cfg.capPromote);
		expect(root.promoted, 'root promoted under the burst').to.equal(true);
		// The overflow is bounced outward (cheap single-RPC Promoted) and lands at tier-1 leaves.
		expect(acceptedAtTier(traces, 1)).to.equal(M - cfg.capPromote);
		expect(traces.filter((t) => t.redirects === 1)).to.have.lengthOf(M - cfg.capPromote);
		// No participant is starved — everyone attaches somewhere.
		expect(traces.every((t) => t.outcome === 'accepted' || t.outcome === 'cold-root')).to.equal(true);
		expect(sink.countOf('Admitted')).to.equal(M);
	});
});

describe('ParticipantWalk — claim 3: no speculative outward probe', () => {
	it('every outward move is preceded by a Promoted reply; the walk never probes deeper on a guess', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000 });
		const topicHex = 'outward';
		const ladder = ladderOf([0, 0, 0], 0x50); // d_max = 2
		// Root is promoted; tiers 1 and 2 are cold. The walk must reach the root inward, then follow
		// the single Promoted redirect outward to instantiate tier 1.
		const root = tree.ensure(topicHex, bytesToHex(ladder[0]!), 0, 0);
		tree.promote(root, 0);

		const w = new ParticipantWalk({ scheduler: world.scheduler, tree, participant: peer(0), topicId: topicHex, ladder });
		w.start();
		world.scheduler.run();
		const t = w.trace();

		expect(outwardMovesArePromoted(t), 'outward moves only follow Promoted').to.equal(true);
		expect(t.redirects, 'exactly one outward redirect').to.equal(1);
		expect(t.landingTier, 'landed at the redirected tier').to.equal(1);
		// Never probed beyond d_max speculatively.
		expect(Math.max(...t.probes.map((p) => p.tier))).to.be.at.most(t.startTier);
		// The probe chain is exactly inward-to-root then one outward step.
		expect(t.probes.map((p) => p.tier)).to.deep.equal([2, 1, 0, 1]);
		expect(t.probes.map((p) => p.reply)).to.deep.equal(['no_state', 'no_state', 'promoted', 'accepted']);
	});
});

describe('ParticipantWalk — claim 4: inward retry restarts at d_max', () => {
	it('a post-UnwillingCohort retry restarts at d_max, never re-hitting the declined coord', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000 });
		const topicHex = 'inward-retry';
		const ladder = ladderOf([0, 0, 0], 0x60); // d_max = 2
		tree.ensure(topicHex, bytesToHex(ladder[0]!), 0, 0); // root holds state (not promoted)

		// The root declines once (UnwillingCohort), then admits on the retry.
		let rootProbes = 0;
		const admission: WalkAdmission = (_state, p) => {
			if (p.tier === 0 && ++rootProbes === 1) {
				return { result: 'unwilling_cohort' };
			}
			return { result: 'accepted' };
		};

		const w = new ParticipantWalk({ scheduler: world.scheduler, tree, participant: peer(0), topicId: topicHex, ladder, admission });
		w.start();
		world.scheduler.run();
		const t = w.trace();

		expect(unwillingRetriesRestartAtDMax(t), 'retry restarts at d_max').to.equal(true);
		expect(t.backoffs, 'exactly one back-off').to.equal(1);
		expect(t.outcome).to.equal('accepted');
		expect(t.landingTier).to.equal(0);
		// The probe after the decline restarts at d_max (2), not the declined root coord.
		const declineIdx = t.probes.findIndex((p) => p.reply === 'unwilling_cohort');
		expect(t.probes[declineIdx + 1]!.tier).to.equal(t.startTier);
		expect(t.probes.map((p) => p.tier)).to.deep.equal([2, 1, 0, 2, 1, 0]);
	});
});

describe('ParticipantWalk — determinism', () => {
	it('a burst replays byte-identically from (seed, config)', () => {
		function run(): string {
			const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
			const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000 });
			const topicHex = 'determinism';
			tree.ensure(topicHex, bytesToHex(ladderOf([0, 0], 0x70)[0]!), 0, 0);
			const walks: ParticipantWalk[] = [];
			for (let i = 0; i < 50; i++) {
				const w = new ParticipantWalk({ scheduler: world.scheduler, tree, participant: peer(i), topicId: topicHex, ladder: ladderOf([0, i], 0x70) });
				walks.push(w);
				w.start();
			}
			world.scheduler.run();
			return collect(walks)
				.map((t) => `${t.participantId}:${t.hops}:${t.latency}:${t.landingTier}:${t.outcome}:${t.redirects}:${t.backoffs}`)
				.join('|');
		}
		expect(run()).to.equal(run());
	});
});
