import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import { bytesToHex } from '../src/hex.js';
import type { RingCoord } from '../src/ring-model.js';
import type { PeerRef } from '../src/types.js';
import { TopicTree } from '../src/topic-tree.js';
import type { SimProvider, CapabilityFilter } from '../src/matchmaking.js';
import {
	SeekerWalk,
	TierProviderModel,
	type TierProviderConfig,
	type SeekerTrace,
	type TrafficReporter
} from '../src/seeker-walk.js';
import { measureRefinementSignal, seekerPoolContentionWouldFlip } from '../src/refinement-signal.js';

const SEED = 90909;
const PDF: CapabilityFilter = { must: ['pdf'] };

function peer(i: number): PeerRef {
	return { id: `s${i}`, key: new Uint8Array(32) };
}

/** A synthetic coord ladder, one byte-crafted coord per tier (mirrors walk.spec). */
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

function providers(n: number, caps: string[], from = 0): SimProvider[] {
	return Array.from({ length: n }, (_v, i) => ({ id: `p${from + i}`, capabilities: caps, capacityBudget: 1, attachedAt: 0 }));
}

/**
 * Build a seeker walk landing at `startTier`: pre-seed the tier-`startTier` cohort so the inherited
 * `ParticipantWalk` accepts there on the first probe (`d_max = startTier`). Returns the completed
 * trace after draining the scheduler.
 */
function runSeeker(opts: {
	startTier: number;
	marker: number;
	model: TierProviderModel;
	wantCount: number;
	patienceMs: number;
	filter?: CapabilityFilter;
	reporter?: TrafficReporter;
	participantIndex?: number;
}): SeekerTrace {
	const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
	const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: 1000 });
	const topicHex = 'match-topic';
	const ladder = ladderOf(new Array(opts.startTier + 1).fill(0), opts.marker);
	tree.ensure(topicHex, bytesToHex(ladder[opts.startTier]!), opts.startTier, 0);

	let trace: SeekerTrace | undefined;
	const walk = new SeekerWalk({
		scheduler: world.scheduler,
		tree,
		participant: peer(opts.participantIndex ?? 0),
		topicId: topicHex,
		ladder,
		providers: opts.model,
		wantCount: opts.wantCount,
		patienceMs: opts.patienceMs,
		filter: opts.filter,
		reporter: opts.reporter,
		onComplete: (t) => {
			trace = t;
		}
	});
	walk.start();
	world.scheduler.run();
	if (!trace) {
		throw new Error('seeker walk did not complete');
	}
	return trace;
}

describe('SeekerWalk — docs §Test expectations', () => {
	it('hot topic, deep tier suffices: stops at the first Accepted whose query meets wantCount', () => {
		// Landing tier holds ≥ wantCount providers → immediate match, no hang-out, no escalation.
		const model = new TierProviderModel([
			{ tier: 2, initial: providers(8, ['pdf']), reportedArrivalsPerMin: 90, queriesPerMin: 4 }
		]);
		const t = runSeeker({ startTier: 2, marker: 0x10, model, wantCount: 8, patienceMs: 10_000, filter: PDF });

		expect(t.matched).to.equal(true);
		expect(t.startTier).to.equal(2);
		expect(t.finalTier, 'no walk past the tier of first match').to.equal(2);
		expect(t.tiersVisited).to.equal(1);
		expect(t.escalations).to.equal(0);
		expect(t.requeries).to.equal(0);
		expect(t.matchedCount).to.be.at.least(8);
	});

	it('cold topic, walks to root: traverses every tier; wantCount is met only at the root', () => {
		// Upper tiers thin (escalate); the root holds the merged, sufficient pool.
		const model = new TierProviderModel([
			{ tier: 2, initial: [], reportedArrivalsPerMin: 2, queriesPerMin: 1 },
			{ tier: 1, initial: [], reportedArrivalsPerMin: 2, queriesPerMin: 1 },
			{ tier: 0, initial: providers(8, ['pdf']), reportedArrivalsPerMin: 600, queriesPerMin: 4 }
		]);
		const t = runSeeker({ startTier: 2, marker: 0x20, model, wantCount: 8, patienceMs: 10_000, filter: PDF });

		expect(t.matched).to.equal(true);
		expect(t.finalTier, 'met only at the root').to.equal(0);
		expect(t.tiersVisited, 'queried tiers 2, 1, 0').to.equal(3);
		expect(t.escalations, 'one escalation per tier descended').to.equal(2);
	});

	it('borderline topic, hangs out for full patience: re-queries ≈ patienceMs/requery_interval, returns partial', () => {
		// Estimate says hang out (high reported arrivals), but fresh providers never actually land in
		// time → the seeker drains its full patience and returns the partial set.
		const model = new TierProviderModel([
			{ tier: 0, initial: providers(6, ['pdf']), reportedArrivalsPerMin: 90, queriesPerMin: 4, freshArrivalIntervalMs: 100_000 }
		]);
		const t = runSeeker({ startTier: 0, marker: 0x30, model, wantCount: 8, patienceMs: 10_000, filter: PDF });

		expect(t.matched).to.equal(false);
		expect(t.outcome).to.equal('partial');
		expect(t.finalTier).to.equal(0);
		expect(t.matchedCount, 'returns the partial set it has').to.equal(6);
		// patienceMs / requery_interval_ms ≈ 10000/1000 = 10 (minus the couple of setup hops).
		expect(t.requeries, 'roughly patienceMs / requery_interval_ms').to.be.within(8, 10);
		expect(t.hangOutDurationMs, 'bounded by patienceMs').to.be.at.most(10_000);
	});
});

