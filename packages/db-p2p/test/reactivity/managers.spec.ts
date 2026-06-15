import { expect } from 'chai';
import {
	Tier,
	reactivityTopicId,
	decodeSubscribeAppPayload,
	bytesToB64url,
	coreProfile,
	edgeProfile,
	buildNotificationV1,
	SUBSCRIBER_TTL_CORE_MS,
	SUBSCRIBER_TTL_EDGE_MS,
	DELTA_MAX_CORE_BYTES,
	type CohortTopicService,
	type RegisterRequest,
	type RegistrationHandle,
	type MembershipVerifier,
	type VerifyResult,
	type NotificationV1,
	type CollectionChangeEvent,
	type CommitCert,
} from '@optimystic/db-core';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { ReactivitySubscriptionManager } from '../../src/reactivity/subscription-manager.js';
import { ReactivityOriginationManager } from '../../src/reactivity/origination-manager.js';

/** A membership verifier with a fixed verdict — the managers only need it to resolve a verdict. */
class FixedVerifier implements MembershipVerifier {
	constructor(private readonly verdict: VerifyResult = 'verified') {}
	cache(): void {}
	verifyMessage(): Promise<VerifyResult> {
		return Promise.resolve(this.verdict);
	}
}

/** Recording mock cohort-topic service (mirrors the matchmaking manager tests). */
class RecordingService implements CohortTopicService {
	readonly registers: RegisterRequest[] = [];
	renews = 0;
	withdraws = 0;
	onLocalCommit?: (event: CollectionChangeEvent, commitCert: CommitCert) => void;

	constructor(private readonly verifierImpl: MembershipVerifier = new FixedVerifier('verified')) {}

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
	async renew(): Promise<void> {
		this.renews++;
	}
	async lookup(): Promise<never> {
		throw new Error('lookup not used by managers');
	}
	async withdraw(): Promise<void> {
		this.withdraws++;
	}
	cohortGossip(): never {
		throw new Error('cohortGossip not used by managers');
	}
	verifier(): MembershipVerifier {
		return this.verifierImpl;
	}
}

const COLLECTION = new Uint8Array([1, 2, 3, 4]);
const TAIL = new Uint8Array([9, 9, 9, 9]);

describe('reactivity / subscription manager', () => {
	it('registers at tier T3 with the tail-anchored topic and the subscribe payload', async () => {
		const service = new RecordingService();
		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: COLLECTION,
			tailIdAtAttach: TAIL,
			deliver: () => {},
			profile: coreProfile(),
		});
		await manager.register();
		expect(service.registers).to.have.length(1);
		const req = service.registers[0]!;
		expect(req.tier).to.equal(Tier.T3);
		expect([...req.topicId]).to.deep.equal([...reactivityTopicId(TAIL)]);
		expect(req.ttl).to.equal(SUBSCRIBER_TTL_CORE_MS);
		const payload = decodeSubscribeAppPayload(req.appPayload!);
		expect(payload.kind).to.equal('reactivity');
		expect(payload.collectionId).to.equal(bytesToB64url(COLLECTION));
		expect(payload.tailIdAtAttach).to.equal(bytesToB64url(TAIL));
	});

	it('derives the shorter Edge TTL and declines deltas by default on Edge', async () => {
		const service = new RecordingService();
		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: COLLECTION,
			tailIdAtAttach: TAIL,
			deliver: () => {},
			profile: edgeProfile(),
		});
		await manager.register();
		expect(service.registers[0]!.ttl).to.equal(SUBSCRIBER_TTL_EDGE_MS);
		expect(decodeSubscribeAppPayload(service.registers[0]!.appPayload!).deltaMaxBytes).to.equal(0);
	});

	it('derives the Core delta budget from the profile when not given explicitly', async () => {
		const service = new RecordingService();
		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: COLLECTION,
			tailIdAtAttach: TAIL,
			deliver: () => {},
			profile: coreProfile(),
		});
		await manager.register();
		expect(decodeSubscribeAppPayload(service.registers[0]!.appPayload!).deltaMaxBytes).to.equal(DELTA_MAX_CORE_BYTES);
	});

	it('prefers an explicit deltaMaxBytes over the profile-derived budget', async () => {
		const service = new RecordingService();
		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: COLLECTION,
			tailIdAtAttach: TAIL,
			deliver: () => {},
			profile: coreProfile(),
			deltaMaxBytes: 123,
		});
		await manager.register();
		expect(decodeSubscribeAppPayload(service.registers[0]!.appPayload!).deltaMaxBytes).to.equal(123);
	});

	it('prefers an explicit ttlMs over the profile-derived TTL', async () => {
		const service = new RecordingService();
		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: COLLECTION,
			tailIdAtAttach: TAIL,
			deliver: () => {},
			profile: coreProfile(),
			ttlMs: 12_345,
		});
		await manager.register();
		expect(service.registers[0]!.ttl).to.equal(12_345);
	});

	it('renew is a no-op before the first register; withdraw drops via the substrate', async () => {
		const service = new RecordingService();
		const manager = new ReactivitySubscriptionManager({ service, collectionId: COLLECTION, tailIdAtAttach: TAIL, deliver: () => {} });
		await manager.renew();
		expect(service.renews).to.equal(0);
		await manager.register();
		await manager.withdraw();
		expect(service.withdraws).to.equal(1);
	});

	it('delivers a verified, contiguous notification through the db-core delivery path', async () => {
		const service = new RecordingService(new FixedVerifier('verified'));
		const delivered: number[] = [];
		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: COLLECTION,
			tailIdAtAttach: TAIL,
			deliver: (n) => delivered.push(n.revision),
			lastKnownRev: 41,
		});
		const n: NotificationV1 = {
			v: 1,
			collectionId: bytesToB64url(COLLECTION),
			tailId: bytesToB64url(TAIL),
			revision: 42,
			digest: bytesToB64url(new Uint8Array([42])),
			timestamp: 1_700_000_000_000,
			sig: bytesToB64url(new Uint8Array([0xaa])),
			signers: [bytesToB64url(new Uint8Array([8]))],
		};
		expect(await manager.onNotification(n)).to.equal('delivered');
		expect(delivered).to.deep.equal([42]);
		expect(manager.lastRevision).to.equal(42);
	});

	it('drops an untrusted notification', async () => {
		const service = new RecordingService(new FixedVerifier('untrusted'));
		const delivered: number[] = [];
		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: COLLECTION,
			tailIdAtAttach: TAIL,
			deliver: (n) => delivered.push(n.revision),
			lastKnownRev: 41,
		});
		const n: NotificationV1 = {
			v: 1,
			collectionId: bytesToB64url(COLLECTION),
			tailId: bytesToB64url(TAIL),
			revision: 42,
			digest: bytesToB64url(new Uint8Array([42])),
			timestamp: 1_700_000_000_000,
			sig: bytesToB64url(new Uint8Array([0xaa])),
			signers: [bytesToB64url(new Uint8Array([8]))],
		};
		expect(await manager.onNotification(n)).to.equal('untrusted');
		expect(delivered).to.have.length(0);
	});
});

