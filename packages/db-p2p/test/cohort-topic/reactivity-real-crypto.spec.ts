import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import {
	buildNotificationV1,
	createNotificationVerifier,
	createMembershipVerifier,
	createMembershipSourceRouter,
	createCohortSigner,
	createTierAddressing,
	createRingHash,
	reactivityTopicId,
	bytesToB64url,
	b64urlToBytes,
	Tier,
	type NotificationV1,
	type MembershipCertV1,
	type ICohortThresholdCrypto,
	type IMembershipSource,
	type ClusterRecord,
	type ClusterPeers,
	type Signature,
	type CollectionChangeEvent,
} from '@optimystic/db-core';
import { buildCommitCert } from '../../src/cluster/commit-cert.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { verifyCollectedMultisig, ED25519_SIG_BYTES } from '../../src/cohort-topic/threshold-crypto.js';

/**
 * Integration: a subscriber's **real** Ed25519 threshold-verify over `NotificationV1.digest` succeeds —
 * no pass-crypto stub. This is the seam `12.1-reactivity-digest-commit-hash-alignment` closes: origination
 * sets `digest = base64url(commitCert.signedPayload)` where `signedPayload = utf8(commitHash + ":approve")`
 * is the exact byte image each cohort member signed to produce its chunk of `thresholdSig`. Verify
 * recomputes the cohort threshold check over `b64urlToBytes(digest)`, so it reproduces the signed image
 * and passes against real keys.
 */

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const makeClusterPeers = (keyPairs: KeyPair[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const { peerId } of keyPairs) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url'),
		};
	}
	return peers;
};

/**
 * Build a real {@link CommitCert} over `signedPayload = utf8(commitHash + ":approve")`: each of `signers`
 * produces its real Ed25519 commit signature over that exact preimage; `buildCommitCert` concatenates them
 * in signer order. Mirrors what the cluster captures at consensus.
 */
const buildRealCert = async (signers: KeyPair[], commitHash: string) => {
	const signedPayload = new TextEncoder().encode(commitHash + ':approve');
	const commits: Record<string, Signature> = {};
	for (const kp of signers) {
		const sig = await kp.privateKey.sign(signedPayload);
		commits[kp.peerId.toString()] = { type: 'approve', signature: uint8ArrayToString(sig, 'base64url') };
	}
	const record: ClusterRecord = {
		messageHash: 'mh-' + commitHash,
		message: { operations: [{ get: { blockIds: [] } }], expiration: Date.now() + 30_000 },
		peers: makeClusterPeers(signers),
		promises: {},
		commits,
	};
	return { cert: buildCommitCert(record, signers.length, signedPayload), signedPayload };
};

const TAIL = bytesToB64url(new Uint8Array([2, 2, 2, 2]));
const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));

const event: CollectionChangeEvent = {
	collectionId: COLLECTION,
	blockIds: [bytesToB64url(new Uint8Array([5, 6]))],
	actionId: 'action-abc-123',
	rev: 5,
};

const encodeSigner = (s: string): string => bytesToB64url(peerIdToBytes(s));

const originate = (cert: { signers: readonly string[]; thresholdSig: Uint8Array; signedPayload: Uint8Array }): NotificationV1 =>
	buildNotificationV1(event, { ...cert, minSigs: cert.signers.length }, {
		tailId: TAIL,
		timestamp: 1_700_000_000_000,
		deltaMaxBytes: 0,
		encodeSigner,
	});

/** A FRET membership source that holds no cert — forces the verifier onto its cached cert / single refetch. */
const emptySource = (): IMembershipSource => ({
	current: () => Promise.resolve(undefined),
	fetch: () => Promise.resolve(undefined),
});

/**
 * A verifier wired to the **real** collected-multisig crypto, with a hand-built membership cert cached for
 * the reactivity coord. The cached path trusts the cert's `members` without re-validating its own
 * thresholdSig (production fetch still self-validates), so the membership cert's own sig can be a dummy —
 * what is exercised is the real Ed25519 check over the notification's `digest`.
 */
