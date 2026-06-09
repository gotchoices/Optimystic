import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	MatchmakingProvider,
	MatchmakingSeeker,
	matchTopicId,
	bytesToB64url,
	Tier,
	PROVIDER_TTL_CORE_MS,
	SEEKER_TTL_MS,
	type RegistrationRecord,
	type QueryV1,
	type TopicTrafficV1,
} from '@optimystic/db-core';
import { handleMatchmakingQuery } from '../../src/matchmaking/query-handler.js';

const utf8 = new TextEncoder();
const idBytes = (s: string): Uint8Array => utf8.encode(s);
const fakeSign = async (payload: Uint8Array): Promise<string> => bytesToB64url(sha256(payload));

const topicId = matchTopicId('capability', 'pdf-render');
const cohortEpoch = new Uint8Array(32).fill(7);
const traffic: TopicTrafficV1 = { windowSeconds: 30, arrivalsPerMin: 90, queriesPerMin: 4, directParticipants: 6, childCohortCount: 0 };

async function providerRecord(id: string, capabilities: string[], capacityBudget: number, attachedAt: number): Promise<RegistrationRecord> {
	const provider = new MatchmakingProvider({ topicId, capabilities, capacityBudget, contactHint: `c-${id}`, sign: fakeSign });
	return {
		topicId,
		participantId: idBytes(id),
		tier: Tier.T2,
		primary: idBytes('primary'),
		backups: [],
		attachedAt,
		lastPing: attachedAt,
		ttl: PROVIDER_TTL_CORE_MS,
		appState: await provider.appPayloadBytes(),
	};
}

async function seekerRecord(id: string, wantCount: number, attachedAt: number): Promise<RegistrationRecord> {
	const seeker = new MatchmakingSeeker({ topicId, wantCount, contactHint: `s-${id}`, sign: fakeSign });
	return {
		topicId,
		participantId: idBytes(id),
		tier: Tier.T2,
		primary: idBytes('primary'),
		backups: [],
		attachedAt,
		lastPing: attachedAt,
		ttl: SEEKER_TTL_MS,
		appState: await seeker.appPayloadBytes(),
	};
}

function query(partial: Partial<QueryV1> = {}): QueryV1 {
	return {
		v: 1,
		topicId: bytesToB64url(topicId),
		includeProviders: true,
		includeSeekers: false,
		limit: 256,
		requesterId: 'seeker',
		timestamp: 1,
		signature: 'AA',
		...partial,
	};
}

describe('matchmaking / cohort query handler', () => {
	it('returns filtered providers, cohortEpoch, topicTraffic, and a primary signature', async () => {
		const records = [
			await providerRecord('p1', ['pdf-render', 'gpu'], 4, 100),
			await providerRecord('p2', ['pdf-render'], 2, 200),
			await providerRecord('p3', ['gpu'], 4, 300), // fails must:[pdf-render]
		];
		const reply = await handleMatchmakingQuery(query({ filter: { must: ['pdf-render'], mustNot: [] } }), { records, topicTraffic: traffic, cohortEpoch, sign: fakeSign });
		expect(reply.providers!.map((p) => p.participantId)).to.deep.equal(['p1', 'p2']);
		expect(reply.cohortEpoch).to.equal(bytesToB64url(cohortEpoch));
		expect(reply.topicTraffic).to.deep.equal(traffic);
		expect(reply.truncated).to.equal(false);
		expect(reply.signature.length).to.be.greaterThan(0);
		expect(reply.seekers).to.equal(undefined);
	});

	it('forwards each provider registration signature verbatim for seeker re-validation', async () => {
		const records = [await providerRecord('p1', ['pdf-render'], 2, 100)];
		const reply = await handleMatchmakingQuery(query(), { records, topicTraffic: traffic, cohortEpoch, sign: fakeSign });
		const provider = new MatchmakingProvider({ topicId, capabilities: ['pdf-render'], capacityBudget: 2, contactHint: 'c-p1', sign: fakeSign });
		expect(reply.providers![0]!.registrationSig).to.equal((await provider.buildAppPayload()).signature);
	});

	it('truncates to limit and flags truncated', async () => {
		const records = await Promise.all([1, 2, 3, 4].map((n) => providerRecord(`p${n}`, ['x'], 1, n)));
		const reply = await handleMatchmakingQuery(query({ limit: 2 }), { records, topicTraffic: traffic, cohortEpoch, sign: fakeSign });
		expect(reply.providers).to.have.length(2);
		expect(reply.truncated).to.equal(true);
	});

	it('classifies seeker records separately from providers', async () => {
		const records = [await providerRecord('p1', ['x'], 1, 1), await seekerRecord('s1', 3, 2)];
		const providersOnly = await handleMatchmakingQuery(query(), { records, topicTraffic: traffic, cohortEpoch, sign: fakeSign });
		expect(providersOnly.providers!.map((p) => p.participantId)).to.deep.equal(['p1']);
		const withSeekers = await handleMatchmakingQuery(query({ includeProviders: false, includeSeekers: true }), { records, topicTraffic: traffic, cohortEpoch, sign: fakeSign });
		expect(withSeekers.seekers!.map((s) => s.participantId)).to.deep.equal(['s1']);
	});

	it('skips (and logs) a record whose appState is not a matchmaking payload', async () => {
		const bad: RegistrationRecord = {
			topicId,
			participantId: idBytes('junk'),
			tier: Tier.T2,
			primary: idBytes('primary'),
			backups: [],
			attachedAt: 1,
			lastPing: 1,
			ttl: PROVIDER_TTL_CORE_MS,
			appState: utf8.encode('{"kind":"not-matchmaking"}'),
		};
		const logged: string[] = [];
		const reply = await handleMatchmakingQuery(query(), {
			records: [await providerRecord('p1', ['x'], 1, 1), bad],
			topicTraffic: traffic,
			cohortEpoch,
			sign: fakeSign,
			log: (fmt) => logged.push(fmt),
		});
		expect(reply.providers!.map((p) => p.participantId)).to.deep.equal(['p1']);
		expect(logged).to.have.length(1);
	});
});
