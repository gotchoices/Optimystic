import { expect } from 'chai';
import { selectArrivalPushTargets } from '../../src/matchmaking/index.js';
import type {
	ArrivalPushCandidate,
	CapabilityFilter,
	LocalProviderRegistration,
	ProviderAppPayloadV1,
	SeekerAppPayloadV1,
} from '../../src/matchmaking/index.js';

const PROVIDER_ARRIVED_AT = 10_000;

function provider(capacityBudget: number, capabilities: string[] = ['gpu'], attachedAt = PROVIDER_ARRIVED_AT): LocalProviderRegistration {
	const payload: ProviderAppPayloadV1 = { kind: 'match-provider', capabilities, capacityBudget, contactHint: 'c-p', signature: 'AA' };
	return { participantId: 'p', attachedAt, payload };
}

function pushSeeker(participantId: string, attachedAt: number, filter?: CapabilityFilter): ArrivalPushCandidate {
	const payload: SeekerAppPayloadV1 = {
		kind: 'match-seeker',
		wantCount: 1,
		contactHint: `s-${participantId}`,
		pushOnArrival: true,
		correlationId: 'AAAAAAAAAAAAAAAAAAAAAA',
		signature: 'AA',
		...(filter !== undefined ? { filter } : {}),
	};
	return { participantId, attachedAt, payload };
}

function pollSeeker(participantId: string, attachedAt: number): ArrivalPushCandidate {
	const payload: SeekerAppPayloadV1 = { kind: 'match-seeker', wantCount: 1, contactHint: `s-${participantId}`, correlationId: 'AAAAAAAAAAAAAAAAAAAAAA', signature: 'AA' };
	return { participantId, attachedAt, payload };
}

const ids = (targets: readonly ArrivalPushCandidate[]): string[] => targets.map((t) => t.participantId);

describe('matchmaking / arrival-push fan-out selection (pure)', () => {
	it('pushes a fresh arrival to the capacityBudget longest-waiting matching seekers', () => {
		const seekers = [pushSeeker('s3', 300), pushSeeker('s1', 100), pushSeeker('s5', 500), pushSeeker('s2', 200), pushSeeker('s4', 400)];
		expect(ids(selectArrivalPushTargets(provider(2), seekers))).to.deep.equal(['s1', 's2']);
	});

	it('skips poll-path seekers, which neither receive pushes nor use up fan-out', () => {
		const seekers = [pollSeeker('poll1', 100), pollSeeker('poll2', 200), pushSeeker('s3', 300), pushSeeker('s4', 400), pushSeeker('s5', 500)];
		expect(ids(selectArrivalPushTargets(provider(2), seekers))).to.deep.equal(['s3', 's4']);
	});

	it('does not push a listed-but-full provider (capacityBudget = 0)', () => {
		expect(selectArrivalPushTargets(provider(0), [pushSeeker('s1', 100)])).to.deep.equal([]);
	});

	it('excludes filter misses, minBudget included, without spending a fan-out slot on them', () => {
		const seekers = [
			pushSeeker('mustMiss', 100, { must: ['tpu'], mustNot: [] }),
			pushSeeker('budgetMiss', 150, { must: [], mustNot: [], minBudget: 3 }),
			pushSeeker('s3', 300, { must: ['gpu'], mustNot: [] }),
			pushSeeker('s4', 400),
			pushSeeker('s5', 500),
		];
		expect(ids(selectArrivalPushTargets(provider(2), seekers))).to.deep.equal(['s3', 's4']);
	});

	it('does not push a provider to a seeker that attached after it', () => {
		const seekers = [pushSeeker('before', PROVIDER_ARRIVED_AT - 1), pushSeeker('after', PROVIDER_ARRIVED_AT + 1)];
		expect(ids(selectArrivalPushTargets(provider(4), seekers))).to.deep.equal(['before']);
	});
});
