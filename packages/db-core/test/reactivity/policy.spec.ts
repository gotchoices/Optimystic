import { expect } from 'chai';
import {
	mayServeAsReactivityForwarder,
	instantiateForwarderPushState,
	requireForwarderPushState,
	reactivityNodePolicy,
	ReactivityForwarderForbiddenError,
	PushState,
	DELTA_MAX_CORE_BYTES,
	type PushStateInit,
} from '../../src/reactivity/index.js';
import { coreProfile, edgeProfile, Tier } from '../../src/cohort-topic/tiers.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

const b = (n: number): string => bytesToB64url(new Uint8Array([n]));
const INIT: PushStateInit = { collectionId: b(1), topicId: b(3), tailIdAtJoin: b(2) };

describe('reactivity Edge/Core policy', () => {
	describe('mayServeAsReactivityForwarder', () => {
		it('is true for Core (T3 producer) and false for Edge (subscriber-only)', () => {
			expect(mayServeAsReactivityForwarder(coreProfile())).to.equal(true);
			expect(mayServeAsReactivityForwarder(edgeProfile())).to.equal(false);
		});

		it('is false for a Core node an operator narrowed off T3', () => {
			const noT3 = coreProfile({ willingTiers: [Tier.T0, Tier.T1, Tier.T2] });
			expect(mayServeAsReactivityForwarder(noT3)).to.equal(false);
		});
	});

	describe('instantiateForwarderPushState (the forwarder gate)', () => {
		it('instantiates a PushState on Core', () => {
			const state = instantiateForwarderPushState(coreProfile(), INIT);
			expect(state).to.be.instanceOf(PushState);
		});

		it('returns undefined on Edge — the node stays a pure subscriber, never a forwarder', () => {
			expect(instantiateForwarderPushState(edgeProfile(), INIT)).to.equal(undefined);
		});
	});

	describe('requireForwarderPushState', () => {
		it('throws on a subscriber-only node, succeeds on Core', () => {
			expect(() => requireForwarderPushState(edgeProfile(), INIT)).to.throw(ReactivityForwarderForbiddenError, /edge/);
			expect(requireForwarderPushState(coreProfile(), INIT)).to.be.instanceOf(PushState);
		});
	});

	describe('reactivityNodePolicy', () => {
		it('resolves forwarder eligibility and delta_max per profile (Core 4096 / Edge 0)', () => {
			expect(reactivityNodePolicy(coreProfile())).to.deep.equal({ mayForward: true, deltaMaxBytes: DELTA_MAX_CORE_BYTES });
			expect(reactivityNodePolicy(edgeProfile())).to.deep.equal({ mayForward: false, deltaMaxBytes: 0 });
		});
	});
});
