import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	createTrafficCounters,
	attachTopicTraffic,
	toCohortTopicSummary,
	DEFAULT_TRAFFIC_WINDOW_SECONDS,
} from '../../src/cohort-topic/traffic.js';
import { createCohortView, type MutableCohortView } from '../../src/cohort-topic/gossip/view.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import type { RegisterReplyV1, RegisterResult, TopicTrafficV1, CohortTopicSummary } from '../../src/cohort-topic/wire/types.js';

const TOPIC = sha256(new TextEncoder().encode('topic-T')).slice(0, 32);
const TOPIC_B64 = bytesToB64url(TOPIC);
const EPOCH = sha256(new TextEncoder().encode('epoch')).slice(0, 32);
const SELF = 'self-member';

/** A `directParticipants`-only store stub returning a fixed cohort-wide stock count. */
function storeStub(count: number): { directParticipants: () => number } {
	return { directParticipants: () => count };
}

function addSiblingSummary(view: MutableCohortView, member: string, summary: Partial<CohortTopicSummary>): void {
	const full: CohortTopicSummary = {
		topicId: TOPIC_B64,
		tier: 1,
		directParticipants: 0,
		arrivalsPerMin: 0,
		queriesPerMin: 0,
		promoted: false,
		childCohortCount: 0,
		...summary,
	};
	view.merge(member, {
		cohortEpoch: EPOCH,
		willingness: 0b1111,
		loadBuckets: [0, 0, 0, 0],
		windowSeconds: 60,
		topicSummaries: [full],
		timestamp: 1_000,
	});
}