describe('SeekerWalk — fairness at scale (matchmaking.md §Edge cases item 5)', () => {
	it('100 parallel seekers stay fair under contention_factor_cap = 4.0 (no self-inflicted escalation storm)', function () {
		this.timeout(20_000);
		// A hot tier: many competing seekers (high queriesPerMin) but plenty of arrivals. The cap keeps
		// the threshold bounded so every seeker hangs out and matches locally — none flees to the root.
		const model = new TierProviderModel([
			{ tier: 1, initial: providers(4, ['pdf']), reportedArrivalsPerMin: 600, queriesPerMin: 1200, freshArrivalIntervalMs: 200, freshCapabilities: ['pdf'] },
			{ tier: 0, initial: providers(64, ['pdf']), reportedArrivalsPerMin: 600, queriesPerMin: 1200 }
		]);
		const traces: SeekerTrace[] = [];
		for (let i = 0; i < 100; i++) {
			traces.push(runSeeker({ startTier: 1, marker: 0x40 + (i % 8), model, wantCount: 8, patienceMs: 10_000, filter: PDF, participantIndex: i }));
		}
		const totalEscalations = traces.reduce((n, t) => n + t.escalations, 0);
		expect(totalEscalations, 'no escalation storm — the cap keeps everyone hanging out locally').to.equal(0);
		expect(traces.every((t) => t.matched), 'all 100 seekers served within patience').to.equal(true);
		expect(traces.every((t) => t.finalTier === 1), 'all matched at their landing tier, root untouched').to.equal(true);
	});
});

