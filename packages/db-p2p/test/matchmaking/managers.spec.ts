import { expect } from 'chai';
import {
	MatchmakingProvider,
	MatchmakingSeeker,
	matchTopicId,
	decodeProviderAppPayload,
	decodeSeekerAppPayload,
	coreProfile,
	edgeProfile,
	Tier,
	PROVIDER_TTL_CORE_MS,
	PROVIDER_TTL_EDGE_MS,
	SEEKER_TTL_MS,
	type CohortTopicService,
	type RegisterRequest,
	type RegistrationHandle,
} from '@optimystic/db-core';
import { MatchmakingProviderManager } from '../../src/matchmaking/provider-manager.js';
import { MatchmakingSeekerManager } from '../../src/matchmaking/seeker-manager.js';

/**
 * Manager-tier coverage (gap #3 from the implement handoff): the db-p2p managers are thin wrappers
 * over `CohortTopicService`, but they carry real branching — TTL precedence (explicit > profile >
 * default), register-at-T2, capacity-change-is-a-re-register (the substrate `RenewV1` cannot carry a
 * payload), and the seeker's deliberate no-renew. A recording mock service pins all of it without a
 * live libp2p stack.
 */
class RecordingService implements CohortTopicService {
	readonly registers: RegisterRequest[] = [];
	renews = 0;
	withdraws = 0;

	async register(req: RegisterRequest): Promise<RegistrationHandle> {
		this.registers.push(req);
		return {
			topicId: req.topicId,
			tier: req.tier,
			primary: new Uint8Array(32),
			backups: [],
			cohortEpoch: new Uint8Array(32),
			renewal: {},
		} as unknown as RegistrationHandle;
	}
	async renew(_handle: RegistrationHandle): Promise<void> {
		this.renews++;
	}
	async lookup(): Promise<never> {
		throw new Error('lookup not used by managers');
	}
	async withdraw(_handle: RegistrationHandle): Promise<void> {
		this.withdraws++;
	}
	cohortGossip(): never {
		throw new Error('cohortGossip not used by managers');
	}
	verifier(): never {
		throw new Error('verifier not used by managers');
	}
}

const fakeSign = async (): Promise<string> => 'AA'; // valid base64url (1 byte)

const makeProvider = (capacityBudget: number): MatchmakingProvider =>
	new MatchmakingProvider({
		topicId: matchTopicId('capability', 'pdf-render'),
		capabilities: ['pdf-render'],
		capacityBudget,
		contactHint: '/ip4/10.0.0.1/tcp/4001',
		sign: fakeSign,
	});

describe('matchmaking / provider manager', () => {
	it('registers at tier T2 with the Core profile TTL and the signed payload', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingProviderManager({ service, provider: makeProvider(4), profile: coreProfile() });
		await manager.register();
		expect(service.registers).to.have.length(1);
		const req = service.registers[0]!;
		expect(req.tier).to.equal(Tier.T2);
		expect(req.ttl).to.equal(PROVIDER_TTL_CORE_MS);
		expect(decodeProviderAppPayload(req.appPayload!).capacityBudget).to.equal(4);
		expect(manager.registration).to.not.equal(undefined);
	});

	it('derives the shorter Edge TTL from an edge profile', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingProviderManager({ service, provider: makeProvider(1), profile: edgeProfile() });
		await manager.register();
		expect(service.registers[0]!.ttl).to.equal(PROVIDER_TTL_EDGE_MS);
	});

	it('prefers an explicit ttlMs over the profile-derived TTL', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingProviderManager({ service, provider: makeProvider(1), profile: coreProfile(), ttlMs: 12_345 });
		await manager.register();
		expect(service.registers[0]!.ttl).to.equal(12_345);
	});

	it('falls back to the Core default TTL when neither ttlMs nor profile is supplied', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingProviderManager({ service, provider: makeProvider(1) });
		await manager.register();
		expect(service.registers[0]!.ttl).to.equal(PROVIDER_TTL_CORE_MS);
	});

	it('signalFull re-registers (not renews) with capacityBudget = 0', async () => {
		const service = new RecordingService();
		const provider = makeProvider(4);
		const manager = new MatchmakingProviderManager({ service, provider });
		await manager.register();
		await manager.signalFull();
		expect(service.registers).to.have.length(2);
		expect(service.renews).to.equal(0);
		expect(decodeProviderAppPayload(service.registers[1]!.appPayload!).capacityBudget).to.equal(0);
		expect(provider.capacityBudget).to.equal(0);
	});

	it('setCapacity re-registers with the new budget', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingProviderManager({ service, provider: makeProvider(4) });
		await manager.register();
		await manager.setCapacity(1);
		expect(decodeProviderAppPayload(service.registers[1]!.appPayload!).capacityBudget).to.equal(1);
	});

	it('renew is a no-op before the first register', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingProviderManager({ service, provider: makeProvider(1) });
		await manager.renew();
		expect(service.renews).to.equal(0);
	});

	it('withdraw marks the provider withdrawn and drops the registration', async () => {
		const service = new RecordingService();
		const provider = makeProvider(2);
		const manager = new MatchmakingProviderManager({ service, provider });
		await manager.register();
		await manager.withdraw();
		expect(provider.withdrawn).to.equal(true);
		expect(service.withdraws).to.equal(1);
	});
});

describe('matchmaking / seeker manager', () => {
	const makeSeeker = (): MatchmakingSeeker =>
		new MatchmakingSeeker({ topicId: matchTopicId('task', 'cluster-validate'), wantCount: 3, contactHint: 's', sign: fakeSign });

	it('registers briefly at tier T2 with the short seeker TTL and never renews', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingSeekerManager({ service, seeker: makeSeeker() });
		await manager.register();
		expect(service.registers).to.have.length(1);
		const req = service.registers[0]!;
		expect(req.tier).to.equal(Tier.T2);
		expect(req.ttl).to.equal(SEEKER_TTL_MS);
		expect(decodeSeekerAppPayload(req.appPayload!).wantCount).to.equal(3);
		expect(service.renews).to.equal(0);
	});

	it('honors an explicit seeker ttlMs', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingSeekerManager({ service, seeker: makeSeeker(), ttlMs: 7_000 });
		await manager.register();
		expect(service.registers[0]!.ttl).to.equal(7_000);
	});

	it('withdraw drops the registration via the substrate', async () => {
		const service = new RecordingService();
		const manager = new MatchmakingSeekerManager({ service, seeker: makeSeeker() });
		await manager.register();
		await manager.withdraw();
		expect(service.withdraws).to.equal(1);
	});
});
