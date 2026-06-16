import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	bytesToB64url,
	matchTopicId,
	providerSigningPayload,
	type CapabilityFilter,
	type EntrySigVerifier,
	type ProviderEntryV1,
	type QueryReplyV1,
	type TopicTrafficV1,
} from '@optimystic/db-core';
import {
	SeekerWalkClient,
	type SeekerProbeReply,
	type SeekerWalkClientDeps,
	type SeekerWalkTransport,
} from '../../src/matchmaking/seeker-walk-client.js';

const topicId = matchTopicId('capability', 'pdf-render');
// Hash-as-signature stand-in (same trick as entry-verify.spec.ts in db-core): "sign" = sha256 of the
// canonical payload, "verify" = recompute and compare. Exercises the real signing-image reconstruction.
const fakeVerify: EntrySigVerifier = (_signerId, payload, sig) => bytesToB64url(sha256(payload)) === bytesToB64url(sig);

function entry(id: string, capabilities: string[] = ['pdf-render'], capacityBudget = 2): ProviderEntryV1 {
	return {
		participantId: id,
		capabilities,
		capacityBudget,
		contactHint: `c-${id}`,
		attachedAt: 1,
		registrationSig: bytesToB64url(sha256(providerSigningPayload(topicId, capabilities, capacityBudget))),
	};
}

const eight = Array.from({ length: 8 }, (_, i) => entry(`p${i}`));

// Traffic profiles from docs/matchmaking.md §Worked example.
const hot: TopicTrafficV1 = { windowSeconds: 30, arrivalsPerMin: 90, queriesPerMin: 4, directParticipants: 6, childCohortCount: 0 };
const thin: TopicTrafficV1 = { windowSeconds: 30, arrivalsPerMin: 8, queriesPerMin: 4, directParticipants: 1, childCohortCount: 0 };
const rootTraffic: TopicTrafficV1 = { windowSeconds: 30, arrivalsPerMin: 600, queriesPerMin: 4, directParticipants: 200, childCohortCount: 8 };
const quiet: TopicTrafficV1 = { windowSeconds: 30, arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: 0, childCohortCount: 0 };

const accepted = (topicTraffic?: TopicTrafficV1): SeekerProbeReply =>
	topicTraffic === undefined ? { result: 'accepted' } : { result: 'accepted', topicTraffic };

interface TierBehavior {
	probe: SeekerProbeReply;
	/** Providers returned per `QueryV1` at this tier; a function receives the per-tier query ordinal. */
	providers?: ProviderEntryV1[] | ((nthQuery: number) => ProviderEntryV1[]);
}

/** Fake substrate: scripted per-tier probe/query replies, virtual clock, recorded call sequence. */
class Harness {
	now = 0;
	readonly calls: string[] = [];
	readonly sleeps: number[] = [];
	private readonly queryCounts = new Map<number, number>();

	constructor(private readonly tiers: Record<number, TierBehavior>, private readonly hopCostMs = 0) {}

	readonly clock = (): number => this.now;
	readonly sleep = async (ms: number): Promise<void> => {
		this.sleeps.push(ms);
		this.now += ms;
	};

	readonly transport: SeekerWalkTransport = {
		register: async (d: number): Promise<SeekerProbeReply> => {
			this.calls.push(`register:${d}`);
			this.now += this.hopCostMs;
			return this.tiers[d]?.probe ?? { result: 'no_state' };
		},
		query: async (d: number): Promise<QueryReplyV1> => {
			this.calls.push(`query:${d}`);
			const n = this.queryCounts.get(d) ?? 0;
			this.queryCounts.set(d, n + 1);
			const p = this.tiers[d]?.providers;
			const providers = typeof p === 'function' ? p(n) : (p ?? []);
			return { v: 1, providers, truncated: false, cohortEpoch: 'AA', topicTraffic: quiet, signature: 'AA' };
		},
		renew: async (): Promise<void> => {
			this.calls.push('renew');
		},
		withdraw: async (): Promise<void> => {
			this.calls.push('withdraw');
		},
	};
}

function client(h: Harness, opts: Partial<SeekerWalkClientDeps> & Pick<SeekerWalkClientDeps, 'wantCount' | 'dMax' | 'patienceMs'>): SeekerWalkClient {
	return new SeekerWalkClient({
		transport: h.transport,
		topicId,
		verifyEntry: fakeVerify,
		clock: h.clock,
		sleep: h.sleep,
		...opts,
	});
}

