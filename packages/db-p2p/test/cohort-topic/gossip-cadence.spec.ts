import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey, PeerId } from '@libp2p/interface';
import {
	RingHash,
	createTierAddressing,
	createLoadBarometer,
	coreProfile,
	selfWillingnessBits,
	willingnessBitsHex,
	toGossipRecord,
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	registerSigningPayload,
	renewSigningPayload,
	cohortGossipSigningPayload,
	type CohortGossipV1,
	type RegisterV1,
	type RenewV1,
	type RegistrationRecord,
	type RingCoord,
	type Tier,
} from '@optimystic/db-core';
import { createCohortTopicHost } from '../../src/cohort-topic/host.js';
import {
	createPendingDeltas,
	buildCohortGossip,
	DEFAULT_GOSSIP_INTERVAL_MS,
} from '../../src/cohort-topic/cohort-gossip-driver.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { signPeer, verifyPeerSig } from '../../src/cohort-topic/peer-sig.js';
import { DEFAULT_COHORT_TOPIC_PROTOCOLS } from '../../src/cohort-topic/protocols.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A real cohort member: libp2p key, peer-id string, and dialable member-id bytes. */
interface Member {
	key: PrivateKey;
	peerId: PeerId;
	idStr: string;
	bytes: Uint8Array;
}

async function makeMember(): Promise<Member> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key);
	return { key, peerId, idStr: peerId.toString(), bytes: peerIdToBytes(peerId) };
}

/** A minimal in-memory libp2p stand-in: records protocol handlers and logs (but never completes) dials. */
interface FakeNode {
	peerId: PeerId;
	handlers: Map<string, (stream: unknown, connection: { remotePeer: PeerId }) => void>;
	dialLog: Array<{ peer: string; protocol: string }>;
	handle: (protocol: string | string[], handler: (stream: unknown, connection: { remotePeer: PeerId }) => void) => Promise<void>;
	unhandle: (protocol: string | string[]) => Promise<void>;
	getConnections: () => unknown[];
	dialProtocol: (peer: PeerId, protocols: string | string[]) => Promise<never>;
}

function makeFakeNode(peerId: PeerId): FakeNode {
	const handlers = new Map<string, (stream: unknown, connection: { remotePeer: PeerId }) => void>();
	const dialLog: Array<{ peer: string; protocol: string }> = [];
	const arr = (p: string | string[]): string[] => (Array.isArray(p) ? p : [p]);
	return {
		peerId,
		handlers,
		dialLog,
		handle: (protocol, handler): Promise<void> => {
			for (const p of arr(protocol)) handlers.set(p, handler);
			return Promise.resolve();
		},
		unhandle: (protocol): Promise<void> => {
			for (const p of arr(protocol)) handlers.delete(p);
			return Promise.resolve();
		},
		getConnections: (): unknown[] => [],
		// Outbound gossip is fire-and-forget; rejecting here exercises the transport's swallow-and-continue
		// path. Tests deliver frames to a peer explicitly via `deliverGossip` instead of a real dial.
		dialProtocol: (peer, protocols): Promise<never> => {
			dialLog.push({ peer: peer.toString(), protocol: arr(protocols)[0]! });
			return Promise.reject(new Error('no real dial in gossip-cadence test'));
		},
	};
}

/** A stream that yields exactly one frame then completes — what the host's frame handler reads. */
function singleFrameStream(frame: Uint8Array): AsyncIterable<Uint8Array> & { send: () => void; close: () => Promise<void>; abort: () => void } {
	return {
		[Symbol.asyncIterator]: async function* (): AsyncGenerator<Uint8Array> {
			yield frame;
		},
		send: (): void => {},
		close: (): Promise<void> => Promise.resolve(),
		abort: (): void => {},
	};
}

/** Invoke `node`'s real `/cohort-gossip` handler with `frame`, as if `from` had sent it over the wire. */
function deliverGossip(node: FakeNode, frame: Uint8Array, from: PeerId): void {
	const handler = node.handlers.get(DEFAULT_COHORT_TOPIC_PROTOCOLS.gossip);
	if (handler === undefined) {
		throw new Error('node has no cohort-gossip handler');
	}
	handler(singleFrameStream(frame), { remotePeer: from });
}

