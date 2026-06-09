import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { signPeer, verifyPeerSig } from '../../src/cohort-topic/peer-sig.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';

/**
 * The shared Ed25519 sign/verify primitive: `signPeer` (async, libp2p key) and `verifyPeerSig`
 * (synchronous, noble — the db-core verify ports are sync). The cohort participant-signature seam and
 * the threshold-assembly ticket both build on these, so the cross-key round-trip and the total
 * (never-throw) verify contract are pinned here.
 */
describe('cohort-topic: peer-key sign/verify primitive', () => {
	const payload = (s: string): Uint8Array => new TextEncoder().encode(s);

	it('round-trips a signPeer signature, verifying against the signer peer id (string and bytes forms)', async () => {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		const msg = payload('hello cohort');
		const sig = await signPeer(key, msg);

		// The libp2p signer is RFC8032; noble (ZIP215) accepts it — this is the compatibility proof.
		expect(verifyPeerSig(peerId.toString(), msg, sig), 'string signer id').to.equal(true);
		expect(verifyPeerSig(peerIdToBytes(peerId), msg, sig), 'peer-codec bytes signer id').to.equal(true);
	});

	it('rejects a signature made by a different key claimed under another identity (forgery)', async () => {
		const keyA = await generateKeyPair('Ed25519');
		const keyB = await generateKeyPair('Ed25519');
		const peerIdA = peerIdFromPrivateKey(keyA);
		const msg = payload('payload');
		const sigB = await signPeer(keyB, msg);
		// B's signature, but claiming A's identity → must not verify.
		expect(verifyPeerSig(peerIdA.toString(), msg, sigB)).to.equal(false);
	});

	it('rejects a tampered payload', async () => {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		const sig = await signPeer(key, payload('original'));
		expect(verifyPeerSig(peerId.toString(), payload('tampered'), sig)).to.equal(false);
	});

	it('returns false (never throws) on garbage ids, non-Ed25519 ids, and malformed signatures', async () => {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		const msg = payload('x');
		const sig = await signPeer(key, msg);

		expect(verifyPeerSig('not-a-peer-id', msg, sig), 'garbage string id').to.equal(false);
		expect(verifyPeerSig(new Uint8Array([0xff, 0xfe]), msg, sig), 'non-utf8 bytes id').to.equal(false);
		expect(verifyPeerSig(peerId.toString(), msg, new Uint8Array(0)), 'empty signature').to.equal(false);
		expect(verifyPeerSig(peerId.toString(), msg, new Uint8Array(10)), 'short signature').to.equal(false);

		// A non-Ed25519 identity has no embedded Ed25519 key → the substrate treats it as unverifiable.
		const secpKey = await generateKeyPair('secp256k1');
		const secpPeerId = peerIdFromPrivateKey(secpKey);
		const secpSig = await signPeer(secpKey, msg);
		expect(verifyPeerSig(secpPeerId.toString(), msg, secpSig), 'secp256k1 id is rejected').to.equal(false);
	});
});
