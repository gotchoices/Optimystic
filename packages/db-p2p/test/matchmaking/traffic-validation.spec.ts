import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	matchTopicId,
	providerSigningPayload,
	bytesToB64url,
	type ProviderEntryV1,
	type QueryReplyV1,
	type TopicTrafficV1,
	type EntrySigVerifier,
} from '@optimystic/db-core';
import {
	boundReportedTraffic,
	reportTrafficCrossCheck,
	maxWalkHops,
	DEFAULT_TRAFFIC_BOUND_CONFIG,
	type SeekerWalkState,
	type TrafficCrossCheckSignal,
} from '../../src/matchmaking/traffic-validation.js';
import { SeekerWalkClient, type SeekerProbeReply, type SeekerWalkTransport } from '../../src/matchmaking/seeker-walk-client.js';
import { PenaltyReason, type IPeerReputation } from '../../src/reputation/index.js';

/**
 * Seeker-side adversarial traffic bounds (`docs/matchmaking.md` §Adversarial cohort traffic reporting).
 * Two halves: (1) the pure `boundReportedTraffic` bounds + cross-check emission, and (2) an end-to-end
 * adversarial walk over the real `SeekerWalkClient` driven by a lying transport, asserting the documented
 * worst-case harm — over-report ≤ wasted patience + one hop, under-report ≤ one extra hop per tier
 * terminating at the root.
 */
const TOPIC_ID = matchTopicId('capability', 'pdf-render');
const fakeSign = (payload: Uint8Array): string => bytesToB64url(sha256(payload));
const fakeVerify: EntrySigVerifier = (_id, payload, sig) => bytesToB64url(sha256(payload)) === bytesToB64url(sig);

const traffic = (partial: Partial<TopicTrafficV1> = {}): TopicTrafficV1 => ({
	windowSeconds: 30,
	arrivalsPerMin: 0,
	queriesPerMin: 0,
	directParticipants: 0,
	childCohortCount: 0,
	...partial,
});

const replyWith = (t: TopicTrafficV1): QueryReplyV1 => ({
	v: 1,
	truncated: false,
	cohortEpoch: bytesToB64url(new Uint8Array(32).fill(1)),
	topicTraffic: t,
	signature: bytesToB64url(new Uint8Array(64).fill(2)),
});

const walkState = (partial: Partial<SeekerWalkState> = {}): SeekerWalkState => ({
	currentTier: 1,
	dMax: 2,
	tiersWalked: 1,
	patienceMs: 10_000,
	patienceRemainingMs: 6_000,
	observedMatches: 0,
	...partial,
});

describe('matchmaking / traffic bounds — boundReportedTraffic', () => {
	it('caps hang-out to the seeker remaining patience (over-report bound)', () => {
		const result = boundReportedTraffic(replyWith(traffic({ arrivalsPerMin: 5_000 })), walkState({ patienceRemainingMs: 6_000, observedMatches: 1 }));
		expect(result.capPatienceMs).to.equal(6_000);
	});

	it('clamps a negative remaining patience to 0', () => {
		const result = boundReportedTraffic(replyWith(traffic()), walkState({ patienceRemainingMs: -500 }));
		expect(result.capPatienceMs).to.equal(0);
	});

	it('reports the one-extra-hop-per-tier escalation bound', () => {
		const result = boundReportedTraffic(replyWith(traffic({ arrivalsPerMin: 90 })), walkState());
		expect(result.escalateAfterTiers).to.equal(DEFAULT_TRAFFIC_BOUND_CONFIG.maxExtraHopsPerTier);
		expect(result.escalateAfterTiers).to.equal(1);
	});

	it('flags a suspect over-report (claimed hot, seeker query yields almost nothing)', () => {
		const result = boundReportedTraffic(
			replyWith(traffic({ directParticipants: 100, arrivalsPerMin: 200 })),
			walkState({ observedMatches: 1, primaryId: 'primary-X' }),
		);
		expect(result.trusted).to.equal(false);
		expect(result.reputationSignals.map((s) => s.kind)).to.include('over-report-suspected');
		expect(result.reputationSignals[0]!.subjectId).to.equal('primary-X');
	});

	it('flags a suspect under-report (claimed cold while the seeker query yields matches)', () => {
		const result = boundReportedTraffic(
			replyWith(traffic({ arrivalsPerMin: 0, directParticipants: 0 })),
			walkState({ observedMatches: 4, primaryId: 'primary-Y' }),
		);
		expect(result.trusted).to.equal(false);
		expect(result.reputationSignals.map((s) => s.kind)).to.deep.equal(['under-report-suspected']);
	});

	it('trusts a plausible report (no cross-check signal)', () => {
		const result = boundReportedTraffic(replyWith(traffic({ arrivalsPerMin: 90, directParticipants: 6 })), walkState({ observedMatches: 4 }));
		expect(result.trusted).to.equal(true);
		expect(result.reputationSignals).to.have.length(0);
	});

	it('omits subjectId when the walk state attributes no primary', () => {
		const result = boundReportedTraffic(replyWith(traffic({ directParticipants: 100 })), walkState({ observedMatches: 1 }));
		expect(result.reputationSignals[0]).to.not.have.property('subjectId');
	});

	it('maxWalkHops is (dMax + 1) * maxExtraHopsPerTier', () => {
		expect(maxWalkHops(2)).to.equal(3);
		expect(maxWalkHops(0)).to.equal(1);
	});
});

