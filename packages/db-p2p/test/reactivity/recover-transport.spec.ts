import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import {
	PushState,
	RollingCheckpoint,
	reactivityTopicId,
	bytesToB64url,
	b64urlToBytes,
	serveResume,
	backfillSigningPayload,
	resumeSigningPayload,
	encodeRecoverRequestV1,
	decodeRecoverReplyV1,
	createCorrelationReplayGuard,
	type BackfillSignable,
	type BackfillV1,
	type ResumeSignable,
	type ResumeV1,
	type NotificationV1,
	type CheckpointSummary,
	type RotationRedirectV1,
	type StickyCohortHintCache,
} from '@optimystic/db-core';
import { createStickyCohortHintCache } from '@optimystic/db-core';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { signPeer } from '../../src/cohort-topic/peer-sig.js';
import { PROTOCOL_REACTIVITY_RECOVER } from '../../src/reactivity/protocols.js';
import {
	Libp2pReactivityRecoverTransport,
	createRecoverRequestHandler,
	decodeCohortHintTarget,
	RotationRedirectError,
	type RecoverDialer,
	type RecoverServeDeps,
} from '../../src/reactivity/recover-transport.js';

const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));
const TAIL = bytesToB64url(new Uint8Array([2, 2, 2, 2]));
const OTHER_TAIL = bytesToB64url(new Uint8Array([7, 7, 7, 7]));
const FIXED_NOW = 1_700_000_000_000;
const TOPIC = reactivityTopicId(b64urlToBytes(TAIL));

function note(revision: number): NotificationV1 {
	return {
		v: 1,
		collectionId: COLLECTION,
		tailId: TAIL,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: FIXED_NOW + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [bytesToB64url(new Uint8Array([8]))],
	};
}

