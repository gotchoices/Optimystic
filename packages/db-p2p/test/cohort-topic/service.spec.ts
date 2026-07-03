import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Connection, PeerId, Stream } from '@libp2p/interface';
import {
	RingHash,
	createRegistrationStore,
	createSlotAssigner,
	createCohortGossipBus,
	createWillingnessCheck,
	createPromotionLifecycle,
	createColdStartManager,
	createTrafficCounters,
	createRenewalCohortSide,
	createCohortSigner,
	createCohortMemberEngine,
	createCohortTopicService,
	createLoadBarometer,
	createTierAddressing,
	coreProfile,
	CohortBackoffError,
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	decodeCohortMessage,
	validateRegisterV1,
	validateRenewV1,
	type ITopicRouter,
	type ICohortGossipTransport,
	type ISizeEstimator,
	type ICohortThresholdCrypto,
	type IMembershipSource,
	type IMembershipSourceRouter,
	type MembershipVerifier,
	type CohortMemberEngine,
	type ParticipantSigner,
	type PeerRef,
	type RegisterV1,
	type RenewV1,
	type RingCoord,
	type Tier,
} from '@optimystic/db-core';
import { createCohortTopicHost, resolveRenew } from '../../src/cohort-topic/host.js';
import { bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import { DEFAULT_COHORT_TOPIC_PROTOCOLS } from '../../src/cohort-topic/protocols.js';

const sha256digest = (b: Uint8Array): Uint8Array => new RingHash().H(b);

/** A single-member cohort wired in memory: the participant's router runs the member engine directly. */
function buildSingleMemberCohort(opts: { memberId: Uint8Array; capPromote: number }): { engine: CohortMemberEngine; member: Uint8Array; epoch: Uint8Array; store: ReturnType<typeof createRegistrationStore> } {
	const hash = new RingHash();
	const member = opts.memberId;
	const cohortEpoch = hash.H(new TextEncoder().encode('epoch:' + bytesToB64url(member)));
	const cohort = (): { members: readonly Uint8Array[]; cohortEpoch: Uint8Array } => ({ members: [member], cohortEpoch });

	const store = createRegistrationStore();
	const slots = createSlotAssigner(hash);
	const barometer = createLoadBarometer();

	// Mock gossip transport (no peers): the bus's view/merge logic still works for a single member.
	const gossipTransport: ICohortGossipTransport = {
		broadcast: (): void => {},
		onMessage: (): (() => void) => () => {},
	};
	const gossipBus = createCohortGossipBus({ transport: gossipTransport, store, coord: cohortEpoch, localEpoch: () => cohortEpoch });
	const view = gossipBus.view();
	const selfMember = bytesToB64url(member);

	const crypto: ICohortThresholdCrypto = {
		assemble: (payload: Uint8Array): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> =>
			Promise.resolve({ thresholdSig: sha256digest(payload), signers: [member] }),
		verify: (): boolean => true,
	};
	// minSigs=1 so a single-member cohort can threshold-sign promotion notices in this mock tier.
	const signer = createCohortSigner(crypto, 1);

	const willingness = createWillingnessCheck({
		barometer,
		view,
		selfMember,
		primaryTopicCount: (): number => 0,
		config: { cohortSize: 1 },
	});
	const traffic = createTrafficCounters({ view, store, selfMember });
	const promotion = createPromotionLifecycle({
		store,
		loadBucket: (): number => 0,
		childCohortCount: (): number => 0,
		treeTier: (): number => 0,
		parentCoord: (topicId: Uint8Array): Uint8Array => hash.H(topicId),
		// This mock's single-member cohort is served at `cohortEpoch` (the bus coord above).
		cohortCoord: () => cohortEpoch,
		cohortEpoch: () => cohortEpoch,
		signer,
		config: { capPromote: opts.capPromote, growthWindowMs: 0 },
	});
	const coldStart = createColdStartManager({
		parentRegistrar: { registerWithParent: (): Promise<void> => Promise.resolve() },
	});
	const renewal = createRenewalCohortSide({
		store,
		self: member,
		slots,
		cohort,
		gossip: { touch: (): void => {}, evicted: (): void => {} },
	});

	const engine = createCohortMemberEngine({
		self: member,
		profile: coreProfile(),
		hash,
		store,
		slots,
		willingness,
		promotion,
		coldStart,
		traffic,
		renewal,
		cohort,
		quorumWilling: (): boolean => true,
	});
	return { engine, member, epoch: cohortEpoch, store };
}

/**
 * A mock router that delivers register activity + renew dials straight to one member engine. `clock`
 * drives BOTH the server-side handling `now` and the participant's renew timestamps, so a test can make
 * time advance deterministically — the renewal freshness gate needs a privileged withdraw/reattach to be
 * stamped strictly after the record's last touch, which a fixed `Date.now()` in a single tick cannot show.
 */
function buildMockService(engine: CohortMemberEngine, member: Uint8Array, onDial?: () => void, clock: () => number = () => Date.now()): ReturnType<typeof createCohortTopicService> {
	const hash = new RingHash();
	const addressing = createTierAddressing(hash);
	const self = hash.H(new TextEncoder().encode('participant-self'));

	const router: ITopicRouter = {
		routeAndAct: async (_key: RingCoord, activity: Uint8Array): Promise<Uint8Array> => {
			const reg = validateRegisterV1(decodeCohortMessage(activity));
			const reply = await engine.handleRegister(reg, { followOn: reg.bootstrap === true, treeTier: reg.treeTier }, clock());
			return encodeCohortMessage(reply);
		},
		dialMember: async (_member: PeerRef, activity: Uint8Array): Promise<Uint8Array> => {
			onDial?.();
			const renew = validateRenewV1(decodeCohortMessage(activity));
			return encodeCohortMessage(engine.handleRenew(renew, clock()));
		},
	};
	const sizeEstimator: ISizeEstimator = { estimate: (): { nEst: number; confidence: number } => ({ nEst: 50, confidence: 1 }) };
	const gossipBus = createCohortGossipBus({
		transport: { broadcast: (): void => {}, onMessage: (): (() => void) => () => {} },
		store: createRegistrationStore(),
		coord: self,
		localEpoch: () => self,
	});
	const noSource: IMembershipSource = { current: () => Promise.resolve(undefined), fetch: () => Promise.resolve(undefined) };
	const membershipRouter: IMembershipSourceRouter = { for: (): IMembershipSource => noSource };
	const crypto: ICohortThresholdCrypto = { assemble: () => Promise.resolve({ thresholdSig: new Uint8Array(), signers: [] }), verify: (): boolean => true };
	const verifier = {
		cache: (): void => {},
		verifyMessage: (): Promise<'verified' | 'untrusted'> => Promise.resolve('verified'),
	} as unknown as MembershipVerifier;
	void membershipRouter;
	void crypto;
	void member;
	const signer: ParticipantSigner = { signRegister: (): Promise<string> => Promise.resolve(''), signRenew: (): Promise<string> => Promise.resolve('') };

	return createCohortTopicService({ self, hash, router, sizeEstimator, signer, gossipBus, verifier, clock });
}

describe('cohort-topic: service composition (mock transport)', () => {
	const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 1) & 0xff);

	it('register → accepted: resolves a handle pointing at the cohort primary', async () => {
		const { engine, member } = buildSingleMemberCohort({ memberId: new TextEncoder().encode('member-A'), capPromote: 64 });
		const service = buildMockService(engine, member);

		const handle = await service.register({ topicId: TOPIC, tier: 0 as Tier });
		expect(bytesToB64url(handle.primary)).to.equal(bytesToB64url(member));
		expect(bytesToB64url(handle.topicId)).to.equal(bytesToB64url(TOPIC));
		expect(handle.tier).to.equal(0);
	});

	it('renew: a ping cycle on a live handle succeeds and keeps the primary', async () => {
		const { engine, member } = buildSingleMemberCohort({ memberId: new TextEncoder().encode('member-B'), capPromote: 64 });
		const service = buildMockService(engine, member);

		const handle = await service.register({ topicId: TOPIC, tier: 0 as Tier });
		const before = bytesToB64url(handle.primary);
		await service.renew(handle);
		expect(bytesToB64url(handle.primary)).to.equal(before);
	});

	it('withdraw: sends one signed tombstone that evicts the cohort record immediately, then renew no-ops', async () => {
		const { engine, member, store } = buildSingleMemberCohort({ memberId: new TextEncoder().encode('member-W'), capPromote: 64 });
		let dials = 0;
		// A deterministic clock that advances between the ping and the withdraw: the withdraw tombstone is
		// stamped strictly after the record's last touch, so the renewal freshness gate accepts it (a real
		// leave always post-dates the last successful ping).
		let clock = 1_000;
		const service = buildMockService(engine, member, () => { dials++; }, () => clock);

		const handle = await service.register({ topicId: TOPIC, tier: 0 as Tier });
		await service.renew(handle);
		expect(dials, 'a live handle pings its primary').to.equal(1);
		expect(store.directParticipants(TOPIC), 'the registration is resident before withdraw').to.equal(1);

		// The remote half: withdraw dials the primary once with a tombstone, which evicts the record
		// immediately (instead of waiting out the TTL).
		clock = 2_000; // the leave happens after the last ping
		await service.withdraw(handle);
		expect(dials, 'withdraw sends exactly one tombstone dial').to.equal(2);
		expect(store.directParticipants(TOPIC), 'the tombstone freed the cohort record immediately').to.equal(0);

		// The local half: the handle dropped out of the live set, so a subsequent renew is a no-op.
		await service.renew(handle); // withdrawn → must not dial again
		expect(dials, 'a withdrawn handle no longer pings').to.equal(2);

		// Idempotent: a second withdraw finds no live renewal and dials nothing.
		await service.withdraw(handle);
		expect(dials, 'a second withdraw is a no-op').to.equal(2);
	});

	it('lookup: a read-only probe resolves a warmed topic without admitting (no new soft-state)', async () => {
		const { engine, member, store } = buildSingleMemberCohort({ memberId: new TextEncoder().encode('member-C'), capPromote: 64 });
		const service = buildMockService(engine, member);

		// Warm the topic with a real registration first; lookup is now a read-only probe, not a register.
		await service.register({ topicId: TOPIC, tier: 0 as Tier });
		const before = store.directParticipants(TOPIC);
		expect(before, 'the warming registration is resident').to.equal(1);

		const hint = await service.lookup(TOPIC, 0 as Tier);
		expect(bytesToB64url(hint.primary)).to.equal(bytesToB64url(member));
		expect(hint.cohortMembers.map(bytesToB64url)).to.include(bytesToB64url(member));

		// Read-only: the probe added no participant — the direct-participant count is unchanged.
		expect(store.directParticipants(TOPIC), 'the probe left no throwaway registration behind').to.equal(before);
	});

	it('lookup: a never-warmed (cold) topic rejects with CohortBackoffError — no cold-root instantiation', async () => {
		const { engine, member, store } = buildSingleMemberCohort({ memberId: new TextEncoder().encode('member-C2'), capPromote: 64 });
		const service = buildMockService(engine, member);

		const COLD = Uint8Array.from({ length: 32 }, (_v, i) => (i + 100) & 0xff);
		let caught: unknown;
		try {
			await service.lookup(COLD, 0 as Tier);
		} catch (err) {
			caught = err;
		}
		expect(caught, 'a cold lookup backs off rather than registering').to.be.instanceOf(CohortBackoffError);
		// The probe walked to the root and backed off without ever instantiating a forwarder / record.
		expect(store.directParticipants(COLD), 'a cold probe persists nothing').to.equal(0);
	});

	it('promote: once direct participants cross cap_promote, new registrations are redirected onward', async () => {
		const { engine } = buildSingleMemberCohort({ memberId: new TextEncoder().encode('member-D'), capPromote: 2 });

		const mkReg = (participant: string): ReturnType<typeof validateRegisterV1> => ({
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesToB64url(new TextEncoder().encode(participant)),
			ttl: 90_000,
			bootstrap: true,
			timestamp: Date.now(),
			correlationId: bytesToB64url(new TextEncoder().encode('cid-' + participant)),
			signature: '',
		});

		const r1 = await engine.handleRegister(mkReg('p1'), { followOn: true, treeTier: 0 }, Date.now());
		expect(r1.result).to.equal('accepted');
		const r2 = await engine.handleRegister(mkReg('p2'), { followOn: true, treeTier: 0 }, Date.now());
		expect(r2.result).to.equal('accepted');
		await Promise.resolve(); // flush the async promotion fired on the cap-crossing arrival

		const r3 = await engine.handleRegister(mkReg('p3'), { followOn: true, treeTier: 0 }, Date.now());
		expect(r3.result).to.equal('promoted');
		expect(r3.targetTier).to.equal(1);
	});
});

