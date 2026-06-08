import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCohortSigner, DEFAULT_MIN_SIGS } from '../../src/cohort-topic/sig/threshold.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import { bytesEqual } from '../../src/cohort-topic/registration/bytes.js';
import type { ICohortThresholdCrypto } from '../../src/cohort-topic/ports.js';
import type { MembershipCertV1 } from '../../src/cohort-topic/wire/types.js';

function member(i: number): Uint8Array {
	return sha256(new TextEncoder().encode(`member-${i}`)).slice(0, 16);
}

const MEMBERS = Array.from({ length: 16 }, (_, i) => member(i));

/** Deterministic stand-in for FRET's minSigs assembly: sig = sha256(payload); verify checks that + signer count. */
function mockCrypto(): ICohortThresholdCrypto {
	const sigFor = (payload: Uint8Array): Uint8Array => sha256(payload).slice(0, 16);
	return {
		assemble: async (payload, minSigs) => ({ thresholdSig: sigFor(payload), signers: MEMBERS.slice(0, minSigs) }),
		verify: (payload, sig, signers) => bytesEqual(sig, sigFor(payload)) && signers.length > 0,
	};
}

function certOf(members: Uint8Array[]): MembershipCertV1 {
	return {
		v: 1,
		cohortCoord: bytesToB64url(sha256(new TextEncoder().encode('coord')).slice(0, 32)),
		cohortEpoch: bytesToB64url(sha256(new TextEncoder().encode('epoch')).slice(0, 32)),
		members: members.map(bytesToB64url),
		stabilizedAt: 1_000,
		thresholdSig: bytesToB64url(new Uint8Array(16)),
		signers: [],
	};
}

const PAYLOAD = new TextEncoder().encode('promotion-notice-bytes');

describe('cohort-topic / threshold signatures', () => {
	const crypto = mockCrypto();
	const signer = createCohortSigner(crypto); // default minSigs = 14
	const cert = certOf(MEMBERS);
	const goodSig = sha256(PAYLOAD).slice(0, 16);

	it('thresholdSign assembles exactly minSigs signers', async () => {
		const { signers, thresholdSig } = await signer.thresholdSign(PAYLOAD);
		expect(signers).to.have.length(DEFAULT_MIN_SIGS);
		expect([...thresholdSig]).to.deep.equal([...goodSig]);
	});

	it('verifies with minSigs (= k − x) signers drawn from the cert', () => {
		const signers = MEMBERS.slice(0, DEFAULT_MIN_SIGS);
		expect(signer.verifyThreshold(PAYLOAD, goodSig, signers, cert, DEFAULT_MIN_SIGS)).to.be.true;
	});

	it('fails below the threshold (minSigs − 1 signers)', () => {
		const signers = MEMBERS.slice(0, DEFAULT_MIN_SIGS - 1);
		expect(signer.verifyThreshold(PAYLOAD, goodSig, signers, cert, DEFAULT_MIN_SIGS)).to.be.false;
	});

	it('fails when a signer is not a member of the cert', () => {
		const outsider = sha256(new TextEncoder().encode('outsider')).slice(0, 16);
		const signers = [...MEMBERS.slice(0, DEFAULT_MIN_SIGS - 1), outsider];
		expect(signers).to.have.length(DEFAULT_MIN_SIGS);
		expect(signer.verifyThreshold(PAYLOAD, goodSig, signers, cert, DEFAULT_MIN_SIGS)).to.be.false;
	});

	it('fails when a duplicated signer is used to pad the count', () => {
		const signers = [...MEMBERS.slice(0, DEFAULT_MIN_SIGS - 1), MEMBERS[0]!]; // 14 entries, one repeated
		expect(signer.verifyThreshold(PAYLOAD, goodSig, signers, cert, DEFAULT_MIN_SIGS)).to.be.false;
	});

	it('fails when the signature does not verify against the payload', () => {
		const wrongSig = sha256(new TextEncoder().encode('other')).slice(0, 16);
		const signers = MEMBERS.slice(0, DEFAULT_MIN_SIGS);
		expect(signer.verifyThreshold(PAYLOAD, wrongSig, signers, cert, DEFAULT_MIN_SIGS)).to.be.false;
	});

	it('honours a custom minSigs', () => {
		const smallSigner = createCohortSigner(crypto, 3);
		expect(smallSigner.verifyThreshold(PAYLOAD, goodSig, MEMBERS.slice(0, 3), cert, 3)).to.be.true;
		expect(smallSigner.verifyThreshold(PAYLOAD, goodSig, MEMBERS.slice(0, 2), cert, 3)).to.be.false;
	});
});