/** A fake FRET whose `assembleCohort` returns `cohortFor(coord)` (host prepends self + dedupes). */
function makeFakeFret(cohortFor: (coord: RingCoord) => string[]): unknown {
	return {
		assembleCohort: (coord: RingCoord): string[] => cohortFor(coord),
		setActivityHandler: (): void => {},
		getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: 50, confidence: 1, sources: 1 }),
		routeAct: (): Promise<{ commitCertificate: string }> => Promise.resolve({ commitCertificate: '' }),
	};
}

const addressing = createTierAddressing(new RingHash());
const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 3) & 0xff);
const TOPIC2 = Uint8Array.from({ length: 32 }, (_v, i) => (i + 70) & 0xff);

/**
 * A participant-signed `RegisterV1` (live-signer mode verifies it against `participant`'s key). The
 * `timestamp` must sit inside the cohort's replay-guard freshness window relative to the `now` the
 * register is handled at — callers that handle at real-clock `Date.now()` pass `timestamp = now`, so a
 * synthetic stamp isn't dropped as stale.
 */
async function signedRegister(participant: Member, topicId: Uint8Array, ttl = 90_000, timestamp = 1_000): Promise<RegisterV1> {
	const body: Omit<RegisterV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topicId),
		tier: 0,
		treeTier: 0,
		participantCoord: bytesToB64url(participant.bytes),
		ttl,
		bootstrap: true,
		timestamp,
		correlationId: bytesToB64url(new TextEncoder().encode('cid-reg')),
	};
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, registerSigningPayload(body))) };
}

/** A participant-signed crash-failover `reattach` `RenewV1` (forces a `gossip.touch` at the cohort member). */
async function signedReattach(participant: Member, topicId: Uint8Array): Promise<RenewV1> {
	const body: Omit<RenewV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topicId),
		participantId: bytesToB64url(participant.bytes),
		correlationId: bytesToB64url(new TextEncoder().encode('cid-reg')),
		timestamp: 2_000,
		reattach: true,
	};
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, renewSigningPayload(body))) };
}

/** Build + sign a `CohortGossipV1` as if from `from`, scoped to `coord`/`epoch`. */
async function signedGossip(from: Member, coord: Uint8Array, epoch: Uint8Array, opts: Partial<CohortGossipV1> = {}): Promise<Uint8Array> {
	const g: CohortGossipV1 = {
		v: 1,
		fromMember: bytesToB64url(from.bytes),
		coord: bytesToB64url(coord),
		cohortEpoch: bytesToB64url(epoch),
		treeTier: 0,
		willingnessBits: 'f',
		loadBuckets: [0, 0, 0, 0],
		windowSeconds: 60,
		topicSummaries: [],
		timestamp: 3_000,
		signature: '',
		...opts,
	};
	g.signature = bytesToB64url(await signPeer(from.key, cohortGossipSigningPayload(g)));
	return encodeCohortMessage(g);
}