describe('matchmaking / traffic bounds — reputation cross-check bridge', () => {
	it('forwards attributed signals to the reputation subsystem as a ProtocolViolation', () => {
		const calls: Array<{ peerId: string; reason: PenaltyReason; context?: string }> = [];
		const reputation = { reportPeer: (peerId: string, reason: PenaltyReason, context?: string) => calls.push({ peerId, reason, context }) } as unknown as IPeerReputation;
		const signals: TrafficCrossCheckSignal[] = [
			{ kind: 'over-report-suspected', subjectId: 'primary-A', tier: 1, reportedDirectParticipants: 100, reportedArrivalsPerMin: 0, observedMatches: 0 },
			{ kind: 'under-report-suspected', tier: 0, reportedDirectParticipants: 0, reportedArrivalsPerMin: 0, observedMatches: 5 }, // no subjectId → skipped
		];
		reportTrafficCrossCheck(reputation, signals);
		expect(calls).to.have.length(1);
		expect(calls[0]!.peerId).to.equal('primary-A');
		expect(calls[0]!.reason).to.equal(PenaltyReason.ProtocolViolation);
		expect(calls[0]!.context).to.equal('matchmaking:over-report-suspected');
	});
});

// --- end-to-end adversarial walk over the real SeekerWalkClient -----------------------------------

function providerEntry(participantId: string): ProviderEntryV1 {
	const capabilities = ['pdf-render'];
	const capacityBudget = 2;
	return {
		participantId,
		capabilities,
		capacityBudget,
		contactHint: `c-${participantId}`,
		attachedAt: 1_000,
		registrationSig: fakeSign(providerSigningPayload(TOPIC_ID, capabilities, capacityBudget)),
	};
}

const queryReply = (providers: ProviderEntryV1[]): QueryReplyV1 => ({ ...replyWith(traffic()), providers });

/** A transport scripted per tier: it records registered tiers so spatial-flood absence is assertable. */
class ScriptedTransport implements SeekerWalkTransport {
	registeredTiers: number[] = [];
	renews = 0;
	withdraws = 0;
	constructor(
		private readonly probe: (tier: number) => SeekerProbeReply,
		private readonly providersAt: (tier: number) => ProviderEntryV1[],
	) {}
	async register(treeTier: number): Promise<SeekerProbeReply> {
		this.registeredTiers.push(treeTier);
		return this.probe(treeTier);
	}
	async query(treeTier: number): Promise<QueryReplyV1> {
		return queryReply(this.providersAt(treeTier));
	}
	async renew(): Promise<void> {
		this.renews++;
	}
	async withdraw(): Promise<void> {
		this.withdraws++;
	}
}

