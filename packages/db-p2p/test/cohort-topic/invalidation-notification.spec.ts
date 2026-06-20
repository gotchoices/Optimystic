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
import { verifyCollectedMultisig } from '../../src/cohort-topic/threshold-crypto.js';

/**
 * The reactivity **push** path for a durable invalidation (7.6-invalidation-client-notification): an
 * invalidation is a committed collection change like any other, so it rides the same notification path,
 * reusing the *invalidation's* commit cert as the notification signature (never re-signed). This proves
 * that:
 *  - the notification carries the typed invalidation marker (flag + `invalidatedActionId`) distinct from a
 *    plain commit;
 *  - its `sig` verifies against the tail cohort's `MembershipCertV1` with **real** Ed25519 — exactly the
 *    same verifier path a commit notification uses;
 *  - a forged threshold signature is rejected by the subscriber.
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
 * The invalidation's own commit cert: the tail cohort's real Ed25519 threshold signature over the
 * consensus-ordered `invalidate` op's commit-vote preimage `utf8(commitHash + ":approve")` — the same
 * shape a commit cert has (the cluster captures it identically; see cluster-repo `applyConsensusInvalidation`).
 */
const buildInvalidationCert = async (signers: KeyPair[], commitHash: string) => {
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
	return buildCommitCert(record, signers.length, signedPayload);
};

const TAIL = bytesToB64url(new Uint8Array([3, 3, 3, 3]));
const COLLECTION = bytesToB64url(new Uint8Array([9, 8, 7, 6]));
const INVALIDATED_ACTION = 'action-being-reversed-xyz';

/** A change event for a durable invalidation (the marker an invalidation-apply sink sets on its emit). */
const invalidationEvent: CollectionChangeEvent = {
	collectionId: COLLECTION,
	blockIds: [bytesToB64url(new Uint8Array([5, 6]))],
	actionId: `inv:${INVALIDATED_ACTION}:dispute-1`,
	rev: 9,
	invalidation: true,
	invalidatedActionId: INVALIDATED_ACTION,
};

const encodeSigner = (s: string): string => bytesToB64url(peerIdToBytes(s));

const originate = (cert: { signers: readonly string[]; thresholdSig: Uint8Array; signedPayload: Uint8Array }): NotificationV1 =>
	buildNotificationV1(invalidationEvent, { ...cert, minSigs: cert.signers.length }, {
		tailId: TAIL,
		timestamp: 1_700_000_000_000,
		deltaMaxBytes: 0,
		encodeSigner,
	});

const emptySource = (): IMembershipSource => ({
	current: () => Promise.resolve(undefined),
	fetch: () => Promise.resolve(undefined),
});

const makeVerifier = (members: string[], minSigs: number) => {
	const crypto: ICohortThresholdCrypto = {
		assemble: () => Promise.reject(new Error('verify-only')),
		verify: verifyCollectedMultisig,
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

describe('reactivity: invalidation notification (push) — reused cert, real verify, forge-resistant', () => {
	let keys: KeyPair[];

	beforeEach(async () => {
		keys = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair()]);
	});

	it('carries the typed invalidation marker (flag + invalidatedActionId), distinct from a commit', () => {
		const cert = { signers: ['a', 'b'], thresholdSig: new Uint8Array([1, 2]), signedPayload: new Uint8Array([3]) };
		const n = originate(cert);
		expect(n.invalidation).to.equal(true);
		expect(n.invalidatedActionId).to.equal(INVALIDATED_ACTION);

		// A commit notification (no marker) over the same machinery stays a plain refresh.
		const commit = buildNotificationV1(
			{ collectionId: COLLECTION, blockIds: invalidationEvent.blockIds, actionId: 'plain-commit', rev: 9 },
			{ ...cert, minSigs: 2 },
			{ tailId: TAIL, timestamp: 1, deltaMaxBytes: 0 },
		);
		expect(commit).to.not.have.property('invalidation');
		expect(commit).to.not.have.property('invalidatedActionId');
	});

	it('verifies the reused invalidation commit cert against the tail cohort membership (real Ed25519)', async () => {
		const cert = await buildInvalidationCert(keys, 'invHash-1');
		const notification = originate(cert);

		// sig is bit-for-bit the invalidation's threshold signature; digest is the exact signed preimage.
		expect([...b64urlToBytes(notification.sig)]).to.deep.equal([...cert.thresholdSig]);
		expect([...b64urlToBytes(notification.digest)]).to.deep.equal([...new TextEncoder().encode('invHash-1:approve')]);

		const verifier = makeVerifier([...notification.signers], keys.length);
		expect(await verifier.verify(notification)).to.equal('verified');
	});

	it('rejects (untrusted) a forged threshold signature — a forwarder cannot fake an invalidation', async () => {
		const cert = await buildInvalidationCert(keys, 'invHash-1');
		const notification = originate(cert);
		const verifier = makeVerifier([...notification.signers], keys.length);

		const forgedSig = b64urlToBytes(notification.sig);
		forgedSig[0] = forgedSig[0]! ^ 0xff;
		const forged: NotificationV1 = { ...notification, sig: bytesToB64url(forgedSig) };
		expect(await verifier.verify(forged)).to.equal('untrusted');
	});

	it('rejects (untrusted) when the invalidation cert is below the cohort threshold', async () => {
		const cert = await buildInvalidationCert(keys.slice(0, 2), 'invHash-1');
		const notification = originate(cert);
		const allMembers = keys.map((k) => encodeSigner(k.peerId.toString()));
		const verifier = makeVerifier(allMembers, 3);
		expect(await verifier.verify(notification)).to.equal('untrusted');
	});
});
