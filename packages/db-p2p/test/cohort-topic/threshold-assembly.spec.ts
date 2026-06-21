import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import {
	createCohortSigner,
	createMembershipCertPublisher,
	createMembershipVerifier,
	createTierAddressing,
	RingHash,
	bytesToB64url,
	b64urlToBytes,
	membershipCertSigningPayload,
	type IMembershipSource,
	type IMembershipSourceRouter,
	type MembershipCertV1,
	type RingCoord,
	type SignReplyV1,
	type SignRequestV1,
} from '@optimystic/db-core';
import {
	FretCohortThresholdCrypto,
	createVerifyOnlyThresholdCrypto,
	verifyCollectedMultisig,
	ED25519_SIG_BYTES,
} from '../../src/cohort-topic/threshold-crypto.js';
import { FretMembershipPublishSink } from '../../src/cohort-topic/membership-publish-sink.js';
import { createCohortTopicHost, handleSignRequest } from '../../src/cohort-topic/host.js';
import { peerIdToBytes, bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import { signPeer, verifyPeerSig } from '../../src/cohort-topic/peer-sig.js';

/** A real cohort member: its libp2p key, peer-id string, and dialable member-id bytes. */
interface Member {
	key: PrivateKey;
	idStr: string;
	bytes: Uint8Array;
}

async function makeMember(): Promise<Member> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key);
	return { key, idStr: peerId.toString(), bytes: peerIdToBytes(peerId) };
}

async function makeMembers(n: number): Promise<Member[]> {
	const out: Member[] = [];
	for (let i = 0; i < n; i++) {
		out.push(await makeMember());
	}
	return out;
}

const COORD: RingCoord = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 1) & 0xff);
const EPOCH = Uint8Array.from({ length: 32 }, (_v, i) => (i * 3 + 9) & 0xff);
const PAYLOAD = new TextEncoder().encode('cohort-threshold-signable-bytes');

/** A `dialSign` that endorses honestly for every member in `byId` (signs the request payload with its key). */
function honestDialSign(byId: Map<string, Member>): (peerStr: string, req: SignRequestV1) => Promise<SignReplyV1> {
	return async (peerStr: string, req: SignRequestV1): Promise<SignReplyV1> => {
		const m = byId.get(peerStr);
		if (m === undefined) {
			return { v: 1, refused: true, reason: 'not a known member' };
		}
		const sig = await signPeer(m.key, b64urlToBytes(req.payload));
		return { v: 1, signer: bytesToB64url(m.bytes), signature: bytesToB64url(sig) };
	};
}

/** Build a coord-scoped assembler bound to `self` over the cohort `members`, dialing via `dial`. */
function assemblerFor(self: Member, members: Member[], dial: (peerStr: string, req: SignRequestV1) => Promise<SignReplyV1>): FretCohortThresholdCrypto {
	return new FretCohortThresholdCrypto({
		kind: 'membership',
		privateKey: self.key,
		selfMember: self.bytes,
		coord: (): RingCoord => COORD,
		cohortEpoch: (): Uint8Array => EPOCH,
		cohortMembers: (): string[] => members.map((m) => m.idStr),
		dialSign: dial,
	});
}

function certOver(members: Member[], thresholdSig: Uint8Array, signers: Uint8Array[]): MembershipCertV1 {
	return {
		v: 1,
		cohortCoord: bytesToB64url(COORD),
		cohortEpoch: bytesToB64url(EPOCH),
		members: members.map((m) => bytesToB64url(m.bytes)),
		stabilizedAt: 1_000,
		thresholdSig: bytesToB64url(thresholdSig),
		signers: signers.map(bytesToB64url),
	};
}

