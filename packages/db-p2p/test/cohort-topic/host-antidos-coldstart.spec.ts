import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Connection, PeerId, Stream } from '@libp2p/interface';
import {
	RingHash,
	createTierAddressing,
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	decodeCohortMessage,
	DEFAULT_RATE_WINDOW_MS,
	DEFAULT_REPLAY_MAX_AGE_MS,
	validateRegisterV1,
	type RegisterV1,
	type RenewV1,
	type RingCoord,
	type Tier,
} from '@optimystic/db-core';
import { createCohortTopicHost, resolveRenew } from '../../src/cohort-topic/host.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const addressing = createTierAddressing(new RingHash());
const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 3) & 0xff);
const TOPIC2 = Uint8Array.from({ length: 32 }, (_v, i) => (i + 71) & 0xff);

async function makePeerId(): Promise<PeerId> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
}

/** Real peer-id bytes — a valid `participantCoord` (the reputation default decodes it as a peer id). */
async function makeParticipantBytes(): Promise<Uint8Array> {
	return peerIdToBytes(await makePeerId());
}

/** A minimal libp2p stand-in: the host only handles/unhandles protocols and reads its own peer id. */
function makeFakeNode(peerId: PeerId): unknown {
	return {
		peerId,
		handle: (): Promise<void> => Promise.resolve(),
		unhandle: (): Promise<void> => Promise.resolve(),
		getConnections: (): Connection[] => [],
		dialProtocol: (): Promise<Stream> => Promise.reject(new Error('no dial in anti-DoS/cold-start test')),
	};
}

/** A `RouteAndMaybeAct`-shaped message the router hands FRET's `routeAct`. */
interface RouteActMsg { key: string; activity: string }

/**
 * A fake FRET. `assembleCohort` returns `cohortFor(coord)` (host prepends self + dedupes). `routeAct`
 * records each call (so a test can assert what coord a forwarder→parent link routed to) and resolves
 * with `routeActReply` — or rejects when `routeActReject` is set (the parent-registration failure path).
 */
function makeFakeFret(opts: {
	cohortFor?: (coord: RingCoord) => string[];
	routeActCalls?: RouteActMsg[];
	routeActReject?: boolean;
} = {}): unknown {
	const cohortFor = opts.cohortFor ?? ((): string[] => []);
	return {
		assembleCohort: (coord: RingCoord): string[] => cohortFor(coord),
		setActivityHandler: (): void => {},
		getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: 50, confidence: 1, sources: 1 }),
		routeAct: (msg: RouteActMsg): Promise<{ commitCertificate: string }> => {
			opts.routeActCalls?.push({ key: msg.key, activity: msg.activity });
			if (opts.routeActReject === true) {
				return Promise.reject(new Error('parent unreachable'));
			}
			// A resolved round-trip is the parent ack; the body is not interpreted this milestone.
			return Promise.resolve({ commitCertificate: bytesToB64url(encodeCohortMessage({ v: 1, result: 'accepted' })) });
		},
	};
}

/** A tier-0 `bootstrap` `RegisterV1` (unsigned — key-less hosts skip participant-sig verification). */
function makeReg(participantCoord: Uint8Array, topicId: Uint8Array, correlationId: string, timestamp: number, extra: Partial<RegisterV1> = {}): RegisterV1 {
	return {
		v: 1,
		topicId: bytesToB64url(topicId),
		tier: 0,
		treeTier: 0,
		participantCoord: bytesToB64url(participantCoord),
		ttl: 90_000,
		bootstrap: true,
		timestamp,
		correlationId: bytesToB64url(new TextEncoder().encode(correlationId)),
		signature: '',
		...extra,
	};
}

