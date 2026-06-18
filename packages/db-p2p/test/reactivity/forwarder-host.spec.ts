import { expect } from 'chai';
import {
	Tier,
	reactivityTopicId,
	createNotificationVerifier,
	createMembershipVerifier,
	createMembershipSourceRouter,
	createCohortSigner,
	createTierAddressing,
	createRingHash,
	encodeSubscribeAppPayload,
	coreProfile,
	edgeProfile,
	bytesToB64url,
	b64urlToBytes,
	T_DRAIN_MS,
	type ICohortThresholdCrypto,
	type IMembershipSource,
	type MembershipCertV1,
	type NotificationV1,
	type NotificationVerifier,
	type NodeProfile,
	type PeerRef,
	type PushStateInit,
	type CohortRef,
	type RegistrationRecord,
} from '@optimystic/db-core';
import {
	ReactivityForwarderHost,
	reactivityNotificationTopicId,
	reactivityDirectSubscribers,
	type ReactivityForwarderHostDeps,
} from '../../src/reactivity/forwarder-host.js';
import type { ReactivityNotifyTransport } from '../../src/reactivity/notify-transport.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';

// --- fixtures ---------------------------------------------------------------

const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));
const TAIL = bytesToB64url(new Uint8Array([9, 9, 9, 9]));
const TOPIC = reactivityTopicId(b64urlToBytes(TAIL));

const SIGNER_A = bytesToB64url(new Uint8Array([0xa1, 0xa1]));
const SIGNER_B = bytesToB64url(new Uint8Array([0xb2, 0xb2]));
const SIGNER_X = bytesToB64url(new Uint8Array([0xcc, 0xcc])); // not a cohort member → untrusted

const SELF = bytesToB64url(new Uint8Array([0x00]));
const SUB_A = bytesToB64url(new Uint8Array([0x10]));
const SUB_B = bytesToB64url(new Uint8Array([0x11]));
const SUB_C = bytesToB64url(new Uint8Array([0x12]));
const CHILD_PRIMARY = bytesToB64url(new Uint8Array([0x20]));

const NOW = 1_700_000_000_000;

/** A notification on the fixed (COLLECTION, TAIL); `signers` default to the member subset (→ "verified"). */
function note(revision: number, over: Partial<NotificationV1> = {}): NotificationV1 {
	return {
		v: 1,
		collectionId: COLLECTION,
		tailId: TAIL,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: NOW + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [SIGNER_A],
		...over,
	};
}

/**
 * A **real** db-core notification verifier (createNotificationVerifier over a real membership verifier)
 * whose raw threshold crypto always passes — so the verdict turns purely on the signer-subset check
 * against the cached tail-cohort cert. Mirrors the db-core reactivity tests' `realishVerifier`.
 */
function realVerifier(members: string[], minSigs = 1): NotificationVerifier {
	const crypto: ICohortThresholdCrypto = { assemble: () => Promise.reject(new Error('verify-only')), verify: () => true };
	const empty: IMembershipSource = { current: () => Promise.resolve(undefined), fetch: () => Promise.resolve(undefined) };
	const expectedCoord = createTierAddressing(createRingHash()).coord0(reactivityTopicId(b64urlToBytes(TAIL)));
	const cert: MembershipCertV1 = {
		v: 1,
		cohortCoord: bytesToB64url(expectedCoord),
		cohortEpoch: bytesToB64url(new Uint8Array([7])),
		members,
		stabilizedAt: NOW,
		thresholdSig: bytesToB64url(new Uint8Array([0])),
		signers: members.slice(0, minSigs),
	};
	const mv = createMembershipVerifier({ signer: createCohortSigner(crypto, minSigs), router: createMembershipSourceRouter({ committed: empty, fret: empty }), minSigs });
	mv.cache(cert);
	return createNotificationVerifier({ verifier: mv, tier: Tier.T3 });
}

/** A captured outbound dial. */
interface Sent {
	readonly target: string;
	readonly n: NotificationV1;
}

/** A fake notify transport that records every `send` and lets a test feed inbound frames to its subscribers. */
class FakeTransport implements ReactivityNotifyTransport {
	readonly sent: Sent[] = [];
	private readonly handlers = new Set<(from: PeerRef, n: NotificationV1) => void>();
	/** When set, `send(target, …)` rejects for these targets (exercise per-target failure isolation). */
	constructor(private readonly dead: Set<string> = new Set()) {}