describe('cohort-topic: real k − x threshold-signature assembly', () => {
	it('assembles a ≥ minSigs collected multisig across the cohort and verifies it', async () => {
		const members = await makeMembers(5);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const minSigs = 4;
		const crypto = assemblerFor(members[0]!, members, honestDialSign(byId));

		const { thresholdSig, signers } = await crypto.assemble(PAYLOAD, minSigs);

		expect(signers.length, 'gathered at least minSigs distinct signers').to.be.at.least(minSigs);
		expect(thresholdSig.length, 'blob is signers.length × 64 bytes').to.equal(signers.length * ED25519_SIG_BYTES);
		// Self is always one of the signers (the acting member).
		expect(signers.some((s) => bytesToB64url(s) === bytesToB64url(members[0]!.bytes)), 'self is included').to.equal(true);
		// Signers are deterministically ordered (ascending) so the blob is reproducible.
		const ordered = [...signers].map(bytesToB64url);
		expect(ordered, 'signers are ascending').to.deep.equal([...ordered].sort());

		expect(crypto.verify(PAYLOAD, thresholdSig, signers), 'crypto.verify accepts the real multisig').to.equal(true);
		expect(verifyCollectedMultisig(PAYLOAD, thresholdSig, signers), 'pure verify accepts it').to.equal(true);
	});

	it('CohortSigner.verifyThreshold accepts a real assembled sig and rejects a tampered chunk', async () => {
		const members = await makeMembers(5);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const minSigs = 4;
		const crypto = assemblerFor(members[0]!, members, honestDialSign(byId));
		const { thresholdSig, signers } = await crypto.assemble(PAYLOAD, minSigs);
		const cert = certOver(members, thresholdSig, signers);

		const verifier = createCohortSigner(createVerifyOnlyThresholdCrypto(), minSigs);
		expect(verifier.verifyThreshold(PAYLOAD, thresholdSig, signers, cert, minSigs), 'real sig verifies').to.equal(true);

		// Flip one byte inside the first chunk → that signer's Ed25519 check fails.
		const tampered = thresholdSig.slice();
		tampered[0] = tampered[0]! ^ 0xff;
		expect(verifier.verifyThreshold(PAYLOAD, tampered, signers, cert, minSigs), 'tampered chunk rejected').to.equal(false);
		expect(crypto.verify(PAYLOAD, tampered, signers), 'crypto.verify rejects the tamper too').to.equal(false);

		// A different payload than the one signed must not verify against the same blob.
		expect(verifier.verifyThreshold(new TextEncoder().encode('other'), thresholdSig, signers, cert, minSigs), 'wrong payload rejected').to.equal(false);
	});

	it('throws (never fabricates a single-signer sig) when the quorum is unreachable', async () => {
		const members = await makeMembers(3);
		const refusingDial = (): Promise<SignReplyV1> => Promise.resolve({ v: 1, refused: true, reason: 'unwilling' });
		const crypto = assemblerFor(members[0]!, members, refusingDial);

		let error: unknown;
		try {
			await crypto.assemble(PAYLOAD, 3); // only self will sign → 1 < 3
		} catch (err) {
			error = err;
		}
		expect(error, 'short quorum throws rather than returning a single-signer sig').to.be.instanceOf(Error);
		expect((error as Error).message, 'message names the shortfall').to.match(/1 of 3/);
	});

	it('minSigs greater than the cohort size cannot succeed (tiny-network guard)', async () => {
		const members = await makeMembers(2);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const crypto = assemblerFor(members[0]!, members, honestDialSign(byId));
		// Cohort has 2 members; minSigs 5 is unreachable even with everyone willing.
		let threw = false;
		try {
			await crypto.assemble(PAYLOAD, 5);
		} catch {
			threw = true;
		}
		expect(threw, 'cannot assemble more signatures than the cohort has members').to.equal(true);
	});

	it('drops poisoned / forged / duplicate SignReplies before counting, then still reaches the quorum', async () => {
		const members = await makeMembers(6);
		const [self, honestA, honestB, badSig, forgedId, dup] = members as [Member, Member, Member, Member, Member, Member];
		const byId = new Map(members.map((m) => [m.idStr, m]));

		const dial = async (peerStr: string, req: SignRequestV1): Promise<SignReplyV1> => {
			const payload = b64urlToBytes(req.payload);
			if (peerStr === badSig.idStr) {
				// Garbage signature bytes (right length, wrong content) → verifyPeerSig fails → dropped.
				return { v: 1, signer: bytesToB64url(badSig.bytes), signature: bytesToB64url(new Uint8Array(ED25519_SIG_BYTES)) };
			}
			if (peerStr === forgedId.idStr) {
				// Signs with a DIFFERENT key while claiming forgedId's identity → verify against forgedId's key fails.
				const wrongKey = await generateKeyPair('Ed25519');
				const sig = await signPeer(wrongKey, payload);
				return { v: 1, signer: bytesToB64url(forgedId.bytes), signature: bytesToB64url(sig) };
			}
			if (peerStr === dup.idStr) {
				// Returns SELF's identity (a duplicate of an already-collected signer) → deduped away.
				const sig = await signPeer(self.key, payload);
				return { v: 1, signer: bytesToB64url(self.bytes), signature: bytesToB64url(sig) };
			}
			// honestA / honestB endorse correctly.
			const m = byId.get(peerStr)!;
			const sig = await signPeer(m.key, payload);
			return { v: 1, signer: bytesToB64url(m.bytes), signature: bytesToB64url(sig) };
		};

		const crypto = assemblerFor(self, members, dial);
		const { thresholdSig, signers } = await crypto.assemble(PAYLOAD, 3); // self + honestA + honestB = 3

		const signerKeys = signers.map(bytesToB64url);
		expect(signerKeys, 'self counted once').to.include(bytesToB64url(self.bytes));
		expect(signerKeys, 'honest A counted').to.include(bytesToB64url(honestA.bytes));
		expect(signerKeys, 'honest B counted').to.include(bytesToB64url(honestB.bytes));
		expect(signerKeys, 'poisoned (bad sig) excluded').to.not.include(bytesToB64url(badSig.bytes));
		expect(signerKeys, 'forged-identity excluded').to.not.include(bytesToB64url(forgedId.bytes));
		expect(new Set(signerKeys).size, 'no duplicate padding the count').to.equal(signerKeys.length);
		expect(crypto.verify(PAYLOAD, thresholdSig, signers), 'the de-poisoned blob still verifies').to.equal(true);
	});
});

