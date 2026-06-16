import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	matchTopicId,
	bytesToB64url,
	decodeProviderAppPayload,
	decodeSeekerAppPayload,
	providerSigningPayload,
	Tier,
	PROVIDER_TTL_CORE_MS,
	SEEKER_TTL_MS,
	coreProfile,
	type CohortTopicService,
	type RegisterRequest,
	type RegistrationHandle,
	type QueryV1,
	type QueryReplyV1,
	type TopicTrafficV1,
	type ProviderEntryV1,
	type AggregateCountV1,
	type EntrySigVerifier,
	type MultiCohortSweepPorts,
	type SweepShardQuery,
	type QuorumDiscoveryRequest,
} from '@optimystic/db-core';
import {
	MatchmakingProviderSession,
	MatchmakingSeekerSession,
	createMatchmakingQuorumDiscovery,
	type MatchTopicRef,
} from '../../src/matchmaking/module.js';
import { type SeekerProbeReply, type SeekerWalkTransport } from '../../src/matchmaking/seeker-walk-client.js';

/**
 * Public matchmaking module (`docs/matchmaking.md` §Overview): the provider/seeker sessions wired to
 * `CohortTopicService` plus the voting `QuorumDiscovery` binding. The substrate I/O (walk transport,
 * one-shot query, d_max estimate, sweep ports) is injected, so this exercises the composition without a
 * live libp2p stack.
 */
const fakeSign = async (payload: Uint8Array): Promise<string> => bytesToB64url(sha256(payload));
const fakeVerify: EntrySigVerifier = (_id, payload, sig) => bytesToB64url(sha256(payload)) === bytesToB64url(sig);

const PROVIDER_TOPIC: MatchTopicRef = { kind: 'capability', label: 'pdf-render' };
const TOPIC_ID = matchTopicId('capability', 'pdf-render');

class RecordingService implements CohortTopicService {
	readonly registers: RegisterRequest[] = [];
	renews = 0;
	withdraws = 0;
	async register(req: RegisterRequest): Promise<RegistrationHandle> {
		this.registers.push(req);
		return { topicId: req.topicId, tier: req.tier, primary: new Uint8Array(32), backups: [], cohortEpoch: new Uint8Array(32), renewal: {} } as unknown as RegistrationHandle;
	}
	async renew(): Promise<void> {
		this.renews++;
	}
	async lookup(): Promise<never> {
		throw new Error('lookup not used');
	}
	async withdraw(): Promise<void> {
		this.withdraws++;
	}
	cohortGossip(): never {
		throw new Error('cohortGossip not used');
	}
	verifier(): never {
		throw new Error('verifier not used');
	}
}

function providerEntry(participantId: string): ProviderEntryV1 {
	const capabilities = ['pdf-render'];
	const capacityBudget = 2;
	return {
		participantId,
		capabilities,
		capacityBudget,
		contactHint: `c-${participantId}`,
		attachedAt: 1_000,
		registrationSig: bytesToB64url(sha256(providerSigningPayload(TOPIC_ID, capabilities, capacityBudget))),
	};
}

const traffic = (partial: Partial<TopicTrafficV1> = {}): TopicTrafficV1 => ({ windowSeconds: 30, arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: 0, childCohortCount: 0, ...partial });
const queryReply = (providers: ProviderEntryV1[]): QueryReplyV1 => ({ v: 1, providers, truncated: false, cohortEpoch: bytesToB64url(new Uint8Array(32).fill(1)), topicTraffic: traffic(), signature: bytesToB64url(new Uint8Array(64).fill(2)) });

/** A walk transport returning a fixed probe reply + per-tier query providers. */
class FixedWalkTransport implements SeekerWalkTransport {
	constructor(private readonly probe: SeekerProbeReply, private readonly providers: ProviderEntryV1[]) {}
	async register(): Promise<SeekerProbeReply> {
		return this.probe;
	}
	async query(): Promise<QueryReplyV1> {
		return queryReply(this.providers);
	}
	async renew(): Promise<void> {}
	async withdraw(): Promise<void> {}
}

