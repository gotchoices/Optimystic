import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import {
	PushState,
	reactivityTopicId,
	bytesToB64url,
	b64urlToBytes,
	createCorrelationReplayGuard,
	encodeRecoverRequestV1,
	decodeRecoverReplyV1,
	type BackfillSignable,
	type ResumeSignable,
	type NotificationV1,
} from '@optimystic/db-core';
import { signPeer, signPeerSig, verifyPeerSig } from '../../src/cohort-topic/peer-sig.js';
import {
	createRecoverRequestSigners,
	createRecoverRequestHandler,
	type RecoverServeDeps,
} from '../../src/reactivity/recover-transport.js';

const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));
const TAIL = bytesToB64url(new Uint8Array([2, 2, 2, 2]));
const FIXED_NOW = 1_700_000_000_000;

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

function seedPushState(revs: number[]): PushState {
	const topicId = reactivityTopicId(b64urlToBytes(TAIL));
	const ps = new PushState({ collectionId: COLLECTION, topicId: bytesToB64url(topicId), tailIdAtJoin: TAIL });
	for (const rev of revs) {
		ps.replayBuffer.append({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
	}
	ps.lastRevision = revs.length > 0 ? revs[revs.length - 1]! : -1;
	return ps;
}

function serveDepsFor(ps: PushState): RecoverServeDeps {
	return {
		pushStateFor: (topicId) => (bytesToB64url(topicId) === ps.topicId ? ps : undefined),
		pushStateForCollection: (collectionId) => (collectionId === ps.collectionId ? ps : undefined),
		replayGuard: createCorrelationReplayGuard(),
		clock: () => FIXED_NOW,
	};
}

let key: PrivateKey;
let peerId: PeerId;

before(async () => {
	key = await generateKeyPair('Ed25519');
	peerId = peerIdFromPrivateKey(key);
});

describe('reactivity recover — synchronous signer primitive (signPeerSig)', () => {
	it('produces a signature the synchronous verifyPeerSig accepts (round-trip)', () => {
		const payload = new TextEncoder().encode('recover-payload-under-test');
		const sig = signPeerSig(key, payload);
		expect(verifyPeerSig(peerId.toString(), payload, sig)).to.equal(true);
	});

	it('is byte-identical to the async signPeer for the same key + payload (deterministic Ed25519)', async () => {
		const payload = new TextEncoder().encode('determinism-check');
		const sync = signPeerSig(key, payload);
		const async = await signPeer(key, payload);
		// RFC8032 Ed25519 is deterministic: the noble sync sign and libp2p's async (Node/WebCrypto) sign
		// over the same seed + message MUST produce the same bytes — pinning the cross-impl compatibility.
		expect(bytesToB64url(sync)).to.equal(bytesToB64url(async));
	});

	it('a signature does not verify under a different peer id', async () => {
		const payload = new TextEncoder().encode('wrong-verifier');
		const sig = signPeerSig(key, payload);
		const otherPeer = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		expect(verifyPeerSig(otherPeer.toString(), payload, sig)).to.equal(false);
	});

	it('rejects a non-Ed25519 key (the substrate assumes Ed25519)', async () => {
		const secp = await generateKeyPair('secp256k1');
		expect(() => signPeerSig(secp, new Uint8Array([1, 2, 3]))).to.throw(/Ed25519/);
	});
});

describe('reactivity recover — request signers integrate with the inbound serve handler', () => {
	it('signBackfill produces a request the handler verifies + serves', async () => {
		const ps = seedPushState([10, 11, 12, 13, 14]);
		const handler = createRecoverRequestHandler(serveDepsFor(ps));
		const { signBackfill } = createRecoverRequestSigners(key);

		const unsigned: BackfillSignable = { v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: FIXED_NOW };
		const req = { ...unsigned, signature: signBackfill(unsigned) };
		const replyFrame = await handler(encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: req }), peerId);

		expect(replyFrame, 'a correctly-signed request must be served').to.not.equal(undefined);
		const reply = decodeRecoverReplyV1(replyFrame!);
		expect(reply.kind).to.equal('backfill');
		expect(reply.backfillReply!.entries.map((e) => e.revision)).to.deep.equal([11, 12, 13, 14]);
	});

	it('signResume produces a request the handler verifies + serves', async () => {
		const ps = seedPushState([10, 11, 12, 13, 14]);
		const handler = createRecoverRequestHandler(serveDepsFor(ps));
		const { signResume } = createRecoverRequestSigners(key);

		const unsigned: ResumeSignable = { v: 1, collectionId: COLLECTION, fromRevision: 12, latestKnownTailId: TAIL, subscriberCoord: COLLECTION, timestamp: FIXED_NOW };
		const req = { ...unsigned, signature: signResume(unsigned) };
		const replyFrame = await handler(encodeRecoverRequestV1({ v: 1, kind: 'resume', resume: req }), peerId);

		expect(replyFrame, 'a correctly-signed resume must be served').to.not.equal(undefined);
		const reply = decodeRecoverReplyV1(replyFrame!);
		expect(reply.kind).to.equal('resume');
		expect(reply.resumeReply).to.not.equal(undefined);
	});

	it('a request signed by another key is rejected (no reply) when dialed from this peer', async () => {
		const ps = seedPushState([10, 11, 12]);
		const handler = createRecoverRequestHandler(serveDepsFor(ps));
		// Sign with a DIFFERENT key than the dialing peer id below → signer != dialer → verify fails.
		const otherKey = await generateKeyPair('Ed25519');
		const { signBackfill } = createRecoverRequestSigners(otherKey);

		const unsigned: BackfillSignable = { v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 12, timestamp: FIXED_NOW };
		const req = { ...unsigned, signature: signBackfill(unsigned) };
		const replyFrame = await handler(encodeRecoverRequestV1({ v: 1, kind: 'backfill', backfill: req }), peerId);

		expect(replyFrame, 'signer != dialing peer → no reply').to.equal(undefined);
	});
});