describe('cohort-topic: gossip-cadence driver helpers', () => {
	function record(participant: string, lastPing: number): RegistrationRecord {
		return {
			topicId: TOPIC,
			participantId: new TextEncoder().encode(participant),
			tier: 0,
			primary: new TextEncoder().encode('member-0'),
			backups: [new TextEncoder().encode('member-1')],
			attachedAt: 1_000,
			lastPing,
			ttl: 90_000,
		};
	}

	it('pending deltas: touch upserts (last-writer-wins by lastPing), evicted drops the pending record', () => {
		const pending = createPendingDeltas();
		expect(pending.isEmpty()).to.equal(true);
		pending.touch(record('p1', 1_000));
		pending.touch(record('p1', 5_000)); // newer touch wins
		pending.touch(record('p1', 3_000)); // older touch ignored
		pending.touch(record('p2', 2_000));
		expect(pending.isEmpty()).to.equal(false);

		const drained = pending.drain();
		expect(pending.isEmpty(), 'drain clears the queue').to.equal(true);
		const p1 = drained.records.find((r) => r.participantId === bytesToB64url(new TextEncoder().encode('p1')));
		expect(p1?.lastPing, 'last-writer-wins kept the newest touch').to.equal(5_000);
		expect(drained.records.length, 'two distinct participants queued').to.equal(2);
		expect(drained.evicted.length).to.equal(0);
	});

	it('pending deltas: a touch after an eviction supersedes it, and vice versa', () => {
		const pending = createPendingDeltas();
		pending.evicted(record('p', 1_000));
		pending.touch(record('p', 6_000)); // live touch supersedes the queued eviction
		let d = pending.drain();
		expect(d.evicted.length, 'eviction dropped by the later touch').to.equal(0);
		expect(d.records.length, 'record queued').to.equal(1);

		pending.touch(record('p', 1_000));
		pending.evicted(record('p', 1_000)); // eviction supersedes the queued record
		d = pending.drain();
		expect(d.records.length, 'record dropped by the later eviction').to.equal(0);
		expect(d.evicted.length, 'eviction queued').to.equal(1);
	});

	it('buildCohortGossip skips an idle non-heartbeat engine, emits a willingness-only heartbeat when idle+willing, and packs deltas otherwise', () => {
		const barometer = createLoadBarometer();
		const base = {
			fromMember: 'self',
			coord: bytesToB64url(TOPIC),
			cohortEpoch: bytesToB64url(TOPIC2),
			treeTier: 0,
			profile: coreProfile(),
			barometer,
			windowSeconds: 60,
			timestamp: 9_000,
		};
		expect(buildCohortGossip({ ...base, heartbeat: false, topicSummaries: [], records: [], evicted: [] }), 'idle, no heartbeat → no frame').to.equal(undefined);

		// Idle + heartbeat + willing (coreProfile serves every tier) → a willingness-only frame: no summaries,
		// no record/eviction deltas, but the willingness vector + tree tier are carried so a cold sibling can
		// instantiate off it and reciprocate.
		const hb = buildCohortGossip({ ...base, heartbeat: true, topicSummaries: [], records: [], evicted: [] });
		expect(hb, 'idle + heartbeat + willing → a willingness-only frame').to.not.equal(undefined);
		expect(hb!.treeTier, 'the heartbeat carries the tree tier for cold-sibling instantiation').to.equal(0);
		expect(hb!.topicSummaries, 'no topic summaries on a heartbeat').to.deep.equal([]);
		expect(hb!.records ?? [], 'no record delta on a heartbeat').to.deep.equal([]);
		expect(hb!.willingnessBits).to.equal(willingnessBitsHex(selfWillingnessBits(coreProfile(), barometer)));

		// An idle engine that is willing for NOTHING stays silent even on a heartbeat (nothing to bootstrap).
		const noTiers = { ...coreProfile(), willingTiers: new Set<Tier>() };
		expect(buildCohortGossip({ ...base, profile: noTiers, heartbeat: true, topicSummaries: [], records: [], evicted: [] }), 'idle + heartbeat but unwilling → no frame').to.equal(undefined);

		const withDelta = buildCohortGossip({ ...base, heartbeat: false, topicSummaries: [], records: [toGossipRecord(record('p', 5_000))], evicted: [] });
		expect(withDelta, 'a pending delta makes it non-idle').to.not.equal(undefined);
		expect(withDelta!.willingnessBits).to.equal(willingnessBitsHex(selfWillingnessBits(coreProfile(), barometer)));
		expect(withDelta!.loadBuckets).to.deep.equal([0, 0, 0, 0]);
		expect(withDelta!.records?.length).to.equal(1);
		expect(withDelta!.signature, 'signature slot left for the host signer').to.equal('');
	});
});

