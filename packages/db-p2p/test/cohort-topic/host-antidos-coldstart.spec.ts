import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Connection, PeerId, PrivateKey, Stream } from '@libp2p/interface';
import {
	RingHash,
	createTierAddressing,
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	decodeCohortMessage,
	decodeRegisterReplyV1,
	serializeBootstrapEvidenceEnvelope,
	bootstrapBoundImage,
	parentRefSigningImage,
	DEFAULT_RATE_WINDOW_MS,
	DEFAULT_REPLAY_MAX_AGE_MS,
	validateChildLinkV1,
	type ChildLinkV1,
	type RegisterV1,
	type RenewV1,
	type RingCoord,
	type Tier,
} from '@optimystic/db-core';
import { createCohortTopicHost, dispatchChildLink, resolveRenew, DEFAULT_COORD_ENGINES_MAX, CoordEngineRegistryFullError, type DispatchChildLinkDeps } from '../../src/cohort-topic/host.js';
import type { BootstrapParentTopicView } from '../../src/cohort-topic/bootstrap-parent-reference.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { signPeerSig } from '../../src/cohort-topic/peer-sig.js';

/** A non-banned, clean reputation view (the `{ isBanned, getScore }` shape the referee verifier needs). */
const cleanReputation = { isBanned: (): boolean => false, getScore: (): number => 0 };

/** A 16-byte correlationId seeded from a label — the wire codec pins the field to exactly 16 bytes. */
const cid16 = (label: string): string => {
	const buf = new Uint8Array(16);
	new TextEncoder().encodeInto(label, buf);
	return bytesToB64url(buf);
};

/** A real keypair → dialable peer-id bytes (a valid `participantCoord` / `referee`). */
async function makeParticipant(): Promise<{ key: PrivateKey; bytes: Uint8Array }> {
	const key = await generateKeyPair('Ed25519');
	return { key, bytes: peerIdToBytes(peerIdFromPrivateKey(key)) };
}

/** A PoW evidence field (the nonce is irrelevant when the host runs `powDifficultyBits: 0`). */
function powEvidence(nonce: Uint8Array = Uint8Array.from([0, 0, 0, 0])): string {
	return serializeBootstrapEvidenceEnvelope({ v: 1, pow: { nonce: bytesToB64url(nonce) } });
}

/** A referee endorsement field: `refereeKey` peer-key-signs `reg`'s bound image, referee = `refereeBytes`. */
function refereeEvidence(reg: RegisterV1, refereeBytes: Uint8Array, refereeKey: PrivateKey): string {
	const sig = signPeerSig(refereeKey, bootstrapBoundImage(reg));
	return serializeBootstrapEvidenceEnvelope({ v: 1, reputation: { referee: bytesToB64url(refereeBytes), sig: bytesToB64url(sig) } });
}

/** A signed parent-reference field: the participant peer-key-signs the parentRef image binding `reg` + `parentTopicId`. */
function parentRefEvidence(reg: RegisterV1, parentTopicId: Uint8Array, participantKey: PrivateKey): string {
	const sig = signPeerSig(participantKey, parentRefSigningImage(reg, bytesToB64url(parentTopicId)));
	return serializeBootstrapEvidenceEnvelope({ v: 1, parentRef: { parentTopicId: bytesToB64url(parentTopicId), sig: bytesToB64url(sig) } });
}

/** An existence view that knows exactly the parent topics in `known` (the `antiDos.parentTopicView` test seam). */
function viewKnowing(known: Uint8Array[]): BootstrapParentTopicView {
	const set = new Set(known.map(bytesToB64url));
	return { exists: (parentTopicId): boolean => set.has(bytesToB64url(parentTopicId)) };
}

/** A stand-in "existing committed parent topic" and a parent the node has never cached. */
const KNOWN_PARENT = Uint8Array.from({ length: 32 }, (_v, i) => (i + 130) & 0xff);
const UNKNOWN_PARENT = Uint8Array.from({ length: 32 }, (_v, i) => (i + 200) & 0xff);

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

/** The activity-handler shape the host installs via `setActivityHandler`. */
type ActivityHandler = (activity: string, cohort: string[]) => Promise<{ commitCertificate: string }>;

