import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import {
	PushState,
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

	it('uses the configured recover protocol id for the libp2p dialer default', () => {
		expect(PROTOCOL_REACTIVITY_RECOVER).to.equal('/optimystic/reactivity/1.0.0/recover');
	});
});
