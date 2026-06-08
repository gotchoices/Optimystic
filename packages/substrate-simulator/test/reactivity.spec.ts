import { expect } from 'chai';
import {
	ReplayRing,
	RollingCheckpoint,
	DedupeWindow,
	CohortPushState,
	classifyResume,
	traceResume,
	resumeRpcCount,
	coverageSeconds,
	measureCoverage,
	assessAdaptiveW,
	measureRepeatedWakeThrash,
	simulateRotationBurst,
	DEFAULT_REACTIVITY_CONFIG,
	DEFAULT_RESUME_COST,
	type ResumeKind
} from '../src/reactivity.js';
import { generatePeers } from '../src/peer.js';
import { createRng } from '../src/rng.js';

const C = DEFAULT_REACTIVITY_CONFIG;
const subscriber = generatePeers(1, createRng(7))[0]!;

describe('reactivity — replay ring buffer', () => {
	it('holds the last W revisions and retires the oldest past capacity', () => {
		const ring = new ReplayRing(C.W);
		for (let r = 1; r <= C.W; r++) {
			expect(ring.append({ revision: r, sigDigest: `d${r}`, receivedAt: r })).to.equal(undefined);
		}
		expect(ring.size).to.equal(C.W);
		expect(ring.lowestRevision()).to.equal(1);
		expect(ring.highestRevision()).to.equal(C.W);

		const retired = ring.append({ revision: C.W + 1, sigDigest: 'd257', receivedAt: C.W + 1 });
		expect(retired?.revision, 'oldest retired').to.equal(1);
		expect(ring.size, 'stays at capacity').to.equal(C.W);
		expect(ring.lowestRevision()).to.equal(2);
		expect(ring.covers(2)).to.equal(true);
		expect(ring.covers(1), 'retired out of window').to.equal(false);
		expect(ring.covers(C.W + 1)).to.equal(true);
	});

	it('rejects a non-positive capacity', () => {
		expect(() => new ReplayRing(0)).to.throw(RangeError);
		expect(() => new ReplayRing(-1)).to.throw(RangeError);
	});
});

describe('reactivity — rolling checkpoint advances as revisions retire', () => {
	it('sits immediately below the replay ring, spanning W_checkpoint', () => {
		const state = new CohortPushState(C);
		// Fill far enough that the ring has shed revisions into the checkpoint.
		const total = C.W + C.Wcheckpoint + 100;
		for (let r = 1; r <= total; r++) {
			state.ingest(r, `d${r}`, r);
		}
		const ringLow = state.replay.lowestRevision()!;
		const cp = state.checkpoint.window()!;
		expect(cp.toRevision, 'checkpoint top is just below the ring').to.equal(ringLow - 1);
		expect(cp.toRevision - cp.fromRevision + 1, 'span is W_checkpoint').to.equal(C.Wcheckpoint);
		// A revision inside the checkpoint band is covered there but not by the ring.
		const mid = cp.fromRevision + 10;
		expect(state.checkpoint.covers(mid)).to.equal(true);
		expect(state.replay.covers(mid)).to.equal(false);
	});

	it('rejects a non-positive span', () => {
		expect(() => new RollingCheckpoint(0)).to.throw(RangeError);
	});
});

describe('reactivity — sliding dedupe window', () => {
	it('forwards a new head, drops a duplicate, re-forwards a gap-closing retransmit', () => {
		const state = new CohortPushState(C);
		expect(state.ingest(100, 'a', 100), 'new head').to.equal('forwarded');
		expect(state.ingest(100, 'a', 100), 'exact duplicate dropped').to.equal('duplicate');
		// Earlier revision not yet seen → recovery retransmit, forwarded once then deduped.
		expect(state.ingest(98, 'x', 101), 'gap-closing retransmit').to.equal('forwarded');
		expect(state.ingest(98, 'x', 101), 'same retransmit deduped').to.equal('duplicate');
		// A distinct signature for the same revision is a different (rev,sig) pair → forwarded.
		expect(state.ingest(98, 'y', 101), 'distinct sigDigest is not a dup').to.equal('forwarded');
	});

	it('evicts by revision age so old (rev,sig) pairs fall out of the window', () => {
		const dedupe = new DedupeWindow(4);
		for (let r = 1; r <= 10; r++) {
			expect(dedupe.admit(r, `d${r}`)).to.equal(true);
		}
		// Window holds the last 4 revisions (7..10); revision 6 has aged out.
		expect(dedupe.has(10, 'd10')).to.equal(true);
		expect(dedupe.has(7, 'd7')).to.equal(true);
		expect(dedupe.has(6, 'd6'), 'aged out of window').to.equal(false);
	});

	it('rejects a non-positive window', () => {
		expect(() => new DedupeWindow(0)).to.throw(RangeError);
	});
});

