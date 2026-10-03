import { expect } from 'chai';
import {
	Tier,
	reactivityCollectionTopicId,
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
	type RotationRedirectV1,
	type CollectionChangeEvent,
	type CommitCert,
} from '@optimystic/db-core';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { reactivityTailBytes } from '../../src/reactivity/topic-bytes.js';
import { ReactivitySubscriptionManager, type ReactivitySubscriptionManagerOptions, type RotationNotice } from '../../src/reactivity/subscription-manager.js';
import { RotationRedirectError } from '../../src/reactivity/recover-transport.js';
import { ReactivityOriginationManager } from '../../src/reactivity/origination-manager.js';

/** A membership verifier with a fixed verdict — the managers only need it to resolve a verdict. */
class FixedVerifier implements MembershipVerifier {
	constructor(private readonly verdict: VerifyResult = 'verified') {}
	cache(): void {}
	forget(): void {}
	verifyMessage(): Promise<VerifyResult> {
		return Promise.resolve(this.verdict);
	}
}

/** Recording mock cohort-topic service (mirrors the matchmaking manager tests). Every registration lands at the root. */
class RecordingService implements CohortTopicService {
	readonly registers: RegisterRequest[] = [];
	/** Every `moveRoot`: the root key the handle was moved to. */
	readonly moves: Uint8Array[] = [];
	renews = 0;
	withdraws = 0;
	onLocalCommit?: (event: CollectionChangeEvent, commitCert: CommitCert) => void;

	constructor(private readonly verifierImpl: MembershipVerifier = new FixedVerifier('verified')) {}