	send(target: string, n: NotificationV1): Promise<void> {
		this.sent.push({ target, n });
		return this.dead.has(target) ? Promise.reject(new Error(`unreachable: ${target}`)) : Promise.resolve();
	}

	onNotification(handler: (from: PeerRef, n: NotificationV1) => void): () => void {
		this.handlers.add(handler);
		return (): void => { this.handlers.delete(handler); };
	}

	deliver(_fromPeerId: string, _frame: Uint8Array): void {
		// not exercised by these unit tests (the host calls `send`, not `deliver`)
	}

	targets(): string[] {
		return this.sent.map((s) => s.target);
	}
}

/** Build a host with sensible defaults; every dep is overridable per test. */
function makeHost(over: Partial<ReactivityForwarderHostDeps> & {
	transport?: FakeTransport;
	verifierMembers?: string[];
	queueMax?: number;
	childCohorts?: CohortRef[];
} = {}): { host: ReactivityForwarderHost; transport: FakeTransport } {
	const transport = over.transport ?? new FakeTransport();
	const verifier = realVerifier(over.verifierMembers ?? [SIGNER_A, SIGNER_B]);
	const deps: ReactivityForwarderHostDeps = {
		transport,
		selfPeerId: over.selfPeerId ?? SELF,
		profile: over.profile ?? coreProfile(),
		pushStateInit: over.pushStateInit ?? ((topicId, n): PushStateInit => ({
			collectionId: n.collectionId,
			topicId: bytesToB64url(topicId),
			tailIdAtJoin: n.tailId,
			w: 256,
			queueMax: over.queueMax ?? 32,
			...(over.childCohorts === undefined ? {} : { childCohorts: over.childCohorts }),
		})),
		verifierFor: over.verifierFor ?? ((): NotificationVerifier => verifier),
		directSubscribers: over.directSubscribers ?? ((): string[] => [SUB_A, SUB_B, SUB_C]),
		...(over.resolveChildPrimary === undefined ? {} : { resolveChildPrimary: over.resolveChildPrimary }),
		...(over.deliverLocal === undefined ? {} : { deliverLocal: over.deliverLocal }),
		clock: over.clock ?? ((): number => NOW),
	};
	return { host: new ReactivityForwarderHost(deps), transport };
}

// --- tests ------------------------------------------------------------------