describe('cohort-topic: host gossip round', () => {
	it('a gossip round drains a touched record into a signed, coord-scoped frame', async () => {
		const self = await makeMember();
		const host = await createCohortTopicHost(makeFakeNode(self.peerId) as never, makeFakeFret(() => []) as never, {
			privateKey: self.key,
			wantK: 1,
			minSigs: 1,
			gossipIntervalMs: 3_600_000, // park the timer; this test drives the round by hand
		});
		const coord0 = addressing.coord0(TOPIC);
		const participant = await makeMember();
		const ce = host.registry.forCoord(coord0, 0 as Tier, participant.bytes);

		// An idle-but-willing engine's first idle round emits a willingness-only heartbeat (empty summaries /
		// no record deltas) so a cold cohort can bootstrap — not `undefined`.
		const hb = await ce.gossipRound(5_000);
		expect(hb, 'an idle-but-willing engine emits a willingness heartbeat on its first idle round').to.not.equal(undefined);
		expect(hb!.topicSummaries, 'the heartbeat carries no topic summaries').to.deep.equal([]);
		expect(hb!.records ?? [], 'the heartbeat carries no record delta').to.deep.equal([]);
		expect(hb!.treeTier, 'the heartbeat carries the tree tier').to.equal(0);

		expect((await ce.engine.handleRegister(await signedRegister(participant, TOPIC), { followOn: false, treeTier: 0 }, 5_000)).result).to.equal('accepted');
		// A re-attach forces a cohort-side touch → the record lands in the pending-delta queue.
		expect((ce.engine.handleRenew(await signedReattach(participant, TOPIC), 6_000)).result).to.equal('ok');

		const g = await ce.gossipRound(7_000);
		expect(g, 'a touched record makes the round non-idle').to.not.equal(undefined);
		expect(g!.coord, 'frame is scoped to the served coord').to.equal(bytesToB64url(coord0));
		expect(g!.fromMember).to.equal(bytesToB64url(self.bytes));
		expect(g!.records?.length, 'the touched record was drained into the frame').to.equal(1);
		expect(g!.records![0]!.participantId).to.equal(bytesToB64url(participant.bytes));
		expect(g!.signature.length, 'the envelope is peer-key signed').to.be.greaterThan(0);

		expect(
			verifyPeerSig(self.bytes, cohortGossipSigningPayload(g!), b64urlToBytes(g!.signature)),
			'the gossip signature verifies against the node key',
		).to.equal(true);

		// The next round has no fresh deltas but still advertises the resident topic's summary.
		const g2 = await ce.gossipRound(8_000);
		expect(g2, 'a resident topic keeps the round non-idle').to.not.equal(undefined);
		expect(g2!.records ?? [], 'no record delta after the queue was drained').to.deep.equal([]);
		expect(g2!.topicSummaries.length, 'the resident topic is summarized').to.equal(1);

		await host.stop();
	});
});

describe('cohort-topic: two-coord inbound routing isolation', () => {
	it('a gossip for coord A merges only into coord A’s store — not a sibling coord with the same epoch', async () => {
		// A self-only node serves two coords; both cohorts are just {self}, so they share an epoch. Only the
		// per-coord routing (not epoch) keeps a gossip for one out of the other's store.
		const self = await makeMember();
		const node = makeFakeNode(self.peerId);
		const host = await createCohortTopicHost(node as never, makeFakeFret(() => []) as never, {
			privateKey: self.key,
			wantK: 1,
			minSigs: 1,
			gossipIntervalMs: 3_600_000,
		});
		const participant = await makeMember();
		const coordA = addressing.coord0(TOPIC);
		const coordB = addressing.coord0(TOPIC2);
		const eA = host.registry.forCoord(coordA, 0 as Tier, participant.bytes);
		const eB = host.registry.forCoord(coordB, 0 as Tier, participant.bytes);
		expect(bytesToB64url(eA.cohort().cohortEpoch), 'the two coords share an epoch (same member set)').to.equal(bytesToB64url(eB.cohort().cohortEpoch));

		const rec: RegistrationRecord = {
			topicId: TOPIC,
			participantId: participant.bytes,
			tier: 0,
			primary: self.bytes,
			backups: [],
			attachedAt: Date.now(),
			lastPing: Date.now(),
			ttl: 90_000,
		};
		const frame = await signedGossip(self, coordA, eA.cohort().cohortEpoch, { records: [toGossipRecord(rec)] });
		deliverGossip(node, frame, self.peerId);
		await delay(30);

		expect(eA.holds(TOPIC, participant.bytes), 'coord A merged the record').to.equal(true);
		expect(eB.holds(TOPIC, participant.bytes), 'coord B (same epoch) did NOT — routing isolates by coord').to.equal(false);

		await host.stop();
	});
});