describe('cohort-topic: host anti-DoS wiring (gap 6)', () => {
	it('per-(peer,topic) rate limiter: over-rate registers draw unwilling_cohort with a back-off', async () => {
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, { wantK: 1 });
		const participant = await makeParticipantBytes();
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const now = 1_000_000;

		// register_rate_per_peer = 4 in the window → first four admit.
		for (let i = 0; i < 4; i++) {
			const r = await ce.engine.handleRegister(makeReg(participant, TOPIC, `cid-${i}`, now), { followOn: false, treeTier: 0 }, now);
			expect(r.result, `register ${i} admitted`).to.equal('accepted');
		}
		// The fifth in the same window is rate-limited.
		const fifth = await ce.engine.handleRegister(makeReg(participant, TOPIC, 'cid-5', now), { followOn: false, treeTier: 0 }, now);
		expect(fifth.result, 'fifth over-rate register is declined in time').to.equal('unwilling_cohort');
		expect(fifth.retryAfterMs ?? 0, 'declined with an exponential back-off').to.be.greaterThan(0);

		await host.stop();
	});

	it('replay guard: an exact correlationId replay → no_state; a stale-timestamp register → no_state', async () => {
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, { wantK: 1 });
		const participant = await makeParticipantBytes();
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const now = 1_000_000;

		expect((await ce.engine.handleRegister(makeReg(participant, TOPIC, 'cid-replay', now), { followOn: false, treeTier: 0 }, now)).result, 'fresh register admits').to.equal('accepted');
		// Same correlationId, fresh timestamp, still in the window → replay (serve nothing, record nothing).
		expect((await ce.engine.handleRegister(makeReg(participant, TOPIC, 'cid-replay', now + 100), { followOn: false, treeTier: 0 }, now + 100)).result, 'replayed correlationId is no_state').to.equal('no_state');
		// A timestamp older than the freshness window is stale → no_state.
		const stale = makeReg(participant, TOPIC, 'cid-stale', now - DEFAULT_REPLAY_MAX_AGE_MS - 1);
		expect((await ce.engine.handleRegister(stale, { followOn: false, treeTier: 0 }, now)).result, 'stale register is no_state').to.equal('no_state');

		await host.stop();
	});

	it('topic budget: a full-of-populated budget refuses a new topic; the populated topic keeps serving', async () => {
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { topicBudget: { topicsMax: 1 } },
		});
		const participant = await makeParticipantBytes();
		// Drive two distinct topics through ONE coord engine to fill its per-coord budget.
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const now = 1_000_000;

		expect((await ce.engine.handleRegister(makeReg(participant, TOPIC, 'cid-t1', now), { followOn: false, treeTier: 0 }, now)).result, 'first topic instantiates').to.equal('accepted');
		// The budget (topics_max = 1) is now full of a populated topic → a new topic is refused, not evicted-for.
		const refused = await ce.engine.handleRegister(makeReg(participant, TOPIC2, 'cid-t2', now), { followOn: false, treeTier: 0 }, now);
		expect(refused.result, 'a new topic over the full budget is refused').to.equal('unwilling_cohort');
		expect(ce.servesTopic(TOPIC), 'the populated topic is never evicted for a new instantiation').to.equal(true);
		expect(ce.servesTopic(TOPIC2), 'the refused topic was not instantiated').to.equal(false);

		await host.stop();
	});

	it('bootstrap evidence: a cold-root bootstrap is denied without evidence and admitted with it', async () => {
		const participant = await makeParticipantBytes();
		const now = 1_000_000;

		// A reputation view that bans the peer → the T0 committed-work proxy fails → cold-root denial.
		const denyHost = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: { isBanned: (): boolean => true } },
		});
		const ceDeny = denyHost.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const denied = await ceDeny.engine.handleRegister(makeReg(participant, TOPIC, 'cid-noev', now), { followOn: false, treeTier: 0 }, now);
		expect(denied.result, 'cold-root bootstrap without evidence is unwilling_cohort, not a silent accept').to.equal('unwilling_cohort');
		await denyHost.stop();

		// A non-banned peer satisfies the evidence → admitted.
		const okHost = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: { isBanned: (): boolean => false } },
		});
		const ceOk = okHost.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const admitted = await ceOk.engine.handleRegister(makeReg(participant, TOPIC, 'cid-ev', now), { followOn: false, treeTier: 0 }, now);
		expect(admitted.result, 'a non-banned peer carries acceptable evidence').to.equal('accepted');
		await okHost.stop();
	});

	it('renewal is not replay-gated: a renew reusing the correlationId is served past the replay window', async () => {
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, { wantK: 1 });
		const participant = await makeParticipantBytes();
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const t0 = 1_000_000;

		expect((await ce.engine.handleRegister(makeReg(participant, TOPIC, 'cid-renew', t0), { followOn: false, treeTier: 0 }, t0)).result).to.equal('accepted');

		// A renew reusing the original correlationId, evaluated a full freshness window later, is accepted:
		// onRenew never consults the replay guard (only RegisterV1 is guarded), and the record is still live.
		const late = t0 + DEFAULT_REPLAY_MAX_AGE_MS + 5_000;
		const renew: RenewV1 = {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			participantId: bytesToB64url(participant),
			correlationId: bytesToB64url(new TextEncoder().encode('cid-renew')),
			timestamp: t0,
			signature: '',
		};
		expect(resolveRenew(host.registry, renew, late).result, 'a renewal after maxAge is served, not dropped as a replay').to.equal('ok');

		await host.stop();
	});

	it('guards are isolated per coord: a saturated coord does not throttle a sibling coord', async () => {
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, { wantK: 1 });
		const participant = await makeParticipantBytes();
		// Two arbitrary distinct served coords → two independent CoordEngines (hence guard sets).
		const coordA = addressing.coord0(TOPIC);
		const coordB = addressing.coord0(TOPIC2);
		const ceA = host.registry.forCoord(coordA, 0 as Tier, participant);
		const ceB = host.registry.forCoord(coordB, 0 as Tier, participant);
		const now = 1_000_000;

		// Saturate (participant, TOPIC) at coord A.
		for (let i = 0; i < 4; i++) {
			await ceA.engine.handleRegister(makeReg(participant, TOPIC, `a-${i}`, now), { followOn: false, treeTier: 0 }, now);
		}
		expect((await ceA.engine.handleRegister(makeReg(participant, TOPIC, 'a-5', now), { followOn: false, treeTier: 0 }, now)).result, 'coord A is saturated').to.equal('unwilling_cohort');

		// The SAME (participant, TOPIC) at coord B is unaffected — B has its own fresh rate limiter.
		expect((await ceB.engine.handleRegister(makeReg(participant, TOPIC, 'b-0', now), { followOn: false, treeTier: 0 }, now)).result, 'coord B is not throttled by coord A’s budget').to.equal('accepted');

		await host.stop();
	});
});

