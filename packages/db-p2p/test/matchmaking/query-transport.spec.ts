import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	MatchmakingProvider,
	MatchmakingSeeker,
	matchTopicId,
	createTierAddressing,
	createRingHash,
	createTrafficCounters,
	encodeQueryV1,
	decodeQueryReplyV1,
	bytesToB64url,
	bytesEqual,
	Tier,
	PROVIDER_TTL_CORE_MS,
	SEEKER_TTL_MS,
	type RegistrationRecord,
	type QueryV1,
	type TopicTrafficV1,
} from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { createMatchmakingQueryHandler } from '../../src/matchmaking/query-transport.js';
import type { CoordEngine, CoordRegistry } from '../../src/cohort-topic/host.js';

// The serve transport is the production binding around the pure `handleMatchmakingQuery`; these unit tests
// exercise the transport-only branches the gated e2e (§5b of substrate-real-libp2p) cannot cheaply reach:
// the no-serving-engine DoS guard, the gate seam, the cold-probe empty reply, undecodable-appState skip, and
// the malformed-frame drop. The happy path / filter semantics live in query-handler.spec.ts + query-eval.

const utf8 = new TextEncoder();
const idBytes = (s: string): Uint8Array => utf8.encode(s);
const fakeSign = async (payload: Uint8Array): Promise<string> => bytesToB64url(sha256(payload));
const addressing = createTierAddressing(createRingHash());
const topicId = matchTopicId('capability', 'pdf-render');
const cohortEpoch = new Uint8Array(32).fill(7);
const traffic: TopicTrafficV1 = { windowSeconds: 30, arrivalsPerMin: 90, queriesPerMin: 4, directParticipants: 6, childCohortCount: 0 };
const remotePeer = { toString: (): string => 'remote-peer' } as unknown as PeerId;

async function providerRecord(id: string, capabilities: string[], capacityBudget: number): Promise<RegistrationRecord> {
	const provider = new MatchmakingProvider({ topicId, capabilities, capacityBudget, contactHint: `c-${id}`, sign: fakeSign });
	return {
		topicId,
		participantId: idBytes(id),
		tier: Tier.T2,
		primary: idBytes('primary'),
		backups: [],
		attachedAt: 1,
		lastPing: 1,
		ttl: PROVIDER_TTL_CORE_MS,
		appState: await provider.appPayloadBytes(),
	};
}

async function seekerRecord(id: string, wantCount: number): Promise<RegistrationRecord> {
	const seeker = new MatchmakingSeeker({ topicId, wantCount, contactHint: `s-${id}`, sign: fakeSign });
	return {
		topicId,
		participantId: idBytes(id),
		tier: Tier.T2,
		primary: idBytes('primary'),
		backups: [],
		attachedAt: 1,
		lastPing: 1,
		ttl: SEEKER_TTL_MS,
		appState: await seeker.appPayloadBytes(),
	};
}

/** A record whose `appState` is not a matchmaking payload (a foreign app sharing the cohort). */
function foreignRecord(id: string): RegistrationRecord {
	return {
		topicId,
		participantId: idBytes(id),
		tier: Tier.T2,
		primary: idBytes('primary'),
		backups: [],
		attachedAt: 1,
		lastPing: 1,
		ttl: PROVIDER_TTL_CORE_MS,
		appState: utf8.encode('not-a-matchmaking-payload{'),
	};
}

/** A query-accounting bump the stub engine's `recordQuery` spy captured. */
interface RecordedQuery { topicId: Uint8Array; now: number; }

/**
 * A stub CoordEngine exposing only the read surface the serve transport touches, plus a `recordQuery`
 * spy: every call is pushed onto `calls` so a test can assert the accounting seam fired exactly once
 * with the served `topicId` and the injected clock's `now`.
 */
function stubEngine(records: readonly RegistrationRecord[], calls: RecordedQuery[] = []): CoordEngine {
	return {
		records: (): readonly RegistrationRecord[] => records,
		topicTraffic: (): TopicTrafficV1 => traffic,
		recordQuery: (t: Uint8Array, now: number): void => { calls.push({ topicId: t, now }); },
		cohort: (): { cohortEpoch: Uint8Array } => ({ cohortEpoch }),
	} as unknown as CoordEngine;
}

/**
 * A stub registry whose lookups return `engine` (or undefined). `forCoord` throws so any test that
 * accidentally drives the handler down an instantiation path fails loudly — the no-engine guard must
 * never create an engine from an inbound query (DoS amplifier).
 */
