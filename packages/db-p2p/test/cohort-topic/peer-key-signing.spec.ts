import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Connection, PeerId, Stream } from '@libp2p/interface';
import {
	RingHash,
	createRegistrationStore,
	createSlotAssigner,
	createRenewalCohortSide,
	createTierAddressing,
	bytesToB64url,
	b64urlToBytes,
	bytesEqual,
	encodeCohortMessage,
	decodeCohortMessage,
	validateRegisterV1,
	registerSigningPayload,
	renewSigningPayload,
	type RegisterV1,
	type RegistrationRecord,
	type RenewV1,
	type RingCoord,
	type Tier,
} from '@optimystic/db-core';
import { createCohortTopicHost } from '../../src/cohort-topic/host.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { signPeer, verifyPeerSig } from '../../src/cohort-topic/peer-sig.js';

const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 3) & 0xff);

/** A minimal libp2p stand-in: the host only handles/unhandles protocols and reads its own peer id. */
function makeFakeNode(peerId: PeerId): unknown {
	return {
		peerId,
		handle: (): Promise<void> => Promise.resolve(),
		unhandle: (): Promise<void> => Promise.resolve(),
		getConnections: (): Connection[] => [],
		dialProtocol: (): Promise<Stream> => Promise.reject(new Error('no dial in signing test')),
	};
}

/** A fake FRET returning the given cohort for every coord. */
function makeFakeFret(cohortFor: (coord: RingCoord) => string[]): unknown {
	return {
		assembleCohort: (coord: RingCoord): string[] => cohortFor(coord),
		setActivityHandler: (): void => {},
		getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: 50, confidence: 1, sources: 1 }),
		routeAct: (): Promise<{ commitCertificate: string }> => Promise.resolve({ commitCertificate: '' }),
	};
}

describe('cohort-topic: participant register signing (host-wired, live-key mode)', () => {
	it('admits a peer-key-signed register and answers no_state to an unsigned or forged one', async () => {
		// Cohort node (the verifier) holds a key → live-signer mode → inbound verification is enforced.
		const cohortKey = await generateKeyPair('Ed25519');
		const cohortPeerId = peerIdFromPrivateKey(cohortKey);
		const fret = makeFakeFret(() => []); // self-only cohort everywhere
		const host = await createCohortTopicHost(makeFakeNode(cohortPeerId) as never, fret as never, { privateKey: cohortKey, wantK: 1 });

		// A separate participant node signs its own register with its own key.
		const participantKey = await generateKeyPair('Ed25519');
		const participantCoordBytes = peerIdToBytes(peerIdFromPrivateKey(participantKey));
		const body: Omit<RegisterV1, 'signature'> = {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesToB64url(participantCoordBytes),
			ttl: 90_000,
			bootstrap: true,
			timestamp: Date.now(),
			correlationId: bytesToB64url(new TextEncoder().encode('cid-signed')),
		};
		const goodSig = await signPeer(participantKey, registerSigningPayload(body));

		const addressing = createTierAddressing(new RingHash());
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participantCoordBytes);

		// 1. Correctly signed → admitted.
		const signed: RegisterV1 = { ...body, signature: bytesToB64url(goodSig) };
		expect((await ce.engine.handleRegister(signed, { followOn: false, treeTier: 0 }, Date.now())).result, 'signed register admits').to.equal('accepted');

		// 2. Unsigned (empty signature) → no_state (serve nothing).
		const unsigned: RegisterV1 = { ...body, signature: '' };
		expect((await ce.engine.handleRegister(unsigned, { followOn: false, treeTier: 0 }, Date.now())).result, 'unsigned register serves no_state').to.equal('no_state');

		// 3. Forged: signed by a DIFFERENT key while claiming the participant's identity → no_state.
		const forgedSig = await signPeer(await generateKeyPair('Ed25519'), registerSigningPayload(body));
		const forged: RegisterV1 = { ...body, signature: bytesToB64url(forgedSig) };
		expect((await ce.engine.handleRegister(forged, { followOn: false, treeTier: 0 }, Date.now())).result, 'forged register serves no_state').to.equal('no_state');

		await host.stop();
	});

	it('without a node key (interim mode) does NOT enforce verification — an unsigned register still admits', async () => {
		const cohortPeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		const host = await createCohortTopicHost(makeFakeNode(cohortPeerId) as never, makeFakeFret(() => []) as never, { wantK: 1 });

		const participantCoordBytes = peerIdToBytes(peerIdFromPrivateKey(await generateKeyPair('Ed25519')));
		const reg: RegisterV1 = {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesToB64url(participantCoordBytes),
			ttl: 90_000,
			bootstrap: true,
			timestamp: Date.now(),
			correlationId: bytesToB64url(new TextEncoder().encode('cid-nokey')),
			signature: '',
		};
		const addressing = createTierAddressing(new RingHash());
		const ce = host.registry.forCoord(addressing.coord0(TOPIC), 0 as Tier, participantCoordBytes);
		expect((await ce.engine.handleRegister(reg, { followOn: false, treeTier: 0 }, Date.now())).result, 'key-less host admits unsigned').to.equal('accepted');

		await host.stop();
	});
});