describe('reactivity — resume classification (one-RPC backfill)', () => {
	const base = { subscriber, currentTailId: 'T', latestKnownTailId: 'T' };

	it('lag < W resolves as Backfill in exactly one RPC', () => {
		const trace = traceResume({ ...base, currentRevision: 1000, fromRevision: 1000 - (C.W - 1) });
		expect(trace.kind).to.equal('Backfill');
		expect(trace.rpcCount, 'exactly one backfill RPC').to.equal(1);
		expect(trace.lagRevisions).to.equal(C.W - 1);
		expect(trace.latency).to.equal(DEFAULT_RESUME_COST.roundTripMs);
	});

	it('W ≤ lag < W_checkpoint resolves as CheckpointWindow in one RPC', () => {
		const trace = traceResume({ ...base, currentRevision: 5000, fromRevision: 5000 - C.W });
		expect(trace.kind, 'lag == W is the checkpoint boundary').to.equal('CheckpointWindow');
		expect(trace.rpcCount, 'one checkpoint RPC').to.equal(1);

		const deep = traceResume({ ...base, currentRevision: 5000, fromRevision: 5000 - (C.Wcheckpoint - 1) });
		expect(deep.kind, 'lag just under W_checkpoint still checkpoint').to.equal('CheckpointWindow');
	});

	it('lag ≥ W_checkpoint falls to a chain read (OutOfWindow)', () => {
		const trace = traceResume({ ...base, currentRevision: 9000, fromRevision: 9000 - C.Wcheckpoint });
		expect(trace.kind).to.equal('OutOfWindow');
		expect(trace.rpcCount, 'resume + chain read').to.be.greaterThan(1);
		expect(trace.latency, 'includes chain-read cost')
			.to.equal(DEFAULT_RESUME_COST.roundTripMs + DEFAULT_RESUME_COST.chainReadMs);
	});

	it('a stale latestKnownTailId yields TailRotated regardless of lag', () => {
		const trace = traceResume({
			subscriber,
			currentRevision: 1000,
			fromRevision: 999, // tiny lag — still rotated, tail dominates
			currentTailId: 'T_new',
			latestKnownTailId: 'T_old'
		});
		expect(trace.kind).to.equal('TailRotated');
		expect(trace.rpcCount, 're-resolve costs extra round trips').to.be.greaterThan(1);
		expect(classifyResume({
			subscriber, currentRevision: 1000, fromRevision: 999,
			currentTailId: 'T_new', latestKnownTailId: 'T_new'
		}), 'same tail → not rotated').to.equal('Backfill');
	});

	it('rpcCount is one only for the in-window kinds', () => {
		expect(resumeRpcCount('Backfill')).to.equal(1);
		expect(resumeRpcCount('CheckpointWindow')).to.equal(1);
		expect(resumeRpcCount('OutOfWindow')).to.be.greaterThan(1);
		expect(resumeRpcCount('TailRotated')).to.be.greaterThan(1);
	});
});

describe('reactivity — coverage windows', () => {
	it('at 1 cps: W ≈ 4 min, W_checkpoint ≈ 1 hour', () => {
		const cov = measureCoverage(1);
		expect(cov.replaySeconds, 'W = 256 rev / 1 cps').to.equal(256);
		expect(cov.replaySeconds / 60, '≈ 4 min').to.be.within(4, 4.5);
		expect(cov.checkpointSeconds, 'W_checkpoint = 4096 rev / 1 cps').to.equal(4096);
		expect(cov.checkpointSeconds / 3600, '≈ 1 hour').to.be.within(1, 1.2);
	});

	it('at 100 cps (hot collection): W covers ≈ 2.5 s', () => {
		const cov = measureCoverage(100);
		expect(cov.replaySeconds, 'W = 256 rev / 100 cps').to.be.closeTo(2.56, 0.001);
		expect(cov.replaySeconds, '≈ 2.5 s').to.be.within(2, 3);
	});

	it('coverageSeconds rejects a non-positive cps', () => {
		expect(() => coverageSeconds(256, 0)).to.throw(RangeError);
	});
});