describe('cohort-topic / traffic counters', () => {
	it('rejects a non-positive observation window', () => {
		expect(() => createTrafficCounters({ view: createCohortView(), store: storeStub(0), selfMember: SELF, windowSeconds: 0 })).to.throw(RangeError);
		expect(() => createTrafficCounters({ view: createCohortView(), store: storeStub(0), selfMember: SELF, windowSeconds: -1 })).to.throw(RangeError);
	});

	it('echoes a custom observation window in the snapshot', () => {
		const tc = createTrafficCounters({ view: createCohortView(), store: storeStub(0), selfMember: SELF, windowSeconds: 30 });
		expect(tc.snapshot(TOPIC).windowSeconds).to.equal(30);
	});

	it('reports zeros for a topic that was never observed', () => {
		const tc = createTrafficCounters({ view: createCohortView(), store: storeStub(0), selfMember: SELF });
		expect(tc.published(TOPIC)).to.deep.equal({ arrivals: 0, queries: 0 });
		const snap = tc.snapshot(TOPIC);
		expect(snap.arrivalsPerMin).to.equal(0);
		expect(snap.queriesPerMin).to.equal(0);
		expect(snap.childCohortCount).to.equal(0);
	});

	it('combines fresh registrations and renewals into one arrivals scalar', () => {
		const tc = createTrafficCounters({ view: createCohortView(), store: storeStub(0), selfMember: SELF });
		tc.recordArrival(TOPIC, 1_000); // fresh registration
		tc.recordArrival(TOPIC, 2_000); // renewal — same counter
		tc.recordQuery(TOPIC, 2_500);
		const pub = tc.publish(TOPIC, 3_000);
		expect(pub.arrivals, 'fresh + renewal combined').to.equal(2);
		expect(pub.queries).to.equal(1);
	});

	it('counts exact integers over the sliding window and prunes stale events', () => {
		const tc = createTrafficCounters({ view: createCohortView(), store: storeStub(0), selfMember: SELF, windowSeconds: 60 });
		tc.recordArrival(TOPIC, 500); // before the cutoff → outside the [now-60s, now] window
		tc.recordArrival(TOPIC, 1_000); // exactly at the cutoff (now-60s) → inside
		tc.recordArrival(TOPIC, 30_000);
		const pub = tc.publish(TOPIC, 61_000); // cutoff = 1_000
		expect(pub.arrivals).to.equal(2); // the 500ms event pruned
	});

	it('snapshot is gossip-derived: own last-published, not a live recompute', () => {
		const tc = createTrafficCounters({ view: createCohortView(), store: storeStub(7), selfMember: SELF });
		tc.recordArrival(TOPIC, 1_000);
		tc.publish(TOPIC, 1_000); // freeze arrivals = 1
		tc.recordArrival(TOPIC, 1_500); // a new arrival AFTER the freeze — must not show until next publish
		const snap = tc.snapshot(TOPIC);
		expect(snap.arrivalsPerMin, 'reflects frozen publish, lags ≤ one round').to.equal(1);
		expect(snap.directParticipants).to.equal(7);
		expect(snap.windowSeconds).to.equal(DEFAULT_TRAFFIC_WINDOW_SECONDS);
	});

	it('aggregates own + sibling gossiped summaries (exact-integer sums)', () => {
		const view = createCohortView();
		addSiblingSummary(view, 'sib-1', { arrivalsPerMin: 3, queriesPerMin: 1, childCohortCount: 2 });
		addSiblingSummary(view, 'sib-2', { arrivalsPerMin: 4, queriesPerMin: 5, childCohortCount: 0 });
		const tc = createTrafficCounters({ view, store: storeStub(12), selfMember: SELF });
		tc.recordArrival(TOPIC, 1_000);
		tc.recordArrival(TOPIC, 1_100);
		tc.recordQuery(TOPIC, 1_200);
		tc.publish(TOPIC, 2_000); // own: arrivals 2, queries 1

		const snap = tc.snapshot(TOPIC);
		expect(snap.arrivalsPerMin).to.equal(2 + 3 + 4);
		expect(snap.queriesPerMin).to.equal(1 + 1 + 5);
		expect(snap.directParticipants).to.equal(12);
		expect(snap.childCohortCount, 'max child-cohort count across the cohort').to.equal(2);
	});

	it('does not double-count its own gossiped summary if echoed back into the view', () => {
		const view = createCohortView();
		// Self appears in the view (e.g. a fan-out transport echoes own broadcast) — must be skipped.
		addSiblingSummary(view, SELF, { arrivalsPerMin: 99, queriesPerMin: 99 });
		const tc = createTrafficCounters({ view, store: storeStub(0), selfMember: SELF });
		tc.recordArrival(TOPIC, 1_000);
		tc.publish(TOPIC, 1_000);
		expect(tc.snapshot(TOPIC).arrivalsPerMin).to.equal(1);
	});

	it('resets to zero on cohortEpoch change; a single post-rotation zero is a valid reading', () => {
		const tc = createTrafficCounters({ view: createCohortView(), store: storeStub(0), selfMember: SELF });
		tc.recordArrival(TOPIC, 1_000);
		tc.publish(TOPIC, 1_000);
		expect(tc.snapshot(TOPIC).arrivalsPerMin).to.equal(1);

		tc.reset(); // cohortEpoch rotated
		const snap = tc.snapshot(TOPIC);
		expect(snap.arrivalsPerMin, 'under-reports as zero for one round').to.equal(0);
		expect(snap.queriesPerMin).to.equal(0);
		// Consumers can still read every field — a zero does not throw or produce NaN.
		expect(snap.windowSeconds).to.equal(DEFAULT_TRAFFIC_WINDOW_SECONDS);
		expect(snap.directParticipants).to.equal(0);
		expect(snap.childCohortCount).to.equal(0);
	});

	it('childCohortCount override (promotion layer) takes precedence over the gossiped max', () => {
		const view = createCohortView();
		addSiblingSummary(view, 'sib', { childCohortCount: 1 });
		const tc = createTrafficCounters({ view, store: storeStub(0), selfMember: SELF, childCohortCount: () => 16 });
		expect(tc.snapshot(TOPIC).childCohortCount).to.equal(16);
	});
});

describe('cohort-topic / traffic reply wiring', () => {
	const traffic: TopicTrafficV1 = {
		windowSeconds: 60,
		arrivalsPerMin: 5,
		queriesPerMin: 2,
		directParticipants: 10,
		childCohortCount: 0,
	};

	function reply(result: RegisterResult): RegisterReplyV1 {
		return { v: 1, result };
	}

	it('attaches traffic on accepted and promoted only', () => {
		expect(attachTopicTraffic(reply('accepted'), traffic).topicTraffic).to.deep.equal(traffic);
		expect(attachTopicTraffic(reply('promoted'), traffic).topicTraffic).to.deep.equal(traffic);
	});

	it('omits traffic on no_state and the unwilling_* results', () => {
		for (const r of ['no_state', 'unwilling_member', 'unwilling_cohort'] as RegisterResult[]) {
			expect(attachTopicTraffic(reply(r), traffic).topicTraffic, `omitted on ${r}`).to.be.undefined;
		}
	});

	it('builds a cohort-topic summary from published counts plus caller-supplied fields', () => {
		const summary = toCohortTopicSummary(TOPIC, { arrivals: 4, queries: 3 }, {
			tier: 1,
			directParticipants: 9,
			promoted: true,
			childCohortCount: 2,
		});
		expect(summary).to.deep.equal({
			topicId: TOPIC_B64,
			tier: 1,
			directParticipants: 9,
			arrivalsPerMin: 4,
			queriesPerMin: 3,
			promoted: true,
			childCohortCount: 2,
		});
	});
});