describe('cohort-topic: host cold-start parent registration (gap 7)', () => {
	/** Build a host + the tier-1 served/parent coords for TOPIC under `participantCoord`. */
	async function tier1Setup(routeActCalls?: RouteActMsg[], routeActReject?: boolean): Promise<{
		host: Awaited<ReturnType<typeof createCohortTopicHost>>;
		participantCoord: Uint8Array;
		servedCoord: RingCoord;
		parentCoord: RingCoord;
	}> {
		const participantCoord = await makeParticipantBytes();
		const servedCoord = addressing.coord(1, participantCoord, TOPIC);
		const parentCoord = addressing.coord(0, participantCoord, TOPIC);
		const host = await createCohortTopicHost(
			makeFakeNode(await makePeerId()) as never,
			makeFakeFret({ routeActCalls, routeActReject }) as never,
			{ wantK: 1 },
		);
		return { host, participantCoord, servedCoord, parentCoord };
	}

	it('a tier-1 forwarder links to its tier-0 parent and flips to serving on the ack', async () => {
		const routeActCalls: RouteActMsg[] = [];
		const { host, participantCoord, servedCoord, parentCoord } = await tier1Setup(routeActCalls);
		const ce = host.registry.forCoord(servedCoord, 1 as Tier, participantCoord);
		const now = 1_000_000;

		const reg = makeReg(participantCoord, TOPIC, 'cid-fwd', now, { tier: 1, treeTier: 1 });
		const reply = await ce.engine.handleRegister(reg, { followOn: false, treeTier: 1, parentCoord }, now);
		expect(reply.result, 'the instantiating participant is accepted immediately').to.equal('accepted');

		// Pre-ack: accepts participants but holds parent-involving ops.
		const fwd = ce.forwarder(TOPIC);
		expect(fwd, 'a forwarder was instantiated for the topic').to.not.equal(undefined);
		expect(fwd!.acceptsParticipants()).to.equal(true);

		await delay(30); // let the parent-link round-trip resolve

		expect(ce.forwarder(TOPIC)!.phase(), 'the forwarder flips to serving on the parent ack').to.equal('serving');
		expect(ce.forwarder(TOPIC)!.servesParentOps()).to.equal(true);

		// It routed the link to the CORRECT parent coordinate (coord_0(topic)), not the served coord.
		const linkCall = routeActCalls.find((c) => c.key === bytesToB64url(parentCoord));
		expect(linkCall, 'the link routed to coord_{d-1}(participant, topic)').to.not.equal(undefined);
		expect(routeActCalls.some((c) => c.key === bytesToB64url(servedCoord)), 'it did NOT route to the served coord').to.equal(false);
		const linked = validateRegisterV1(decodeCohortMessage(b64urlToBytes(linkCall!.activity)));
		expect(linked.treeTier, 'the link rides the parent serving tier (d-1)').to.equal(0);
		expect(linked.topicId).to.equal(bytesToB64url(TOPIC));

		await host.stop();
	});

	it('a failed parent registration leaves the forwarder serving direct participants but holding parent ops', async () => {
		const { host, participantCoord, servedCoord, parentCoord } = await tier1Setup(undefined, true);
		const ce = host.registry.forCoord(servedCoord, 1 as Tier, participantCoord);
		const now = 1_000_000;

		const reg = makeReg(participantCoord, TOPIC, 'cid-fwd-fail', now, { tier: 1, treeTier: 1 });
		const reply = await ce.engine.handleRegister(reg, { followOn: false, treeTier: 1, parentCoord }, now);
		// The failure must not crash the instantiating register — the participant is still accepted.
		expect(reply.result, 'the participant is accepted even when the parent link fails').to.equal('accepted');

		await delay(30); // let the rejected parent-link settle

		const fwd = ce.forwarder(TOPIC);
		expect(fwd!.acceptsParticipants(), 'still serves direct participants').to.equal(true);
		expect(fwd!.servesParentOps(), 'holds parent-involving ops until a successful retry').to.equal(false);
		expect(fwd!.phase()).to.equal('awaiting_parent');

		await host.stop();
	});
});

// Reference the imported window constant so the documented default stays asserted somewhere.
describe('cohort-topic: anti-DoS defaults', () => {
	it('exposes the simulator-confirmed rate window', () => {
		expect(DEFAULT_RATE_WINDOW_MS).to.equal(60_000);
	});
});