describe('reactivity — adaptive-W finding (recorded for fold-back)', () => {
	it('flags W as too shallow at 100 cps but ample at 1 cps (floor = 60 s recovery)', () => {
		const floor = 60; // want ≥ 1 minute of one-RPC recovery
		const slow = assessAdaptiveW(1, floor);
		expect(slow.belowFloor, '1 cps: 256 s ≥ 60 s').to.equal(false);
		expect(slow.recommendedW, 'no change at 1 cps').to.equal(C.W);

		const hot = assessAdaptiveW(100, floor);
		expect(hot.coverageSeconds, '100 cps: ≈ 2.56 s').to.be.closeTo(2.56, 0.001);
		expect(hot.belowFloor, 'below the 60 s floor → adaptive W warranted').to.equal(true);
		expect(hot.recommendedW, 'scale W to restore the floor').to.equal(6000);
		// The recorded finding: at hot cps the fixed W must grow to keep the same recovery window.
		expect(hot.recommendedW).to.be.greaterThan(C.W);
	});
});

describe('reactivity — no thrash under bursty lag-≈-W wakes', () => {
	it('repeated wakes at lag just under W stay Backfill, single-RPC, zero transitions', () => {
		const readout = measureRepeatedWakeThrash({
			subscriber,
			lag: C.W - 1,
			wakes: 50,
			commitsPerWake: 10
		});
		expect(readout.kinds.every((k: ResumeKind) => k === 'Backfill'), 'never leaves Backfill').to.equal(true);
		expect(readout.transitions, 'no replay/checkpoint ping-pong').to.equal(0);
		expect(readout.allSingleRpc, 'every wake one RPC').to.equal(true);
	});

	it('a steady commit stream never double-forwards a revision (dedupe holds)', () => {
		const state = new CohortPushState(C);
		let forwarded = 0;
		for (let r = 1; r <= 500; r++) {
			if (state.ingest(r, `d${r}`, r) === 'forwarded') {
				forwarded++;
			}
			// A retried delivery of the same notification is always dropped.
			expect(state.ingest(r, `d${r}`, r)).to.equal('duplicate');
		}
		expect(forwarded, 'each revision forwarded exactly once').to.equal(500);
	});
});

describe('reactivity — tail-rotation re-registration burst', () => {
	it('the wave stays within cap_promote_fast at the new root, inside T_drain, across populations', () => {
		for (const subscriberCount of [100, 1000, 10000]) {
			const result = simulateRotationBurst({ subscriberCount });
			// A population past the cap must fill the root *to* cap_promote_fast and fast-promote there
			// — exactly the cap, not merely ≤ it. Asserting equality guards against a regression where
			// the root promotes far below the cap (e.g. slope lookahead re-enabled), which would leave
			// the `≤ cap` bound vacuously satisfied and the fast-promote mechanism untested.
			expect(result.peakRootDirect, `root fills to cap_promote_fast then promotes (n=${subscriberCount})`)
				.to.equal(C.capPromoteFast);
			expect(result.withinCapPromoteFast, `within fast-promote bound (n=${subscriberCount})`).to.equal(true);
			expect(result.completedWithinDrain, `all re-registered inside T_drain (n=${subscriberCount})`).to.equal(true);
			expect(result.lastArrivalAt, `jittered over ≤ T_rejoin_jitter (n=${subscriberCount})`)
				.to.be.at.most(C.tRejoinJitterMs);
			// A population past the fast-promote cap must have spread off the root.
			if (subscriberCount > C.capPromoteFast) {
				expect(result.finalDepth, `tree grew past the root (n=${subscriberCount})`).to.be.greaterThan(0);
			}
		}
	});

	it('is deterministic for a fixed seed', () => {
		const a = simulateRotationBurst({ subscriberCount: 1000, seed: 42 });
		const b = simulateRotationBurst({ subscriberCount: 1000, seed: 42 });
		expect(a).to.deep.equal(b);
	});

	it('rejects a negative subscriber count', () => {
		expect(() => simulateRotationBurst({ subscriberCount: -1 })).to.throw(RangeError);
	});
});