describe('SeekerWalk — adversarial traffic reporting (matchmaking.md §Adversarial traffic reporting)', () => {
	it('under-report (claim a cold tier) costs ≤ one extra hop per tier', () => {
		// Tiers 2 and 1 each hold 6 and fill to 8 quickly; the root holds 8 outright.
		const tiers: TierProviderConfig[] = [
			{ tier: 2, initial: providers(6, ['pdf'], 200), reportedArrivalsPerMin: 90, queriesPerMin: 4, freshArrivalIntervalMs: 500, freshCapabilities: ['pdf'] },
			{ tier: 1, initial: providers(6, ['pdf'], 300), reportedArrivalsPerMin: 90, queriesPerMin: 4, freshArrivalIntervalMs: 500, freshCapabilities: ['pdf'] },
			{ tier: 0, initial: providers(8, ['pdf'], 400), reportedArrivalsPerMin: 600, queriesPerMin: 4 }
		];
		const model = new TierProviderModel(tiers);

		const honest = runSeeker({ startTier: 2, marker: 0x50, model, wantCount: 8, patienceMs: 10_000, filter: PDF });
		expect(honest.finalTier, 'honest seeker hangs out and matches at the landing tier').to.equal(2);
		expect(honest.escalations).to.equal(0);

		// A lying primary under-reports arrivals at every upper tier → the seeker escalates each one.
		const underReport: TrafficReporter = (truthful, tier) => (tier > 0 ? { ...truthful, arrivalsPerMin: 0 } : truthful);
		const lied = runSeeker({ startTier: 2, marker: 0x55, model, wantCount: 8, patienceMs: 10_000, filter: PDF, reporter: underReport });

		expect(lied.matched, 'still terminates at the root — under-reporting is bounded, not fatal').to.equal(true);
		expect(lied.finalTier).to.equal(0);
		// One extra register hop per under-reported tier (tiers 2 and 1) — bounded by the tier count.
		expect(lied.escalations - honest.escalations).to.be.at.most(2);
		expect(lied.escalations).to.equal(2);
	});

	it('over-report (claim a hot tier) costs ≤ patienceMs of wasted drain', () => {
		// Tier 1 is genuinely thin (truthful → escalate to the rich root); tier 0 holds 8.
		const tiers: TierProviderConfig[] = [
			{ tier: 1, initial: providers(2, ['pdf'], 500), reportedArrivalsPerMin: 2, queriesPerMin: 1 },
			{ tier: 0, initial: providers(8, ['pdf'], 600), reportedArrivalsPerMin: 600, queriesPerMin: 4 }
		];
		const model = new TierProviderModel(tiers);

		const honest = runSeeker({ startTier: 1, marker: 0x60, model, wantCount: 8, patienceMs: 10_000, filter: PDF });
		expect(honest.matched, 'honest seeker escalates off the thin tier and matches at the root').to.equal(true);
		expect(honest.finalTier).to.equal(0);
		expect(honest.hangOutDurationMs, 'no wasted hang-out').to.equal(0);

		// A lying primary over-reports arrivals at the thin tier → the seeker hangs out there.
		const overReport: TrafficReporter = (truthful, tier) => (tier === 1 ? { ...truthful, arrivalsPerMin: 100_000 } : truthful);
		const lied = runSeeker({ startTier: 1, marker: 0x66, model, wantCount: 8, patienceMs: 10_000, filter: PDF, reporter: overReport });

		expect(lied.hangOutDurationMs, 'wasted drain is bounded by patienceMs').to.be.at.most(10_000);
		expect(lied.hangOutDurationMs, 'the over-report did cost real drain').to.be.greaterThan(0);
		expect(lied.matchLatency, 'terminates within patienceMs (plus the setup hops)').to.be.at.most(10_000 + 200);
	});
});

describe('SeekerWalk — refinement signal (recorded for fold-simulator-findings-into-design-docs)', () => {
	it('reports whether per-tier-patience-splitting and contention-from-seeker-pool would help the borderline regime', () => {
		// Borderline: hangs out at a deep tier and fails, while the root would have matched outright.
		const model = new TierProviderModel([
			{ tier: 1, initial: providers(6, ['pdf']), reportedArrivalsPerMin: 90, queriesPerMin: 4, freshArrivalIntervalMs: 100_000 },
			{ tier: 0, initial: providers(8, ['pdf']), reportedArrivalsPerMin: 600, queriesPerMin: 4 }
		]);
		const t = runSeeker({ startTier: 1, marker: 0x70, model, wantCount: 8, patienceMs: 10_000, filter: PDF });
		expect(t.outcome, 'borderline deep-tier hang-out drains to partial').to.equal('partial');
		expect(t.finalTier).to.equal(1);

		const signal = measureRefinementSignal({
			trace: t,
			rootMatchableCount: 8, // the root held wantCount the whole time
			wantCount: 8,
			// A borderline reply where the exact Σ wantCount over registered seekers exceeds the
			// meanWantCount × queriesPerMin approximation enough to flip hang-out → escalate.
			borderlineTraffic: { windowSeconds: 60, arrivalsPerMin: 30, queriesPerMin: 1, directParticipants: 4, childCohortCount: 0 },
			borderlineMatches: 4,
			borderlineDemand: { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 },
			seekerWantSum: 30
		});

		// Both signals are recorded for fold-back; in this regime both refinements WOULD have helped.
		expect(signal.patienceSplittingWouldHelp, 'root could have answered → splitting helps').to.equal(true);
		expect(signal.seekerPoolContentionWouldHelp, 'exact Σwant flips the borderline decision').to.equal(true);
		expect(signal.note).to.be.a('string');
	});

	it('seekerPoolContentionWouldFlip isolates the case where the exact Σwant changes the decision', () => {
		const demand = { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 };
		const traffic = { windowSeconds: 60, arrivalsPerMin: 30, queriesPerMin: 1, directParticipants: 4, childCohortCount: 0 };
		// Approximation (queriesPerMin×meanWantCount = 3) → hang out; exact Σwant = 30 → escalate.
		expect(seekerPoolContentionWouldFlip(traffic, 4, demand, 30)).to.equal(true);
		// When the exact sum matches the approximation, nothing flips.
		expect(seekerPoolContentionWouldFlip(traffic, 4, demand, 3)).to.equal(false);
	});
});