describe('cohort-topic: reattach forgery rejection (renewal cohort side)', () => {
	it('promotes only a correctly-signed reattach; a forged or unsigned reattach is redirected, never promoted', async () => {
		const hash = new RingHash();
		const store = createRegistrationStore();
		const slots = createSlotAssigner(hash);

		// Cohort members are opaque bytes here — only the PARTICIPANT needs a real key (the verified signer).
		const selfBytes = new TextEncoder().encode('cohort-self');
		const otherBytes = new TextEncoder().encode('cohort-other');
		const members = [selfBytes, otherBytes];

		const participantKey = await generateKeyPair('Ed25519');
		const participantId = peerIdToBytes(peerIdFromPrivateKey(participantKey));

		// Pick an epoch under which the deterministic slots make `other` the primary and `self` a backup,
		// so a *valid* reattach would legitimately promote self.
		let cohortEpoch: Uint8Array | undefined;
		for (let i = 0; i < 256; i++) {
			const candidate = hash.H(new TextEncoder().encode('epoch-' + i));
			const { primary, backups } = slots.assignSlots(participantId, candidate, members);
			if (!bytesEqual(primary, selfBytes) && backups.some((b) => bytesEqual(b, selfBytes))) {
				cohortEpoch = candidate;
				break;
			}
		}
		expect(cohortEpoch, 'found an epoch where self is a backup (so a valid reattach can promote it)').to.not.equal(undefined);
		const epoch = cohortEpoch!;

		const verifyReattachSig = (renew: RenewV1): boolean =>
			renew.signature.length > 0 &&
			verifyPeerSig(b64urlToBytes(renew.participantId), renewSigningPayload(renew), b64urlToBytes(renew.signature));

		const renewal = createRenewalCohortSide({
			store,
			self: selfBytes,
			slots,
			cohort: () => ({ members, cohortEpoch: epoch }),
			gossip: { touch: (): void => {}, evicted: (): void => {} },
			verifyReattachSig,
		});

		const rec: RegistrationRecord = {
			topicId: TOPIC,
			participantId,
			tier: 0,
			primary: otherBytes,
			backups: [selfBytes],
			attachedAt: 0,
			lastPing: 0,
			ttl: 90_000,
		};
		store.put(rec);

		const renewBody: Omit<RenewV1, 'signature'> = {
			v: 1,
			topicId: bytesToB64url(TOPIC),
			participantId: bytesToB64url(participantId),
			correlationId: bytesToB64url(new TextEncoder().encode('cid-reattach')),
			timestamp: 1_000,
			reattach: true,
		};

		// Forged (signed by a different key) → redirected, NOT promoted; the stored primary is untouched.
		const forgedSig = await signPeer(await generateKeyPair('Ed25519'), renewSigningPayload(renewBody));
		const forged: RenewV1 = { ...renewBody, signature: bytesToB64url(forgedSig) };
		expect(renewal.onRenew(forged, 2_000).result, 'forged reattach is redirected').to.equal('primary_moved');
		expect(bytesEqual(store.getByParticipant(TOPIC, participantId)!.primary, otherBytes), 'forged reattach did not usurp primary').to.equal(true);

		// Unsigned → redirected.
		const unsigned: RenewV1 = { ...renewBody, signature: '' };
		expect(renewal.onRenew(unsigned, 2_000).result, 'unsigned reattach is redirected').to.equal('primary_moved');
		expect(bytesEqual(store.getByParticipant(TOPIC, participantId)!.primary, otherBytes), 'unsigned reattach did not usurp primary').to.equal(true);

		// Correctly signed by the participant → promotes self.
		const validSig = await signPeer(participantKey, renewSigningPayload(renewBody));
		const valid: RenewV1 = { ...renewBody, signature: bytesToB64url(validSig) };
		expect(renewal.onRenew(valid, 2_000).result, 'a correctly-signed reattach promotes the backup').to.equal('ok');
		expect(bytesEqual(store.getByParticipant(TOPIC, participantId)!.primary, selfBytes), 'valid reattach re-stamped self as primary').to.equal(true);
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
			correlationId: bytesToB64url(new TextEncoder().encode('cid-roundtrip')),
		};
		const sig = await signPeer(participantKey, registerSigningPayload(body));
		const signed: RegisterV1 = { ...body, signature: bytesToB64url(sig) };

		// Full wire round-trip the way an inbound frame is processed by the host.
		const decoded = validateRegisterV1(decodeCohortMessage(encodeCohortMessage(signed), undefined));
		expect(decoded.bootstrap, 'absent bootstrap stays absent across the wire').to.equal(undefined);
		expect(decoded.appPayload, 'appPayload round-trips').to.equal(body.appPayload);
		expect(
			verifyPeerSig(b64urlToBytes(decoded.participantCoord), registerSigningPayload(decoded), b64urlToBytes(decoded.signature)),
			'signature verifies against the decoded frame',
		).to.equal(true);

		// A post-signing tamper of any covered field (here appPayload) must break verification.
		const tampered = validateRegisterV1(decodeCohortMessage(encodeCohortMessage({ ...signed, appPayload: bytesToB64url(new TextEncoder().encode('other')) }), undefined));
		expect(
			verifyPeerSig(b64urlToBytes(tampered.participantCoord), registerSigningPayload(tampered), b64urlToBytes(tampered.signature)),
			'tampered appPayload fails verification',
		).to.equal(false);
	});
});
