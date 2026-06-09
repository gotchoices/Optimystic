import { expect } from 'chai';
import {
	DEFAULT_REACTIVITY_CONFIG,
	W_DEFAULT,
	DEDUPE_WINDOW_DEFAULT,
	deltaMaxForProfile,
	subscriberTtlForProfile,
	resolveW,
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
});
