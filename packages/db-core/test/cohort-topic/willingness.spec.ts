import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	createLoadBarometer,
	utilizationBucket,
	DEFAULT_OVERLOAD_BUCKET,
} from '../../src/cohort-topic/load/barometer.js';
import {
	createWillingnessCheck,
	selfWillingnessBits,
	tierBit,
	packWillingnessBits,
	backoffRetryMs,
	DEFAULT_BACKOFF_CONFIG,
	defaultQuorum,
} from '../../src/cohort-topic/willingness.js';
import { createCohortView, type MutableCohortView } from '../../src/cohort-topic/gossip/view.js';
import { coreProfile, edgeProfile, Tier } from '../../src/cohort-topic/tiers.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import type { RegisterV1 } from '../../src/cohort-topic/wire/types.js';

function peer(label: string): Uint8Array {
	return sha256(new TextEncoder().encode(label)).slice(0, 16);
}

const EPOCH = sha256(new TextEncoder().encode('epoch-1')).slice(0, 32);

function reg(tier: number): RegisterV1 {
	return {
		v: 1,
		topicId: bytesToB64url(sha256(new TextEncoder().encode('topic')).slice(0, 32)),
		tier,
		treeTier: 2,
		participantCoord: bytesToB64url(peer('participant')),
		ttl: 90_000,
		timestamp: 1_000,
		correlationId: bytesToB64url(peer('corr').slice(0, 16)),
		signature: bytesToB64url(peer('sig').slice(0, 8)),
	};
}

/** Add a sibling member to the view with a willingness vector (4-bit) and identifying key. */
function addSibling(view: MutableCohortView, key: string, willingness: number): void {
	view.merge(key, {
		cohortEpoch: EPOCH,
		willingness,
		loadBuckets: [0, 0, 0, 0],
		windowSeconds: 60,
		topicSummaries: [],
		timestamp: 1_000,
	});
}

describe('cohort-topic / barometer', () => {
	it('log-buckets utilization monotonically with the documented boundaries', () => {
		expect(utilizationBucket(0)).to.equal(0);
		expect(utilizationBucket(-1)).to.equal(0);
		expect(utilizationBucket(1 / 128)).to.equal(0); // just under bucket 1's floor (1/64)
		expect(utilizationBucket(1 / 64)).to.equal(1);
		expect(utilizationBucket(0.25)).to.equal(5);
		expect(utilizationBucket(0.49)).to.equal(5);
		expect(utilizationBucket(0.5)).to.equal(6); // the overload boundary
		expect(utilizationBucket(0.99)).to.equal(6);
		expect(utilizationBucket(1.0)).to.equal(7);
		expect(utilizationBucket(4.0)).to.equal(7); // clamps at the top
	});

	it('flips the willingness bit exactly at the bucket boundary (default overload = 6)', () => {
		const b = createLoadBarometer();
		expect(DEFAULT_OVERLOAD_BUCKET).to.equal(6);

		b.observe(Tier.T2, 0.49); // bucket 5 < 6
		expect(b.bucket(Tier.T2)).to.equal(5);
		expect(b.loadWilling(Tier.T2), 'willing just below the boundary').to.be.true;
		expect(b.isOverloaded(Tier.T2)).to.be.false;

		b.observe(Tier.T2, 0.5); // bucket 6 == overload → shed
		expect(b.bucket(Tier.T2)).to.equal(6);
		expect(b.loadWilling(Tier.T2), 'unwilling exactly at the boundary').to.be.false;
		expect(b.isOverloaded(Tier.T2), 'overload (early-promote) signal raised').to.be.true;
	});

	it('packs profile ∧ load into the gossiped willingness vector; edge sheds T2/T3 permanently', () => {
		const b = createLoadBarometer();
		// Core, all idle → all four bits set.
		expect(selfWillingnessBits(coreProfile(), b)).to.equal(0b1111);
		// Overload T1 → its bit clears, others remain.
		b.observe(Tier.T1, 1.0);
		const core = selfWillingnessBits(coreProfile(), b);
		expect(tierBit(core, Tier.T1)).to.be.false;
		expect(tierBit(core, Tier.T0)).to.be.true;
		expect(tierBit(core, Tier.T2)).to.be.true;
		// Edge serves T0+T1 only regardless of (idle) load.
		const edge = selfWillingnessBits(edgeProfile(), createLoadBarometer());
		expect(edge).to.equal(0b0011);
	});
});