describe('reactivity / origination manager', () => {
	const event: CollectionChangeEvent = {
		collectionId: bytesToB64url(COLLECTION),
		blockIds: [bytesToB64url(new Uint8Array([5, 6]))],
		actionId: 'action-xyz',
		rev: 7,
	};
	const cert: CommitCert = {
		thresholdSig: new Uint8Array([10, 20, 30]),
		signers: ['12D3KooWAlice', '12D3KooWBob'],
		minSigs: 2,
		signedPayload: new TextEncoder().encode('commit-hash-xyz:approve'),
	};

	it('installs onLocalCommit and emits a notification reusing the commit cert sig', () => {
		const service = new RecordingService();
		const emitted: NotificationV1[] = [];
		const manager = new ReactivityOriginationManager({
			service,
			resolveContext: () => ({ tailId: TAIL, deltaMaxBytes: 0 }),
			emit: (n) => emitted.push(n),
			clock: () => 1_700_000_000_000,
		});
		manager.install();
		expect(service.onLocalCommit).to.be.a('function');
		service.onLocalCommit!(event, cert);
		expect(emitted).to.have.length(1);
		const n = emitted[0]!;
		expect(n.collectionId).to.equal(event.collectionId);
		expect(n.revision).to.equal(7);
		expect(n.sig).to.equal(bytesToB64url(cert.thresholdSig));
		// signers re-encoded to the member-id bytes the subscriber verifier compares against.
		expect(n.signers).to.deep.equal(cert.signers.map((s) => bytesToB64url(peerIdToBytes(s))));
		expect(n.tailId).to.equal(bytesToB64url(TAIL));
		expect(n).to.not.have.property('delta'); // deltaMaxBytes 0 → omit
	});

	it('round-trips the emitted signers back through buildNotificationV1 (encoding parity)', () => {
		const direct = buildNotificationV1(event, cert, {
			tailId: bytesToB64url(TAIL),
			timestamp: 1_700_000_000_000,
			deltaMaxBytes: 0,
			encodeSigner: (s) => bytesToB64url(peerIdToBytes(s)),
		});
		expect(direct.signers).to.deep.equal(cert.signers.map((s) => bytesToB64url(peerIdToBytes(s))));
	});

	it('skips origination when the collection context resolves to undefined', () => {
		const service = new RecordingService();
		const emitted: NotificationV1[] = [];
		const manager = new ReactivityOriginationManager({
			service,
			resolveContext: () => undefined,
			emit: (n) => emitted.push(n),
		});
		manager.install();
		service.onLocalCommit!(event, cert);
		expect(emitted).to.have.length(0);
	});
});
