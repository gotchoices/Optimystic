import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	MatchmakingProvider,
	MatchmakingSeeker,
	decodeProviderAppPayload,
	decodeSeekerAppPayload,
	matchTopicId,
	providerTtlForProfile,
	PROVIDER_TTL_CORE_MS,
	PROVIDER_TTL_EDGE_MS,
	SEEKER_TTL_MS,
} from '../../src/matchmaking/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import { createRegistrationStore } from '../../src/cohort-topic/registration/store.js';
import type { RegistrationRecord } from '../../src/cohort-topic/registration/types.js';
import { Tier } from '../../src/cohort-topic/tiers.js';
import { edgeProfile, coreProfile } from '../../src/cohort-topic/tiers.js';

function seededBytes(len: number, seed: number): Uint8Array {
	const out = new Uint8Array(len);
	let s = (seed * 2654435761) >>> 0;
	for (let i = 0; i < len; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		out[i] = (s >>> 24) & 0xff;
	}
	return out;
}

/** Deterministic stand-in for the libp2p peer-key signer: base64url(sha256(payload)). */
const fakeSign = async (payload: Uint8Array): Promise<string> => bytesToB64url(sha256(payload));

describe('matchmaking / provider state', () => {
	const topicId = matchTopicId('capability', 'pdf-render');
	const corr = seededBytes(16, 1);

	const makeProvider = (capacityBudget: number): MatchmakingProvider =>
		new MatchmakingProvider({
			topicId,
			capabilities: ['pdf-render', 'gpu'],
			capacityBudget,
			contactHint: '/ip4/10.0.0.1/tcp/4001',
			sign: fakeSign,
			correlationId: corr,
		});

	it('builds a signed payload reflecting the initial capacity', async () => {
		const provider = makeProvider(4);
		const payload = await provider.buildAppPayload();
		expect(payload.kind).to.equal('match-provider');
		expect(payload.capacityBudget).to.equal(4);
		expect(payload.capabilities).to.deep.equal(['pdf-render', 'gpu']);
		expect(payload.signature.length).to.be.greaterThan(0);
	});

	it('round-trips appPayloadBytes through the wire decoder', async () => {
		const provider = makeProvider(2);
		const decoded = decodeProviderAppPayload(await provider.appPayloadBytes());
		expect(decoded.capacityBudget).to.equal(2);
		expect(decoded.contactHint).to.equal('/ip4/10.0.0.1/tcp/4001');
	});

	it('signalFull sets capacityBudget to 0 (listed but full) and re-signs', async () => {
		const provider = makeProvider(4);
		const before = await provider.buildAppPayload();
		provider.signalFull();
		expect(provider.capacityBudget).to.equal(0);
		const after = await provider.buildAppPayload();
		expect(after.capacityBudget).to.equal(0);
		expect(after.signature).to.not.equal(before.signature);
	});

	it('setCapacity updates the live budget', () => {
		const provider = makeProvider(4);
		provider.setCapacity(1);
		expect(provider.capacityBudget).to.equal(1);
	});

	it('rejects a negative capacity', () => {
		const provider = makeProvider(4);
		expect(() => provider.setCapacity(-1)).to.throw(RangeError);
		expect(() => makeProvider(-2)).to.throw(RangeError);
	});

	it('records withdrawal intent', () => {
		const provider = makeProvider(4);
		expect(provider.withdrawn).to.equal(false);
		provider.markWithdrawn();
		expect(provider.withdrawn).to.equal(true);
	});

	it('generates a fresh correlationId when none is supplied', () => {
		let n = 0;
		const fakeRandom = (len: number): Uint8Array => seededBytes(len, ++n + 100);
		const provider = new MatchmakingProvider({ topicId, capabilities: [], capacityBudget: 1, contactHint: 'x', sign: fakeSign, randomBytes: fakeRandom });
		expect(provider.correlationId.length).to.equal(16);
	});
});

