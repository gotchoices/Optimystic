import { expect } from 'chai';
import {
	Tier,
	reactivityTopicId,
	decodeSubscribeAppPayload,
	bytesToB64url,
	coreProfile,
	edgeProfile,
	buildNotificationV1,
	createReplayBuffer,
	createRejoinJitter,
	serveBackfill,
	SUBSCRIBER_TTL_CORE_MS,
	SUBSCRIBER_TTL_EDGE_MS,
	DELTA_MAX_CORE_BYTES,
	type CohortTopicService,
	type RegisterRequest,
	type RegistrationHandle,
	type MembershipVerifier,
	type VerifyResult,
	type NotificationV1,
	type BackfillV1,
	type ResumeV1,
	type ResumeReplyV1,
	type CollectionChangeEvent,
	type CommitCert,
} from '@optimystic/db-core';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { ReactivitySubscriptionManager, type ReactivitySubscriptionManagerOptions, type RotationNotice } from '../../src/reactivity/subscription-manager.js';
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

	const noteB64 = (revision: number): NotificationV1 => ({
		v: 1,
		collectionId: bytesToB64url(COLLECTION),
		tailId: bytesToB64url(TAIL),
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [bytesToB64url(new Uint8Array([8]))],
	});

	describe('backfill seam wired to the RPC', () => {
		it('drives a BackfillV1 over the transport on a gap and replays the reply through delivery', async () => {
			const service = new RecordingService(new FixedVerifier('verified'));
			const buffer = createReplayBuffer(256);
			for (let rev = 10; rev <= 14; rev++) buffer.append({ revision: rev, payload: noteB64(rev), receivedAt: 1000 + rev });

			const delivered: number[] = [];
			let resolveAll: () => void;
			const allDelivered = new Promise<void>((r) => { resolveAll = r; });
			const sentReqs: BackfillV1[] = [];
			const manager = new ReactivitySubscriptionManager({
				service,
				collectionId: COLLECTION,
				tailIdAtAttach: TAIL,
				deliver: (n) => { delivered.push(n.revision); if (n.revision === 14) resolveAll(); },
				lastKnownRev: 10,
				signBackfill: (req) => bytesToB64url(new Uint8Array([req.fromRevision & 0xff, req.toRevision & 0xff])),
				backfillTransport: (req) => { sentReqs.push(req); return Promise.resolve(serveBackfill(buffer, req, bytesToB64url(COLLECTION))); },
			});

			// A gap arrives (10 → 14): the manager's seam drives the backfill RPC and replays 11..14.
			expect(await manager.onNotification(noteB64(14))).to.equal('gap');
			await allDelivered;
			expect(sentReqs).to.have.length(1);
			expect(sentReqs[0]!.fromRevision).to.equal(11);
			expect(sentReqs[0]!.signature).to.be.a('string');
			expect(sentReqs[0]!.timestamp).to.be.a('number'); // stamped from the manager clock into the signed image
			expect(delivered).to.deep.equal([11, 12, 13, 14]);
			expect(manager.lastRevision).to.equal(14);
		});

		it('retries then escalates to resume() when the backfill transport keeps failing (no unhandled rejection)', async () => {
			const service = new RecordingService(new FixedVerifier('verified'));
			let backfillCalls = 0;
			let resumeReqs = 0;
			let resolveResume!: () => void;
			const resumeCalled = new Promise<void>((r) => { resolveResume = r; });
			const manager = new ReactivitySubscriptionManager({
				service,
				collectionId: COLLECTION,
				tailIdAtAttach: TAIL,
				deliver: () => {},
				lastKnownRev: 10,
				backfillMaxRetries: 1,
				signBackfill: () => bytesToB64url(new Uint8Array([1])),
				backfillTransport: () => { backfillCalls++; return Promise.reject(new Error('dial failed')); },
				signResume: () => bytesToB64url(new Uint8Array([2])),
				resumeTransport: () => { resumeReqs++; resolveResume(); return Promise.resolve({ v: 1, result: 'backfill', entries: [], currentRevision: 14 } as ResumeReplyV1); },
				clock: () => 1_700_000_000_999,
			});

			// The gap seam never faults the delivery path even when every backfill attempt rejects.
			expect(await manager.onNotification(noteB64(14))).to.equal('gap');
			await resumeCalled;
			expect(backfillCalls).to.be.greaterThan(1); // initial attempt + at least one retry before escalating
			expect(resumeReqs).to.equal(1); // escalated to a resume once the bounded retries were exhausted
		});
	});

	describe('resume() drives the RPC and applies the reply', () => {
		const makeManager = (over: Partial<ReactivitySubscriptionManagerOptions> = {}, delivered: number[] = []) =>
			new ReactivitySubscriptionManager({
				service: new RecordingService(new FixedVerifier('verified')),
				collectionId: COLLECTION,
				tailIdAtAttach: TAIL,
				deliver: (n) => delivered.push(n.revision),
				lastKnownRev: 17,
				signResume: () => bytesToB64url(new Uint8Array([1])),
				clock: () => 1_700_000_000_999,
				...over,
			});

		it('throws when no resume transport/signer is configured', async () => {
			const manager = new ReactivitySubscriptionManager({ service: new RecordingService(), collectionId: COLLECTION, tailIdAtAttach: TAIL, deliver: () => {} });
			let threw = false;
			try { await manager.resume(); } catch { threw = true; }
			expect(threw).to.equal(true);
		});

		it('sends a ResumeV1 from lastRevision + 1 and replays a backfill reply', async () => {
			const delivered: number[] = [];
			let sent: ResumeV1 | undefined;
			const reply: ResumeReplyV1 = { v: 1, result: 'backfill', entries: [noteB64(18), noteB64(19)], currentRevision: 19 };
			const manager = makeManager({ resumeTransport: (req) => { sent = req; return Promise.resolve(reply); } }, delivered);
			expect(await manager.resume()).to.equal('backfilled');
			expect(sent!.fromRevision).to.equal(18); // lastKnownRev 17 + 1
			expect(sent!.latestKnownTailId).to.equal(bytesToB64url(TAIL));
			expect(delivered).to.deep.equal([18, 19]);
		});

		it('signs the supplied ring coordinate into the ResumeV1 (not the collectionId placeholder)', async () => {
			const RING_COORD = bytesToB64url(new Uint8Array([0xc0, 0x0c]));
			let sent: ResumeV1 | undefined;
			const reply: ResumeReplyV1 = { v: 1, result: 'out_of_window', currentTailId: bytesToB64url(TAIL), currentRevision: 18 };
			const manager = makeManager({ subscriberCoord: RING_COORD, resumeTransport: (req) => { sent = req; return Promise.resolve(reply); } });
			await manager.resume();
			expect(sent!.subscriberCoord).to.equal(RING_COORD);
			expect(sent!.subscriberCoord).to.not.equal(bytesToB64url(COLLECTION));
		});

		it('falls back to the collectionId placeholder for subscriberCoord when none is supplied', async () => {
			let sent: ResumeV1 | undefined;
			const reply: ResumeReplyV1 = { v: 1, result: 'out_of_window', currentTailId: bytesToB64url(TAIL), currentRevision: 18 };
			const manager = makeManager({ resumeTransport: (req) => { sent = req; return Promise.resolve(reply); } });
			await manager.resume();
			expect(sent!.subscriberCoord).to.equal(bytesToB64url(COLLECTION));
		});

		it('invalidates the sticky cohort-hint cache and escalates on a tail_rotated reply', async () => {
			const rotations: Array<[string, number]> = [];
			const reply: ResumeReplyV1 = { v: 1, result: 'tail_rotated', newTailId: bytesToB64url(new Uint8Array([7, 7, 7, 7])), newRevisionAtRotation: 50 };
			const manager = makeManager({ resumeTransport: () => Promise.resolve(reply), onTailRotated: (t, r) => rotations.push([t, r]) });
			manager.cohortHint.set(bytesToB64url(COLLECTION), { topicId: bytesToB64url(TAIL), primary: bytesToB64url(new Uint8Array([4])), cohortHint: [] });
			expect(await manager.resume()).to.equal('tail_rotated');
			expect(rotations).to.have.length(1);
			expect(manager.cohortHint.get(bytesToB64url(COLLECTION))).to.equal(undefined); // dropped — cached primary is under the old tree
		});
	});

	describe('tail-rotation detection on delivery', () => {
		const NEW_TAIL = new Uint8Array([6, 6, 6, 6]);
		const makeRotationManager = (notices: RotationNotice[]) =>
			new ReactivitySubscriptionManager({
				service: new RecordingService(new FixedVerifier('verified')),
				collectionId: COLLECTION,
				tailIdAtAttach: TAIL,
				deliver: () => {},
				lastKnownRev: 41,
				rejoinJitter: createRejoinJitter({ random: () => 0.5 }),
				clock: () => 1_000,
				onRotation: (n) => notices.push(n),
			});

		it('surfaces a pre-announce hint with a jittered re-registration plan carrying lastRevision', async () => {
			const notices: RotationNotice[] = [];
			const manager = makeRotationManager(notices);
			manager.cohortHint.set(bytesToB64url(COLLECTION), { topicId: bytesToB64url(TAIL), primary: bytesToB64url(new Uint8Array([4])), cohortHint: [] });

			await manager.onNotification(noteB64(42)); // ordinary delivery, no rotation
			expect(notices).to.have.length(0);

			// revision 43 carries the rotation pre-announce.
			const announce: NotificationV1 = { ...noteB64(43), rotationHint: { newTailId: bytesToB64url(NEW_TAIL), effectiveAtRevision: 44 } };
			await manager.onNotification(announce);

			expect(notices).to.have.length(1);
			expect(notices[0]!.preAnnounced).to.equal(true);
			expect(notices[0]!.newTailId).to.equal(bytesToB64url(NEW_TAIL));
			expect(notices[0]!.plan.lastRevision).to.equal(43); // continuous across the rotation
			expect([...notices[0]!.plan.newTopicId]).to.deep.equal([...reactivityTopicId(NEW_TAIL)]);
			// the cached primary is under the now-stale tree — dropped so re-registration re-walks.
			expect(manager.cohortHint.get(bytesToB64url(COLLECTION))).to.equal(undefined);
		});

		it('fires the rotation notice once per successor tail', async () => {
			const notices: RotationNotice[] = [];
			const manager = makeRotationManager(notices);
			const announce = (rev: number): NotificationV1 => ({ ...noteB64(rev), rotationHint: { newTailId: bytesToB64url(NEW_TAIL), effectiveAtRevision: 44 } });
			await manager.onNotification(announce(42));
			await manager.onNotification(announce(43));
			expect(notices).to.have.length(1);
		});

		it('detects a hard rotation when the delivered tailId already differs', async () => {
			const notices: RotationNotice[] = [];
			const manager = makeRotationManager(notices);
			const onNewTree: NotificationV1 = { ...noteB64(42), tailId: bytesToB64url(NEW_TAIL) };
			await manager.onNotification(onNewTree);
			expect(notices).to.have.length(1);
			expect(notices[0]!.preAnnounced).to.equal(false);
		});
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

	it('embeds the rotation pre-announce on the block-filling notification', () => {
		const service = new RecordingService();
		const emitted: NotificationV1[] = [];
		const newTailId = bytesToB64url(new Uint8Array([6, 6]));
		const manager = new ReactivityOriginationManager({
			service,
			// the block-fill tracker would supply this rotationHint on the filling commit (rev + 1 effective).
			resolveContext: () => ({ tailId: TAIL, deltaMaxBytes: 0, rotationHint: { newTailId, effectiveAtRevision: event.rev + 1 } }),
			emit: (n) => emitted.push(n),
			clock: () => 1_700_000_000_000,
		});
		manager.install();
		service.onLocalCommit!(event, cert);
		expect(emitted).to.have.length(1);
		expect(emitted[0]!.rotationHint).to.deep.equal({ newTailId, effectiveAtRevision: event.rev + 1 });
	});
});