describe('cohort-topic: two-node replication via a gossip round', () => {
	/** Two keyed hosts whose shared FRET puts both in the cohort for `coord0(TOPIC)`. */
	async function twoNodeCohort(): Promise<{
		a: { host: Awaited<ReturnType<typeof createCohortTopicHost>>; node: FakeNode; member: Member };
		b: { host: Awaited<ReturnType<typeof createCohortTopicHost>>; node: FakeNode; member: Member };
		coord0: RingCoord;
	}> {
		const a = await makeMember();
		const b = await makeMember();
		const coord0 = addressing.coord0(TOPIC);
		const coordKey = bytesToB64url(coord0);
		const cohortFor = (coord: RingCoord): string[] => (bytesToB64url(coord) === coordKey ? [a.idStr, b.idStr] : []);
		const nodeA = makeFakeNode(a.peerId);
		const nodeB = makeFakeNode(b.peerId);
		const hostA = await createCohortTopicHost(nodeA as never, makeFakeFret(cohortFor) as never, { privateKey: a.key, wantK: 2, minSigs: 2, gossipIntervalMs: 3_600_000 });
		const hostB = await createCohortTopicHost(nodeB as never, makeFakeFret(cohortFor) as never, { privateKey: b.key, wantK: 2, minSigs: 2, gossipIntervalMs: 3_600_000 });
		return { a: { host: hostA, node: nodeA, member: a }, b: { host: hostB, node: nodeB, member: b }, coord0 };
	}

	it('an admitted record replicates to a sibling in one gossip round with no intervening renewal touch', async () => {
		// This test exercises the admission-time `onAdmit` hook: a record admitted on A must appear on B
		// after one gossip round even if no `handleRenew`/reattach fires first.
		const { a, b, coord0 } = await twoNodeCohort();
		const participant = await makeMember();
		const eA = a.host.registry.forCoord(coord0, 0 as Tier, participant.bytes);
		const eB = b.host.registry.forCoord(coord0, 0 as Tier, participant.bytes);
		const epoch = eA.cohort().cohortEpoch;

		// Seed A's view with B's willingness so the 2-of-2 quorum is met and A can admit.
		deliverGossip(a.node, await signedGossip(b.member, coord0, epoch, { willingnessBits: 'f' }), b.member.peerId);
		await delay(30);

		const now = Date.now();
		const result = await eA.engine.handleRegister(
			await signedRegister(participant, TOPIC, 90_000, now),
			{ followOn: false, treeTier: 0 },
			now,
		);
		expect(result.result, 'A admits the registration').to.equal('accepted');
		// No handleRenew — that is the whole point: the onAdmit hook, not renewal, must queue the delta.

		const g = await eA.gossipRound(now);
		expect(g?.records?.length, 'the admitted record was drained from the queue with no renewal').to.equal(1);
		deliverGossip(b.node, encodeCohortMessage(g!), a.member.peerId);
		await delay(30);

		expect(eB.holds(TOPIC, participant.bytes), 'B replicated the record via admission-time gossip, not renewal').to.equal(true);

		await a.host.stop();
		await b.host.stop();
	});

	it('a touched record + willingness propagate from node A to node B in one gossip round; an eviction converges', async () => {
		const { a, b, coord0 } = await twoNodeCohort();
		const participant = await makeMember();
		const eA = a.host.registry.forCoord(coord0, 0 as Tier, participant.bytes);
		const eB = b.host.registry.forCoord(coord0, 0 as Tier, participant.bytes);
		const epoch = eA.cohort().cohortEpoch;
		expect(bytesToB64url(eB.cohort().cohortEpoch), 'both nodes compute the same cohort epoch').to.equal(bytesToB64url(epoch));

		// Seed A's view with B's willingness so the 2-of-2 willingness quorum is met and A can admit.
		deliverGossip(a.node, await signedGossip(b.member, coord0, epoch, { willingnessBits: 'f' }), b.member.peerId);
		await delay(30);

		// Real-clock timestamps: the receiver merges with `Date.now()`, so a synthetic `lastPing` would look
		// past-TTL and be dropped by the bus's anti-resurrection guard.
		const now = Date.now();
		expect((await eA.engine.handleRegister(await signedRegister(participant, TOPIC, 90_000, now), { followOn: false, treeTier: 0 }, now)).result, 'A admits once a sibling is willing').to.equal('accepted');
		expect((eA.engine.handleRenew(await signedReattach(participant, TOPIC), now)).result).to.equal('ok');

		const g = await eA.gossipRound(now);
		expect(g?.records?.length, 'A’s round carries the touched record').to.equal(1);
		// Deliver A's real gossip frame to B (A's internal broadcast dial is a no-op in this harness).
		deliverGossip(b.node, encodeCohortMessage(g!), a.member.peerId);
		await delay(30);

		expect(eB.holds(TOPIC, participant.bytes), 'B replicated the record in one round').to.equal(true);
		const contribution = eB.cohortView().get(bytesToB64url(a.member.bytes));
		expect(contribution, 'B merged A’s gossip contribution into its view').to.not.equal(undefined);
		expect(contribution!.willingness, 'A’s willingness vector propagated').to.equal(parseInt(willingnessBitsHex(selfWillingnessBits(coreProfile(), createLoadBarometer())), 16));
		expect([...contribution!.loadBuckets], 'A’s load barometer propagated').to.deep.equal([0, 0, 0, 0]);

		// Eviction convergence: let the record go stale, sweep it on A, and gossip the eviction to B.
		const later = now + 90_000 + 1;
		const gEvict = await eA.gossipRound(later);
		expect(gEvict?.evicted?.length, 'the stale record was swept and queued as an eviction').to.equal(1);
		deliverGossip(b.node, encodeCohortMessage(gEvict!), a.member.peerId);
		await delay(30);
		expect(eB.holds(TOPIC, participant.bytes), 'B converged on the eviction').to.equal(false);

		await a.host.stop();
		await b.host.stop();
	});
});