describe('reactivity / forwarder host', () => {
	it('fans out a verified notification to each direct subscriber exactly once, byte-identical frame', async () => {
		const { host, transport } = makeHost();
		const n = note(1);
		await host.ingest(TOPIC, n);

		expect(transport.targets().sort()).to.deep.equal([SUB_A, SUB_B, SUB_C].sort());
		expect(transport.sent, 'one dial per subscriber, no duplicates').to.have.length(3);
		for (const s of transport.sent) {
			expect(s.n, 'the unmodified frame is fanned out (same reference — forwarders never re-sign)').to.equal(n);
		}
		// The receive path buffered the revision for replay.
		expect(host.pushStateFor(TOPIC)!.replayBuffer.entries().map((e) => e.revision)).to.deep.equal([1]);
	});

	it('fans out on "forward" but not on "duplicate" or "untrusted"', async () => {
		const { host, transport } = makeHost({ directSubscribers: (): string[] => [SUB_A] });

		// forward
		await host.ingest(TOPIC, note(1));
		expect(transport.sent).to.have.length(1);

		// duplicate (same revision + sig) → no further fan-out, buffer unchanged
		await host.ingest(TOPIC, note(1));
		expect(transport.sent, 'a duplicate is not re-fanned out').to.have.length(1);
		expect(host.pushStateFor(TOPIC)!.replayBuffer.entries().map((e) => e.revision)).to.deep.equal([1]);

		// untrusted (signer not in the cohort cert) → dropped before any buffer/dedupe mutation, no fan-out
		await host.ingest(TOPIC, note(2, { signers: [SIGNER_X] }));
		expect(transport.sent, 'an untrusted notification is never fanned out').to.have.length(1);
		expect(host.pushStateFor(TOPIC)!.replayBuffer.entries().map((e) => e.revision), 'untrusted never reaches the ring').to.deep.equal([1]);
	});

	it('a node that is both subscriber and primary delivers locally AND fans out — self is never dialed', async () => {
		const delivered: NotificationV1[] = [];
		const { host, transport } = makeHost({
			directSubscribers: (): string[] => [SELF, SUB_A, SUB_B],
			deliverLocal: (_topicId, n): void => { delivered.push(n); },
		});
		const n = note(1);
		await host.ingest(TOPIC, n);

		expect(delivered, 'the co-located subscriber is delivered in-process').to.deep.equal([n]);
		expect(transport.targets().sort(), 'self is never dialed; the two remote subscribers are').to.deep.equal([SUB_A, SUB_B].sort());
	});

	it('drives both roles on an inbound dial (forwarder fan-out + local subscriber delivery)', async () => {
		const delivered: NotificationV1[] = [];
		const { host, transport } = makeHost({
			directSubscribers: (): string[] => [SUB_A],
			deliverLocal: (_topicId, n): void => { delivered.push(n); },
		});
		const from: PeerRef = { id: new Uint8Array([0xde, 0xad]) };
		const n = note(1);
		await host.onInbound(from, n);

		expect(delivered, 'subscriber role: delivered in-process').to.deep.equal([n]);
		expect(transport.targets(), 'forwarder role: fanned out to the direct subscriber').to.deep.equal([SUB_A]);
	});

	it('onInbound for a co-located subscriber+forwarder invokes deliverLocal twice (relies on the manager\'s (collectionId,revision) dedupe)', async () => {
		// SELF is in the direct-subscriber set: the subscriber role delivers in-process, and the forwarder
		// role's fan-out *also* delivers to SELF (never dialed). The host deliberately relies on the
		// downstream subscription manager's (collectionId, revision) dedupe to collapse the two to one
		// surfaced delivery — so a raw, non-deduping sink sees both calls. Pin that contract here.
		const rawCalls: NotificationV1[] = [];
		const { host, transport } = makeHost({
			directSubscribers: (): string[] => [SELF, SUB_A],
			deliverLocal: (_topicId, n): void => { rawCalls.push(n); },
		});
		const n = note(1);
		await host.onInbound({ id: new Uint8Array([0xab]) }, n);

		expect(rawCalls, 'subscriber role + forwarder self-delivery both fire (manager dedupe collapses them)').to.deep.equal([n, n]);
		expect(transport.targets(), 'self is never dialed; only the remote subscriber is').to.deep.equal([SUB_A]);

		// A correctly-wired manager that dedupes by (collectionId, revision) surfaces exactly one delivery.
		const surfaced: NotificationV1[] = [];
		let lastRev = -1;
		const { host: host2 } = makeHost({
			directSubscribers: (): string[] => [SELF, SUB_A],
			deliverLocal: (_topicId, m): void => { if (m.revision > lastRev) { lastRev = m.revision; surfaced.push(m); } },
		});
		await host2.onInbound({ id: new Uint8Array([0xab]) }, n);
		expect(surfaced, 'a deduping sink yields exactly one delivery').to.deep.equal([n]);
	});

	it('a slow subscriber drops-oldest without stalling fast subscribers; its dropped counter increments', async () => {
		const queueMax = 2;
		const { host, transport } = makeHost({ directSubscribers: (): string[] => [SUB_A, SUB_B], queueMax });

		// First fan-out instantiates the PushState and drains both subscribers' queues empty.
		await host.ingest(TOPIC, note(1));
		const pushState = host.pushStateFor(TOPIC)!;

		// Model SUB_A as a backed-up slow subscriber: pre-fill its queue to capacity (its prior dials never
		// drained). The host fires sends fire-and-forget, so a real "slow dial" backlog is simulated directly.
		const slowQueue = pushState.perSubscriberQueue.queue(SUB_A);
		slowQueue.enqueue(note(101));
		slowQueue.enqueue(note(102));
		expect(slowQueue.full).to.equal(true);

		const before = transport.sent.length;
		await host.ingest(TOPIC, note(2));

		expect(pushState.perSubscriberQueue.peekQueue(SUB_A)!.dropped, 'the slow subscriber dropped its oldest').to.equal(1);
		// SUB_B (fast) still received revision 2 — its delivery is not stalled by SUB_A's backlog.
		const newlySent = transport.sent.slice(before);
		expect(newlySent.some((s) => s.target === SUB_B && s.n.revision === 2), 'the fast subscriber is delivered revision 2').to.equal(true);
	});

	it('reclaims a departed subscriber\'s queue on the next fan-out (memory bound: live set + one round)', async () => {
		let subs = [SUB_A, SUB_B];
		const { host } = makeHost({ directSubscribers: (): string[] => subs });

		await host.ingest(TOPIC, note(1));
		const pushState = host.pushStateFor(TOPIC)!;
		expect(pushState.perSubscriberQueue.subscriberCount).to.equal(2);

		// SUB_B departs (TTL-expired / withdrawn): the live set shrinks to [SUB_A].
		subs = [SUB_A];
		await host.ingest(TOPIC, note(2));

		expect(pushState.perSubscriberQueue.subscriberCount, 'the departed subscriber\'s queue is reclaimed').to.equal(1);
		expect(pushState.perSubscriberQueue.peekQueue(SUB_B), 'SUB_B has no queue').to.equal(undefined);
		expect(pushState.perSubscriberQueue.peekQueue(SUB_A), 'SUB_A keeps its queue').to.not.equal(undefined);
	});

	it('dials a child cohort primary on fan-out (CohortRef.primary, and the resolveChildPrimary fallback)', async () => {
		// (a) CohortRef.primary present → dialed directly.
		const childA: CohortRef = { coord: bytesToB64url(new Uint8Array([0x30])), primary: CHILD_PRIMARY };
		const { host: hostA, transport: txA } = makeHost({ directSubscribers: (): string[] => [], childCohorts: [childA] });
		await hostA.ingest(TOPIC, note(1));
		expect(txA.sent.map((s) => s.target), 'child primary dialed with the unmodified frame').to.deep.equal([CHILD_PRIMARY]);
		expect(txA.sent[0]!.n.revision).to.equal(1);

		// (b) CohortRef.primary absent → resolveChildPrimary resolves the dial target.
		const childB: CohortRef = { coord: bytesToB64url(new Uint8Array([0x31])) };
		const { host: hostB, transport: txB } = makeHost({
			directSubscribers: (): string[] => [],
			childCohorts: [childB],
			resolveChildPrimary: (ref): string | undefined => (ref.coord === childB.coord ? CHILD_PRIMARY : undefined),
		});
		await hostB.ingest(TOPIC, note(1));
		expect(txB.sent.map((s) => s.target)).to.deep.equal([CHILD_PRIMARY]);
	});

	it('never forwards on an Edge node (no PushState), but still delivers locally as a subscriber', async () => {
		const delivered: NotificationV1[] = [];
		const { host, transport } = makeHost({
			profile: edgeProfile(),
			directSubscribers: (): string[] => [SUB_A, SUB_B],
			deliverLocal: (_topicId, n): void => { delivered.push(n); },
		});

		// ingest path: an Edge node never instantiates a PushState and never fans out.
		await host.ingest(TOPIC, note(1));
		expect(host.pushStateFor(TOPIC), 'Edge instantiates no forwarder PushState').to.equal(undefined);
		expect(transport.sent, 'Edge never fans out').to.have.length(0);

		// onInbound still delivers in-process (pure subscriber).
		await host.onInbound({ id: new Uint8Array([1]) }, note(2));
		expect(delivered.map((n) => n.revision), 'Edge delivers as a subscriber via deliverLocal').to.deep.equal([2]);
		expect(transport.sent, 'still no fan-out on Edge').to.have.length(0);
	});

	it('isolates a per-target send failure: one dead subscriber never breaks fan-out to the rest', async () => {
		const transport = new FakeTransport(new Set([SUB_B])); // SUB_B's dial rejects
		const { host } = makeHost({ transport, directSubscribers: (): string[] => [SUB_A, SUB_B, SUB_C] });

		await host.ingest(TOPIC, note(1)); // must not reject despite SUB_B failing
		expect(transport.targets().sort(), 'all three were attempted; the failure was swallowed').to.deep.equal([SUB_A, SUB_B, SUB_C].sort());
	});

	it('serializes concurrent ingest for one collection — replay ring stays contiguous and dedupe holds', async () => {
		const { host, transport } = makeHost({ directSubscribers: (): string[] => [SUB_A] });

		// Five notifications ingested concurrently for the same topic must serialize into a contiguous ring.
		await Promise.all([1, 2, 3, 4, 5].map((rev) => host.ingest(TOPIC, note(rev))));
		const pushState = host.pushStateFor(TOPIC)!;
		expect(pushState.replayBuffer.entries().map((e) => e.revision), 'ring is contiguous and ordered').to.deep.equal([1, 2, 3, 4, 5]);
		expect(pushState.lastRevision).to.equal(5);
		expect(transport.sent, 'each fresh revision fanned out exactly once').to.have.length(5);

		// A concurrent duplicate of an already-buffered revision is deduped (no double-append, no extra dial).
		await Promise.all([host.ingest(TOPIC, note(3)), host.ingest(TOPIC, note(6))]);
		expect(pushState.replayBuffer.entries().map((e) => e.revision)).to.deep.equal([1, 2, 3, 4, 5, 6]);
		expect(transport.sent, 'only the fresh revision 6 added a dial').to.have.length(6);
	});

	it('never rejects out of ingest even when the verifier throws (a fan-out fault can never fail a commit)', async () => {
		const throwingVerifier: NotificationVerifier = { verify: () => Promise.reject(new Error('boom')) };
		const { host, transport } = makeHost({ verifierFor: (): NotificationVerifier => throwingVerifier });

		await host.ingest(TOPIC, note(1)); // resolves (does not reject)
		expect(transport.sent, 'a verifier fault drops the notification, no fan-out').to.have.length(0);
	});
});

