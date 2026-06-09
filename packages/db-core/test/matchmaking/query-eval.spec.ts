import { expect } from 'chai';
import { evaluateQuery, providerEntryOf } from '../../src/matchmaking/index.js';
import type {
	LocalProviderRegistration,
	LocalSeekerRegistration,
	ProviderAppPayloadV1,
	SeekerAppPayloadV1,
	QueryV1,
} from '../../src/matchmaking/index.js';

function providerReg(participantId: string, capabilities: string[], capacityBudget: number, attachedAt: number): LocalProviderRegistration {
	const payload: ProviderAppPayloadV1 = { kind: 'match-provider', capabilities, capacityBudget, contactHint: `c-${participantId}`, signature: 'AA' };
	return { participantId, attachedAt, payload };
}

function seekerReg(participantId: string, wantCount: number, attachedAt: number): LocalSeekerRegistration {
	const payload: SeekerAppPayloadV1 = { kind: 'match-seeker', wantCount, contactHint: `s-${participantId}`, signature: 'AA' };
	return { participantId, attachedAt, payload };
}

function query(partial: Partial<QueryV1> = {}): QueryV1 {
	return {
		v: 1,
		topicId: 'AA',
		includeProviders: true,
		includeSeekers: false,
		limit: 256,
		requesterId: 'seeker',
		timestamp: 1,
		signature: 'AA',
		...partial,
	};
}

describe('matchmaking / query evaluation (pure)', () => {
	it('builds a forwarded ProviderEntryV1 carrying the registration signature verbatim', () => {
		const entry = providerEntryOf(providerReg('p1', ['gpu'], 3, 100));
		expect(entry).to.deep.equal({ participantId: 'p1', capabilities: ['gpu'], capacityBudget: 3, contactHint: 'c-p1', attachedAt: 100, registrationSig: 'AA' });
	});

	it('returns matching providers, oldest-first (FCFS by attachedAt)', () => {
		const providers = [providerReg('b', ['gpu'], 2, 200), providerReg('a', ['gpu'], 2, 100), providerReg('c', ['gpu'], 2, 300)];
		const res = evaluateQuery(query(), providers, []);
		expect(res.providers!.map((p) => p.participantId)).to.deep.equal(['a', 'b', 'c']);
		expect(res.truncated).to.equal(false);
	});

	it('applies the capability filter (advisory) cohort-side', () => {
		const providers = [providerReg('a', ['gpu', 'pdf'], 4, 1), providerReg('b', ['gpu'], 4, 2), providerReg('c', ['gpu', 'pdf', 'beta'], 4, 3)];
		const res = evaluateQuery(query({ filter: { must: ['gpu', 'pdf'], mustNot: ['beta'] } }), providers, []);
		expect(res.providers!.map((p) => p.participantId)).to.deep.equal(['a']);
	});

	it('filters on minBudget', () => {
		const providers = [providerReg('a', ['x'], 1, 1), providerReg('b', ['x'], 5, 2)];
		const res = evaluateQuery(query({ filter: { must: [], mustNot: [], minBudget: 3 } }), providers, []);
		expect(res.providers!.map((p) => p.participantId)).to.deep.equal(['b']);
	});

	it('truncates to limit and flags truncated when more matched', () => {
		const providers = [1, 2, 3, 4, 5].map((n) => providerReg(`p${n}`, ['x'], 1, n));
		const res = evaluateQuery(query({ limit: 3 }), providers, []);
		expect(res.providers).to.have.length(3);
		expect(res.providers!.map((p) => p.participantId)).to.deep.equal(['p1', 'p2', 'p3']); // oldest kept
		expect(res.truncated).to.equal(true);
	});

	it('omits providers when includeProviders is false', () => {
		const res = evaluateQuery(query({ includeProviders: false }), [providerReg('a', ['x'], 1, 1)], []);
		expect(res.providers).to.equal(undefined);
		expect(res.truncated).to.equal(false);
	});

	it('includes seekers (oldest-first) when includeSeekers is set', () => {
		const seekers = [seekerReg('s2', 3, 20), seekerReg('s1', 5, 10)];
		const res = evaluateQuery(query({ includeProviders: false, includeSeekers: true }), [], seekers);
		expect(res.seekers!.map((s) => s.participantId)).to.deep.equal(['s1', 's2']);
		expect(res.seekers![0]).to.deep.equal({ participantId: 's1', wantCount: 5, contactHint: 's-s1', attachedAt: 10, registrationSig: 'AA' });
	});

	it('truncated reflects an over-limit seeker set too', () => {
		const seekers = [1, 2, 3].map((n) => seekerReg(`s${n}`, 1, n));
		const res = evaluateQuery(query({ includeProviders: false, includeSeekers: true, limit: 2 }), [], seekers);
		expect(res.seekers).to.have.length(2);
		expect(res.truncated).to.equal(true);
	});
});
