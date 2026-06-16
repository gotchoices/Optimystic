import { expect } from 'chai';
import {
	DEFAULT_REACTIVITY_CONFIG,
	W_DEFAULT,
	DEDUPE_WINDOW_DEFAULT,
	QUEUE_MAX_DEFAULT,
	BLOCK_FILL_SIZE_DEFAULT,
	T_DRAIN_MS,
	WARM_THRESHOLD_DEFAULT,
	T_REJOIN_JITTER_MS,
	deltaMaxForProfile,
	subscriberTtlForProfile,
	resolveW,
	resolveQueueMax,
	SUBSCRIBER_TTL_CORE_MS,
	SUBSCRIBER_TTL_EDGE_MS,
	DELTA_MAX_CORE_BYTES,
	DELTA_MAX_EDGE_BYTES,
} from '../../src/reactivity/index.js';
import { coreProfile, edgeProfile } from '../../src/cohort-topic/tiers.js';

describe('reactivity config', () => {
	it('exposes the documented defaults from a single table', () => {
		expect(DEFAULT_REACTIVITY_CONFIG.w).to.equal(256);
		expect(DEFAULT_REACTIVITY_CONFIG.dedupeWindow).to.equal(64);
		expect(W_DEFAULT).to.equal(256);
		expect(DEDUPE_WINDOW_DEFAULT).to.equal(64);
		expect(DEFAULT_REACTIVITY_CONFIG.wCheckpoint).to.equal(4096);
	});

	it('consolidates the rotation/backpressure defaults this ticket owns', () => {
		expect(QUEUE_MAX_DEFAULT).to.equal(32);
		expect(BLOCK_FILL_SIZE_DEFAULT).to.equal(64);
		expect(T_DRAIN_MS).to.equal(60_000);
		expect(WARM_THRESHOLD_DEFAULT).to.equal(8);
		expect(T_REJOIN_JITTER_MS).to.equal(30_000); // inherited from cohort-topic
		expect(DEFAULT_REACTIVITY_CONFIG.queueMax).to.equal(32);
		expect(DEFAULT_REACTIVITY_CONFIG.blockFillSize).to.equal(64);
		expect(DEFAULT_REACTIVITY_CONFIG.tDrainMs).to.equal(60_000);
		expect(DEFAULT_REACTIVITY_CONFIG.warmThreshold).to.equal(8);
		expect(DEFAULT_REACTIVITY_CONFIG.tRejoinJitterMs).to.equal(30_000);
	});

	it('derives delta_max per profile (Core 4 KB / Edge 0 declines deltas)', () => {
		expect(deltaMaxForProfile(coreProfile())).to.equal(DELTA_MAX_CORE_BYTES);
		expect(deltaMaxForProfile(edgeProfile())).to.equal(DELTA_MAX_EDGE_BYTES);
		expect(deltaMaxForProfile(edgeProfile())).to.equal(0);
	});

	it('derives the subscriber TTL per profile (Core 90 s / Edge 60 s)', () => {
		expect(subscriberTtlForProfile(coreProfile())).to.equal(SUBSCRIBER_TTL_CORE_MS);
		expect(subscriberTtlForProfile(edgeProfile())).to.equal(SUBSCRIBER_TTL_EDGE_MS);
	});

	describe('resolveW (simulator-validated-pending adaptive hook)', () => {
		it('returns the static default when no cps is supplied (Edge/low-rate default)', () => {
			expect(resolveW()).to.equal(256);
			expect(resolveW({ minCoverageSeconds: 60 })).to.equal(256);
		});

		it('scales W ≈ ⌈min_coverage × cps⌉ on a hot collection', () => {
			expect(resolveW({ cps: 10, minCoverageSeconds: 60 })).to.equal(600);
			expect(resolveW({ cps: 100, minCoverageSeconds: 60 })).to.equal(6000);
		});

		it('never drops below the static default', () => {
			expect(resolveW({ cps: 1, minCoverageSeconds: 60 })).to.equal(256);
		});

		it('clamps to a per-cohort memory budget when supplied', () => {
			expect(resolveW({ cps: 100, minCoverageSeconds: 60, maxW: 1024 })).to.equal(1024);
		});

		it('ignores a non-positive cps and falls back to the default', () => {
			expect(resolveW({ cps: 0, minCoverageSeconds: 60 })).to.equal(256);
			expect(resolveW({ cps: -5, minCoverageSeconds: 60 })).to.equal(256);
		});
	});

	describe('resolveQueueMax (simulator-validated-pending adaptive hook)', () => {
		it('returns the static default when no cohort size is supplied', () => {
			expect(resolveQueueMax()).to.equal(32);
		});

		it('scales with cohort size but never below the static default', () => {
			expect(resolveQueueMax({ cohortSubscribers: 64, scaleBaseline: 64 })).to.equal(32); // baseline → unchanged
			expect(resolveQueueMax({ cohortSubscribers: 256, scaleBaseline: 64 })).to.equal(128); // 4× cohort → 4× depth
			expect(resolveQueueMax({ cohortSubscribers: 8, scaleBaseline: 64 })).to.equal(32); // small cohort floors at default
		});

		it('clamps to a per-cohort memory budget when supplied', () => {
			expect(resolveQueueMax({ cohortSubscribers: 1024, scaleBaseline: 64, maxQueue: 100 })).to.equal(100);
		});
	});
});
