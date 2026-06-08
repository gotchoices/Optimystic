import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	createPromotionLifecycle,
	type PromotionDeps,
	DEFAULT_CAP_PROMOTE,
	DEFAULT_CAP_PROMOTE_FAST,
	DEFAULT_BUCKET_OVERLOAD,
	DEFAULT_CAP_DEMOTE,
	DEFAULT_T_DEMOTE_MS,
	DEFAULT_T_PROMOTE_STICKY_MS,
} from '../../src/cohort-topic/promotion.js';
import type { CohortSigner } from '../../src/cohort-topic/sig/threshold.js';
import type { PromotionNoticeV1 } from '../../src/cohort-topic/wire/types.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

function bytes(label: string, len = 32): Uint8Array {
	return sha256(new TextEncoder().encode(label)).slice(0, len);
}

const TOPIC = bytes('promo-topic');
const EPOCH = bytes('promo-epoch');
const PARENT = bytes('parent-coord');
const SIGNERS = Array.from({ length: 14 }, (_, i) => bytes(`signer-${i}`, 16));

/** Deterministic threshold signer stub: sig = sha256(payload); 14 fixed signers. */
const signer: CohortSigner = {
	thresholdSign: async (payload) => ({ thresholdSig: sha256(payload).slice(0, 16), signers: SIGNERS }),
	verifyThreshold: () => true,
};

/** A mutable knob bag the lifecycle deps read, so a test can drive count/load/children/tier over time. */
interface Knobs {
	count: number;
	loadBucket: number;
	children: number;
	treeTier: number;
}

function lifecycleWith(knobs: Knobs, config?: PromotionDeps['config']) {
	const deps: PromotionDeps = {
		store: { directParticipants: () => knobs.count },
		loadBucket: () => knobs.loadBucket,
		childCohortCount: () => knobs.children,
		treeTier: () => knobs.treeTier,
		parentCoord: () => PARENT,
		cohortEpoch: () => EPOCH,
		signer,
		config,
	};
	return createPromotionLifecycle(deps);
}