describe('cohort-topic: published MembershipCertV1 verifies via MembershipVerifier', () => {
	it('a real threshold-signed cert from the publisher is accepted; a tampered one is untrusted', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const minSigs = 3;
		const sink = new FretMembershipPublishSink();
		const signer = createCohortSigner(assemblerFor(members[0]!, members, honestDialSign(byId)), minSigs);
		const publisher = createMembershipCertPublisher({ signer, sink, minSigs });

		const snapshot = { coord: COORD, cohortEpoch: EPOCH, members: members.map((m) => m.bytes), stabilizedAt: 2_000 };
		const cert = await publisher.onStabilized(snapshot, 2_000);
		expect(cert, 'publisher produced a cert').to.not.equal(undefined);
		const encoded = sink.latest();
		expect(encoded, 'cert was served through the sink').to.not.equal(undefined);

		// A participant-side verifier pulling the cert from a (mock) source must accept it for real.
		const source: IMembershipSource = { current: () => Promise.resolve(encoded), fetch: () => Promise.resolve(encoded) };
		const router: IMembershipSourceRouter = { for: (): IMembershipSource => source };
		const verifier = createMembershipVerifier({ signer: createCohortSigner(createVerifyOnlyThresholdCrypto(), minSigs), router, minSigs });

		const certPayload = membershipCertSigningPayload(cert!);
		const certSig = b64urlToBytes(cert!.thresholdSig);
		const certSigners = cert!.signers.map(b64urlToBytes);
		expect(await verifier.verifyMessage(certSigners, COORD, 0, certPayload, certSig), 'real cert verifies via MembershipVerifier').to.equal('verified');

		const tamperedSig = certSig.slice();
		tamperedSig[0] = tamperedSig[0]! ^ 0xff;
		expect(await verifier.verifyMessage(certSigners, COORD, 0, certPayload, tamperedSig), 'tampered cert is untrusted').to.equal('untrusted');
	});
});

describe('cohort-topic: /sign endorsement policy', () => {
	const baseReq: SignRequestV1 = {
		v: 1,
		kind: 'membership',
		coord: bytesToB64url(COORD),
		cohortEpoch: bytesToB64url(EPOCH),
		payload: bytesToB64url(PAYLOAD),
	};

	it('endorses with a verifiable peer-key signature when self + requester share the cohort + epoch', async () => {
		const [self, requester] = await makeMembers(2);
		const reply = await handleSignRequest(baseReq, requester!.idStr, {
			privateKey: self!.key,
			selfMember: self!.bytes,
			cohortMembersAround: (): string[] => [self!.idStr, requester!.idStr],
			currentEpoch: (): Uint8Array => EPOCH,
		});
		expect('signer' in reply, 'an endorsement, not a refusal').to.equal(true);
		if ('signer' in reply) {
			expect(verifyPeerSig(b64urlToBytes(reply.signer), PAYLOAD, b64urlToBytes(reply.signature)), 'signature verifies against the endorser key').to.equal(true);
			expect(bytesToPeerIdString(b64urlToBytes(reply.signer)), 'signer id is self').to.equal(self!.idStr);
		}
	});

	it('refuses a requester outside the cohort, an epoch mismatch, and a key-less node', async () => {
		const [self, requester, outsider] = await makeMembers(3);
		const deps = {
			privateKey: self!.key,
			selfMember: self!.bytes,
			cohortMembersAround: (): string[] => [self!.idStr, requester!.idStr],
			currentEpoch: (): Uint8Array => EPOCH,
		};

		const outOfCohort = await handleSignRequest(baseReq, outsider!.idStr, deps);
		expect('refused' in outOfCohort && outOfCohort.refused, 'outsider requester refused').to.equal(true);

		const wrongEpoch: SignRequestV1 = { ...baseReq, cohortEpoch: bytesToB64url(Uint8Array.from({ length: 32 }, () => 0xaa)) };
		const epochMismatch = await handleSignRequest(wrongEpoch, requester!.idStr, deps);
		expect('refused' in epochMismatch && epochMismatch.refused, 'epoch mismatch refused').to.equal(true);

		const keyless = await handleSignRequest(baseReq, requester!.idStr, { ...deps, privateKey: undefined });
		expect('refused' in keyless && keyless.refused, 'key-less node refuses').to.equal(true);
	});
});

