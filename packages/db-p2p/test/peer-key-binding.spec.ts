/**
 * Unit tests for the key ↔ peer-id binding predicate that gates the cluster/dispute vote paths.
 * These pin the predicate directly (the cluster/dispute specs only exercise it transitively):
 * a matching Ed25519 key binds, a mismatched one does not, and every hostile/malformed input —
 * including a non-Ed25519 (secp256k1) id — returns `false` rather than throwing.
 */

import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { peerIdBindsPublicKey } from '../src/cluster/peer-key-binding.js';

describe('peerIdBindsPublicKey', () => {
	it('binds an Ed25519 peer id to its own raw public key', async () => {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		expect(peerIdBindsPublicKey(peerId.toString(), peerId.publicKey!.raw)).to.equal(true);
	});

	it('rejects an Ed25519 peer id paired with a different key', async () => {
		const a = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		const b = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		expect(peerIdBindsPublicKey(a.toString(), b.publicKey!.raw)).to.equal(false);
	});

	it('rejects a non-Ed25519 (secp256k1) peer id even against its own key', async () => {
		const key = await generateKeyPair('secp256k1');
		const peerId = peerIdFromPrivateKey(key);
		// The whole substrate assumes Ed25519; a secp256k1 id must not bind, so such votes are
		// rejected as unproven identities rather than silently accepted.
		expect(peerIdBindsPublicKey(peerId.toString(), peerId.publicKey!.raw)).to.equal(false);
	});

	it('returns false (never throws) on a malformed peer id string', async () => {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		expect(peerIdBindsPublicKey('not-a-peer-id', peerId.publicKey!.raw)).to.equal(false);
	});

	it('returns false on a wrong-length key without throwing', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		expect(peerIdBindsPublicKey(peerId.toString(), new Uint8Array(0))).to.equal(false);
		expect(peerIdBindsPublicKey(peerId.toString(), new Uint8Array(31))).to.equal(false);
	});
});