/** A sweep ports mock: a single non-empty shard of `swept` providers. */
function fixedSweepPorts(swept: ProviderEntryV1[]): MultiCohortSweepPorts {
	const aggregate: AggregateCountV1 = {
		v: 1,
		topicId: bytesToB64url(TOPIC_ID),
		bucketCounts: [{ targetTier: 1, prefixSlot: 0, count: 16 }],
		signature: bytesToB64url(new Uint8Array(64).fill(3)),
		signers: [bytesToB64url(new Uint8Array(38).fill(4))],
		cohortEpoch: bytesToB64url(new Uint8Array(32).fill(5)),
	};
	return {
		async fetchAggregate(): Promise<AggregateCountV1 | undefined> {
			return aggregate;
		},
		async queryShard(_shard: SweepShardQuery): Promise<readonly ProviderEntryV1[]> {
			return swept;
		},
	};
}

function virtualTime(): { clock: () => number; sleep: (ms: number) => Promise<void> } {
	let now = 0;
	return { clock: () => now, sleep: async (ms: number) => { now += ms; } };
}

describe('matchmaking / module — provider session', () => {
	it('register builds the signed provider and registers at tier T2 (Core TTL) for the topic anchor', async () => {
		const service = new RecordingService();
		const session = new MatchmakingProviderSession({ service, sign: fakeSign, profile: coreProfile() });
		await session.register(PROVIDER_TOPIC, { capabilities: ['pdf-render'], capacityBudget: 4, contactHint: '/ip4/10.0.0.1/tcp/4001' });

		expect(service.registers).to.have.length(1);
		const req = service.registers[0]!;
		expect(req.tier).to.equal(Tier.T2);
		expect(req.ttl).to.equal(PROVIDER_TTL_CORE_MS);
		expect(bytesToB64url(req.topicId)).to.equal(bytesToB64url(TOPIC_ID));
		expect(decodeProviderAppPayload(req.appPayload!).capacityBudget).to.equal(4);
		expect(session.registration).to.not.equal(undefined);
	});

	it('signalFull re-registers with capacityBudget = 0; renew/withdraw delegate', async () => {
		const service = new RecordingService();
		const session = new MatchmakingProviderSession({ service, sign: fakeSign });
		await session.register(PROVIDER_TOPIC, { capabilities: ['pdf-render'], capacityBudget: 4, contactHint: 'c' });
		await session.signalFull();
		expect(decodeProviderAppPayload(service.registers[1]!.appPayload!).capacityBudget).to.equal(0);
		await session.renew();
		expect(service.renews).to.equal(1);
		await session.withdraw();
		expect(service.withdraws).to.equal(1);
	});

	it('setCapacity before register throws a clear error', async () => {
		const session = new MatchmakingProviderSession({ service: new RecordingService(), sign: fakeSign });
		let threw = false;
		try {
			await session.setCapacity(1);
		} catch (err) {
			threw = true;
			expect((err as Error).message).to.match(/register/);
		}
		expect(threw).to.equal(true);
	});
});