describe('cohort-topic: /sign rotation endorsement gate (prior-epoch membership)', () => {
	// A rotation request carries the PRIOR epoch as `cohortEpoch`; the gate checks prior-epoch membership
	// (via `priorCohortMembersAt`) rather than the CURRENT cohort, so the genuinely outgoing cohort co-signs
	// the hand-off. These cover the four branches of the rotation gate the live-tier mesh tests do not isolate.
	const rotReq: SignRequestV1 = {
		v: 1,
		kind: 'rotation',
		coord: bytesToB64url(COORD),
		cohortEpoch: bytesToB64url(EPOCH), // EPOCH is the prevEpoch the endorser must have been a member at
		payload: bytesToB64url(PAYLOAD),
	};

	it('endorses a hand-off when self + requester were both members of the prior cohort — even when neither is in the CURRENT cohort', async () => {
		const [self, requester] = await makeMembers(2);
		const reply = await handleSignRequest(rotReq, requester!.idStr, {
			privateKey: self!.key,
			selfMember: self!.bytes,
			// The current cohort is deliberately EMPTY: a rotation endorsement must consult prior, not current,
			// membership — so this stub must never be the basis of the decision.
			cohortMembersAround: (): string[] => [],
			currentEpoch: (): Uint8Array => Uint8Array.from({ length: 32 }, () => 0xff),
			priorCohortMembersAt: (): readonly string[] => [self!.idStr, requester!.idStr],
		});
		expect('signer' in reply, 'an endorsement, not a refusal').to.equal(true);
		if ('signer' in reply) {
			expect(verifyPeerSig(b64urlToBytes(reply.signer), PAYLOAD, b64urlToBytes(reply.signature)), 'signature verifies against the endorser key').to.equal(true);
			expect(bytesToPeerIdString(b64urlToBytes(reply.signer)), 'signer id is self').to.equal(self!.idStr);
		}
	});

	it('refuses when this node has no prior-epoch history for the coord (cold restart / never assembled at prevEpoch)', async () => {
		const [self, requester] = await makeMembers(2);
		const reply = await handleSignRequest(rotReq, requester!.idStr, {
			privateKey: self!.key,
			selfMember: self!.bytes,
			cohortMembersAround: (): string[] => [self!.idStr, requester!.idStr],
			currentEpoch: (): Uint8Array => EPOCH,
			priorCohortMembersAt: (): undefined => undefined, // no tracked identity at prevEpoch
		});
		expect('refused' in reply && reply.refused, 'no prior history → refused').to.equal(true);
	});

	it('refuses when self was not a member of the prior cohort', async () => {
		const [self, requester] = await makeMembers(2);
		const reply = await handleSignRequest(rotReq, requester!.idStr, {
			privateKey: self!.key,
			selfMember: self!.bytes,
			cohortMembersAround: (): string[] => [self!.idStr, requester!.idStr],
			currentEpoch: (): Uint8Array => EPOCH,
			priorCohortMembersAt: (): readonly string[] => [requester!.idStr], // prior cohort excludes self
		});
		expect('refused' in reply && reply.refused, 'self ∉ prior cohort → refused').to.equal(true);
	});

	it('refuses when the requester was not a member of the prior cohort', async () => {
		const [self, requester] = await makeMembers(2);
		const reply = await handleSignRequest(rotReq, requester!.idStr, {
			privateKey: self!.key,
			selfMember: self!.bytes,
			cohortMembersAround: (): string[] => [self!.idStr, requester!.idStr],
			currentEpoch: (): Uint8Array => EPOCH,
			priorCohortMembersAt: (): readonly string[] => [self!.idStr], // prior cohort excludes the requester
		});
		expect('refused' in reply && reply.refused, 'requester ∉ prior cohort → refused').to.equal(true);
	});

	it('refuses a key-less node before any prior-membership work', async () => {
		const [self, requester] = await makeMembers(2);
		const reply = await handleSignRequest(rotReq, requester!.idStr, {
			privateKey: undefined,
			selfMember: self!.bytes,
			cohortMembersAround: (): string[] => [self!.idStr, requester!.idStr],
			currentEpoch: (): Uint8Array => EPOCH,
			priorCohortMembersAt: (): readonly string[] => [self!.idStr, requester!.idStr],
		});
		expect('refused' in reply && reply.refused, 'key-less node refuses').to.equal(true);
	});
});

