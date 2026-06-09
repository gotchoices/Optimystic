import { expect } from 'chai';
import {
	encodeProviderAppPayload,
	decodeProviderAppPayload,
	encodeSeekerAppPayload,
	decodeSeekerAppPayload,
	encodeQueryV1,
	decodeQueryV1,
	encodeQueryReplyV1,
	decodeQueryReplyV1,
	encodeAggregateCountV1,
	decodeAggregateCountV1,
	providerSigningPayload,
	seekerSigningPayload,
	DEFAULT_MAX_APP_PAYLOAD_BYTES,
	QUERY_LIMIT_MAX,
} from '../../src/matchmaking/index.js';
import type {
	ProviderAppPayloadV1,
	SeekerAppPayloadV1,
	QueryV1,
	QueryReplyV1,
	AggregateCountV1,
} from '../../src/matchmaking/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import { CohortWireError } from '../../src/cohort-topic/wire/validate.js';

/** Deterministic pseudo-random bytes (no Math.random — keeps the test reproducible). */
function seededBytes(len: number, seed: number): Uint8Array {
	const out = new Uint8Array(len);
	let s = (seed * 2654435761) >>> 0;
	for (let i = 0; i < len; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		out[i] = (s >>> 24) & 0xff;
	}
	return out;
}

const b64 = (len: number, seed: number): string => bytesToB64url(seededBytes(len, seed));

const sampleProvider = (): ProviderAppPayloadV1 => ({
	kind: 'match-provider',
	capabilities: ['pdf-render', 'gpu'],
	capacityBudget: 4,
	serviceUntil: 1_700_000_100_000,
	contactHint: '/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWProvider',
	signature: b64(64, 1),
});

const sampleSeeker = (): SeekerAppPayloadV1 => ({
	kind: 'match-seeker',
	wantCount: 8,
	filter: { must: ['pdf-render'], mustNot: ['deprecated'], minBudget: 1 },
	contactHint: '/ip4/10.0.0.2/tcp/4001/p2p/12D3KooWSeeker',
	pushOnArrival: true,
	signature: b64(64, 2),
});

const sampleQuery = (): QueryV1 => ({
	v: 1,
	topicId: b64(32, 3),
	includeProviders: true,
	includeSeekers: false,
	filter: { must: ['pdf-render'], mustNot: [] },
	limit: 16,
	requesterId: '12D3KooWRequester',
	timestamp: 1_700_000_000_000,
	signature: b64(64, 4),
});

const sampleQueryReply = (): QueryReplyV1 => ({
	v: 1,
	providers: [
		{
			participantId: '12D3KooWP1',
			capabilities: ['pdf-render'],
			capacityBudget: 2,
			contactHint: '/ip4/10.0.0.3/tcp/4001',
			attachedAt: 1_700_000_001_000,
			registrationSig: b64(64, 5),
		},
	],
	seekers: [
		{
			participantId: '12D3KooWS1',
			wantCount: 3,
			contactHint: '/ip4/10.0.0.4/tcp/4001',
			attachedAt: 1_700_000_002_000,
			registrationSig: b64(64, 6),
		},
	],
	truncated: false,
	cohortEpoch: b64(32, 7),
	topicTraffic: { windowSeconds: 60, arrivalsPerMin: 90, queriesPerMin: 4, directParticipants: 6, childCohortCount: 0 },
	signature: b64(64, 8),
});

const sampleAggregate = (): AggregateCountV1 => ({
	v: 1,
	topicId: b64(32, 9),
	bucketCounts: [
		{ targetTier: 1, prefixSlot: 0, count: 8 },
		{ targetTier: 1, prefixSlot: 3, count: 64 },
	],
	signature: b64(64, 10),
	cohortEpoch: b64(32, 11),
});