describe('cohort-topic / willingness check', () => {
	const cfg = { cohortSize: 4, quorum: 2 };

	it('accepts when the routed member is willing and quorum holds', () => {
		const view = createCohortView();
		addSibling(view, bytesToB64url(peer('sib-1')), 0b1111); // 1 willing sibling + self = quorum 2
		const check = createWillingnessCheck({
			barometer: createLoadBarometer(),
			view,
			selfMember: bytesToB64url(peer('self')),
			primaryTopicCount: () => 0,
			config: cfg,
		});
		expect(check.evaluate(reg(Tier.T1), coreProfile(), 5_000).kind).to.equal('accepted');
	});

	it('returns unwilling_member (with willing siblings) when self is shed but quorum holds', () => {
		const view = createCohortView();
		const sibA = bytesToB64url(peer('sib-A'));
		const sibB = bytesToB64url(peer('sib-B'));
		addSibling(view, sibA, 0b1111);
		addSibling(view, sibB, 0b1111);
		const barometer = createLoadBarometer();
		barometer.observe(Tier.T1, 1.0); // self overloaded at T1 → personally unwilling
		const out = createWillingnessCheck({
			barometer,
			view,
			selfMember: bytesToB64url(peer('self')),
			primaryTopicCount: () => 0,
			config: cfg,
		}).evaluate(reg(Tier.T1), coreProfile(), 5_000);

		expect(out.kind).to.equal('unwilling_member');
		if (out.kind !== 'unwilling_member') throw new Error('unreachable');
		const got = out.candidateMembers.map(bytesToB64url).sort();
		expect(got).to.deep.equal([sibA, sibB].sort());
	});

	it('returns unwilling_member when the profile cannot serve the tier at all (edge → T3)', () => {
		const view = createCohortView();
		addSibling(view, bytesToB64url(peer('core-sib-1')), 0b1111);
		addSibling(view, bytesToB64url(peer('core-sib-2')), 0b1111);
		const out = createWillingnessCheck({
			barometer: createLoadBarometer(),
			view,
			selfMember: bytesToB64url(peer('self')),
			primaryTopicCount: () => 0,
			config: cfg,
		}).evaluate(reg(Tier.T3), edgeProfile(), 5_000);
		expect(out.kind).to.equal('unwilling_member'); // edge sheds T3, but core siblings serve it
	});

	it('returns unwilling_cohort with the back-off retryAfter when quorum fails', () => {
		const view = createCohortView();
		// Only one willing member total (self), below quorum 2.
		const out = createWillingnessCheck({
			barometer: createLoadBarometer(),
			view,
			selfMember: bytesToB64url(peer('self')),
			primaryTopicCount: () => 0,
			attempts: () => 2, // third rejection
			config: cfg,
		}).evaluate(reg(Tier.T1), coreProfile(), 5_000);

		expect(out.kind).to.equal('unwilling_cohort');
		if (out.kind !== 'unwilling_cohort') throw new Error('unreachable');
		expect(out.retryAfterMs).to.equal(backoffRetryMs(2)); // 1000 · 2^2 = 4000
		expect(out.retryAfterMs).to.equal(4_000);
	});

	it('sheds the tier via the per-tier primary-topic budget even when load is idle', () => {
		const view = createCohortView();
		addSibling(view, bytesToB64url(peer('sib-budget-1')), 0b1111);
		addSibling(view, bytesToB64url(peer('sib-budget-2')), 0b1111); // quorum 2 met by siblings alone
		const out = createWillingnessCheck({
			barometer: createLoadBarometer(),
			view,
			selfMember: bytesToB64url(peer('self')),
			primaryTopicCount: (t) => (t === Tier.T1 ? 2048 : 0), // at the budget cap for T1
			config: cfg,
		}).evaluate(reg(Tier.T1), coreProfile(), 5_000);
		expect(out.kind).to.equal('unwilling_member'); // self over budget, sibling serves
	});

	it('default quorum is a strict majority of the cohort', () => {
		expect(defaultQuorum(16)).to.equal(9);
		expect(defaultQuorum(4)).to.equal(3);
	});
});