function stubRegistry(engine: CoordEngine | undefined): CoordRegistry {
	return {
		findServing: (): CoordEngine | undefined => engine,
		findByCoord: (): CoordEngine | undefined => engine,
		forCoord: (): never => { throw new Error('forCoord must never be called from the query serve path'); },
	} as unknown as CoordRegistry;
}

function query(partial: Partial<QueryV1> = {}): QueryV1 {
	return {
		v: 1,
		topicId: bytesToB64url(topicId),
		includeProviders: true,
		includeSeekers: false,
		limit: 256,
		requesterId: 'self-asserted-requester',
		timestamp: 1,
		signature: 'AA',
		...partial,
	};
}

const frameOf = (q: QueryV1): Uint8Array => encodeQueryV1(q);

describe('matchmaking / query serve transport', () => {
	it('serves the cohort provider set when an engine is serving the topic', async () => {
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(stubEngine([await providerRecord('p1', ['gpu'], 4)])), addressing, sign: fakeSign });
		const replyFrame = await handle(frameOf(query()), remotePeer);
		expect(replyFrame, 'a serving engine produces a reply frame').to.not.equal(undefined);
		const reply = decodeQueryReplyV1(replyFrame!);
		expect(reply.providers?.length, 'the reply carries the provider').to.equal(1);
		expect(reply.providers![0]!.participantId).to.equal('p1');
		expect(reply.topicTraffic.directParticipants).to.equal(6);
		expect(reply.signature.length, 'the reply is single-member signed').to.be.greaterThan(0);
	});

	it('returns no reply (and never instantiates an engine) when no engine serves the topic', async () => {
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(undefined), addressing, sign: fakeSign });
		const replyFrame = await handle(frameOf(query()), remotePeer);
		expect(replyFrame, 'no serving engine → no reply frame (DoS guard)').to.equal(undefined);
	});

	it('gates on the connection-verified `from` peer, not the self-asserted requesterId', async () => {
		let gated: { from: string; topic: Uint8Array } | undefined;
		const handle = createMatchmakingQueryHandler({
			registry: stubRegistry(stubEngine([await providerRecord('p1', ['gpu'], 4)])),
			addressing,
			sign: fakeSign,
			gate: (from: PeerId, t: Uint8Array): boolean => { gated = { from: from.toString(), topic: t }; return false; },
		});
		const replyFrame = await handle(frameOf(query({ requesterId: 'liar' })), remotePeer);
		expect(replyFrame, 'a gate rejection drops the query with no reply').to.equal(undefined);
		expect(gated?.from, 'the gate sees the verified remote peer').to.equal('remote-peer');
		expect(gated?.from, 'the gate does NOT see the self-asserted requesterId').to.not.equal('liar');
		expect(bytesEqual(gated!.topic, topicId), 'the gate sees the decoded topicId').to.equal(true);
	});

	it('serves a valid empty reply on a cold probe (engine serving, zero records)', async () => {
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(stubEngine([])), addressing, sign: fakeSign });
		const reply = decodeQueryReplyV1((await handle(frameOf(query()), remotePeer))!);
		expect(reply.providers ?? [], 'no providers on an empty cohort').to.deep.equal([]);
		expect(reply.topicTraffic, 'topicTraffic still attached').to.not.equal(undefined);
		expect(reply.signature.length, 'the empty reply is still signed').to.be.greaterThan(0);
	});

	it('skips records whose appState is not a matchmaking payload and still replies', async () => {
		const records = [foreignRecord('foreign'), await providerRecord('p1', ['gpu'], 4)];
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(stubEngine(records)), addressing, sign: fakeSign });
		const reply = decodeQueryReplyV1((await handle(frameOf(query()), remotePeer))!);
		expect(reply.providers?.length, 'only the decodable provider is served').to.equal(1);
		expect(reply.providers![0]!.participantId).to.equal('p1');
	});

	it('passes the query limit through to evaluateQuery (no transport-side re-clamp)', async () => {
		const records = [await providerRecord('p1', ['gpu'], 4), await providerRecord('p2', ['gpu'], 4)];
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(stubEngine(records)), addressing, sign: fakeSign });
		const reply = decodeQueryReplyV1((await handle(frameOf(query({ limit: 1 })), remotePeer))!);
		expect(reply.providers?.length, 'limit=1 truncates to one provider').to.equal(1);
		expect(reply.truncated, 'the reply flags truncation').to.equal(true);
	});

	it('honors includeSeekers / includeProviders selection', async () => {
		const records = [await providerRecord('p1', ['gpu'], 4), await seekerRecord('s1', 2)];
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(stubEngine(records)), addressing, sign: fakeSign });
		const reply = decodeQueryReplyV1((await handle(frameOf(query({ includeProviders: false, includeSeekers: true })), remotePeer))!);
		expect(reply.providers, 'providers omitted when not requested').to.equal(undefined);
		expect(reply.seekers?.length, 'the seeker is served when requested').to.equal(1);
		expect(reply.seekers![0]!.participantId).to.equal('s1');
	});

	it('drops a malformed (undecodable) frame with no reply', async () => {
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(stubEngine([])), addressing, sign: fakeSign });
		expect(await handle(Uint8Array.from([1, 2, 3, 4]), remotePeer), 'an undecodable frame yields no reply').to.equal(undefined);
	});

	it('drops to no reply (never throws) when the reply build fails', async () => {
		// A transient signer rejection must surface as a clean no-reply, not a thrown error out of the handler
		// (the outer handleRequestResponse would otherwise abort the stream). Mirrors the recover serve handler.
		const handle = createMatchmakingQueryHandler({
			registry: stubRegistry(stubEngine([await providerRecord('p1', ['gpu'], 4)])),
			addressing,
			sign: async (): Promise<string> => { throw new Error('signer offline'); },
		});
		expect(await handle(frameOf(query()), remotePeer), 'a sign failure drops to no reply').to.equal(undefined);
	});

	it('records exactly one query-accounting bump with the served topicId and the injected clock', async () => {
		const calls: RecordedQuery[] = [];
		const handle = createMatchmakingQueryHandler({
			registry: stubRegistry(stubEngine([await providerRecord('p1', ['gpu'], 4)], calls)),
			addressing,
			sign: fakeSign,
			clock: (): number => 12345,
		});
		await handle(frameOf(query()), remotePeer);
		expect(calls.length, 'exactly one accounting bump for one served query').to.equal(1);
		expect(bytesEqual(calls[0]!.topicId, topicId), 'the bump keys on the served topicId').to.equal(true);
		expect(calls[0]!.now, 'the bump stamps the injected clock').to.equal(12345);
	});

	it('feeds queriesPerMin end-to-end: a served query surfaces in a subsequent snapshot after publish (lags one round)', async () => {
		// Drive a REAL TrafficCounters through the handler's `recordQuery` bump. `now` must agree between the
		// injected `clock` and the `publish`/`snapshot` timestamps, else the sliding-window prune drops the event
		// (virtual-time note: a real host would use Date.now for both; here we pin both to `now`).
		const now = 1000;
		const counters = createTrafficCounters({
			view: { get: () => undefined, all: () => new Map() } as unknown as Parameters<typeof createTrafficCounters>[0]['view'],
			store: { directParticipants: (): number => 0 },
			selfMember: 'self',
		});
		const engine = { ...stubEngine([]), recordQuery: (t: Uint8Array, n: number): void => counters.recordQuery(t, n) } as unknown as CoordEngine;
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(engine), addressing, sign: fakeSign, clock: (): number => now });

		await handle(frameOf(query()), remotePeer);
		// Self-increment lag: the recording query's own snapshot (before any publish) still reads the pre-bump value.
		expect(counters.snapshot(topicId).queriesPerMin, 'the bump is not visible before the next round freezes it').to.equal(0);
		// The next gossip round freezes the window; now the served query surfaces.
		counters.publish(topicId, now);
		expect(counters.snapshot(topicId).queriesPerMin, 'one served query in-window → queriesPerMin > 0').to.equal(1);
	});

	it('records nothing when no engine serves the topic (never reaches recordQuery)', async () => {
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(undefined), addressing, sign: fakeSign });
		// `stubRegistry(undefined).forCoord` throws, so a reached instantiation path would fail loudly.
		expect(await handle(frameOf(query()), remotePeer), 'no serving engine → no reply').to.equal(undefined);
	});

	it('records nothing on a gate rejection', async () => {
		const calls: RecordedQuery[] = [];
		const handle = createMatchmakingQueryHandler({
			registry: stubRegistry(stubEngine([await providerRecord('p1', ['gpu'], 4)], calls)),
			addressing,
			sign: fakeSign,
			gate: (): boolean => false,
		});
		expect(await handle(frameOf(query()), remotePeer), 'a gate rejection drops the query').to.equal(undefined);
		expect(calls.length, 'a gate-rejected query never bumps the barometer').to.equal(0);
	});

	it('records nothing on a malformed frame', async () => {
		const calls: RecordedQuery[] = [];
		const handle = createMatchmakingQueryHandler({ registry: stubRegistry(stubEngine([], calls)), addressing, sign: fakeSign });
		expect(await handle(Uint8Array.from([1, 2, 3, 4]), remotePeer), 'an undecodable frame yields no reply').to.equal(undefined);
		expect(calls.length, 'a decode failure throws before topicId resolves → no bump').to.equal(0);
	});
});