/**
 * A fake FRET. `assembleCohort` returns `cohortFor(coord)` (host prepends self + dedupes). `routeAct`
 * records each call (so a test can assert what coord a forwarder→parent link routed to). When
 * `invokeActivity` is set it faithfully drives the host's captured activity handler with the routed frame
 * (so a routed child-link actually reaches the parent engine's dispatch and its real
 * {@link ChildLinkReplyV1} comes back); otherwise it returns a canned `linked` ack. `routeActReject` makes
 * every route reject (the parent-registration failure path).
 */
function makeFakeFret(opts: {
	cohortFor?: (coord: RingCoord) => string[];
	routeActCalls?: RouteActMsg[];
	routeActReject?: boolean;
	invokeActivity?: boolean;
} = {}): unknown {
	const cohortFor = opts.cohortFor ?? ((): string[] => []);
	let activityHandler: ActivityHandler | undefined;
	return {
		assembleCohort: (coord: RingCoord): string[] => cohortFor(coord),
		setActivityHandler: (h: ActivityHandler): void => { activityHandler = h; },
		getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: 50, confidence: 1, sources: 1 }),
		routeAct: async (msg: RouteActMsg): Promise<{ commitCertificate: string }> => {
			opts.routeActCalls?.push({ key: msg.key, activity: msg.activity });
			if (opts.routeActReject === true) {
				return Promise.reject(new Error('parent unreachable'));
			}
			// Faithful path: run the host's activity handler on the routed frame (so a child-link reaches the
			// parent engine's dispatch and records the child), returning its real reply.
			if (opts.invokeActivity === true && activityHandler !== undefined) {
				return activityHandler(msg.activity, cohortFor(b64urlToBytes(msg.key)));
			}
			// Canned ack: a `linked` ChildLinkReplyV1 (the child-link's success-ack shape).
			return Promise.resolve({ commitCertificate: bytesToB64url(encodeCohortMessage({ v: 1, result: 'linked' })) });
		},
		// Test hook: drive the host's installed activity handler directly (the FRET-routed register path), so a
		// register that must be refused by the coord-engine registry cap flows through the real `dispatchRegister`
		// and its refusal→reply mapping rather than being poked at the engine level.
		runActivity: (activity: string, cohort: string[]): Promise<{ commitCertificate: string }> => {
			if (activityHandler === undefined) {
				throw new Error('no activity handler installed');
			}
			return activityHandler(activity, cohort);
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
		correlationId: cid16(correlationId),
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

	it('bootstrap evidence: a configured host denies a T2 bootstrap with no evidence and admits one carrying a valid PoW', async () => {
		const { bytes: participant } = await makeParticipant();
		const now = 1_000_000;
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: cleanReputation, powDifficultyBits: 0 },
		});

		// No evidence at all → verifyPoW / verifyReputation / verifyParentReference all fail closed → denied.
		const ceNo = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const denied = await ceNo.engine.handleRegister(makeReg(participant, TOPIC, 'cid-noev', now, { tier: 2 }), { followOn: false, treeTier: 0 }, now);
		expect(denied.result, 'a configured cohort denies a T2 bootstrap with no evidence').to.equal('unwilling_cohort');

		// A valid PoW alone admits a T2 bootstrap even with no reputation endorsement (the `||` disjunction).
		const ceOk = host.registry.forCoord(addressing.coord0(TOPIC2), 0 as Tier, participant);
		const reg = makeReg(participant, TOPIC2, 'cid-pow', now, { tier: 2, bootstrapEvidence: powEvidence() });
		const admitted = await ceOk.engine.handleRegister(reg, { followOn: false, treeTier: 0 }, now);
		expect(admitted.result, 'a valid PoW alone admits a T2 bootstrap').to.equal('accepted');

		await host.stop();
	});

	it('bootstrap evidence: a configured host admits a T0 bootstrap with a valid parent-ref to a known parent and denies an unknown one', async () => {
		const now = 1_000_000;
		// The committed-tier (T0) path now demands a real signed parent reference to a parent the node knows
		// exists. Inject the existence view (the host default fails T0 closed without a committed reader).
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: cleanReputation, parentTopicView: viewKnowing([KNOWN_PARENT]) },
		});

		// A valid parent-ref to the known parent → admitted.
		const { key: okKey, bytes: okParticipant } = await makeParticipant();
		const okReg = makeReg(okParticipant, TOPIC, 'cid-t0-pref-ok', now);
		okReg.bootstrapEvidence = parentRefEvidence(okReg, KNOWN_PARENT, okKey);
		const ceOk = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, okParticipant);
		expect((await ceOk.engine.handleRegister(okReg, { followOn: false, treeTier: 0 }, now)).result, 'T0 parent-ref to a known parent is admitted').to.equal('accepted');

		// A valid signature but to a parent the node has never cached → denied (fail closed).
		const { key: noKey, bytes: noParticipant } = await makeParticipant();
		const unknownReg = makeReg(noParticipant, TOPIC2, 'cid-t0-pref-unknown', now);
		unknownReg.bootstrapEvidence = parentRefEvidence(unknownReg, UNKNOWN_PARENT, noKey);
		const ceUnknown = host.registry.forCoord(addressing.coord0(TOPIC2), 0 as Tier, noParticipant);
		expect((await ceUnknown.engine.handleRegister(unknownReg, { followOn: false, treeTier: 0 }, now)).result, 'T0 parent-ref to an unknown parent is denied').to.equal('unwilling_cohort');

		await host.stop();
	});

	it('bootstrap evidence: a configured host denies a T0 bootstrap whose parent-ref signature is bad', async () => {
		const now = 1_000_000;
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: cleanReputation, parentTopicView: viewKnowing([KNOWN_PARENT]) },
		});
		// A parent-ref to a KNOWN parent but signed by a different key (not the participant) → rejected even
		// though the parent exists: the existence check never runs without a valid binding signature.
		const { bytes: participant } = await makeParticipant();
		const { key: otherKey } = await makeParticipant();
		const reg = makeReg(participant, TOPIC, 'cid-t0-pref-badsig', now);
		reg.bootstrapEvidence = parentRefEvidence(reg, KNOWN_PARENT, otherKey);
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		expect((await ce.engine.handleRegister(reg, { followOn: false, treeTier: 0 }, now)).result, 'a bad parent-ref signature is denied').to.equal('unwilling_cohort');
		await host.stop();
	});

	it('bootstrap evidence: a T2 bootstrap is admitted via a valid parent-ref alone (the PoW || reputation || parent-ref disjunction)', async () => {
		const now = 1_000_000;
		// A banning reputation view and no PoW offered → only the parent-ref can carry the disjunction.
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: { isBanned: (): boolean => true, getScore: (): number => 0 }, powDifficultyBits: 0, parentTopicView: viewKnowing([KNOWN_PARENT]) },
		});

		const { key: okKey, bytes: okParticipant } = await makeParticipant();
		const okReg = makeReg(okParticipant, TOPIC, 'cid-t2-pref', now, { tier: 2 });
		okReg.bootstrapEvidence = parentRefEvidence(okReg, KNOWN_PARENT, okKey);
		const ceOk = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, okParticipant);
		expect((await ceOk.engine.handleRegister(okReg, { followOn: false, treeTier: 0 }, now)).result, 'a valid parent-ref alone admits a T2 bootstrap').to.equal('accepted');

		// An unknown parent → parent-ref fails, PoW absent, reputation banned → the whole disjunction fails.
		const { key: badKey, bytes: badParticipant } = await makeParticipant();
		const badReg = makeReg(badParticipant, TOPIC2, 'cid-t2-pref-bad', now, { tier: 2 });
		badReg.bootstrapEvidence = parentRefEvidence(badReg, UNKNOWN_PARENT, badKey);
		const ceBad = host.registry.forCoord(addressing.coord0(TOPIC2), 0 as Tier, badParticipant);
		expect((await ceBad.engine.handleRegister(badReg, { followOn: false, treeTier: 0 }, now)).result, 'an unknown parent-ref falls through to denial').to.equal('unwilling_cohort');

		await host.stop();
	});

	it('bootstrap evidence gates T2/T3 too: a banned referee cannot slip the disjunction (a valid PoW alone still admits)', async () => {
		// T2/T3 accept `PoW || reputation || parent-ref`. A banned referee (no PoW offered) must yield
		// unwilling_cohort — verifyPoW returns false on an absent pow (not permissive), so the banned
		// referee verifier is not slipped. A valid PoW alone still admits (the gate is effective, not deny-all).
		const now = 1_000_000;

		const banHost = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: { isBanned: (): boolean => true, getScore: (): number => 0 }, powDifficultyBits: 0 },
		});
		const { key: banKey, bytes: banParticipant } = await makeParticipant();
		const banReg = makeReg(banParticipant, TOPIC, 'cid-t2-ban', now, { tier: 2 });
		banReg.bootstrapEvidence = refereeEvidence(banReg, banParticipant, banKey); // a referee endorsement, no PoW
		const ceBan = banHost.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, banParticipant);
		const bannedT2 = await ceBan.engine.handleRegister(banReg, { followOn: false, treeTier: 0 }, now);
		expect(bannedT2.result, 'a banned referee is denied at T2 — PoW does not slip it through').to.equal('unwilling_cohort');
		await banHost.stop();

		const okHost = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: { isBanned: (): boolean => true, getScore: (): number => 0 }, powDifficultyBits: 0 },
		});
		const { bytes: okParticipant } = await makeParticipant();
		const okReg = makeReg(okParticipant, TOPIC2, 'cid-t2-ok', now, { tier: 2, bootstrapEvidence: powEvidence() });
		const ceOk = okHost.registry.forCoord(addressing.coord0(TOPIC2), 0 as Tier, okParticipant);
		const okT2 = await ceOk.engine.handleRegister(okReg, { followOn: false, treeTier: 0 }, now);
		expect(okT2.result, 'a valid PoW alone admits a T2 bootstrap even with a banning reputation view').to.equal('accepted');
		await okHost.stop();
	});

	it('bootstrap evidence: an entirely unconfigured host stays permissive (a tier-0 bootstrap with no evidence is admitted)', async () => {
		// No `antiDos` at all → the permissive-but-logged fallback fires (one-time warning), preserving the
		// db-core/mock-tier flows that bootstrap tier-0 without evidence (service.spec / live-tier / scale suites).
		const { bytes: participant } = await makeParticipant();
		const now = 1_000_000;
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, { wantK: 1 });
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const admitted = await ce.engine.handleRegister(makeReg(participant, TOPIC, 'cid-bare', now), { followOn: false, treeTier: 0 }, now);
		expect(admitted.result, 'a bare host admits a tier-0 bootstrap with no evidence').to.equal('accepted');
		await host.stop();
	});

	it('cold-start origination: a configured host with no committed backing admits a T0 bootstrap with no evidence but still denies a T2 one', async () => {
		// The cold-start-origination regression guard (cohort-topic-bootstrap-coldstart-origination-regression).
		// A real production node wires a reputation view (so the policy is *configured*) but, today, no
		// committed-existence backing — no `antiDos.parentTopicView` override and no `committedParentTopicReader`.
		// A brand-new T0 root has no parent to reference and the default view fails T0 closed, so at T0/T1 the
		// policy (which consults ONLY verifyParentReference there) stays permissive-but-logged: an evidence-less
		// T0 bootstrap is admitted. The fix is scoped to T0/T1 — a T2 bootstrap with no evidence is still denied
		// (verifyPoW / verifyReputation / verifyParentReference all fail closed), proving T2/T3 gating is intact.
		const now = 1_000_000;
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { reputation: cleanReputation, powDifficultyBits: 0 },
		});

		const { bytes: t0Participant } = await makeParticipant();
		const ceT0 = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, t0Participant);
		const t0 = await ceT0.engine.handleRegister(makeReg(t0Participant, TOPIC, 'cid-coldstart-t0', now), { followOn: false, treeTier: 0 }, now);
		expect(t0.result, 'a configured host with no committed backing admits an evidence-less T0 bootstrap').to.equal('accepted');

		const { bytes: t2Participant } = await makeParticipant();
		const ceT2 = host.registry.forCoord(addressing.coord0(TOPIC2), 0 as Tier, t2Participant);
		const t2 = await ceT2.engine.handleRegister(makeReg(t2Participant, TOPIC2, 'cid-coldstart-t2', now, { tier: 2 }), { followOn: false, treeTier: 0 }, now);
		expect(t2.result, 'the fix is scoped to T0/T1 — a configured host still denies an evidence-less T2 bootstrap').to.equal('unwilling_cohort');

		await host.stop();
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

	it('the gossip tick sweeps idle node-level promote-gate limiter keys (cohort-topic-promote-gate-map-eviction)', async () => {
		// The driveTick → promoteGate.rateLimiter.sweep wiring. The node-level promote-gate limiter is reclaimed
		// on the same gossip cadence the per-coord limiters sweep on. A tiny idleTtlMs + fast tick reclaims an
		// idle `(peer, topic)` key. The node-gate limiter is swept *only* by driveTick (the per-coord limiters
		// are distinct instances), so this fails if the sweep call is missing or scoped outside the tick.
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			gossipIntervalMs: 5,
			antiDos: { rateLimiter: { idleTtlMs: 10 } },
		});
		// Allocate one node-gate limiter key (exactly as an inbound promote notice would), then let ticks reclaim it.
		host.promoteGate.rateLimiter.check(await makeParticipantBytes(), TOPIC, Date.now());
		expect(host.promoteGate.rateLimiter.size, 'the key was allocated').to.equal(1);

		await delay(80); // several 5ms ticks past the 10ms idle TTL
		expect(host.promoteGate.rateLimiter.size, 'the gossip tick swept the idle key').to.equal(0);

		await host.stop();
	});
});

