import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { peerIdToBytes, bytesToPeerIdString, bytesToPeerId } from '../../src/cohort-topic/peer-codec.js';

/**
 * The cohort-member ids the substrate carries on the wire are the UTF-8 of the canonical peer-id
 * string (see peer-codec.ts). They MUST round-trip back to a dialable peer or renewal/gossip break,
 * so this pins both directions for real Ed25519 peer ids.
 */
describe('cohort-topic: peer-id ↔ bytes codec', () => {
	it('round-trips a real peer id through bytes and back to a dialable PeerId', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		const bytes = peerIdToBytes(peerId);

		expect(bytesToPeerIdString(bytes)).to.equal(peerId.toString());
		expect(bytesToPeerId(bytes).toString()).to.equal(peerId.toString());
	});

	it('encodes a string and a PeerId to identical bytes', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		expect(Array.from(peerIdToBytes(peerId.toString()))).to.deep.equal(Array.from(peerIdToBytes(peerId)));
	});

	it('rejects non-UTF-8 garbage rather than silently producing a bogus id', () => {
		// 0xff is not valid UTF-8 — the fatal decoder must throw, not yield a replacement-char "peer".
		expect(() => bytesToPeerIdString(new Uint8Array([0xff, 0xfe]))).to.throw();
	});
});