describe('matchmaking / seeker state', () => {
	const topicId = matchTopicId('task', 'cluster-validate');

	it('builds a signed seeker payload with filter + pushOnArrival', async () => {
		const seeker = new MatchmakingSeeker({
			topicId,
			wantCount: 8,
			contactHint: '/ip4/10.0.0.2/tcp/4001',
			filter: { must: ['eligible'], mustNot: [] },
			pushOnArrival: true,
			sign: fakeSign,
			correlationId: seededBytes(16, 2),
		});
		const decoded = decodeSeekerAppPayload(await seeker.appPayloadBytes());
		expect(decoded.wantCount).to.equal(8);
		expect(decoded.filter).to.deep.equal({ must: ['eligible'], mustNot: [] });
		expect(decoded.pushOnArrival).to.equal(true);
	});

	it('rejects wantCount below 1', () => {
		expect(() => new MatchmakingSeeker({ topicId, wantCount: 0, contactHint: 'x', sign: fakeSign })).to.throw(RangeError);
	});

	it('query() is a documented stub deferred to the next ticket', () => {
		const seeker = new MatchmakingSeeker({ topicId, wantCount: 1, contactHint: 'x', sign: fakeSign });
		expect(() => seeker.query()).to.throw(/matchmaking-query-filter-hangout/);
	});
});

describe('matchmaking / profile TTLs', () => {
	it('resolves Core/Edge provider TTLs', () => {
		expect(providerTtlForProfile(coreProfile())).to.equal(PROVIDER_TTL_CORE_MS);
		expect(providerTtlForProfile(edgeProfile())).to.equal(PROVIDER_TTL_EDGE_MS);
	});
});

describe('matchmaking / registration TTL semantics (over the cohort-topic store)', () => {
	const topicId = matchTopicId('capability', 'geocode-resolver');
	const t0 = 1_000_000;

	const baseRecord = (participantSeed: number, ttl: number, appState: Uint8Array): RegistrationRecord => ({
		topicId,
		participantId: seededBytes(32, participantSeed),
		tier: Tier.T2,
		primary: seededBytes(32, 900),
		backups: [seededBytes(32, 901)],
		attachedAt: t0,
		lastPing: t0,
		ttl,
		appState,
	});

	it('evicts a brief seeker registration on TTL while a renewed provider survives', async () => {
		const store = createRegistrationStore();

		const provider = new MatchmakingProvider({ topicId, capabilities: ['geocode-resolver'], capacityBudget: 2, contactHint: 'p', sign: fakeSign, correlationId: seededBytes(16, 10) });
		const seeker = new MatchmakingSeeker({ topicId, wantCount: 3, contactHint: 's', sign: fakeSign, correlationId: seededBytes(16, 11) });

		const providerRec = baseRecord(1, PROVIDER_TTL_CORE_MS, await provider.appPayloadBytes());
		const seekerRec = baseRecord(2, SEEKER_TTL_MS, await seeker.appPayloadBytes());
		store.put(providerRec);
		store.put(seekerRec);

		// Provider renews at ttl/3 (keep-alive touch) — its lastPing advances.
		providerRec.lastPing = t0 + 30_000;
		store.put(providerRec);

		// Just past the seeker TTL but well within the (renewed) provider TTL.
		const evicted = store.evictStale(t0 + SEEKER_TTL_MS + 1);

		const evictedSeekers = evicted.filter((r) => r.ttl === SEEKER_TTL_MS);
		expect(evictedSeekers).to.have.length(1);
		expect(store.getByParticipant(topicId, seekerRec.participantId)).to.equal(undefined);
		expect(store.getByParticipant(topicId, providerRec.participantId)).to.not.equal(undefined);
	});

	it('evicts a seeker that never renews and keeps no provider when the provider also stops renewing', async () => {
		const store = createRegistrationStore();
		const provider = new MatchmakingProvider({ topicId, capabilities: [], capacityBudget: 1, contactHint: 'p', sign: fakeSign, correlationId: seededBytes(16, 12) });
		const providerRec = baseRecord(3, PROVIDER_TTL_CORE_MS, await provider.appPayloadBytes());
		store.put(providerRec);

		// No renewal: provider ages out one ms past its TTL.
		const evicted = store.evictStale(t0 + PROVIDER_TTL_CORE_MS + 1);
		expect(evicted).to.have.length(1);
		expect(store.directParticipants(topicId)).to.equal(0);
	});

	it("a provider record's appState decodes back to its matchmaking payload", async () => {
		const provider = new MatchmakingProvider({ topicId, capabilities: ['geocode-resolver'], capacityBudget: 5, contactHint: 'p', sign: fakeSign, correlationId: seededBytes(16, 13) });
		const rec = baseRecord(4, PROVIDER_TTL_CORE_MS, await provider.appPayloadBytes());
		const decoded = decodeProviderAppPayload(rec.appState!);
		expect(decoded.kind).to.equal('match-provider');
		expect(decoded.capacityBudget).to.equal(5);
	});
});