describe('cohort-topic: host cold-start parent registration (gap 7)', () => {
	/** Build a host + the tier-1 served/parent coords for TOPIC under `participantCoord`. */
	async function tier1Setup(routeActCalls?: RouteActMsg[], routeActReject?: boolean, invokeActivity?: boolean): Promise<{
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
			makeFakeFret({ routeActCalls, routeActReject, invokeActivity }) as never,
			{ wantK: 1 },
		);
		return { host, participantCoord, servedCoord, parentCoord };
	}

	it('a tier-1 forwarder links to its tier-0 parent (child-link frame) and flips to serving on the linked ack', async () => {
		const routeActCalls: RouteActMsg[] = [];
		// invokeActivity: route the child-link into the SAME host's parent engine so the real dispatch records it.
		const { host, participantCoord, servedCoord, parentCoord } = await tier1Setup(routeActCalls, false, true);
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

		expect(ce.forwarder(TOPIC)!.phase(), 'the forwarder flips to serving on the parent linked ack').to.equal('serving');
		expect(ce.forwarder(TOPIC)!.servesParentOps()).to.equal(true);

		// It routed a ChildLinkV1 to the CORRECT parent coordinate (coord_0(topic)), not the served coord.
		const linkCall = routeActCalls.find((c) => c.key === bytesToB64url(parentCoord));
		expect(linkCall, 'the link routed to coord_{d-1}(participant, topic)').to.not.equal(undefined);
		expect(routeActCalls.some((c) => c.key === bytesToB64url(servedCoord)), 'it did NOT route to the served coord').to.equal(false);
		const linked = validateChildLinkV1(decodeCohortMessage(b64urlToBytes(linkCall!.activity)));
		expect(linked.childTier, 'the frame is a child-link stamped at the child tree tier (d)').to.equal(1);
		expect(linked.topicId).to.equal(bytesToB64url(TOPIC));
		expect(linked.childCohortCoord, 'childCohortCoord is the child engine served coord').to.equal(bytesToB64url(servedCoord));
		expect(linked.childParticipantCoord).to.equal(bytesToB64url(participantCoord));
		expect(linked.thresholdSig, 'key-less interim: the link is unsigned').to.equal('');

		// The parent engine recorded the child, and the count is wired into its traffic snapshot.
		const parentEngine = host.registry.forCoord(parentCoord, 0 as Tier, participantCoord);
		expect(parentEngine.childCohortCount(TOPIC), 'the routed parent recorded the child').to.equal(1);
		expect(parentEngine.topicTraffic(TOPIC).childCohortCount, 'the count feeds the traffic snapshot').to.equal(1);

		await host.stop();
	});

	it('the recorded child count feeds the parent gossip summary and the demotion gate resolver', async () => {
		const routeActCalls: RouteActMsg[] = [];
		const { host, participantCoord, servedCoord, parentCoord } = await tier1Setup(routeActCalls, false, true);
		const ce = host.registry.forCoord(servedCoord, 1 as Tier, participantCoord);
		const now = 1_000_000;

		// The parent cohort holds a direct participant for TOPIC (so it is resident + appears in the summary).
		const parentEngine = host.registry.forCoord(parentCoord, 0 as Tier, participantCoord);
		await parentEngine.engine.handleRegister(makeReg(participantCoord, TOPIC, 'cid-parent-direct', now), { followOn: false, treeTier: 0 }, now);

		// The child links to the parent → the parent records it.
		await ce.engine.handleRegister(makeReg(participantCoord, TOPIC, 'cid-fwd2', now, { tier: 1, treeTier: 1 }), { followOn: false, treeTier: 1, parentCoord }, now);
		await delay(30);

		expect(parentEngine.childCohortCount(TOPIC), 'parent recorded exactly one child').to.equal(1);

		// The gossip summary for TOPIC now carries the real childCohortCount (was hardcoded 0).
		const frame = await parentEngine.gossipRound(now);
		expect(frame, 'the resident parent emits a gossip frame').to.not.equal(undefined);
		const summary = frame!.topicSummaries.find((s) => s.topicId === bytesToB64url(TOPIC));
		expect(summary, 'the summary includes TOPIC').to.not.equal(undefined);
		expect(summary!.childCohortCount, 'the gossip summary carries the real child count').to.equal(1);

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

describe('cohort-topic: parent-side child-link dispatch (record + reject)', () => {
	/** A 32-byte epoch filler for a well-formed frame. */
	const EPOCH = Uint8Array.from({ length: 32 }, (_v, i) => (i + 90) & 0xff);
	/** A forged child coord that will not recompute from any real participant coord. */
	const FORGED_COORD = Uint8Array.from({ length: 32 }, (_v, i) => (i + 250) & 0xff);

	/** Build the dispatch deps with a spy `recordChild`; `verify` selects key-less-permissive / live-key. */
	function deps(verify?: (link: ChildLinkV1, now: number) => Promise<boolean>): { deps: DispatchChildLinkDeps; recorded: Array<{ topic: string; child: string; at: number }> } {
		const recorded: Array<{ topic: string; child: string; at: number }> = [];
		return {
			recorded,
			deps: {
				coord: (tier, pc, topicId): RingCoord => addressing.coord(tier, pc, topicId),
				resolveParent: () => ({
					recordChild: (topicId: Uint8Array, childCohortCoord: Uint8Array, effectiveAt: number): void => {
						recorded.push({ topic: bytesToB64url(topicId), child: bytesToB64url(childCohortCoord), at: effectiveAt });
					},
				}),
				verifyChildLinkSig: verify,
			},
		};
	}

	/** A well-formed child-link whose coords recompute consistently for `participantCoord`. */
	function wellFormedLink(participantCoord: Uint8Array, overrides: Partial<ChildLinkV1> = {}): ChildLinkV1 {
		return {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			childCohortCoord: bytesToB64url(addressing.coord(1, participantCoord, TOPIC)),
			childParticipantCoord: bytesToB64url(participantCoord),
			childTier: 1,
			tier: 0,
			effectiveAt: 1_000,
			thresholdSig: '',
			signers: [],
			cohortEpoch: bytesToB64url(EPOCH),
			...overrides,
		};
	}

	it('key-less-permissive: a well-formed link with matching coords is recorded and acked linked', async () => {
		const participantCoord = await makeParticipantBytes();
		const { deps: d, recorded } = deps(undefined);
		const reply = await dispatchChildLink(wellFormedLink(participantCoord), d, 2_000);
		expect(reply.result).to.equal('linked');
		expect(recorded).to.have.length(1);
		expect(recorded[0]!.topic).to.equal(bytesToB64url(TOPIC));
		expect(recorded[0]!.child).to.equal(bytesToB64url(addressing.coord(1, participantCoord, TOPIC)));
		expect(recorded[0]!.at).to.equal(1_000);
	});

	it('live-key: a verified signature is recorded and acked linked', async () => {
		const participantCoord = await makeParticipantBytes();
		const { deps: d, recorded } = deps(async () => true);
		const reply = await dispatchChildLink(wellFormedLink(participantCoord, { thresholdSig: bytesToB64url(FORGED_COORD), signers: [bytesToB64url(participantCoord)] }), d, 2_000);
		expect(reply.result).to.equal('linked');
		expect(recorded).to.have.length(1);
	});

	it('coord mismatch: a childParticipantCoord that does not recompute to childCohortCoord is rejected, not recorded', async () => {
		const participantCoord = await makeParticipantBytes();
		// A forged childCohortCoord that cannot equal coord_1(participantCoord, TOPIC).
		const link = wellFormedLink(participantCoord, { childCohortCoord: bytesToB64url(FORGED_COORD) });
		const { deps: d, recorded } = deps(undefined);
		const reply = await dispatchChildLink(link, d, 2_000);
		expect(reply.result).to.equal('rejected');
		expect(reply.reason ?? '').to.match(/coord mismatch/);
		expect(recorded, 'a mismatched link records nothing').to.have.length(0);
	});

	it('live-key forged/under-quorum sig: a coord-consistent link that fails verify is rejected, not recorded', async () => {
		const participantCoord = await makeParticipantBytes();
		const { deps: d, recorded } = deps(async () => false);
		const reply = await dispatchChildLink(wellFormedLink(participantCoord, { thresholdSig: bytesToB64url(FORGED_COORD), signers: [bytesToB64url(participantCoord)] }), d, 2_000);
		expect(reply.result).to.equal('rejected');
		expect(reply.reason ?? '').to.match(/signature/);
		expect(recorded, 'an unverified link records nothing').to.have.length(0);
	});
});

// Reference the imported window constant so the documented default stays asserted somewhere.
describe('cohort-topic: anti-DoS defaults', () => {
	it('exposes the simulator-confirmed rate window', () => {
		expect(DEFAULT_RATE_WINDOW_MS).to.equal(60_000);
	});

	it('exposes the documented default coord-engine cap', () => {
		expect(DEFAULT_COORD_ENGINES_MAX).to.equal(2048);
	});
});

describe('cohort-topic: coord-engine registry cap (attacker-keyed engine creation bound)', () => {
	/** A distinct 32-byte topic id per index → a distinct served coord0 (H(0x00 ‖ topicId)). */
	function topicAt(i: number): Uint8Array {
		return Uint8Array.from({ length: 32 }, (_v, j) => (i * 31 + j * 7 + 1) & 0xff);
	}

	it('spraying distinct coords stays bounded at the cap and tears evicted engines down', async () => {
		const CAP = 8;
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { coordEnginesMax: CAP },
		});
		const participant = await makeParticipantBytes();
		// Baseline gossip-transport subscriptions with zero coord engines (the node-level participant bus).
		const base = host.gossipTransport.subscriberCount;

		// Spray 5×CAP distinct served coords. Each creates an IDLE engine (no handleRegister → no record /
		// forwarder), exactly the attacker's cold-coord spray.
		const coords: RingCoord[] = [];
		for (let i = 0; i < 5 * CAP; i++) {
			const coord = addressing.coord0(topicAt(i));
			coords.push(coord);
			host.registry.forCoord(coord, 0 as Tier, participant);
		}

		// Live-engine count never exceeds the cap...
		expect(host.registry.all().length, 'registry is bounded by the cap').to.equal(CAP);
		// ...and each eviction closed its engine (dropped its gossip subscription): one subscription per live
		// engine, none leaked. Were close() skipped, subscriberCount would be base + 5×CAP.
		expect(host.gossipTransport.subscriberCount, 'evicted engines were close()d — no leaked subscriptions').to.equal(base + CAP);

		// LRU discipline: the earliest-sprayed (least-recently-used) coord was evicted; the most-recent CAP survive.
		expect(host.registry.findByCoord(coords[0]!), 'the least-recently-used coord was evicted').to.equal(undefined);
		for (const coord of coords.slice(coords.length - CAP)) {
			expect(host.registry.findByCoord(coord), 'the most-recent CAP coords survive').to.not.equal(undefined);
		}

		await host.stop();
	});

	it('a hot (recently-used) engine survives eviction while cold ones are reclaimed', async () => {
		const CAP = 4;
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { coordEnginesMax: CAP },
		});
		const participant = await makeParticipantBytes();
		const hotCoord = addressing.coord0(topicAt(0));
		host.registry.forCoord(hotCoord, 0 as Tier, participant); // the coord we keep touching

		// Spray past the cap, re-touching the hot coord before each new creation so it stays most-recently-used.
		for (let i = 1; i < 5 * CAP; i++) {
			host.registry.findByCoord(hotCoord); // bump recency
			host.registry.forCoord(addressing.coord0(topicAt(i)), 0 as Tier, participant);
		}

		expect(host.registry.all().length, 'still bounded by the cap').to.equal(CAP);
		expect(host.registry.findByCoord(hotCoord), 'the continually-touched engine is never evicted').to.not.equal(undefined);

		await host.stop();
	});

	it('a full-of-live registry refuses a new coord and keeps the live cohorts (multi-cohort node unaffected)', async () => {
		const CAP = 2;
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, makeFakeFret() as never, {
			wantK: 1,
			antiDos: { coordEnginesMax: CAP },
		});
		const participant = await makeParticipantBytes();
		const now = 1_000_000;

		// Fill the cap with LIVE engines: each holds an admitted record (hasState() === true).
		const ce1 = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		const ce2 = host.registry.forCoord(addressing.coord0(TOPIC2), 0 as Tier, participant);
		expect((await ce1.engine.handleRegister(makeReg(participant, TOPIC, 'cid-1', now), { followOn: false, treeTier: 0 }, now)).result, 'first cohort admits').to.equal('accepted');
		expect((await ce2.engine.handleRegister(makeReg(participant, TOPIC2, 'cid-2', now), { followOn: false, treeTier: 0 }, now)).result, 'second cohort admits').to.equal('accepted');
		expect(ce1.hasState() && ce2.hasState(), 'both engines hold live state').to.equal(true);

		// A third distinct coord cannot be created — every slot holds a live cohort, so nothing is idle-evictable.
		const newCoord = addressing.coord0(topicAt(99));
		expect(() => host.registry.forCoord(newCoord, 0 as Tier, participant), 'refuses a new coord when full of live cohorts').to.throw(CoordEngineRegistryFullError);
		expect(host.registry.all().length, 'the live cohorts are untouched').to.equal(CAP);
		expect(host.registry.findByCoord(newCoord), 'the refused coord created no engine').to.equal(undefined);
		// The existing live cohorts keep serving.
		expect(ce1.servesTopic(TOPIC) && ce2.servesTopic(TOPIC2), 'both live cohorts keep serving').to.equal(true);

		await host.stop();
	});

	it('register dispatch over a full-of-live registry replies unwilling_cohort (no unhandled throw)', async () => {
		const fret = makeFakeFret() as { runActivity: (activity: string, cohort: string[]) => Promise<{ commitCertificate: string }> };
		const host = await createCohortTopicHost(makeFakeNode(await makePeerId()) as never, fret as never, {
			wantK: 1,
			antiDos: { coordEnginesMax: 1 },
		});
		const participant = await makeParticipantBytes();
		const now = 1_000_000;

		// Fill the single slot with a live cohort.
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participant);
		expect((await ce.engine.handleRegister(makeReg(participant, TOPIC, 'cid-live', now), { followOn: false, treeTier: 0 }, now)).result).to.equal('accepted');

		// Drive a register for a DISTINCT topic through the real FRET activity-handler → dispatchRegister path.
		const reg = makeReg(participant, TOPIC2, 'cid-refused', now);
		const { commitCertificate } = await fret.runActivity(bytesToB64url(encodeCohortMessage(reg)), []);
		const reply = decodeRegisterReplyV1(b64urlToBytes(commitCertificate));
		expect(reply.result, 'a register the cap refuses is a clean unwilling_cohort — never an unhandled throw').to.equal('unwilling_cohort');
		expect((reply.retryAfterMs ?? 0) > 0, 'carries a back-off so the walk retries in time').to.equal(true);
		expect(host.registry.all().length, 'the refused register created no engine').to.equal(1);

		await host.stop();
	});
});