describe('cohort-topic: host drives a per-coord MembershipCertPublisher', () => {
	const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 11) & 0xff);

	/** A minimal libp2p stand-in: the host only handles/unhandles protocols and reads its own peer id. */
	function makeFakeNode(peerId: ReturnType<typeof peerIdFromPrivateKey>): unknown {
		return {
			peerId,
			handle: (): Promise<void> => Promise.resolve(),
			unhandle: (): Promise<void> => Promise.resolve(),
			getConnections: (): unknown[] => [],
			dialProtocol: (): Promise<never> => Promise.reject(new Error('no dial in single-member cohort test')),
		};
	}

	function makeFakeFret(): unknown {
		return {
			assembleCohort: (): string[] => [], // self-only cohort everywhere (host prepends self)
			setActivityHandler: (): void => {},
			getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: 50, confidence: 1, sources: 1 }),
			routeAct: (): Promise<{ commitCertificate: string }> => Promise.resolve({ commitCertificate: '' }),
		};
	}

	it('onStabilized publishes a real (self-signed, k=1) cert the verify-only signer accepts', async () => {
		// A wantK=1 / minSigs=1 cohort is just self: the engine assembles a legitimate single-signer
		// threshold sig (k = 1, not a fabrication) with no dialing, so the host wiring is exercised end-to-end.
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		const host = await createCohortTopicHost(makeFakeNode(peerId) as never, makeFakeFret() as never, { privateKey: key, wantK: 1, minSigs: 1 });

		const addressing = createTierAddressing(new RingHash());
		const coord0 = addressing.coord0(TOPIC);
		const ce = host.registry.forCoord(coord0, 0, new TextEncoder().encode('participant-M'));

		const cert = await ce.onStabilized(3_000);
		expect(cert, 'host engine published a membership cert').to.not.equal(undefined);
		expect(cert!.signers.length, 'one legitimate signer for a one-member cohort').to.equal(1);
		expect(bytesToPeerIdString(b64urlToBytes(cert!.signers[0]!)), 'the lone signer is self').to.equal(peerId.toString());

		const verifier = createCohortSigner(createVerifyOnlyThresholdCrypto(), 1);
		expect(
			verifier.verifyThreshold(
				membershipCertSigningPayload(cert!),
				b64urlToBytes(cert!.thresholdSig),
				cert!.signers.map(b64urlToBytes),
				cert!,
				1,
			),
			'the host-produced cert is a real, verifiable threshold signature',
		).to.equal(true);

		await host.stop();
	});

	it('a key-less host no-ops the publish hooks instead of rejecting (verify-only per-coord signer)', async () => {
		// Without a private key the per-coord signer is verify-only and cannot assemble. The publish hooks
		// must resolve `undefined` (not reject), so a future cadence driver iterating registry.all() is safe.
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		const host = await createCohortTopicHost(makeFakeNode(peerId) as never, makeFakeFret() as never, { wantK: 1, minSigs: 1 });

		const addressing = createTierAddressing(new RingHash());
		const coord0 = addressing.coord0(TOPIC);
		const ce = host.registry.forCoord(coord0, 0, new TextEncoder().encode('participant-K'));

		expect(await ce.onStabilized(4_000), 'key-less onStabilized resolves undefined').to.equal(undefined);
		expect(await ce.pumpMembership(4_000), 'key-less pumpMembership resolves undefined').to.equal(undefined);

		await host.stop();
	});
});