describe('matchmaking / module — seeker session', () => {
	const SEEKER_TOPIC: MatchTopicRef = { kind: 'task', label: 'cluster-validate' };

	it('register registers briefly at tier T2 with the short seeker TTL', async () => {
		const service = new RecordingService();
		const session = new MatchmakingSeekerSession({ service, sign: fakeSign, verifyEntry: fakeVerify, walkTransport: () => new FixedWalkTransport({ result: 'no_state' }, []), queryCohort: async () => queryReply([]), estimateDMax: async () => 0 });
		await session.register(SEEKER_TOPIC, { wantCount: 3, contactHint: 's' });
		expect(service.registers[0]!.tier).to.equal(Tier.T2);
		expect(service.registers[0]!.ttl).to.equal(SEEKER_TTL_MS);
		expect(decodeSeekerAppPayload(service.registers[0]!.appPayload!).wantCount).to.equal(3);
		expect(service.renews).to.equal(0); // seeker never renews by default
	});

	it('query delegates to the injected one-shot cohort query', async () => {
		let captured: QueryV1 | undefined;
		const session = new MatchmakingSeekerSession({
			service: new RecordingService(),
			sign: fakeSign,
			verifyEntry: fakeVerify,
			walkTransport: () => new FixedWalkTransport({ result: 'no_state' }, []),
			queryCohort: async (q) => { captured = q; return queryReply([providerEntry('p1')]); },
			estimateDMax: async () => 0,
		});
		const q: QueryV1 = { v: 1, topicId: bytesToB64url(TOPIC_ID), includeProviders: true, includeSeekers: false, limit: 16, requesterId: 'me', timestamp: 1, signature: 'AA' };
		const reply = await session.query(q);
		expect(captured).to.equal(q);
		expect(reply.providers!.map((p) => p.participantId)).to.deep.equal(['p1']);
	});

	it('walk escalates to the multi-cohort sweep on a hot topic and unions the swept providers', async () => {
		const vt = virtualTime();
		// d=0 root is hot (childCohortCount>0) but its single-cohort query yields only p1 (< wantCount 3).
		const session = new MatchmakingSeekerSession({
			service: new RecordingService(),
			sign: fakeSign,
			verifyEntry: fakeVerify,
			walkTransport: () => new FixedWalkTransport({ result: 'accepted', topicTraffic: traffic({ childCohortCount: 4, arrivalsPerMin: 0 }) }, [providerEntry('p1')]),
			queryCohort: async () => queryReply([]),
			estimateDMax: async () => 0,
			sweepPorts: () => fixedSweepPorts([providerEntry('p2'), providerEntry('p3')]),
			clock: vt.clock,
			sleep: vt.sleep,
		});
		const providers = await session.walk(PROVIDER_TOPIC, { wantCount: 3, patienceMs: 2_000 });
		expect(providers.map((p) => p.participantId).sort()).to.deep.equal(['p1', 'p2', 'p3']);
	});

	it('walk does not sweep a cold topic (no sweep ports consulted)', async () => {
		const vt = virtualTime();
		let sweepConsulted = false;
		const session = new MatchmakingSeekerSession({
			service: new RecordingService(),
			sign: fakeSign,
			verifyEntry: fakeVerify,
			walkTransport: () => new FixedWalkTransport({ result: 'accepted', topicTraffic: traffic({ childCohortCount: 0, arrivalsPerMin: 0 }) }, [providerEntry('p1'), providerEntry('p2')]),
			queryCohort: async () => queryReply([]),
			estimateDMax: async () => 0,
			sweepPorts: () => { sweepConsulted = true; return fixedSweepPorts([]); },
			clock: vt.clock,
			sleep: vt.sleep,
		});
		const providers = await session.walk(PROVIDER_TOPIC, { wantCount: 2, patienceMs: 2_000 });
		expect(providers.map((p) => p.participantId).sort()).to.deep.equal(['p1', 'p2']);
		expect(sweepConsulted).to.equal(false); // cold + wantCount met → no sweep
	});
});

describe('matchmaking / module — quorum discovery binding', () => {
	it('walk surfaces the matched entries plus the hotness signal', async () => {
		const vt = virtualTime();
		const discovery = createMatchmakingQuorumDiscovery({
			verifyEntry: fakeVerify,
			walkTransport: () => new FixedWalkTransport({ result: 'accepted', topicTraffic: traffic({ childCohortCount: 2, arrivalsPerMin: 0 }) }, [providerEntry('v1')]),
			estimateDMax: async () => 0,
			sweepPorts: () => fixedSweepPorts([]),
			clock: vt.clock,
			sleep: vt.sleep,
		});
		const req: QuorumDiscoveryRequest = { topicId: TOPIC_ID, wantCount: 3, patienceMs: 2_000 };
		const slice = await discovery.walk(req);
		expect(slice.entries.map((e) => e.participantId)).to.deep.equal(['v1']);
		expect(slice.childCohortCount).to.equal(2);
	});

	it('sweep returns the unioned swept entries with childCohortCount 0 (no double-escalation)', async () => {
		const discovery = createMatchmakingQuorumDiscovery({
			verifyEntry: fakeVerify,
			walkTransport: () => new FixedWalkTransport({ result: 'no_state' }, []),
			estimateDMax: async () => 0,
			sweepPorts: () => fixedSweepPorts([providerEntry('v2'), providerEntry('v3')]),
		});
		const slice = await discovery.sweep({ topicId: TOPIC_ID, wantCount: 64, patienceMs: 5_000 });
		expect(slice.entries.map((e) => e.participantId).sort()).to.deep.equal(['v2', 'v3']);
		expect(slice.childCohortCount).to.equal(0);
	});
});