describe('reactivity / forwarder host — rotation drain', () => {
	const NEW_TAIL = bytesToB64url(new Uint8Array([0x60, 0x60]));
	const NEW_TAIL_2 = bytesToB64url(new Uint8Array([0x70, 0x70]));
	const newTopicOf = (tail: string): string => bytesToB64url(reactivityTopicId(b64urlToBytes(tail)));

	it('markRotated → rotationRedirectFor returns the redirect (derived newTopicId) throughout the drain window', () => {
		const { host } = makeHost();
		host.markRotated(TOPIC, { newTailId: NEW_TAIL, effectiveAtRevision: 5401 }, NOW);

		const mid = host.rotationRedirectFor(TOPIC, NOW + 30_000);
		expect(mid, 'a request mid-drain is told to move').to.not.equal(undefined);
		expect(mid!.result).to.equal('rotated');
		expect(mid!.newTailId).to.equal(NEW_TAIL);
		expect(mid!.effectiveAtRevision).to.equal(5401);
		// db-core derives newTopicId = H(newTailId ‖ "reactivity"); the host never supplies it.
		expect(mid!.newTopicId).to.equal(newTopicOf(NEW_TAIL));
	});

	it('a topic that never rotated has no redirect', () => {
		const { host } = makeHost();
		expect(host.rotationRedirectFor(TOPIC, NOW)).to.equal(undefined);
	});

	it('strict drain boundary: redirect at rotatedAt + T_drain − 1, none (evicted) at exactly rotatedAt + T_drain', () => {
		const { host } = makeHost();
		host.markRotated(TOPIC, { newTailId: NEW_TAIL, effectiveAtRevision: 1 }, NOW);
		expect(host.rotationRedirectFor(TOPIC, NOW + T_DRAIN_MS - 1), 'still draining just inside the window').to.not.equal(undefined);
		expect(host.rotationRedirectFor(TOPIC, NOW + T_DRAIN_MS), 'drained at exactly the boundary (isDraining is strict <)').to.equal(undefined);
		// The gate entry was evicted: a later in-window-relative-to-a-fresh-mark query still sees nothing.
		expect(host.rotationRedirectFor(TOPIC, NOW + 1)).to.equal(undefined);
	});

	it('evicts the served PushState (and ingest tail) once the drain window closes', async () => {
		const { host } = makeHost({ directSubscribers: (): string[] => [SUB_A] });
		// Serve the outgoing tail: ingest instantiates its PushState (and its ingest-serialization tail).
		await host.ingest(TOPIC, note(1));
		expect(host.pushStateFor(TOPIC), 'the outgoing tail is served before rotation').to.not.equal(undefined);

		host.markRotated(TOPIC, { newTailId: NEW_TAIL, effectiveAtRevision: 2 }, NOW);
		// While draining the served state is retained (renewals/replays could still be answered by the redirect).
		expect(host.rotationRedirectFor(TOPIC, NOW + 10_000)).to.not.equal(undefined);
		expect(host.pushStateFor(TOPIC), 'served state retained during drain').to.not.equal(undefined);

		// After the window closes the next query evicts the gate AND reclaims the served PushState (12.31 leak).
		expect(host.rotationRedirectFor(TOPIC, NOW + T_DRAIN_MS)).to.equal(undefined);
		expect(host.pushStateFor(TOPIC), 'served PushState reclaimed on drain-elapsed eviction').to.equal(undefined);
		expect(host.livePushStates(), 'no live forwarder state lingers for the drained tail').to.have.length(0);
	});

	it('is idempotent for the same successor (no-op; drain window not restarted)', () => {
		const { host } = makeHost();
		host.markRotated(TOPIC, { newTailId: NEW_TAIL, effectiveAtRevision: 100 }, NOW);
		// A second mark to the SAME successor (even much later) must not restart the drain window.
		host.markRotated(TOPIC, { newTailId: NEW_TAIL, effectiveAtRevision: 100 }, NOW + 50_000);
		// If the window had restarted, this query (NOW + T_drain) would still be draining; it must be drained.
		expect(host.rotationRedirectFor(TOPIC, NOW + T_DRAIN_MS), 'window anchored at the first mark, not the second').to.equal(undefined);
	});

	it('advances to a later successor on a chained rotation (OLD→A→B), replacing the gate', () => {
		const { host } = makeHost();
		host.markRotated(TOPIC, { newTailId: NEW_TAIL, effectiveAtRevision: 100 }, NOW);
		expect(host.rotationRedirectFor(TOPIC, NOW + 1_000)!.newTailId).to.equal(NEW_TAIL);

		// A second rotation to a LATER successor (higher effectiveAtRevision) replaces the gate and restarts drain.
		host.markRotated(TOPIC, { newTailId: NEW_TAIL_2, effectiveAtRevision: 200 }, NOW + 5_000);
		const redirect = host.rotationRedirectFor(TOPIC, NOW + 6_000);
		expect(redirect!.newTailId, 'redirect advanced to the later successor').to.equal(NEW_TAIL_2);
		expect(redirect!.newTopicId).to.equal(newTopicOf(NEW_TAIL_2));
		expect(redirect!.effectiveAtRevision).to.equal(200);

		// An EARLIER successor (lower effectiveAtRevision) is ignored — the gate stays on B.
		host.markRotated(TOPIC, { newTailId: NEW_TAIL, effectiveAtRevision: 50 }, NOW + 7_000);
		expect(host.rotationRedirectFor(TOPIC, NOW + 8_000)!.newTailId, 'earlier successor ignored').to.equal(NEW_TAIL_2);
	});
});