describe('matchmaking / seeker walk client', () => {
	it('hot topic: deep tier suffices — stops at the first Accepted whose query meets wantCount', async () => {
		const h = new Harness({ 3: { probe: accepted(hot), providers: eight } });
		const result = await client(h, { wantCount: 8, dMax: 3, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.terminalTier).to.equal(3);
		expect(result.hops).to.equal(1);
		expect(h.calls).to.deep.equal(['register:3', 'query:3']); // no walk past the matching tier
	});

	it('worked example: 6 of 8 with arrivals 90 / queries 4 ⇒ hang out; renewals land the rest', async () => {
		const six = eight.slice(0, 6);
		const h = new Harness({ 1: { probe: accepted(hot), providers: (n) => (n === 0 ? six : eight) } });
		const result = await client(h, { wantCount: 8, dMax: 1, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.terminalTier).to.equal(1);
		expect(h.sleeps).to.deep.equal([1_000]); // one requery_interval_ms poll filled the set
		expect(h.calls).to.deep.equal(['register:1', 'query:1', 'renew', 'query:1']);
	});

	it('worked example contrast: thin shard ⇒ withdraw, walk to root, root query fills immediately', async () => {
		const h = new Harness({
			1: { probe: accepted(thin), providers: [entry('t0')] },
			0: { probe: accepted(rootTraffic), providers: eight },
		});
		const result = await client(h, { wantCount: 8, dMax: 1, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.terminalTier).to.equal(0);
		expect(result.hops).to.equal(2);
		expect(h.calls).to.deep.equal(['register:1', 'query:1', 'withdraw', 'register:0', 'query:0']);
	});

	it('cold topic: walks every tier from d_max to the root, withdrawing politely at each hop', async () => {
		const h = new Harness({
			3: { probe: accepted(quiet) },
			2: { probe: accepted(quiet) },
			1: { probe: accepted(quiet) },
			0: { probe: accepted(rootTraffic), providers: eight },
		});
		const result = await client(h, { wantCount: 8, dMax: 3, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.terminalTier).to.equal(0);
		expect(h.calls.filter((c) => c.startsWith('register'))).to.deep.equal(['register:3', 'register:2', 'register:1', 'register:0']);
		expect(h.calls.filter((c) => c === 'withdraw')).to.have.length(3);
	});

	it('borderline: hangs out for the full patience, polling at requery_interval_ms, and returns the partial set', async () => {
		const three = eight.slice(0, 3);
		const h = new Harness({ 0: { probe: accepted(hot), providers: three } });
		const result = await client(h, { wantCount: 8, dMax: 0, patienceMs: 5_000 }).run();
		expect(result.metWantCount).to.equal(false);
		expect(result.providers.map((p) => p.participantId)).to.deep.equal(['p0', 'p1', 'p2']);
		expect(result.terminalTier).to.equal(0);
		expect(h.sleeps).to.deep.equal([1_000, 1_000, 1_000, 1_000, 1_000]); // ≈ patienceMs / requery_interval_ms
		expect(h.calls.filter((c) => c === 'renew')).to.have.length(5);
		expect(h.calls.filter((c) => c === 'query:0')).to.have.length(6); // immediate + 5 polls
	});

	it('patience drains across walked tiers — the terminal hang-out sees only what the hops left', async () => {
		// Each register hop costs 1 s of the 4 s budget; tiers 2 and 1 are NoState, so the root
		// hang-out has 1 s left and gets exactly one poll instead of four.
		const h = new Harness({ 0: { probe: accepted(hot), providers: eight.slice(0, 3) } }, 1_000);
		const result = await client(h, { wantCount: 8, dMax: 2, patienceMs: 4_000 }).run();
		expect(result.metWantCount).to.equal(false);
		expect(h.sleeps).to.deep.equal([1_000]);
	});

	it('stale arrivalsPerMin = 0: issues the query first — a quiet-but-full cohort resolves done, no walk', async () => {
		const h = new Harness({ 2: { probe: accepted(quiet), providers: eight } });
		const result = await client(h, { wantCount: 8, dMax: 2, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.terminalTier).to.equal(2);
		expect(h.calls).to.deep.equal(['register:2', 'query:2']);
	});

	it('missing topicTraffic: walks one tier toward the root without hanging out', async () => {
		const h = new Harness({
			2: { probe: accepted(undefined), providers: [entry('a')] },
			1: { probe: accepted(hot), providers: eight },
		});
		const result = await client(h, { wantCount: 8, dMax: 2, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.terminalTier).to.equal(1);
		expect(h.sleeps).to.deep.equal([]); // never hung out at the traffic-less tier
		expect(h.calls).to.deep.equal(['register:2', 'query:2', 'withdraw', 'register:1', 'query:1']);
	});

	it('missing topicTraffic at the root: terminates with the partial set, no hang-out', async () => {
		const h = new Harness({ 0: { probe: accepted(undefined), providers: [entry('a')] } });
		const result = await client(h, { wantCount: 8, dMax: 0, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(false);
		expect(result.providers.map((p) => p.participantId)).to.deep.equal(['a']);
		expect(h.sleeps).to.deep.equal([]);
	});

	it('filter accept ratio decays across the walk: ~10% matchable shards force escalation to the root', async () => {
		const filter: CapabilityFilter = { must: ['x'], mustNot: [] };
		const shard = (prefix: string): ProviderEntryV1[] => [
			entry(`${prefix}-hit`, ['x']),
			...Array.from({ length: 9 }, (_, i) => entry(`${prefix}-miss${i}`, ['y'])),
		];
		// With filterAcceptRatio stuck at 1.0, tier 2 would hang out (1 + 15 ≥ 9.07). The observed 1/10
		// yield decays the ratio to 0.1 before decide() runs, collapsing expectedNewMatches to 1.5.
		const h = new Harness({
			2: { probe: accepted(hot), providers: shard('a') },
			1: { probe: accepted(hot), providers: shard('b') },
			0: { probe: accepted(rootTraffic), providers: Array.from({ length: 8 }, (_, i) => entry(`r${i}`, ['x'])) },
		});
		const result = await client(h, { wantCount: 8, dMax: 2, patienceMs: 10_000, filter }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.terminalTier).to.equal(0);
		expect(h.sleeps).to.deep.equal([]); // escalated every tier — never hung out
		expect(result.providers.map((p) => p.participantId)).to.include.members(['a-hit', 'b-hit']);
	});

	it('drops a forwarded entry whose registrationSig does not match the reconstructed signing image', async () => {
		const forged = { ...entry('evil'), capacityBudget: 99 }; // tampered after signing
		const h = new Harness({ 1: { probe: accepted(hot), providers: [entry('good'), forged] } });
		const result = await client(h, { wantCount: 1, dMax: 1, patienceMs: 10_000 }).run();
		expect(result.providers.map((p) => p.participantId)).to.deep.equal(['good']);
	});

	it('dedupes providers seen across successive queries by participantId', async () => {
		const [a, b, c] = [entry('A'), entry('B'), entry('C')];
		const h = new Harness({ 1: { probe: accepted(hot), providers: (n) => (n === 0 ? [a!, b!] : [b!, c!]) } });
		const result = await client(h, { wantCount: 3, dMax: 1, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.providers.map((p) => p.participantId)).to.deep.equal(['A', 'B', 'C']);
	});

	it('UnwillingCohort: hang-out is never entered — no query, no renew, standard back-off applies upstream', async () => {
		const h = new Harness({ 2: { probe: { result: 'unwilling_cohort' } } });
		const result = await client(h, { wantCount: 8, dMax: 2, patienceMs: 10_000 }).run();
		expect(result.providers).to.deep.equal([]);
		expect(result.terminalTier).to.equal(2);
		expect(h.calls).to.deep.equal(['register:2']);
	});

	it('Promoted: descends to the target tier and continues the walk there', async () => {
		const h = new Harness({
			2: { probe: { result: 'promoted', targetTier: 3 } },
			3: { probe: accepted(hot), providers: eight },
		});
		const result = await client(h, { wantCount: 8, dMax: 2, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.terminalTier).to.equal(3);
		expect(h.calls.filter((cl) => cl.startsWith('register'))).to.deep.equal(['register:2', 'register:3']);
	});

	it('records the hotness signal even when one hot cohort immediately meets wantCount (done path)', async () => {
		// rootTraffic.childCohortCount = 8; the immediate query already satisfies wantCount, so the walk
		// resolves `done` at the first tier. maxChildCohortCount must still surface the hotness so the
		// public session / voting QuorumDiscovery binding escalates to the representative sweep.
		const h = new Harness({ 2: { probe: accepted(rootTraffic), providers: eight } });
		const result = await client(h, { wantCount: 8, dMax: 2, patienceMs: 10_000 }).run();
		expect(result.metWantCount).to.equal(true);
		expect(result.hops).to.equal(1);
		expect(result.maxChildCohortCount).to.equal(8);
	});

	it('folds the max childCohortCount across walked tiers (hottest tier wins)', async () => {
		const h = new Harness({
			2: { probe: accepted(thin), providers: [entry('t0')] }, // childCohortCount 0
			1: { probe: accepted(rootTraffic), providers: [entry('t1')] }, // childCohortCount 8
			0: { probe: accepted(quiet), providers: eight },
		});
		const result = await client(h, { wantCount: 8, dMax: 2, patienceMs: 10_000 }).run();
		expect(result.maxChildCohortCount).to.equal(8);
	});

	it('honors a configured requeryIntervalMs for the hang-out poll cadence', async () => {
		const h = new Harness({ 0: { probe: accepted(hot), providers: eight.slice(0, 3) } });
		const result = await client(h, {
			wantCount: 8,
			dMax: 0,
			patienceMs: 1_000,
			config: { contentionFactorCap: 4.0, requeryIntervalMs: 500 },
		}).run();
		expect(result.metWantCount).to.equal(false);
		expect(h.sleeps).to.deep.equal([500, 500]);
	});
});