describe('cohort-topic: FRET host protocol handshake', () => {
	async function makePeerId(): Promise<PeerId> {
		const key = await generateKeyPair('Ed25519');
		return peerIdFromPrivateKey(key);
	}

	it('registers handlers on each of the five /optimystic/cohort-topic/1.0.0/* protocols', async () => {
		const handled = new Set<string>();
		const peerId = await makePeerId();
		const fakeNode = {
			peerId,
			handle: (protocol: string | string[]): Promise<void> => {
				for (const p of Array.isArray(protocol) ? protocol : [protocol]) {
					handled.add(p);
				}
				return Promise.resolve();
			},
			unhandle: (): Promise<void> => Promise.resolve(),
			getConnections: (): Connection[] => [],
			dialProtocol: (): Promise<Stream> => Promise.reject(new Error('no dial in handshake test')),
		};
		const fakeFret = {
			assembleCohort: (): string[] => [],
			setActivityHandler: (): void => {},
			getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: 50, confidence: 1, sources: 1 }),
			routeAct: (): Promise<{ commitCertificate: string }> => Promise.resolve({ commitCertificate: '' }),
		};

		const host = await createCohortTopicHost(fakeNode as never, fakeFret as never);

		for (const protocol of [
			DEFAULT_COHORT_TOPIC_PROTOCOLS.register,
			DEFAULT_COHORT_TOPIC_PROTOCOLS.gossip,
			DEFAULT_COHORT_TOPIC_PROTOCOLS.promote,
			DEFAULT_COHORT_TOPIC_PROTOCOLS.membership,
			DEFAULT_COHORT_TOPIC_PROTOCOLS.sign,
		]) {
			expect(handled.has(protocol), `handler for ${protocol}`).to.equal(true);
		}
		expect(host.protocols).to.deep.equal(DEFAULT_COHORT_TOPIC_PROTOCOLS);
		await host.stop();
	});
});