const makeVerifier = (members: string[], minSigs: number) => {
	const crypto: ICohortThresholdCrypto = {
		assemble: () => Promise.reject(new Error('verify-only')),
		verify: verifyCollectedMultisig, // REAL Ed25519 collected-multisig — no () => true stub
	};
	const expectedCoord = createTierAddressing(createRingHash()).coord0(reactivityTopicId(b64urlToBytes(TAIL)));
	const membershipCert: MembershipCertV1 = {
		v: 1,
		cohortCoord: bytesToB64url(expectedCoord),
		cohortEpoch: bytesToB64url(new Uint8Array([7])),
		members,
		stabilizedAt: 1_700_000_000_000,
		thresholdSig: bytesToB64url(new Uint8Array([0])),
		signers: members,
	};
	const membershipVerifier = createMembershipVerifier({
		signer: createCohortSigner(crypto, minSigs),
		router: createMembershipSourceRouter({ committed: emptySource(), fret: emptySource() }),
		minSigs,
	});
	membershipVerifier.cache(membershipCert);
	return createNotificationVerifier({ verifier: membershipVerifier, tier: Tier.T3 });
};

describe('reactivity: real Ed25519 threshold-verify over digest (seam closed, no pass-crypto stub)', () => {
	let keys: KeyPair[];

	beforeEach(async () => {
		keys = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair()]);
	});

	it('verifies a notification whose digest is the real commit-vote signed payload', async () => {
		const { cert } = await buildRealCert(keys, 'commitHash-1');
		const notification = originate(cert);

		// digest carries exactly the bytes thresholdSig was computed over.
		expect([...b64urlToBytes(notification.digest)]).to.deep.equal([...new TextEncoder().encode('commitHash-1:approve')]);

		const verifier = makeVerifier([...notification.signers], keys.length);
		expect(await verifier.verify(notification)).to.equal('verified');
	});

	it('rejects (untrusted) when a single byte of digest is flipped — the signed image no longer matches', async () => {
		const { cert } = await buildRealCert(keys, 'commitHash-1');
		const notification = originate(cert);
		const verifier = makeVerifier([...notification.signers], keys.length);

		const tamperedBytes = b64urlToBytes(notification.digest);
		tamperedBytes[0] = tamperedBytes[0]! ^ 0xff;
		const tampered: NotificationV1 = { ...notification, digest: bytesToB64url(tamperedBytes) };
		expect(await verifier.verify(tampered)).to.equal('untrusted');
	});

	it('rejects (untrusted) the OLD encoding digest = b64url(utf8(actionId)) — proves real crypto needs the preimage', async () => {
		const { cert } = await buildRealCert(keys, 'commitHash-1');
		const notification = originate(cert);
		const verifier = makeVerifier([...notification.signers], keys.length);

		// Reconstruct exactly what pre-12.1 origination produced: digest from the transaction id, not the
		// signed preimage. The threshold signature is unchanged, but it was never computed over utf8(actionId).
		const oldStyle: NotificationV1 = { ...notification, digest: bytesToB64url(new TextEncoder().encode(event.actionId)) };
		expect(await verifier.verify(oldStyle)).to.equal('untrusted');
	});

	it('rejects (untrusted) when the signer count drops below minSigs', async () => {
		// A real 2-signer cert, but the verifier requires 3 — below threshold even though both sigs are valid.
		const { cert } = await buildRealCert(keys.slice(0, 2), 'commitHash-1');
		const notification = originate(cert);
		const allMembers = keys.map((k) => encodeSigner(k.peerId.toString()));
		const verifier = makeVerifier(allMembers, 3);
		expect(notification.signers.length).to.equal(2);
		expect(await verifier.verify(notification)).to.equal('untrusted');
	});

	it('rejects (untrusted) when one chunk of thresholdSig is truncated (stride desync)', async () => {
		const { cert } = await buildRealCert(keys, 'commitHash-1');
		const notification = originate(cert);
		const verifier = makeVerifier([...notification.signers], keys.length);

		// Drop the last 64-byte chunk: now 2 chunks for 3 signers → length !== signers.length × 64.
		const truncated = cert.thresholdSig.subarray(0, cert.thresholdSig.length - ED25519_SIG_BYTES);
		const desynced: NotificationV1 = { ...notification, sig: bytesToB64url(truncated) };
		expect(await verifier.verify(desynced)).to.equal('untrusted');
	});
});