/** A virtual clock that only advances when the walk sleeps — so patience drains deterministically. */
function virtualTime(): { clock: () => number; sleep: (ms: number) => Promise<void>; now: () => number } {
	let now = 0;
	return { clock: () => now, sleep: async (ms: number) => { now += ms; }, now: () => now };
}

describe('matchmaking / traffic bounds — end-to-end adversarial walk', () => {
	it('UNDER-report: costs <= one extra register hop per under-reported tier, terminating at the root', async () => {
		const dMax = 2;
		const cold = (): SeekerProbeReply => ({ result: 'accepted', topicTraffic: traffic({ arrivalsPerMin: 0 }) });
		const hot = (): SeekerProbeReply => ({ result: 'accepted', topicTraffic: traffic({ arrivalsPerMin: 90, directParticipants: 6 }) });

		// Honest baseline: tier d_max is genuinely hot and its query already meets wantCount → stop at hops 1.
		const honestVt = virtualTime();
		const honest = new ScriptedTransport(
			() => hot(),
			(tier) => (tier === dMax ? [providerEntry('p1'), providerEntry('p2')] : []),
		);
		const honestResult = await new SeekerWalkClient({ transport: honest, topicId: TOPIC_ID, wantCount: 2, dMax, patienceMs: 5_000, verifyEntry: fakeVerify, clock: honestVt.clock, sleep: honestVt.sleep }).run();
		expect(honestResult.hops).to.equal(1);
		expect(honestResult.terminalTier).to.equal(dMax);

		// Adversarial: every tier under-reports cold; queries yield below wantCount until the root, where the
		// truth (2 providers) finally surfaces. The seeker escalates one hop per tier and terminates at root.
		const advVt = virtualTime();
		const adversarial = new ScriptedTransport(
			() => cold(),
			(tier) => (tier === 0 ? [providerEntry('p1'), providerEntry('p2')] : []),
		);
		const advResult = await new SeekerWalkClient({ transport: adversarial, topicId: TOPIC_ID, wantCount: 2, dMax, patienceMs: 5_000, verifyEntry: fakeVerify, clock: advVt.clock, sleep: advVt.sleep }).run();

		expect(advResult.terminalTier).to.equal(0); // terminates at the root
		expect(advResult.metWantCount).to.equal(true); // root holds the aggregated truth
		expect(advResult.hops).to.equal(dMax + 1); // exactly one register per tier — the toward-root maximum
		// The harm of under-reporting is bounded to one extra hop per under-reported tier (tiers d_max and 1).
		expect(advResult.hops - honestResult.hops).to.equal(dMax);
		expect(adversarial.registeredTiers).to.deep.equal([2, 1, 0]); // monotone toward root — never outward
	});

	it('OVER-report: harm bounded to wasted patience + one extra hop; no spatial flood', async () => {
		const dMax = 1;
		const patienceMs = 4_000;
		// Every tier fakes a hot rate but its query yields only one (distinct) provider — far below wantCount.
		const vt = virtualTime();
		const transport = new ScriptedTransport(
			() => ({ result: 'accepted', topicTraffic: traffic({ arrivalsPerMin: 5_000, directParticipants: 200 }) }),
			(tier) => [providerEntry(`p-${tier}`)],
		);
		const result = await new SeekerWalkClient({ transport, topicId: TOPIC_ID, wantCount: 5, dMax, patienceMs, verifyEntry: fakeVerify, clock: vt.clock, sleep: vt.sleep }).run();

		expect(vt.now()).to.be.at.most(patienceMs); // wasted patience never exceeds the budget
		expect(result.hops).to.be.at.most(dMax + 1); // wasted patience + one extra register→walk hop
		expect(result.metWantCount).to.equal(false);
		expect(result.terminalTier).to.equal(0);
		// No speculative outward probing — every registered tier is <= d_max and the walk is monotone inward.
		expect(transport.registeredTiers.every((t) => t <= dMax)).to.equal(true);
		expect([...transport.registeredTiers]).to.deep.equal([...transport.registeredTiers].sort((a, b) => b - a));
	});
});