describe('cohort-topic: per-served-coord scoping', () => {
	const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 7) & 0xff);

	async function makePeerId(): Promise<PeerId> {
		const key = await generateKeyPair('Ed25519');
		return peerIdFromPrivateKey(key);
	}

	/** A minimal libp2p stand-in: the host only handles/unhandles protocols and reads its own peer id. */
	function makeFakeNode(peerId: PeerId): unknown {
		return {
			peerId,
			handle: (): Promise<void> => Promise.resolve(),
			unhandle: (): Promise<void> => Promise.resolve(),
			getConnections: (): Connection[] => [],
			dialProtocol: (): Promise<Stream> => Promise.reject(new Error('no dial in coord-scoping test')),
		};
	}

	/** FRET's ActivityHandler shape (the host registers a `(activity, cohort) => {commitCertificate}` callback). */
	type ActivityHandler = (activity: string, cohort: string[]) => Promise<{ commitCertificate: string }>;

	/**
	 * A fake FRET whose `assembleCohort` returns a different set per coordinate. `onSetHandler` (when
	 * given) captures the activity callback the host registers, so a test can drive the real FRET-routed
	 * register dispatch end-to-end.
	 */
	function makeFakeFret(cohortFor: (coord: RingCoord) => string[], onSetHandler?: (h: ActivityHandler) => void): unknown {
		return {
			assembleCohort: (coord: RingCoord): string[] => cohortFor(coord),
			setActivityHandler: (h: ActivityHandler): void => { onSetHandler?.(h); },
			getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: 50, confidence: 1, sources: 1 }),
			routeAct: (): Promise<{ commitCertificate: string }> => Promise.resolve({ commitCertificate: '' }),
		};
	}

	it('the engine serving a topic assembles its cohort around coord_0(topic), NOT the node ring neighbours', async () => {
		// The core bug this ticket fixes: the cohort a topic is served by sits at coord_0(topic), which is
		// unrelated to the node's own ring position. A coord engine must threshold-sign / shard with the
		// topic-coord cohort, not the FRET assembly around `selfCoord`.
		const peerId = await makePeerId();
		const addressing = createTierAddressing(new RingHash());
		const coord0Topic = addressing.coord0(TOPIC);
		const coordKey = bytesToB64url(coord0Topic);
		// 'topic-cohort-member' for the topic root; 'ring-neighbour' for every other coord (incl. selfCoord).
		const fret = makeFakeFret((coord) => (bytesToB64url(coord) === coordKey ? ['topic-cohort-member'] : ['ring-neighbour']));
		const host = await createCohortTopicHost(makeFakeNode(peerId) as never, fret as never);

		const participantCoord = new TextEncoder().encode('participant-X');
		const ce = host.registry.forCoord(coord0Topic, 0 as Tier, participantCoord);
		const members = ce.cohort().members.map(bytesToPeerIdString);

		expect(ce.treeTier, 'instantiated at the tier the coord was first served').to.equal(0);
		expect(members, 'self is prepended to the served cohort').to.include(peerId.toString());
		expect(members, 'cohort is assembled around coord_0(topic)').to.include('topic-cohort-member');
		expect(members, 'NOT the node ring-position neighbours').to.not.include('ring-neighbour');

		await host.stop();
	});

	it('renewal resolves to the coord engine holding the record; an unheld record replies unknown_registration', async () => {
		// A RenewV1 carries no treeTier, so the held record — not a recomputed coord — names the cohort.
		// wantK:1 makes a single-member cohort (self), so the willingness quorum is met and the tier-0
		// bootstrap admits without gossiped siblings (multi-member admission awaits the willingness-gossip
		// wiring — see the implement handoff).
		const peerId = await makePeerId();
		const addressing = createTierAddressing(new RingHash());
		const coord0Topic = addressing.coord0(TOPIC);
		const fret = makeFakeFret(() => []); // self-only cohort everywhere
		const host = await createCohortTopicHost(makeFakeNode(peerId) as never, fret as never, { wantK: 1 });

		const participantCoord = new TextEncoder().encode('participant-R');
		const ce = host.registry.forCoord(coord0Topic, 0 as Tier, participantCoord);
		const reg: RegisterV1 = {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesToB64url(participantCoord),
			ttl: 90_000,
			bootstrap: true,
			timestamp: Date.now(),
			correlationId: bytesToB64url(new TextEncoder().encode('cid-renew')),
			signature: '',
		};
		const reply = await ce.engine.handleRegister(reg, { followOn: false, treeTier: 0 }, Date.now());
		expect(reply.result, 'single-member tier-0 bootstrap admits').to.equal('accepted');

		const participantId = b64urlToBytes(reg.participantCoord);
		expect(host.registry.findHolder(TOPIC, participantId), 'the holding coord engine is found').to.equal(ce);

		const renew: RenewV1 = {
			v: 1,
			topicId: reg.topicId,
			participantId: reg.participantCoord,
			correlationId: reg.correlationId,
			timestamp: Date.now(),
			signature: '',
		};
		expect(resolveRenew(host.registry, renew, Date.now()).result, 'renewal resolves its coord and is served').to.equal('ok');

		const unheld: RenewV1 = { ...renew, participantId: bytesToB64url(new TextEncoder().encode('never-registered')) };
		expect(resolveRenew(host.registry, unheld, Date.now()).result, 'an unheld record re-looks up rather than throwing').to.equal('unknown_registration');

		await host.stop();
	});

	it('the FRET activity callback recomputes the served coord from the frame and routes to its engine', async () => {
		// The production dispatch path: FRET routes a RegisterV1 to this node and invokes the activity
		// handler with NO routed key, so the host must recompute servedCoord = coord(treeTier,
		// participantCoord, topicId) from the decoded frame and run the decision on registry.forCoord(it).
		// The earlier tests poke registry.forCoord directly; this one drives the real callback the host
		// installs, so the recompute + forCoord caching + handleRegister wiring is exercised end-to-end.
		const peerId = await makePeerId();
		const addressing = createTierAddressing(new RingHash());
		const coord0Topic = addressing.coord0(TOPIC);
		let activityHandler: ActivityHandler | undefined;
		const fret = makeFakeFret(() => [], (h) => { activityHandler = h; }); // self-only cohort everywhere
		const host = await createCohortTopicHost(makeFakeNode(peerId) as never, fret as never, { wantK: 1 });
		expect(activityHandler, 'the host installs an activity handler').to.not.equal(undefined);

		const participantCoord = new TextEncoder().encode('participant-D');
		const reg: RegisterV1 = {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesToB64url(participantCoord),
			ttl: 90_000,
			bootstrap: true,
			timestamp: Date.now(),
			correlationId: bytesToB64url(new TextEncoder().encode('cid-dispatch')),
			signature: '',
		};
		const frame = bytesToB64url(encodeCohortMessage(reg));
		const { commitCertificate } = await activityHandler!(frame, []);
		const reply = decodeCohortMessage(b64urlToBytes(commitCertificate)) as { result: string };
		expect(reply.result, 'the recomputed coord_0(topic) engine admits the tier-0 bootstrap').to.equal('accepted');

		// The record landed on the engine bound to coord_0(topic), reachable by the renewal lookup —
		// proving the dispatch recomputed the served coord rather than using the node ring position.
		const participantId = b64urlToBytes(reg.participantCoord);
		const holder = host.registry.findHolder(TOPIC, participantId);
		expect(holder, 'the dispatched register is held by a coord engine').to.not.equal(undefined);
		expect(bytesToB64url(holder!.servedCoord), 'served by coord_0(topic), not selfCoord').to.equal(bytesToB64url(coord0Topic));

		await host.stop();
	});
});