describe('cohort-topic / promotion lifecycle', () => {
	it('exposes the simulator-confirmed defaults', () => {
		expect(DEFAULT_CAP_PROMOTE).to.equal(64);
		expect(DEFAULT_CAP_PROMOTE_FAST).to.equal(32);
		expect(DEFAULT_BUCKET_OVERLOAD).to.equal(6);
		expect(DEFAULT_CAP_DEMOTE).to.equal(16);
		expect(DEFAULT_T_DEMOTE_MS).to.equal(300_000);
		expect(DEFAULT_T_PROMOTE_STICKY_MS).to.equal(60_000);
	});

	it('promotes exactly at cap_promote with zero overshoot in the eager per-arrival path', async () => {
		const knobs: Knobs = { count: 0, loadBucket: 0, children: 0, treeTier: 1 };
		// Isolate the strict cap trigger: disable slope pre-promotion (its own test below) so this asserts
		// the eager cap path fires exactly at the cap, not before.
		const life = lifecycleWith(knobs, { tPromoteLookaheadMs: 0 });

		let notice: PromotionNoticeV1 | undefined;
		let promotedAtCount = -1;
		// Feed arrivals one at a time, calling the lifecycle eagerly on each — the production path.
		for (let c = 1; c <= DEFAULT_CAP_PROMOTE; c++) {
			knobs.count = c;
			notice = await life.onParticipantCountChange(TOPIC, c); // `now` strictly increasing
			if (notice !== undefined) {
				promotedAtCount = c;
				break;
			}
		}
		// Eager evaluation fires the instant the count reaches the cap — overshoot is 0 (≪ the
		// gossip-lagged storm bound `< arrivalsPerRound` recorded by the simulator).
		expect(promotedAtCount, 'promotion fires at the cap, not past it').to.equal(DEFAULT_CAP_PROMOTE);
		expect(life.isPromoted(TOPIC)).to.be.true;
		expect(notice).to.not.equal(undefined);
		expect(notice!.fromTier).to.equal(1);
		expect(notice!.toTier).to.equal(2);
		expect(notice!.topicId).to.equal(bytesToB64url(TOPIC));
		expect(notice!.cohortEpoch).to.equal(bytesToB64url(EPOCH));
		expect(notice!.signers).to.have.length(14);
	});

	it('does not promote below the cap when load is cold', async () => {
		const knobs: Knobs = { count: DEFAULT_CAP_PROMOTE - 1, loadBucket: 0, children: 0, treeTier: 1 };
		const life = lifecycleWith(knobs);
		expect(await life.onParticipantCountChange(TOPIC, 1)).to.equal(undefined);
		expect(life.isPromoted(TOPIC)).to.be.false;
	});

	it('takes the hot fast path at cap_promote_fast when the load bucket is overloaded', async () => {
		const knobs: Knobs = { count: DEFAULT_CAP_PROMOTE_FAST, loadBucket: DEFAULT_BUCKET_OVERLOAD, children: 0, treeTier: 1 };
		const life = lifecycleWith(knobs);
		const notice = await life.onParticipantCountChange(TOPIC, 1);
		expect(notice, 'hot at the tier + ≥ cap_promote_fast → promote early').to.not.equal(undefined);
		expect(life.isPromoted(TOPIC)).to.be.true;
	});

	it('does not take the fast path below cap_promote_fast even when hot', async () => {
		const knobs: Knobs = { count: DEFAULT_CAP_PROMOTE_FAST - 1, loadBucket: 7, children: 0, treeTier: 1 };
		const life = lifecycleWith(knobs);
		expect(await life.onParticipantCountChange(TOPIC, 1)).to.equal(undefined);
	});

	it('pre-promotes on a steep growth slope before the count reaches the cap', async () => {
		const knobs: Knobs = { count: 10, loadBucket: 0, children: 0, treeTier: 1 };
		const life = lifecycleWith(knobs);
		// First sample at t=0, count 10 (no promotion). Then a steep climb: +30 over 1s extrapolates to
		// ~940 within the 30s lookahead, well past cap_promote — promote early though count is only 40.
		expect(await life.onParticipantCountChange(TOPIC, 0)).to.equal(undefined);
		knobs.count = 40;
		const notice = await life.onParticipantCountChange(TOPIC, 1_000);
		expect(notice, 'slope predicts crossing within lookahead → promote early').to.not.equal(undefined);
		expect(life.isPromoted(TOPIC)).to.be.true;
	});

	it('does not flap: stays promoted through a count drop within T_promote_sticky', async () => {
		const knobs: Knobs = { count: DEFAULT_CAP_PROMOTE, loadBucket: 0, children: 0, treeTier: 1 };
		const life = lifecycleWith(knobs);
		expect(await life.onParticipantCountChange(TOPIC, 0)).to.not.equal(undefined); // promoted at t=0

		// Count collapses well below cap_demote immediately after promotion.
		knobs.count = 0;
		await life.onParticipantCountChange(TOPIC, 1_000);

		// Within the sticky window, demotion is refused regardless of the low count → no flap.
		const withinSticky = DEFAULT_T_PROMOTE_STICKY_MS - 1;
		expect(await life.maybeDemote(TOPIC, withinSticky)).to.equal(undefined);
		expect(life.isPromoted(TOPIC), 'still promoted inside the sticky window').to.be.true;
	});

	it('demotes only after T_demote with no live children, and never at the root', async () => {
		const knobs: Knobs = { count: DEFAULT_CAP_PROMOTE, loadBucket: 0, children: 1, treeTier: 1 };
		const life = lifecycleWith(knobs);
		await life.onParticipantCountChange(TOPIC, 0); // promote at t=0

		// Drop to a demotable low load and stamp lowLoadSince at t=1000.
		knobs.count = DEFAULT_CAP_DEMOTE - 4;
		await life.onParticipantCountChange(TOPIC, 1_000);

		const past = 1_000 + DEFAULT_T_DEMOTE_MS + DEFAULT_T_PROMOTE_STICKY_MS; // clears sticky AND T_demote

		// Live children block demotion even past T_demote.
		expect(await life.maybeDemote(TOPIC, past)).to.equal(undefined);
		expect(life.isPromoted(TOPIC)).to.be.true;

		// Before T_demote has elapsed (children now gone) demotion still holds off.
		knobs.children = 0;
		expect(await life.maybeDemote(TOPIC, 1_000 + DEFAULT_T_PROMOTE_STICKY_MS + 1)).to.equal(undefined);

		// No children + low load held ≥ T_demote (and past sticky) → demote, addressed to the parent.
		const notice = await life.maybeDemote(TOPIC, past);
		expect(notice, 'demotes once hysteresis clears').to.not.equal(undefined);
		expect(notice!.tier).to.equal(1);
		expect(notice!.parentCohortCoord).to.equal(bytesToB64url(PARENT));
		expect(notice!.signers).to.have.length(14);
		expect(life.isPromoted(TOPIC), 'demotion releases promoted state').to.be.false;
	});

	it('never demotes the root (tree tier 0)', async () => {
		const knobs: Knobs = { count: 0, loadBucket: 0, children: 0, treeTier: 0 };
		const life = lifecycleWith(knobs);
		// Drive low-load clock far into the past, no children, never promoted.
		await life.onParticipantCountChange(TOPIC, 0);
		expect(await life.maybeDemote(TOPIC, DEFAULT_T_DEMOTE_MS * 10)).to.equal(undefined);
	});
});
