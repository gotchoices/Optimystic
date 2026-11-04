import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	decodeCohortMessage,
	validateRegisterV1,
	registerSigningPayload,
	type RegisterV1,
} from '@optimystic/db-core';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { signPeer, verifyPeerSigAsync } from '../../src/cohort-topic/peer-sig.js';
import { makeMember } from '../../src/testing/cohort-topic-mesh-harness.js';
import { createInboundHost, FRESH_AHEAD_MS, registerBody, renewBody } from './inbound-frame-helpers.js';

const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 3) & 0xff);

/** A 16-byte correlationId seeded from a label — the wire codec pins the field to exactly 16 bytes. */
const cid16 = (label: string): string => {
	const buf = new Uint8Array(16);
	new TextEncoder().encodeInto(label, buf);
	return bytesToB64url(buf);
};

describe('cohort-topic: a host with no node key checks no participant signature', () => {
	it('admits an unsigned register and acts on an unsigned withdraw', async () => {
		const { host, overStream } = await createInboundHost({ keyed: false });
		try {
			const participant = await makeMember();
			const body = registerBody(participant, TOPIC);
			expect((await overStream({ ...body, signature: '' })).result, 'key-less host admits an unsigned register').to.equal('accepted');
			const withdraw = { ...renewBody(participant, TOPIC, Date.now() + FRESH_AHEAD_MS), withdraw: true };
			expect((await overStream({ ...withdraw, signature: '' })).result, 'key-less host acts on an unsigned withdraw').to.equal('withdrawn');
		} finally {
			await host.stop();
		}
	});
});

describe('cohort-topic: register signing payload survives the codec round-trip (determinism)', () => {
	// The host's verifier recomputes `registerSigningPayload` from the *decoded* frame, not the in-memory
	// object the participant signed. Determinism therefore rests on the JSON encode→decode→validate
	// round-trip reproducing the byte image exactly — including optional-field normalization
	// (`bootstrap` absent, `appPayload` present). The other specs pass the in-memory object straight to
	// `handleRegister`, so this is the one that exercises the actual wire path.
	it('verifies after encode→decode→validate, with appPayload present and bootstrap absent', async () => {
		const participantKey = await generateKeyPair('Ed25519');
		const participantCoordBytes = peerIdToBytes(peerIdFromPrivateKey(participantKey));
		const body: Omit<RegisterV1, 'signature'> = {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesToB64url(participantCoordBytes),
			ttl: 90_000,
			// bootstrap deliberately omitted → normalized to `false` on both sides.
			appPayload: bytesToB64url(new TextEncoder().encode('app-state-bytes')),
			timestamp: 1_700_000_000_000,
			correlationId: cid16('cid-roundtrip'),
		};
		const sig = await signPeer(participantKey, registerSigningPayload(body));
		const signed: RegisterV1 = { ...body, signature: bytesToB64url(sig) };

		// Full wire round-trip the way an inbound frame is processed by the host.
		const decoded = validateRegisterV1(decodeCohortMessage(encodeCohortMessage(signed), undefined));
		expect(decoded.bootstrap, 'absent bootstrap stays absent across the wire').to.equal(undefined);
		expect(decoded.appPayload, 'appPayload round-trips').to.equal(body.appPayload);
		expect(
			await verifyPeerSigAsync(b64urlToBytes(decoded.participantCoord), registerSigningPayload(decoded), b64urlToBytes(decoded.signature)),
			'signature verifies against the decoded frame',
		).to.equal(true);

		// A post-signing tamper of any covered field (here appPayload) must break verification.
		const tampered = validateRegisterV1(decodeCohortMessage(encodeCohortMessage({ ...signed, appPayload: bytesToB64url(new TextEncoder().encode('other')) }), undefined));
		expect(
			await verifyPeerSigAsync(b64urlToBytes(tampered.participantCoord), registerSigningPayload(tampered), b64urlToBytes(tampered.signature)),
			'tampered appPayload fails verification',
		).to.equal(false);
	});

	it('covers followOn in the signature: a follow-on register verifies, and a stripped/flipped followOn does not', async () => {
		// A follow-on cold-start re-issue sets followOn:true (treeTier >= 1) and must be covered by the
		// participant signature so a MITM cannot strip it (downgrading the child cold-start) or flip a plain
		// register into one. The signer + verifier recompute registerSigningPayload identically.
		const participantKey = await generateKeyPair('Ed25519');
		const participantCoordBytes = peerIdToBytes(peerIdFromPrivateKey(participantKey));
		const body: Omit<RegisterV1, 'signature'> = {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 0,
			treeTier: 1, // a follow-on is a deeper-than-root growth point
			participantCoord: bytesToB64url(participantCoordBytes),
			ttl: 90_000,
			followOn: true,
			timestamp: 1_700_000_000_000,
			correlationId: cid16('cid-followon'),
		};
		const sig = await signPeer(participantKey, registerSigningPayload(body));
		const signed: RegisterV1 = { ...body, signature: bytesToB64url(sig) };

		const decoded = validateRegisterV1(decodeCohortMessage(encodeCohortMessage(signed), undefined));
		expect(decoded.followOn, 'followOn round-trips').to.equal(true);
		expect(
			await verifyPeerSigAsync(b64urlToBytes(decoded.participantCoord), registerSigningPayload(decoded), b64urlToBytes(decoded.signature)),
			'the follow-on signature verifies against the decoded frame',
		).to.equal(true);

		// Strip followOn (leaving the same signature): the recomputed image differs → verification fails.
		const { followOn: _dropped, ...withoutFollowOn } = decoded;
		expect(
			await verifyPeerSigAsync(b64urlToBytes(decoded.participantCoord), registerSigningPayload(withoutFollowOn as RegisterV1), b64urlToBytes(decoded.signature)),
			'a stripped followOn no longer verifies',
		).to.equal(false);
	});
});
