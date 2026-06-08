import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import {
	backoffDelay,
	BackoffAdmission,
	WillingnessGossip,
	DEFAULT_BACKOFF_CONFIG
} from '../src/backoff.js';
import { makeMemberWillingness, setMemberLoadBucket, type Tier } from '../src/willingness.js';

const SEED = 77;

describe('backoff — exponential retry curve', () => {
	it('backoffDelay doubles from base and caps at maxMs', () => {
		const cfg = DEFAULT_BACKOFF_CONFIG; // base 1000, factor 2, max 60_000
		expect(backoffDelay(0, cfg)).to.equal(1000);
		expect(backoffDelay(1, cfg)).to.equal(2000);
		expect(backoffDelay(2, cfg)).to.equal(4000);
		expect(backoffDelay(5, cfg)).to.equal(32_000);
		expect(backoffDelay(6, cfg)).to.equal(60_000); // 64_000 capped
		expect(backoffDelay(20, cfg)).to.equal(60_000);
	});

	it('minimizes rejections across an overload window yet admits promptly once capacity frees', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const cfg = DEFAULT_BACKOFF_CONFIG;
		const freeAt = 100_000; // cohort is overloaded (UnwillingCohort) until 100 s, then admits

		const driver = new BackoffAdmission({
			scheduler: world.scheduler,
			participantId: 'P',
			gate: (now) => now >= freeAt,
			config: cfg
		});
		world.scheduler.run();

		expect(driver.admitted).to.equal(true);
		expect(driver.admittedAt).to.be.at.least(freeAt);

		// Exponential back-off suffers O(log(window/base)) rejections, not the window/base ≈ 100 a
		// fixed 1 s retry would. Bound: ceil(log2(100s / 1s)) ≈ 7, plus slack.
		const fixedIntervalRejections = freeAt / cfg.baseMs; // ≈ 100
		expect(driver.rejections).to.be.at.most(9);
		expect(driver.rejections).to.be.below(fixedIntervalRejections);

		// Once capacity frees, time-to-admit is bounded by the capped back-off delay (prompt).
		expect(driver.admittedAt! - freeAt).to.be.at.most(cfg.maxMs);
	});

	it('admits on the first attempt when the cohort is already willing (no rejections)', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const driver = new BackoffAdmission({ scheduler: world.scheduler, participantId: 'P', gate: () => true });
		world.scheduler.run();
		expect(driver.admitted).to.equal(true);
		expect(driver.rejections).to.equal(0);
		expect(driver.attempts).to.equal(1);
	});
});

describe('backoff — willingness-gossip staleness edge case', () => {
	it('a seeker routed to a stale-willing member gets UnwillingMember, then recovers via a sibling', () => {
		const tier: Tier = 2;
		const quorum = 2;
		const cohortMembers = [makeMemberWillingness('core'), makeMemberWillingness('core'), makeMemberWillingness('core')];
		const gossip = new WillingnessGossip(cohortMembers);

		// All three gossip as willing for T2 initially.
		expect(gossip.gossipedCandidates(tier)).to.deep.equal([0, 1, 2]);

		// Member 0 just became unwilling (load overload) but the cohort still gossips it as willing.
		setMemberLoadBucket(cohortMembers[0]!, tier, 6);
		expect(gossip.gossipedCandidates(tier)).to.deep.equal([0, 1, 2]); // stale: still lists 0

		// Seeker routed to the stale-willing member 0 → UnwillingMember (live check fails), candidates named.
		const first = gossip.admit(tier, 0, quorum);
		expect(first.result).to.equal('unwilling_member');
		expect(first.candidates).to.include(1);

		// Recovery: retry a named sibling that is genuinely willing → accepted.
		const retry = gossip.admit(tier, 1, quorum);
		expect(retry.result).to.equal('accepted');

		// One heartbeat later the gossip catches up and stops advertising the unwilling member.
		gossip.refresh();
		expect(gossip.gossipedCandidates(tier)).to.deep.equal([1, 2]);
	});

	it('drops to UnwillingCohort once gossip reflects that quorum can no longer be met', () => {
		const tier: Tier = 2;
		const quorum = 2;
		const cohortMembers = [makeMemberWillingness('core'), makeMemberWillingness('core'), makeMemberWillingness('core')];
		const gossip = new WillingnessGossip(cohortMembers);

		// Two of three shed T2; after gossip catches up, only one willing member remains < quorum.
		setMemberLoadBucket(cohortMembers[0]!, tier, 6);
		setMemberLoadBucket(cohortMembers[1]!, tier, 6);
		gossip.refresh();
		expect(gossip.admit(tier, 2, quorum).result).to.equal('unwilling_cohort');
	});
});