describe('reactivity / direct-subscriber adapter', () => {
	const record = (over: Partial<RegistrationRecord>): RegistrationRecord => ({
		topicId: b64urlToBytes(TAIL),
		participantId: new Uint8Array([0]),
		tier: Tier.T3,
		primary: new Uint8Array([0]),
		backups: [],
		attachedAt: NOW,
		lastPing: NOW,
		ttl: 90_000,
		...over,
	});

	const reactivityAppState = (): Uint8Array => encodeSubscribeAppPayload({
		kind: 'reactivity',
		collectionId: COLLECTION,
		tailIdAtAttach: TAIL,
		lastKnownRev: 0,
		deltaMaxBytes: 0,
	});

	it('returns dialable peer-id strings only for records carrying a reactivity subscribe payload', async () => {
		// participantId is carried as peerIdToBytes(peerId) = utf8(peerIdString); the adapter must decode it
		// back to the canonical peer-id string (the transport's `peerIdFromString` dial-target space), NOT
		// base64url — a base64url target would silently fail `peerIdFromString` and never dial.
		const peerA = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const pA = peerIdToBytes(peerA);
		const pB = peerIdToBytes(peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());
		const pC = peerIdToBytes(peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());
		const records: RegistrationRecord[] = [
			record({ participantId: pA, appState: reactivityAppState() }),
			record({ participantId: pB, appState: undefined }), // no appState → not a reactivity subscriber
			record({ participantId: pC, appState: new TextEncoder().encode('{"kind":"match-provider"}') }), // other app
		];
		const source = { records: (): readonly RegistrationRecord[] => records };

		const out = reactivityDirectSubscribers(source, b64urlToBytes(TAIL));
		expect(out).to.deep.equal([peerA]);
		// Pin the no-dial regression: the emitted target round-trips through the transport's `peerIdFromString`.
		expect(() => peerIdFromString(out[0]!), 'the target is a valid dialable peer-id string').to.not.throw();
	});

	it('reactivityNotificationTopicId matches the verifier/origination tail-anchor derivation', () => {
		expect([...reactivityNotificationTopicId(note(1))]).to.deep.equal([...reactivityTopicId(b64urlToBytes(TAIL))]);
	});
});