describe('cohort-topic: gossip driver timer lifecycle', () => {
	it('the periodic driver broadcasts on a cadence and stops cleanly (no ticks after stop)', async () => {
		const self = await makeMember();
		const sibling = await makeMember();
		const coord0 = addressing.coord0(TOPIC);
		const coordKey = bytesToB64url(coord0);
		const cohortFor = (coord: RingCoord): string[] => (bytesToB64url(coord) === coordKey ? [self.idStr, sibling.idStr] : []);
		const node = makeFakeNode(self.peerId);
		const host = await createCohortTopicHost(node as never, makeFakeFret(cohortFor) as never, { privateKey: self.key, wantK: 2, minSigs: 2, gossipIntervalMs: 25 });

		const participant = await makeMember();
		const ce = host.registry.forCoord(coord0, 0 as Tier, participant.bytes);
		// Seed willingness + admit a registration so the engine is non-idle and each tick broadcasts. Use a
		// real-clock `now` for the admission: the driver sweeps with `Date.now()`, so a synthetic timestamp
		// would make the record instantly stale and the engine idle again.
		deliverGossip(node, await signedGossip(sibling, coord0, ce.cohort().cohortEpoch, { willingnessBits: 'f' }), sibling.peerId);
		await delay(20);
		const now = Date.now();
		expect((await ce.engine.handleRegister(await signedRegister(participant, TOPIC, 90_000, now), { followOn: false, treeTier: 0 }, now)).result).to.equal('accepted');

		const gossipDials = (): number => node.dialLog.filter((d) => d.protocol === DEFAULT_COHORT_TOPIC_PROTOCOLS.gossip).length;
		await delay(120);
		const duringRun = gossipDials();
		expect(duringRun, 'the timer fired several gossip rounds').to.be.greaterThan(1);

		await host.stop();
		const atStop = gossipDials();
		await delay(120);
		expect(gossipDials(), 'no gossip rounds fire after stop()').to.equal(atStop);
		expect(DEFAULT_GOSSIP_INTERVAL_MS, 'the documented default cadence is exported').to.equal(5_000);
	});
});