describe('matchmaking wire', () => {
	describe('app payloads (opaque RegisterV1.appPayload bytes)', () => {
		it('round-trips a provider payload losslessly', () => {
			const decoded = decodeProviderAppPayload(encodeProviderAppPayload(sampleProvider()));
			expect(decoded).to.deep.equal(sampleProvider());
		});

		it('round-trips a provider payload without serviceUntil', () => {
			const { serviceUntil: _drop, ...minimal } = sampleProvider();
			const decoded = decodeProviderAppPayload(encodeProviderAppPayload(minimal));
			expect(decoded).to.not.have.property('serviceUntil');
			expect(decoded).to.deep.equal(minimal);
		});

		it('round-trips a seeker payload losslessly', () => {
			const decoded = decodeSeekerAppPayload(encodeSeekerAppPayload(sampleSeeker()));
			expect(decoded).to.deep.equal(sampleSeeker());
		});

		it('round-trips a seeker payload without optional filter/pushOnArrival', () => {
			const { filter: _f, pushOnArrival: _p, ...minimal } = sampleSeeker();
			const decoded = decodeSeekerAppPayload(encodeSeekerAppPayload(minimal));
			expect(decoded).to.not.have.property('filter');
			expect(decoded).to.not.have.property('pushOnArrival');
			expect(decoded).to.deep.equal(minimal);
		});

		it('preserves capacityBudget = 0 (listed-but-full) exactly', () => {
			const full = { ...sampleProvider(), capacityBudget: 0 };
			expect(decodeProviderAppPayload(encodeProviderAppPayload(full)).capacityBudget).to.equal(0);
		});

		it('rejects a wrong kind discriminant', () => {
			const bad = { ...sampleProvider(), kind: 'match-seeker' };
			expect(() => decodeProviderAppPayload(new TextEncoder().encode(JSON.stringify(bad)))).to.throw(CohortWireError, /kind/);
		});

		it('rejects a negative capacityBudget', () => {
			const bad = { ...sampleProvider(), capacityBudget: -1 };
			expect(() => decodeProviderAppPayload(new TextEncoder().encode(JSON.stringify(bad)))).to.throw(CohortWireError, /capacityBudget/);
		});

		it('rejects a seeker wantCount below 1', () => {
			const bad = { ...sampleSeeker(), wantCount: 0 };
			expect(() => decodeSeekerAppPayload(new TextEncoder().encode(JSON.stringify(bad)))).to.throw(CohortWireError, /wantCount/);
		});

		it('rejects a signature that is not base64url', () => {
			const bad = { ...sampleProvider(), signature: 'not valid base64url!!' };
			expect(() => decodeProviderAppPayload(new TextEncoder().encode(JSON.stringify(bad)))).to.throw(CohortWireError, /base64url/);
		});

		it('rejects an oversized app payload', () => {
			const bytes = encodeProviderAppPayload(sampleProvider());
			expect(() => decodeProviderAppPayload(bytes, 8)).to.throw(CohortWireError, /exceeds max/);
		});

		it('rejects non-JSON payload bytes', () => {
			expect(() => decodeProviderAppPayload(new TextEncoder().encode('not json'))).to.throw(CohortWireError, /JSON/);
		});

		it('has a non-trivial default app-payload ceiling', () => {
			expect(DEFAULT_MAX_APP_PAYLOAD_BYTES).to.be.greaterThan(1024);
		});
	});

	describe('query protocol (length-framed)', () => {
		const cases: Array<[string, () => { v: 1 }, (b: Uint8Array) => unknown]> = [
			['QueryV1', sampleQuery, decodeQueryV1 as (b: Uint8Array) => unknown],
			['QueryReplyV1', sampleQueryReply, decodeQueryReplyV1 as (b: Uint8Array) => unknown],
			['AggregateCountV1', sampleAggregate, decodeAggregateCountV1 as (b: Uint8Array) => unknown],
		];

		it('encodes then decodes each message losslessly', () => {
			expect(decodeQueryV1(encodeQueryV1(sampleQuery()))).to.deep.equal(sampleQuery());
			expect(decodeQueryReplyV1(encodeQueryReplyV1(sampleQueryReply()))).to.deep.equal(sampleQueryReply());
			expect(decodeAggregateCountV1(encodeAggregateCountV1(sampleAggregate()))).to.deep.equal(sampleAggregate());
		});

		it('round-trips a QueryReply with neither providers nor seekers present', () => {
			const minimal: QueryReplyV1 = {
				v: 1,
				truncated: true,
				cohortEpoch: b64(32, 12),
				topicTraffic: { windowSeconds: 60, arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: 0, childCohortCount: 0 },
				signature: b64(64, 13),
			};
			const decoded = decodeQueryReplyV1(encodeQueryReplyV1(minimal));
			expect(decoded).to.not.have.property('providers');
			expect(decoded).to.not.have.property('seekers');
			expect(decoded).to.deep.equal(minimal);
		});

		it('accepts a limit at exactly query_limit_max', () => {
			const atMax = { ...sampleQuery(), limit: QUERY_LIMIT_MAX };
			expect(decodeQueryV1(encodeQueryV1(atMax)).limit).to.equal(QUERY_LIMIT_MAX);
		});

		it('rejects a limit over query_limit_max', () => {
			const bad = { ...sampleQuery(), limit: QUERY_LIMIT_MAX + 1 };
			expect(() => encodeQueryV1(bad)).to.throw(CohortWireError, /limit/);
		});

		it('rejects a limit below 1', () => {
			const bad = { ...sampleQuery(), limit: 0 };
			expect(() => encodeQueryV1(bad)).to.throw(CohortWireError, /limit/);
		});

		it('rejects a query reply provider entry with a non-base64url registrationSig', () => {
			const reply = sampleQueryReply();
			const bad = { ...reply, providers: [{ ...reply.providers![0]!, registrationSig: '!!bad!!' }] };
			expect(() => encodeQueryReplyV1(bad as QueryReplyV1)).to.throw(CohortWireError, /base64url/);
		});

		it('rejects a frame whose body exceeds the supplied ceiling', () => {
			expect(() => encodeQueryV1(sampleQuery(), 16)).to.throw(CohortWireError, /max_message_bytes/);
		});

		it('rejects v !== 1', () => {
			const bad = { ...sampleQuery(), v: 2 };
			expect(() => encodeQueryV1(bad as unknown as QueryV1)).to.throw(CohortWireError, /v === 1/);
		});
	});

	describe('byte fidelity', () => {
		it('keeps topicId/signature byte-stable across a Query round-trip (encode→decode→encode)', () => {
			const once = encodeQueryV1(sampleQuery());
			const twice = encodeQueryV1(decodeQueryV1(once));
			expect([...twice]).to.deep.equal([...once]);
		});

		it('keeps a provider payload byte-stable across re-encode', () => {
			const once = encodeProviderAppPayload(sampleProvider());
			const twice = encodeProviderAppPayload(decodeProviderAppPayload(once));
			expect([...twice]).to.deep.equal([...once]);
		});
	});

	describe('signing payloads', () => {
		it('is deterministic for identical inputs (provider)', () => {
			const topicId = seededBytes(32, 50);
			const corr = seededBytes(16, 51);
			const a = providerSigningPayload(topicId, ['x', 'y'], 4, corr);
			const b = providerSigningPayload(topicId, ['x', 'y'], 4, corr);
			expect([...a]).to.deep.equal([...b]);
		});

		it('differs when capacityBudget changes (provider re-signs on capacity change)', () => {
			const topicId = seededBytes(32, 52);
			const corr = seededBytes(16, 53);
			const a = providerSigningPayload(topicId, ['x'], 4, corr);
			const b = providerSigningPayload(topicId, ['x'], 0, corr);
			expect([...a]).to.not.deep.equal([...b]);
		});

		it('is deterministic for identical inputs (seeker)', () => {
			const topicId = seededBytes(32, 54);
			const corr = seededBytes(16, 55);
			const a = seekerSigningPayload(topicId, 8, corr);
			const b = seekerSigningPayload(topicId, 8, corr);
			expect([...a]).to.deep.equal([...b]);
		});
	});
});