	async register(req: RegisterRequest): Promise<RegistrationHandle> {
		this.registers.push(req);
		return {
			topicId: req.topicId,
			tier: req.tier,
			treeTier: 0,
			rootKey: req.rootKey,
			primary: new Uint8Array(32),
			backups: [],
			cohortEpoch: new Uint8Array(32),
			cohortMembers: [],
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
	moveRoot(_handle: RegistrationHandle, rootKey: Uint8Array): void {
		this.moves.push(rootKey);
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
/** The root group's threshold ratio; the fixed-verdict verifiers here never apply it. */
const QUORUM_RATIO = 0.75;

describe('reactivity / subscription manager', () => {
	it('registers at tier T3 on the collection topic, with the tail as the root key and the subscribe payload', async () => {
		const service = new RecordingService();
		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: COLLECTION,
			tail: TAIL,
			quorumRatio: QUORUM_RATIO,
			deliver: () => {},
			profile: coreProfile(),
		});
		await manager.register();
		expect(service.registers).to.have.length(1);
		const req = service.registers[0]!;
		expect(req.tier).to.equal(Tier.T3);
		expect([...req.topicId], 'the topic is the collection\'s, not the tail\'s').to.deep.equal([...reactivityCollectionTopicId(COLLECTION)]);
		expect([...req.rootKey!], 'the tail is the root key').to.deep.equal([...TAIL]);
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
			tail: TAIL,
			quorumRatio: QUORUM_RATIO,
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
			tail: TAIL,
			quorumRatio: QUORUM_RATIO,
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
			tail: TAIL,
			quorumRatio: QUORUM_RATIO,
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
			tail: TAIL,
			quorumRatio: QUORUM_RATIO,
			deliver: () => {},
			profile: coreProfile(),
			ttlMs: 12_345,
		});
		await manager.register();
		expect(service.registers[0]!.ttl).to.equal(12_345);
	});

	it('renew is a no-op before the first register; withdraw drops via the substrate', async () => {
		const service = new RecordingService();
		const manager = new ReactivitySubscriptionManager({ service, collectionId: COLLECTION, tail: TAIL, quorumRatio: QUORUM_RATIO, deliver: () => {} });
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
			tail: TAIL,
			quorumRatio: QUORUM_RATIO,
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
			tail: TAIL,
			quorumRatio: QUORUM_RATIO,
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
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
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
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
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
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
				deliver: (n) => delivered.push(n.revision),
				lastKnownRev: 17,
				signResume: () => bytesToB64url(new Uint8Array([1])),
				clock: () => 1_700_000_000_999,
				...over,
			});

		it('throws when no resume transport/signer is configured', async () => {
			const manager = new ReactivitySubscriptionManager({ service: new RecordingService(), collectionId: COLLECTION, tail: TAIL, quorumRatio: QUORUM_RATIO, deliver: () => {} });
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

	describe('followTail (the subscription follows the collection\'s tail)', () => {
		const NEW_TAIL = new Uint8Array([6, 6, 6, 6]);

		it('records the latest tail: a re-registration at the root names it as root key and payload tail, a later resume as latestKnownTailId, and a repeat follow sends nothing', async () => {
			const service = new RecordingService(new FixedVerifier('verified'));
			let sent: ResumeV1 | undefined;
			const manager = new ReactivitySubscriptionManager({
				service,
				collectionId: COLLECTION,
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
				deliver: () => {},
				lastKnownRev: 17,
				signResume: () => bytesToB64url(new Uint8Array([1])),
				resumeTransport: (req) => { sent = req; return Promise.resolve({ v: 1, result: 'out_of_window', currentTailId: bytesToB64url(NEW_TAIL), currentRevision: 18 } as ResumeReplyV1); },
			});
			expect(await manager.followTail(TAIL), 'the first follow is the first registration').to.equal(true);
			expect(service.registers).to.have.length(1);
			expect(await manager.followTail(TAIL), 'the same tail again registers nothing').to.equal(false);
			expect(service.registers).to.have.length(1);

			expect(await manager.followTail(NEW_TAIL), 'a registration at the root registers again at the moved root').to.equal(true);
			expect(service.registers).to.have.length(2);
			expect([...service.registers[1]!.rootKey!]).to.deep.equal([...NEW_TAIL]);
			expect(decodeSubscribeAppPayload(service.registers[1]!.appPayload!).tailIdAtAttach, 'the payload carries the tail at this registration').to.equal(bytesToB64url(NEW_TAIL));
			expect([...manager.tail]).to.deep.equal([...NEW_TAIL]);
			expect(service.moves, 'a registration at the root is never moved in place').to.have.length(0);

			await manager.resume();
			expect(sent!.latestKnownTailId, 'a resume names the latest followed tail').to.equal(bytesToB64url(NEW_TAIL));
		});
	});

	describe('tail-rotation detection on delivery', () => {
		const NEW_TAIL = new Uint8Array([6, 6, 6, 6]);
		const makeRotationManager = (notices: RotationNotice[]) =>
			new ReactivitySubscriptionManager({
				service: new RecordingService(new FixedVerifier('verified')),
				collectionId: COLLECTION,
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
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
			expect([...notices[0]!.plan.newTailId], 'the plan names the new root key').to.deep.equal([...NEW_TAIL]);
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

	describe('rotation redirect honored over recover (RotationRedirectError)', () => {
		const REDIRECT_TAIL = new Uint8Array([6, 6, 6, 6]);
		const redirect = (over: Partial<RotationRedirectV1> = {}): RotationRedirectV1 => ({
			v: 1,
			result: 'rotated',
			newTailId: bytesToB64url(REDIRECT_TAIL),
			newTopicId: bytesToB64url(reactivityCollectionTopicId(COLLECTION)),
			effectiveAtRevision: 50,
			...over,
		});

		it('resume() honoring a redirect fires onRotation once (plan carries lastRevision), invalidates the cache, resolves tail_rotated (no throw)', async () => {
			const notices: RotationNotice[] = [];
			const manager = new ReactivitySubscriptionManager({
				service: new RecordingService(new FixedVerifier('verified')),
				collectionId: COLLECTION,
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
				deliver: () => {},
				lastKnownRev: 41,
				signResume: () => bytesToB64url(new Uint8Array([1])),
				resumeTransport: () => Promise.reject(new RotationRedirectError(redirect())),
				rejoinJitter: createRejoinJitter({ random: () => 0.5 }),
				clock: () => 1_000,
				onRotation: (n) => notices.push(n),
			});
			manager.cohortHint.set(bytesToB64url(COLLECTION), { topicId: bytesToB64url(TAIL), primary: bytesToB64url(new Uint8Array([4])), cohortHint: [] });

			const outcome = await manager.resume();
			expect(outcome, 'a redirect resolves resume() as a tail rotation, never throws out').to.equal('tail_rotated');
			expect(notices).to.have.length(1);
			expect(notices[0]!.preAnnounced, 'recover-driven, not a pre-announce').to.equal(false);
			expect(notices[0]!.newTailId).to.equal(bytesToB64url(REDIRECT_TAIL));
			expect(notices[0]!.plan.lastRevision, 'plan carries lastRevision (continuous across the rotation)').to.equal(41);
			expect([...notices[0]!.plan.newTailId], 'plan names the new root key').to.deep.equal([...REDIRECT_TAIL]);
			expect(manager.cohortHint.get(bytesToB64url(COLLECTION)), 'sticky cohort-hint cache invalidated').to.equal(undefined);
		});

		it('fires onRotation at most once per successor across repeated redirects', async () => {
			const notices: RotationNotice[] = [];
			const manager = new ReactivitySubscriptionManager({
				service: new RecordingService(new FixedVerifier('verified')),
				collectionId: COLLECTION,
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
				deliver: () => {},
				lastKnownRev: 41,
				signResume: () => bytesToB64url(new Uint8Array([1])),
				resumeTransport: () => Promise.reject(new RotationRedirectError(redirect())),
				rejoinJitter: createRejoinJitter({ random: () => 0.5 }),
				clock: () => 1_000,
				onRotation: (n) => notices.push(n),
			});
			expect(await manager.resume()).to.equal('tail_rotated');
			expect(await manager.resume()).to.equal('tail_rotated');
			expect(notices, 'guarded once-per-successor by rotationHandledFor').to.have.length(1);
		});

		it('shares the once-per-successor seam across notify-driven and recover-driven surfacing (same successor deduped, a chained one re-fires)', async () => {
			// The central claim of the surfaceRotation extraction: notify-driven detection and recover-driven
			// redirects funnel through one rotationHandledFor guard, so they cross-dedup.
			const notices: RotationNotice[] = [];
			const manager = new ReactivitySubscriptionManager({
				service: new RecordingService(new FixedVerifier('verified')),
				collectionId: COLLECTION,
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
				deliver: () => {},
				lastKnownRev: 41,
				signResume: () => bytesToB64url(new Uint8Array([1])),
				resumeTransport: () => Promise.reject(new RotationRedirectError(redirect())),
				rejoinJitter: createRejoinJitter({ random: () => 0.5 }),
				clock: () => 1_000,
				onRotation: (n) => notices.push(n),
			});
			// Notify-driven detection surfaces successor REDIRECT_TAIL first (a pre-announce on rev 42).
			const announce: NotificationV1 = { ...noteB64(42), rotationHint: { newTailId: bytesToB64url(REDIRECT_TAIL), effectiveAtRevision: 50 } };
			await manager.onNotification(announce);
			expect(notices, 'notify-driven surfaced the successor').to.have.length(1);
			expect(notices[0]!.preAnnounced).to.equal(true);
			// A recover redirect to the SAME successor is deduped through the shared rotationHandledFor seam.
			expect(await manager.resume()).to.equal('tail_rotated');
			expect(notices, 'recover-driven redirect to the same successor is deduped').to.have.length(1);
			// A genuinely chained successor (≠ the handled one) still re-fires through the same guard.
			const CHAINED = new Uint8Array([7, 7, 7, 7]);
			const chained: NotificationV1 = { ...noteB64(43), rotationHint: { newTailId: bytesToB64url(CHAINED), effectiveAtRevision: 60 } };
			await manager.onNotification(chained);
			expect(notices, 'a chained successor re-fires through the shared guard').to.have.length(2);
			expect(notices[1]!.newTailId).to.equal(bytesToB64url(CHAINED));
		});

		it('with no onRotation configured a redirect still invalidates the sticky cache and resolves tail_rotated', async () => {
			const manager = new ReactivitySubscriptionManager({
				service: new RecordingService(new FixedVerifier('verified')),
				collectionId: COLLECTION,
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
				deliver: () => {},
				lastKnownRev: 41,
				signResume: () => bytesToB64url(new Uint8Array([1])),
				resumeTransport: () => Promise.reject(new RotationRedirectError(redirect())),
				clock: () => 1_000,
			});
			manager.cohortHint.set(bytesToB64url(COLLECTION), { topicId: bytesToB64url(TAIL), primary: bytesToB64url(new Uint8Array([4])), cohortHint: [] });
			expect(await manager.resume()).to.equal('tail_rotated');
			expect(manager.cohortHint.get(bytesToB64url(COLLECTION)), 'cache invalidated even with no observer').to.equal(undefined);
		});

		it('a redirect off the backfill gap seam surfaces the rotation without faulting the delivery path', async () => {
			const notices: RotationNotice[] = [];
			let resolveNotice!: () => void;
			const noticed = new Promise<void>((r) => { resolveNotice = r; });
			const manager = new ReactivitySubscriptionManager({
				service: new RecordingService(new FixedVerifier('verified')),
				collectionId: COLLECTION,
				tail: TAIL,
				quorumRatio: QUORUM_RATIO,
				deliver: () => {},
				lastKnownRev: 10,
				backfillMaxRetries: 1,
				signBackfill: () => bytesToB64url(new Uint8Array([1])),
				backfillTransport: () => Promise.reject(new RotationRedirectError(redirect())),
				rejoinJitter: createRejoinJitter({ random: () => 0.5 }),
				clock: () => 1_000,
				onRotation: (n) => { notices.push(n); resolveNotice(); },
			});
			// A revision gap (10 → 14) drives the backfill RPC off the detached gap seam; the cohort redirects.
			expect(await manager.onNotification(noteB64(14)), 'delivery still reports the gap, never throws the redirect').to.equal('gap');
			await noticed;
			expect(notices).to.have.length(1);
			expect(notices[0]!.preAnnounced).to.equal(false);
			expect(notices[0]!.plan.lastRevision, 'continuous across the rotation').to.equal(10);
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

	describe('tail observation (observeTailCommit → markRotated)', () => {
		/** A commit event naming `tailId` whose blocks this node applied are `applied` (the tail among them ⇒ in its group). */
		const eventOn = (tailId: string | undefined, rev: number, applied: string[] = tailId === undefined ? ['data-block'] : [tailId]): CollectionChangeEvent => ({
			collectionId: bytesToB64url(COLLECTION),
			blockIds: applied,
			actionId: `action-${rev}`,
			rev,
			tailId,
		});
		interface RotationCall { oldTail: Uint8Array; newTailId: string; effectiveAtRevision: number; now: number; }
		const setup = () => {
			const calls: RotationCall[] = [];
			const manager = new ReactivityOriginationManager({
				service: new RecordingService(),
				resolveContext: () => undefined,
				emit: () => {},
				clock: () => 5_000,
				markRotated: (oldTail, redirect, now) => calls.push({ oldTail, newTailId: redirect.newTailId, effectiveAtRevision: redirect.effectiveAtRevision, now }),
			});
			return { manager, calls };
		};

		it('records the baseline on the first commit (no rotation)', () => {
			const { manager, calls } = setup();
			manager.observeTailCommit(eventOn('block-tail-old', 7));
			expect(calls, 'the first commit records the baseline, fires nothing').to.have.length(0);
		});

		it('fires markRotated for the old tail, in the reactivity tail encoding, when a commit names a new tail', () => {
			const { manager, calls } = setup();
			manager.observeTailCommit(eventOn('block-tail-old', 7));
			manager.observeTailCommit(eventOn('block-tail-new', 8));
			expect(calls, 'a tail change fires markRotated exactly once').to.have.length(1);
			// The old tail MUST be reactivityTailBytes(oldTail) — the bytes a notification's tailId encodes and the
			// forwarder host keys the root's state by. A mismatch would silently never redirect.
			expect([...calls[0]!.oldTail], 'oldTail is the root the forwarder host served').to.deep.equal([...reactivityTailBytes('block-tail-old')]);
			expect(calls[0]!.newTailId, 'redirect names the new tail (reactivityTailBytes encoding)').to.equal(bytesToB64url(reactivityTailBytes('block-tail-new')));
			expect(calls[0]!.effectiveAtRevision, 'effective at the rev the new tail first appeared').to.equal(8);
			expect(calls[0]!.now, 'stamped from the manager clock').to.equal(5_000);
		});

		it('does not fire on same-tail commits; a tail-less commit never disturbs the retained baseline', () => {
			const { manager, calls } = setup();
			manager.observeTailCommit(eventOn('block-tail-old', 7));
			manager.observeTailCommit(eventOn('block-tail-old', 8)); // same tail → no rotation
			manager.observeTailCommit(eventOn(undefined, 9)); // tail-less → ignored, never recorded/cleared
			expect(calls, 'no rotation on same-tail or tail-less commits').to.have.length(0);
			manager.observeTailCommit(eventOn('block-tail-new', 10)); // the tail changes from the retained baseline
			expect(calls, 'the tail-less commit did not clear the baseline; the later change still fires once').to.have.length(1);
			expect([...calls[0]!.oldTail]).to.deep.equal([...reactivityTailBytes('block-tail-old')]);
		});

		it('a machine only in the old tail\'s group marks the rotation from the rollover rewriting the old tail', () => {
			const { manager, calls } = setup();
			manager.observeTailCommit(eventOn('block-tail-old', 7)); // announced at the old tail
			// The rollover lands here only as the old tail block's nextId rewrite: it names the new tail, which this
			// node did not apply.
			manager.observeTailCommit(eventOn('block-tail-new', 8, ['block-tail-old']));
			expect(calls, 'the outgoing root sees the move').to.have.length(1);
			expect([...calls[0]!.oldTail]).to.deep.equal([...reactivityTailBytes('block-tail-old')]);
			expect(calls[0]!.newTailId).to.equal(bytesToB64url(reactivityTailBytes('block-tail-new')));
			// Never having applied the new tail, it holds no baseline: a later commit it sees marks nothing.
			manager.observeTailCommit(eventOn('block-tail-later', 9, ['data-block']));
			expect(calls, 'no root of this node is behind the later tail').to.have.length(1);
		});

		it('keeps its baseline through a commit that names its tail without applying it (a data-block sweep)', () => {
			const { manager, calls } = setup();
			manager.observeTailCommit(eventOn('block-tail-old', 7));
			manager.observeTailCommit(eventOn('block-tail-old', 8, ['data-block'])); // same tail, not applied here
			expect(calls).to.have.length(0);
			manager.observeTailCommit(eventOn('block-tail-new', 9, ['block-tail-old']));
			expect(calls, 'the baseline survived the sweep, so the rollover still marks').to.have.length(1);
			expect([...calls[0]!.oldTail]).to.deep.equal([...reactivityTailBytes('block-tail-old')]);
		});

		it('ignores an older commit naming the previous tail that lands after the rollover (a late sweep)', () => {
			const { manager, calls } = setup();
			manager.observeTailCommit(eventOn('block-tail-old', 7));
			manager.observeTailCommit(eventOn('block-tail-new', 8)); // in both groups: marks old → new, baseline new@8
			manager.observeTailCommit(eventOn('block-tail-old', 7, ['data-block'])); // rev 7's sweep, delayed
			expect(calls, 'the live root is not marked rotated back to the tail the log left').to.have.length(1);
			manager.observeTailCommit(eventOn('block-tail-next', 9));
			expect(calls, 'the baseline survived the late event').to.have.length(2);
			expect([...calls[1]!.oldTail]).to.deep.equal([...reactivityTailBytes('block-tail-new')]);
		});
	});
});