/** A PushState seeded with `revs` in its ring (default-deep) and `lastRevision` set to the high edge. */
function seedPushState(revs: number[], tail = TAIL): PushState {
	const topicId = reactivityTopicId(b64urlToBytes(tail));
	const ps = new PushState({ collectionId: COLLECTION, topicId: bytesToB64url(topicId), tailIdAtJoin: tail });
	for (const rev of revs) {
		ps.replayBuffer.append({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
	}
	ps.lastRevision = revs.length > 0 ? revs[revs.length - 1]! : -1;
	return ps;
}

/**
 * A PushState fed `1..count` through a narrow ring (`w`/`wCheckpoint`), so the overflow auto-retires into the
 * rolling checkpoint (the ring's eviction callback). With `count=20, w=4, wCheckpoint=8`: ring `[17..20]`,
 * rolling checkpoint `[9,16]` — the same shape db-core's resume tests use to exercise the inherited branch.
 */
function seedFedPushState(count: number, w = 4, wCheckpoint = 8, tail = TAIL): PushState {
	const topicId = reactivityTopicId(b64urlToBytes(tail));
	const ps = new PushState({ collectionId: COLLECTION, topicId: bytesToB64url(topicId), tailIdAtJoin: tail, w, wCheckpoint });
	for (let rev = 1; rev <= count; rev++) {
		ps.replayBuffer.append({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
	}
	ps.lastRevision = count;
	return ps;
}

/** A standalone {@link CheckpointSummary} over `[fromRev, toRev]` — stands in for the new tail's rotation handoff. */
function inheritedSummary(fromRev: number, toRev: number): CheckpointSummary {
	const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: toRev - fromRev + 1 });
	for (let rev = fromRev; rev <= toRev; rev++) cp.retire({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
	return cp.summary()!;
}

const NEW_TAIL = bytesToB64url(new Uint8Array([6, 6, 6, 6]));
/** The drain redirect a rotated old cohort hands back over the recover reply (`kind: "rotated"`). */
const rotationRedirect = (over: Partial<RotationRedirectV1> = {}): RotationRedirectV1 => ({
	v: 1,
	result: 'rotated',
	newTailId: NEW_TAIL,
	newTopicId: bytesToB64url(reactivityTopicId(b64urlToBytes(NEW_TAIL))),
	effectiveAtRevision: 5401,
	...over,
});

/** Serve deps backed by one PushState resolved by exact topic and by collection. */
function serveDepsFor(ps: PushState, over: Partial<RecoverServeDeps> = {}): RecoverServeDeps {
	return {
		pushStateFor: (topicId) => (bytesToB64url(topicId) === ps.topicId ? ps : undefined),
		pushStateForCollection: (collectionId) => (collectionId === ps.collectionId ? ps : undefined),
		replayGuard: createCorrelationReplayGuard(),
		clock: () => FIXED_NOW,
		...over,
	};
}

let key: PrivateKey;
let peerId: PeerId;

before(async () => {
	key = await generateKeyPair('Ed25519');
	peerId = peerIdFromPrivateKey(key);
});

async function signBackfill(unsigned: BackfillSignable, signer: PrivateKey = key): Promise<BackfillV1> {
	return { ...unsigned, signature: bytesToB64url(await signPeer(signer, backfillSigningPayload(unsigned))) };
}
async function signResume(unsigned: ResumeSignable, signer: PrivateKey = key): Promise<ResumeV1> {
	return { ...unsigned, signature: bytesToB64url(await signPeer(signer, resumeSigningPayload(unsigned))) };
}

describe('reactivity recover — dial-target encoding bridge', () => {
	it('round-trips a sticky primary (base64url-of-bytes) back to a dialable peer-id string', () => {
		const primary = bytesToB64url(peerIdToBytes(peerId.toString())); // exactly how ReactivityCohortHint.primary is carried
		const target = decodeCohortHintTarget(primary);
		expect(target).to.equal(peerId.toString());
		expect(() => peerIdFromString(target)).to.not.throw(); // decoded value is a valid dial target
	});

	it('pins the bug: the raw base64url-of-bytes is NOT a valid peer-id string', () => {
		const primary = bytesToB64url(peerIdToBytes(peerId.toString()));
		expect(() => peerIdFromString(primary)).to.throw(); // feeding the raw hint to peerIdFromString throws → silent no-dial
	});
});

describe('reactivity recover — inbound serve handler', () => {
	it('serves a backfill from a seeded ring', async () => {
		const ps = seedPushState([10, 11, 12, 13, 14]);
		const handler = createRecoverRequestHandler(serveDepsFor(ps));
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: FIXED_NOW });
		const replyFrame = await handler(encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: req }), peerId);
		expect(replyFrame).to.not.equal(undefined);
		const reply = decodeRecoverReplyV1(replyFrame!);
		expect(reply.kind).to.equal('backfill');
		expect(reply.backfillReply!.entries.map((e) => e.revision)).to.deep.equal([11, 12, 13, 14]);
	});

	for (const variant of ['backfill', 'out_of_window', 'tail_rotated'] as const) {
		it(`faithfully carries the serveResume "${variant}" classification`, async () => {
			const ps = seedPushState([10, 11, 12, 13, 14]);
			// fromRevision / tail chosen so classifyResume lands on each variant:
			const fromRevision = variant === 'out_of_window' ? 3 : variant === 'tail_rotated' ? 11 : 12;
			const latestKnownTailId = variant === 'tail_rotated' ? OTHER_TAIL : TAIL;
			const req = await signResume({ v: 1, collectionId: COLLECTION, fromRevision, latestKnownTailId, subscriberCoord: COLLECTION, timestamp: FIXED_NOW });
			const expected = serveResume(req, { buffer: ps.replayBuffer, checkpoint: ps.checkpoint, currentTailId: ps.tailIdAtJoin, currentRevision: ps.lastRevision, rotationRevision: ps.lastRevision, expectedCollectionId: ps.collectionId });
			expect(expected.result).to.equal(variant); // the fixture really hits this variant

			const handler = createRecoverRequestHandler(serveDepsFor(ps));
			const replyFrame = await handler(encodeRecoverRequestV1({ v: 1, kind: 'resume', resume: req }), peerId);
			const reply = decodeRecoverReplyV1(replyFrame!);
			expect(reply.kind).to.equal('resume');
			expect(reply.resumeReply).to.deep.equal(expected);
		});
	}

	it('answers a stale-tail resume from the collection lookup when the exact topic is unserved (→ tail_rotated)', async () => {
		// Serve only the CURRENT tail; the request carries a stale (rotated-away) tail whose topic is unserved.
		const ps = seedPushState([20, 21, 22]); // current tail = TAIL
		const staleTopic = reactivityTopicId(b64urlToBytes(OTHER_TAIL));
		const handler = createRecoverRequestHandler({
			pushStateFor: (topicId) => (bytesToB64url(topicId) === ps.topicId ? ps : undefined), // unserved for the stale tail
			pushStateForCollection: () => ps,
			replayGuard: createCorrelationReplayGuard(),
			clock: () => FIXED_NOW,
		});
		const req = await signResume({ v: 1, collectionId: COLLECTION, fromRevision: 5, latestKnownTailId: OTHER_TAIL, subscriberCoord: COLLECTION, timestamp: FIXED_NOW });
		expect(bytesToB64url(staleTopic)).to.not.equal(ps.topicId); // sanity: the stale topic is not the served one
		const reply = decodeRecoverReplyV1((await handler(encodeRecoverRequestV1({ v: 1, kind: 'resume', resume: req }), peerId))!);
		expect(reply.resumeReply!.result).to.equal('tail_rotated');
		expect(reply.resumeReply!.newTailId).to.equal(TAIL);
	});

	it('resume reaching a draining old tail is answered with the kind:"rotated" redirect (consulting the stale tail topic)', async () => {
		const ps = seedPushState([10, 11, 12, 13, 14]);
		const redirect = rotationRedirect();
		let seenTopic: Uint8Array | undefined;
		let seenNow: number | undefined;
		const deps = serveDepsFor(ps, {
			rotationFor: (req, now) => { seenTopic = req.topicId; seenNow = now; return redirect; },
		});
		const handler = createRecoverRequestHandler(deps);
		const req = await signResume({ v: 1, collectionId: COLLECTION, fromRevision: 12, latestKnownTailId: TAIL, subscriberCoord: COLLECTION, timestamp: FIXED_NOW });
		const reply = decodeRecoverReplyV1((await handler(encodeRecoverRequestV1({ v: 1, kind: 'resume', resume: req }), peerId))!);
		expect(reply.kind).to.equal('rotated');
		expect(reply.rotated).to.deep.equal(redirect);
		// The redirect lookup is keyed by the request's stale tail topic: reactivityTopicId(latestKnownTailId).
		expect([...seenTopic!]).to.deep.equal([...reactivityTopicId(b64urlToBytes(TAIL))]);
		expect(seenNow).to.equal(FIXED_NOW); // consulted against the injected serve clock
	});

	it('resume across a rotation is served from the new tail inheritedCheckpoint (else out_of_window)', async () => {
		// New-tail PushState: ring [17..20], rolling checkpoint [9,16], plus an inherited handoff [1,16].
		const ps = seedFedPushState(20);
		ps.adoptRotationCheckpoint(inheritedSummary(1, 16));
		const handler = createRecoverRequestHandler(serveDepsFor(ps));
		// fromRevision 5 is below the ring low (17) and the rolling checkpoint low (9), but inside [1,16].
		const req = await signResume({ v: 1, collectionId: COLLECTION, fromRevision: 5, latestKnownTailId: TAIL, subscriberCoord: COLLECTION, timestamp: FIXED_NOW });
		const reply = decodeRecoverReplyV1((await handler(encodeRecoverRequestV1({ v: 1, kind: 'resume', resume: req }), peerId))!);
		expect(reply.kind).to.equal('resume');
		expect(reply.resumeReply!.result, 'answered from the inherited checkpoint').to.equal('checkpoint_window');
		expect(reply.resumeReply!.checkpoint!.fromRevision).to.equal(1);
		expect(reply.resumeReply!.checkpoint!.toRevision).to.equal(16);

		// Proof the serve actually threads ps.inheritedCheckpoint: the same request without the handoff falls to out_of_window.
		const bare = seedFedPushState(20);
		const bareReply = decodeRecoverReplyV1((await createRecoverRequestHandler(serveDepsFor(bare))(encodeRecoverRequestV1({ v: 1, kind: 'resume', resume: req }), peerId))!);
		expect(bareReply.resumeReply!.result).to.equal('out_of_window');
	});

	it('backfill reaching a node serving only the draining old tail is answered with the redirect (keyed by collectionId, no topicId)', async () => {
		const ps = seedPushState([10, 11, 12]);
		const redirect = rotationRedirect();
		let seenReq: { topicId?: Uint8Array; collectionId: string } | undefined;
		const deps = serveDepsFor(ps, {
			rotationFor: (req) => { seenReq = req; return redirect; },
		});
		const handler = createRecoverRequestHandler(deps);
		// A backfill underflowing the ring (fromRevision 5 < ring low 10) — the secondary redirect path.
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 5, toRevision: 8, timestamp: FIXED_NOW });
		const reply = decodeRecoverReplyV1((await handler(encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: req }), peerId))!);
		expect(reply.kind).to.equal('rotated');
		expect(reply.rotated).to.deep.equal(redirect);
		// Backfill defers the topic resolution to the binding: it passes collectionId only, no topicId.
		expect(seenReq!.topicId).to.equal(undefined);
		expect(seenReq!.collectionId).to.equal(COLLECTION);
	});

	it('a non-rotated cohort (rotationFor returns undefined) serves backfill/resume as today', async () => {
		const ps = seedPushState([10, 11, 12, 13, 14]);
		const handler = createRecoverRequestHandler(serveDepsFor(ps, { rotationFor: () => undefined }));
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: FIXED_NOW });
		const reply = decodeRecoverReplyV1((await handler(encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: req }), peerId))!);
		expect(reply.kind).to.equal('backfill');
		expect(reply.backfillReply!.entries.map((e) => e.revision)).to.deep.equal([11, 12, 13, 14]);
	});

	it('rejects (no reply) a request whose signature does not verify against the dialing peer', async () => {
		const ps = seedPushState([10, 11, 12]);
		const handler = createRecoverRequestHandler(serveDepsFor(ps));
		const wrongKey = await generateKeyPair('Ed25519');
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW }, wrongKey); // signed by someone else
		const replyFrame = await handler(encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: req }), peerId);
		expect(replyFrame).to.equal(undefined); // dialing peer != signer → no reply
	});

	it('rejects (no reply) a replayed request and a stale request', async () => {
		const ps = seedPushState([10, 11, 12]);
		let served = 0;
		const deps = serveDepsFor(ps, {
			replayGuard: createCorrelationReplayGuard(),
			pushStateForCollection: (c) => { served++; return c === ps.collectionId ? ps : undefined; },
		});
		const handler = createRecoverRequestHandler(deps);
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW });
		const frame = encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: req });

		expect(await handler(frame, peerId)).to.not.equal(undefined); // first sight accepted
		expect(await handler(frame, peerId)).to.equal(undefined); // identical frame → replay rejected
		expect(served).to.equal(1); // the serve logic ran exactly once

		// A stale timestamp (older than the guard window) is rejected even with a valid signature.
		const stale = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW - 10 * 60_000 });
		expect(await handler(encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: stale }), peerId)).to.equal(undefined);
	});

	it('sends no reply when this node serves no PushState for the request', async () => {
		const handler = createRecoverRequestHandler({
			pushStateFor: () => undefined,
			pushStateForCollection: () => undefined,
			replayGuard: createCorrelationReplayGuard(),
			clock: () => FIXED_NOW,
		});
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW });
		expect(await handler(encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: req }), peerId)).to.equal(undefined);
	});

	it('drops an undecodable frame without throwing', async () => {
		const handler = createRecoverRequestHandler(serveDepsFor(seedPushState([1])));
		expect(await handler(new Uint8Array([0, 0, 0, 2, 0x7b, 0x7b]), peerId)).to.equal(undefined); // garbage body
	});
});