describe('cohort-topic: host gossip auth gate', () => {
	/** A live record stamped at real-clock `now` (a synthetic `lastPing` would look past-TTL and be dropped). */
	function liveRecord(primary: Member, participant: Member): RegistrationRecord {
		const now = Date.now();
		return {
			topicId: TOPIC,
			participantId: participant.bytes,
			tier: 0,
			primary: primary.bytes,
			backups: [],
			attachedAt: now,
			lastPing: now,
			ttl: 90_000,
		};
	}

	it('drops a validly-signed gossip from a non-cohort member', async () => {
		// Cohort around coordA is {self} only; `outsider` is not a member. Its gossip carries a real
		// self-signature, so only the membership half of the gate can reject it — proving the gate binds
		// cohort membership, not merely signature validity.
		const self = await makeMember();
		const node = makeFakeNode(self.peerId);
		const host = await createCohortTopicHost(node as never, makeFakeFret(() => []) as never, {
			privateKey: self.key,
			wantK: 1,
			minSigs: 1,
			gossipIntervalMs: 3_600_000,
		});
		const participant = await makeMember();
		const coordA = addressing.coord0(TOPIC);
		const eA = host.registry.forCoord(coordA, 0 as Tier, participant.bytes);

		const outsider = await makeMember();
		const frame = await signedGossip(outsider, coordA, eA.cohort().cohortEpoch, {
			willingnessBits: 'f',
			records: [toGossipRecord(liveRecord(self, participant))],
		});
		deliverGossip(node, frame, outsider.peerId);
		await delay(30);

		expect(eA.holds(TOPIC, participant.bytes), 'non-member record must not merge').to.equal(false);
		expect(eA.cohortView().get(bytesToB64url(outsider.bytes)), 'non-member willingness must not merge').to.equal(undefined);

		await host.stop();
	});

	it('drops a gossip from a cohort member whose signature does not verify', async () => {
		// `sibling` IS a member of the cohort around coordA, but the frame is signed with the WRONG key, so
		// `fromMember`'s peer-key signature fails to verify — the signature half of the gate must reject it.
		const self = await makeMember();
		const sibling = await makeMember();
		const coordA = addressing.coord0(TOPIC);
		const coordKey = bytesToB64url(coordA);
		const cohortFor = (coord: RingCoord): string[] => (bytesToB64url(coord) === coordKey ? [self.idStr, sibling.idStr] : []);
		const node = makeFakeNode(self.peerId);
		const host = await createCohortTopicHost(node as never, makeFakeFret(cohortFor) as never, {
			privateKey: self.key,
			wantK: 2,
			minSigs: 2,
			gossipIntervalMs: 3_600_000,
		});
		const participant = await makeMember();
		const eA = host.registry.forCoord(coordA, 0 as Tier, participant.bytes);

		// Forge: claim to be `sibling` (a real member) but sign the image with an unrelated key.
		const impostorKey = (await makeMember()).key;
		const g: CohortGossipV1 = {
			v: 1,
			fromMember: bytesToB64url(sibling.bytes),
			coord: bytesToB64url(coordA),
			cohortEpoch: bytesToB64url(eA.cohort().cohortEpoch),
			treeTier: 0,
			willingnessBits: 'f',
			loadBuckets: [0, 0, 0, 0],
			windowSeconds: 60,
			topicSummaries: [],
			records: [toGossipRecord(liveRecord(self, participant))],
			timestamp: 3_000,
			signature: '',
		};
		g.signature = bytesToB64url(await signPeer(impostorKey, cohortGossipSigningPayload(g)));
		deliverGossip(node, encodeCohortMessage(g), sibling.peerId);
		await delay(30);

		expect(eA.holds(TOPIC, participant.bytes), 'bad-signature record must not merge').to.equal(false);
		expect(eA.cohortView().get(bytesToB64url(sibling.bytes)), 'bad-signature willingness must not merge').to.equal(undefined);

		await host.stop();
	});
});