describe('cohort-topic / back-off curve (no cascade)', () => {
	it('caps a single participant at O(log(window/base)) rejections vs window/base fixed', () => {
		const { baseMs, capMs } = DEFAULT_BACKOFF_CONFIG;
		const window = capMs; // a 60 s full-overload window

		// Fixed 1 s interval: one rejection per base over the whole window.
		const fixed = Math.floor(window / baseMs);
		expect(fixed).to.equal(60);

		// Capped doubling: count attempts whose cumulative delay fits inside the window.
		let elapsed = 0;
		let attempts = 0;
		while (elapsed < window) {
			elapsed += backoffRetryMs(attempts);
			attempts++;
		}
		expect(attempts, 'logarithmic in window/base').to.be.lessThan(8);
		expect(attempts).to.be.lessThan(fixed / 5);
	});

	it('monotonic non-decreasing and capped at capMs', () => {
		let prev = 0;
		for (let a = 0; a < 12; a++) {
			const d = backoffRetryMs(a);
			expect(d).to.be.at.least(prev);
			expect(d).to.be.at.most(DEFAULT_BACKOFF_CONFIG.capMs);
			prev = d;
		}
		expect(backoffRetryMs(0)).to.equal(1_000);
		expect(backoffRetryMs(3)).to.equal(8_000);
		expect(backoffRetryMs(20)).to.equal(60_000); // capped
	});

	it('a synchronized burst sheds offered load instead of cascading (accepted/sec ≤ capacity)', () => {
		// Capacity-limited gate: at most `capacity` admits per 1 s window. A burst of `n` participants
		// all start at t=0; each rejection reschedules via backoffRetryMs(attempt). Assert: (a) admits
		// never exceed capacity in any window, (b) the offered-attempt count per wave is non-increasing
		// (no cascade — back-off shrinks load, never multiplies it), (c) everyone is eventually admitted.
		const capacity = 4;
		const n = 40;
		type Ev = { t: number; attempt: number };
		let queue: Ev[] = Array.from({ length: n }, () => ({ t: 0, attempt: 0 }));
		const acceptedPerWindow = new Map<number, number>();
		let admitted = 0;
		const offeredPerWave: number[] = [];
		let guard = 0;

		while (queue.length > 0) {
			if (++guard > 10_000) throw new Error('did not converge');
			// Process the earliest wave (all events at the minimum time).
			const t = Math.min(...queue.map((e) => e.t));
			const wave = queue.filter((e) => e.t === t);
			queue = queue.filter((e) => e.t !== t);
			offeredPerWave.push(wave.length);
			const win = Math.floor(t / 1000);
			for (const e of wave) {
				const got = acceptedPerWindow.get(win) ?? 0;
				if (got < capacity) {
					acceptedPerWindow.set(win, got + 1);
					admitted++;
				} else {
					queue.push({ t: t + backoffRetryMs(e.attempt), attempt: e.attempt + 1 });
				}
			}
		}

		// (a) gate never exceeded.
		for (const [, c] of acceptedPerWindow) {
			expect(c).to.be.at.most(capacity);
		}
		// (b) no cascade: each successive wave offers no more load than the previous.
		for (let i = 1; i < offeredPerWave.length; i++) {
			expect(offeredPerWave[i]!).to.be.at.most(offeredPerWave[i - 1]!);
		}
		// (c) everyone admitted.
		expect(admitted).to.equal(n);
	});
});