describe('reactivity recover — outbound transport', () => {
	/** A dialer that pipes the frame straight through `handler` with `peerId` as the dialing peer. */
	function handlerDialer(handler: ReturnType<typeof createRecoverRequestHandler>, dialed: string[] = []): RecoverDialer {
		return {
			async exchange(target, frame) {
				dialed.push(target);
				const reply = await handler(frame, peerId);
				if (reply === undefined) {
					throw new Error('stream aborted (no reply)'); // mirror requestResponse over a dropped reply
				}
				return reply;
			},
		};
	}

	function hintCacheWith(primary: string): StickyCohortHintCache {
		const cache = createStickyCohortHintCache();
		cache.set(COLLECTION, { topicId: bytesToB64url(TOPIC), primary, cohortHint: [] });
		return cache;
	}

	it('backfillTransport frames the request, exchanges it, and returns the inner reply', async () => {
		const ps = seedPushState([10, 11, 12, 13, 14]);
		const transport = new Libp2pReactivityRecoverTransport({
			dialer: handlerDialer(createRecoverRequestHandler(serveDepsFor(ps))),
			selfPeerId: 'self-peer-not-dialed',
			cohortHintCache: createStickyCohortHintCache(),
			resolveCohort: () => [peerId.toString()],
		});
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: FIXED_NOW });
		const reply = await transport.backfillTransport(TOPIC, COLLECTION)(req);
		expect(reply.entries.map((e) => e.revision)).to.deep.equal([11, 12, 13, 14]);
	});

	it('resumeTransport returns the classified resume reply', async () => {
		const ps = seedPushState([10, 11, 12, 13, 14]);
		const transport = new Libp2pReactivityRecoverTransport({
			dialer: handlerDialer(createRecoverRequestHandler(serveDepsFor(ps))),
			selfPeerId: 'self',
			cohortHintCache: createStickyCohortHintCache(),
			resolveCohort: () => [peerId.toString()],
		});
		const req = await signResume({ v: 1, collectionId: COLLECTION, fromRevision: 12, latestKnownTailId: TAIL, subscriberCoord: COLLECTION, timestamp: FIXED_NOW });
		const reply = await transport.resumeTransport(TOPIC, COLLECTION)(req);
		expect(reply.result).to.equal('backfill');
		expect(reply.entries!.map((e) => e.revision)).to.deep.equal([12, 13, 14]);
	});

	it('dials the sticky primary first', async () => {
		const ps = seedPushState([10, 11, 12]);
		const dialed: string[] = [];
		const primaryStr = peerId.toString();
		const transport = new Libp2pReactivityRecoverTransport({
			dialer: handlerDialer(createRecoverRequestHandler(serveDepsFor(ps)), dialed),
			selfPeerId: 'self',
			cohortHintCache: hintCacheWith(bytesToB64url(peerIdToBytes(primaryStr))),
			resolveCohort: () => ['some-walk-member'],
		});
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW });
		await transport.backfillTransport(TOPIC, COLLECTION)(req);
		expect(dialed[0]).to.equal(primaryStr); // sticky primary tried before the walk
	});

	it('falls back to a cohort-walk member when the sticky primary dial fails', async () => {
		const ps = seedPushState([10, 11, 12]);
		const dialed: string[] = [];
		const goodHandler = createRecoverRequestHandler(serveDepsFor(ps));
		const stalePrimary = bytesToB64url(peerIdToBytes(peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()));
		const walkMember = peerId.toString();
		const transport = new Libp2pReactivityRecoverTransport({
			dialer: {
				async exchange(target, frame) {
					dialed.push(target);
					if (target !== walkMember) throw new Error('dial failed (stale primary)');
					const reply = await goodHandler(frame, peerId);
					if (reply === undefined) throw new Error('no reply');
					return reply;
				},
			},
			selfPeerId: 'self',
			cohortHintCache: hintCacheWith(stalePrimary),
			resolveCohort: () => [walkMember],
		});
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW });
		const reply = await transport.backfillTransport(TOPIC, COLLECTION)(req);
		expect(reply.entries.map((e) => e.revision)).to.deep.equal([11, 12]);
		expect(dialed).to.have.length(2); // sticky failed, then walk succeeded
		expect(dialed[1]).to.equal(walkMember);
	});

	it('never dials self', async () => {
		const ps = seedPushState([10, 11, 12]);
		const dialed: string[] = [];
		const selfStr = peerId.toString();
		const otherStr = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const transport = new Libp2pReactivityRecoverTransport({
			dialer: {
				async exchange(target, frame) {
					dialed.push(target);
					const reply = await createRecoverRequestHandler(serveDepsFor(ps))(frame, peerId);
					if (reply === undefined) throw new Error('no reply');
					return reply;
				},
			},
			selfPeerId: selfStr,
			cohortHintCache: createStickyCohortHintCache(),
			resolveCohort: () => [selfStr, otherStr],
		});
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW });
		await transport.backfillTransport(TOPIC, COLLECTION)(req);
		expect(dialed).to.not.include(selfStr);
		expect(dialed[0]).to.equal(otherStr);
	});

	it('rejects when no target resolves', async () => {
		const transport = new Libp2pReactivityRecoverTransport({
			dialer: { exchange: () => Promise.reject(new Error('should not be called')) },
			selfPeerId: 'self',
			cohortHintCache: createStickyCohortHintCache(),
			resolveCohort: () => [],
		});
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW });
		let threw = false;
		try { await transport.backfillTransport(TOPIC, COLLECTION)(req); } catch { threw = true; }
		expect(threw).to.equal(true);
	});

	it('surfaces a kind:"rotated" reply as a terminal RotationRedirectError (no cohort-walk fallthrough)', async () => {
		const ps = seedPushState([10, 11, 12]);
		const redirect = rotationRedirect();
		const dialed: string[] = [];
		const secondMember = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const handler = createRecoverRequestHandler(serveDepsFor(ps, { rotationFor: () => redirect }));
		const transport = new Libp2pReactivityRecoverTransport({
			dialer: handlerDialer(handler, dialed),
			selfPeerId: 'self',
			cohortHintCache: createStickyCohortHintCache(),
			resolveCohort: () => [peerId.toString(), secondMember],
		});
		const req = await signBackfill({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW });
		let caught: unknown;
		try { await transport.backfillTransport(TOPIC, COLLECTION)(req); } catch (err) { caught = err; }
		expect(caught, 'a rotated reply surfaces as a typed RotationRedirectError').to.be.instanceOf(RotationRedirectError);
		expect((caught as RotationRedirectError).redirect).to.deep.equal(redirect);
		// Terminal: the dialed member answered authoritatively, so the walk stops (NOT a dial-failure fallthrough).
		expect(dialed, 'the redirect stopped the walk after the first member').to.have.length(1);
	});

	it('resumeTransport also surfaces the rotated redirect as a RotationRedirectError', async () => {
		const ps = seedPushState([10, 11, 12, 13, 14]);
		const redirect = rotationRedirect({ effectiveAtRevision: 99 });
		const transport = new Libp2pReactivityRecoverTransport({
			dialer: handlerDialer(createRecoverRequestHandler(serveDepsFor(ps, { rotationFor: () => redirect }))),
			selfPeerId: 'self',
			cohortHintCache: createStickyCohortHintCache(),
			resolveCohort: () => [peerId.toString()],
		});
		const req = await signResume({ v: 1, collectionId: COLLECTION, fromRevision: 12, latestKnownTailId: TAIL, subscriberCoord: COLLECTION, timestamp: FIXED_NOW });
		let caught: unknown;
		try { await transport.resumeTransport(TOPIC, COLLECTION)(req); } catch (err) { caught = err; }
		expect(caught).to.be.instanceOf(RotationRedirectError);
		expect((caught as RotationRedirectError).redirect.effectiveAtRevision).to.equal(99);
	});

	it('uses the configured recover protocol id for the libp2p dialer default', () => {
		expect(PROTOCOL_REACTIVITY_RECOVER).to.equal('/optimystic/reactivity/1.0.0/recover');
	});
});
