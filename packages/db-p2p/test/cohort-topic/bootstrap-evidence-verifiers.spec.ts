import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import {
	RingHash,
	bytesToB64url,
	powPreimage,
	meetsDifficulty,
	bootstrapBoundImage,
	serializeBootstrapEvidenceEnvelope,
	type RegisterV1,
	type BootstrapBoundFields,
} from '@optimystic/db-core';
import {
	createPoWVerifier,
	createReputationVerifier,
	DEFAULT_DEPRIORITIZE_THRESHOLD,
	type BootstrapReputationView,
} from '../../src/cohort-topic/bootstrap-evidence-verifiers.js';
import { createBootstrapEvidenceBuilder } from '../../src/cohort-topic/bootstrap-evidence-builder.js';
import { signPeerSig } from '../../src/cohort-topic/peer-sig.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';

const hash = new RingHash();

const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 3) & 0xff);
const TOPIC2 = Uint8Array.from({ length: 32 }, (_v, i) => (i + 71) & 0xff);

/** A real keypair → dialable peer-id bytes (a valid `participantCoord` / `referee`). */
async function makeKey(): Promise<{ key: PrivateKey; bytes: Uint8Array }> {
	const key = await generateKeyPair('Ed25519');
	return { key, bytes: peerIdToBytes(peerIdFromPrivateKey(key)) };
}

/** A bootstrap tier-`tier` `RegisterV1` carrying `bootstrapEvidence` (the b64url envelope string). */
function makeReg(participantCoord: Uint8Array, topicId: Uint8Array, opts: { tier?: number; timestamp?: number; bootstrapEvidence?: string } = {}): RegisterV1 {
	return {
		v: 1,
		topicId: bytesToB64url(topicId),
		tier: opts.tier ?? 0,
		treeTier: 0,
		participantCoord: bytesToB64url(participantCoord),
		ttl: 90_000,
		bootstrap: true,
		timestamp: opts.timestamp ?? 1_700_000_000_000,
		correlationId: bytesToB64url(new TextEncoder().encode('cid')),
		signature: '',
		...(opts.bootstrapEvidence === undefined ? {} : { bootstrapEvidence: opts.bootstrapEvidence }),
	};
}

const boundOf = (reg: RegisterV1): BootstrapBoundFields => ({
	topicId: reg.topicId,
	tier: reg.tier,
	participantCoord: reg.participantCoord,
	timestamp: reg.timestamp,
});

/** Deterministic counter-nonce miner: the first nonce whose preimage digest meets `bits`. */
function mintNonce(bound: BootstrapBoundFields, bits: number): Uint8Array {
	for (let i = 0; i < 5_000_000; i++) {
		const nonce = Uint8Array.from([i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, (i >> 24) & 0xff]);
		if (meetsDifficulty(hash.H(powPreimage(bound, nonce)), bits)) {
			return nonce;
		}
	}
	throw new Error(`mintNonce: no solution within the cap at bits=${bits}`);
}

const powField = (nonce: Uint8Array): string => serializeBootstrapEvidenceEnvelope({ v: 1, pow: { nonce: bytesToB64url(nonce) } });
const repField = (referee: Uint8Array, sig: Uint8Array): string =>
	serializeBootstrapEvidenceEnvelope({ v: 1, reputation: { referee: bytesToB64url(referee), sig: bytesToB64url(sig) } });

/** A reputation view from a banned set + an explicit score map (unseen peers score 0). */
function repView(opts: { banned?: Set<string>; scores?: Map<string, number> } = {}): BootstrapReputationView {
	return {
		isBanned: (id): boolean => opts.banned?.has(id) ?? false,
		getScore: (id): number => opts.scores?.get(id) ?? 0,
	};
}

describe('cohort-topic / bootstrap-evidence verifiers (db-p2p)', () => {
	describe('createPoWVerifier', () => {
		it('admits a correctly-minted nonce at the configured difficulty', async () => {
			const { bytes: participant } = await makeKey();
			const bits = 12;
			const reg = makeReg(participant, TOPIC);
			const nonce = mintNonce(boundOf(reg), bits);
			reg.bootstrapEvidence = powField(nonce);
			expect(createPoWVerifier({ hash, bits })(reg)).to.equal(true);
		});

		it('admits any well-formed PoW envelope at bits = 0 (the test-disable difficulty)', async () => {
			const { bytes: participant } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			reg.bootstrapEvidence = powField(Uint8Array.from([0, 0, 0, 0]));
			expect(createPoWVerifier({ hash, bits: 0 })(reg)).to.equal(true);
		});

		it('rejects an absent pow, a malformed envelope, and a wrong/short nonce', async () => {
			const { bytes: participant } = await makeKey();
			const verify = createPoWVerifier({ hash, bits: 12 });

			// No bootstrapEvidence at all → not offered.
			expect(verify(makeReg(participant, TOPIC)), 'absent envelope').to.equal(false);
			// A reputation-only envelope carries no pow.
			const { bytes: ref, key } = await makeKey();
			const repReg = makeReg(participant, TOPIC);
			repReg.bootstrapEvidence = repField(ref, signPeerSig(key, bootstrapBoundImage(repReg)));
			expect(verify(repReg), 'no pow kind offered').to.equal(false);
			// A structurally-broken bootstrapEvidence field → fails closed.
			const broken = makeReg(participant, TOPIC);
			broken.bootstrapEvidence = bytesToB64url(new TextEncoder().encode('not an envelope'));
			expect(verify(broken), 'malformed envelope').to.equal(false);
			// A wrong nonce that does not meet the difficulty.
			const wrong = makeReg(participant, TOPIC);
			wrong.bootstrapEvidence = powField(Uint8Array.from([1, 2, 3, 4]));
			expect(verify(wrong), 'a nonce that does not meet difficulty').to.equal(false);
		});

		it('rejects a PoW minted for a different bound tuple (no cross-topic/peer/time replay)', async () => {
			const { bytes: participant } = await makeKey();
			const { bytes: participant2 } = await makeKey();
			const bits = 12;
			const verify = createPoWVerifier({ hash, bits });

			const regA = makeReg(participant, TOPIC);
			const nonce = mintNonce(boundOf(regA), bits);
			const field = powField(nonce);

			// Same nonce, different topic → the preimage differs → digest almost certainly misses difficulty.
			const regDiffTopic = makeReg(participant, TOPIC2, { bootstrapEvidence: field });
			expect(verify(regDiffTopic), 'replayed onto a different topic').to.equal(false);
			// Different participant coord.
			const regDiffPeer = makeReg(participant2, TOPIC, { bootstrapEvidence: field });
			expect(verify(regDiffPeer), 'replayed onto a different participant').to.equal(false);
			// Different timestamp.
			const regDiffTime = makeReg(participant, TOPIC, { timestamp: 1_700_000_000_001, bootstrapEvidence: field });
			expect(verify(regDiffTime), 'replayed at a different timestamp').to.equal(false);
		});
	});

	describe('createReputationVerifier', () => {
		it('admits a valid referee signature over the bound image from a reputable referee', async () => {
			const { bytes: participant } = await makeKey();
			const { bytes: referee, key } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			reg.bootstrapEvidence = repField(referee, signPeerSig(key, bootstrapBoundImage(reg)));
			expect(createReputationVerifier({ reputation: repView() })(reg)).to.equal(true);
		});

		it('rejects a bad signature', async () => {
			const { bytes: participant } = await makeKey();
			const { bytes: referee, key } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			// Sign the wrong bytes — the signature does not bind this register's tuple.
			reg.bootstrapEvidence = repField(referee, signPeerSig(key, new TextEncoder().encode('some other image')));
			expect(createReputationVerifier({ reputation: repView() })(reg)).to.equal(false);
		});

		it('rejects a banned referee even with a valid signature', async () => {
			const { bytes: participant } = await makeKey();
			const { bytes: referee, key } = await makeKey();
			const refereeId = new TextDecoder().decode(referee);
			const reg = makeReg(participant, TOPIC);
			reg.bootstrapEvidence = repField(referee, signPeerSig(key, bootstrapBoundImage(reg)));
			const reputation = repView({ banned: new Set([refereeId]) });
			expect(createReputationVerifier({ reputation })(reg)).to.equal(false);
		});

		it('treats the deprioritize threshold strictly: score at the cutoff fails, just below passes', async () => {
			const { bytes: participant } = await makeKey();
			const { bytes: referee, key } = await makeKey();
			const refereeId = new TextDecoder().decode(referee);
			const reg = makeReg(participant, TOPIC);
			reg.bootstrapEvidence = repField(referee, signPeerSig(key, bootstrapBoundImage(reg)));

			const atThreshold = repView({ scores: new Map([[refereeId, DEFAULT_DEPRIORITIZE_THRESHOLD]]) });
			expect(createReputationVerifier({ reputation: atThreshold })(reg), 'exactly at the threshold is not sufficient').to.equal(false);
			const belowThreshold = repView({ scores: new Map([[refereeId, DEFAULT_DEPRIORITIZE_THRESHOLD - 1]]) });
			expect(createReputationVerifier({ reputation: belowThreshold })(reg), 'just below is sufficient').to.equal(true);
		});

		it('admits a self-vouch (referee == participant) from a reputable participant', async () => {
			const { bytes: participant, key } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			// referee = the participant's own peer-id bytes; the participant signs the bound image.
			reg.bootstrapEvidence = repField(participant, signPeerSig(key, bootstrapBoundImage(reg)));
			expect(createReputationVerifier({ reputation: repView() })(reg)).to.equal(true);
		});

		it('rejects an endorsement bound to a different register', async () => {
			const { bytes: participant } = await makeKey();
			const { bytes: referee, key } = await makeKey();
			const regA = makeReg(participant, TOPIC);
			// Endorse reg A, then attach it to reg B (a different topic).
			const field = repField(referee, signPeerSig(key, bootstrapBoundImage(regA)));
			const regB = makeReg(participant, TOPIC2, { bootstrapEvidence: field });
			expect(createReputationVerifier({ reputation: repView() })(regB)).to.equal(false);
		});

		it('rejects an absent reputation envelope (e.g. a PoW-only envelope)', async () => {
			const { bytes: participant } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			reg.bootstrapEvidence = powField(Uint8Array.from([0, 0, 0, 0]));
			expect(createReputationVerifier({ reputation: repView() })(reg)).to.equal(false);
		});
	});

	describe('createBootstrapEvidenceBuilder', () => {
		it('mints a PoW (low bits) that the matching verifier accepts for the same register', async () => {
			const { bytes: participant } = await makeKey();
			const bits = 0; // every nonce solves → deterministic, fast
			const build = createBootstrapEvidenceBuilder({ hash, bits });
			const reg = makeReg(participant, TOPIC, { tier: 2 });
			const raw = await build(boundOf(reg));
			expect(raw, 'a T2 bootstrap mints PoW evidence').to.not.equal(undefined);
			reg.bootstrapEvidence = bytesToB64url(raw!);
			expect(createPoWVerifier({ hash, bits })(reg), 'the verifier accepts the minted PoW').to.equal(true);
		});

		it('returns undefined for T0/T1 with no endorse capability (parent-reference origination is the follow-on)', async () => {
			const { bytes: participant } = await makeKey();
			const build = createBootstrapEvidenceBuilder({ hash, bits: 0 });
			expect(await build(boundOf(makeReg(participant, TOPIC, { tier: 0 }))), 'T0 carries no evidence').to.equal(undefined);
			expect(await build(boundOf(makeReg(participant, TOPIC, { tier: 1 }))), 'T1 carries no evidence').to.equal(undefined);
		});

		it('mints a self-vouch reputation endorsement for T0/T1 when an endorse capability is supplied', async () => {
			const { bytes: self, key } = await makeKey();
			const build = createBootstrapEvidenceBuilder({
				hash,
				bits: 0,
				endorse: async (image) => ({ referee: bytesToB64url(self), sig: bytesToB64url(signPeerSig(key, image)) }),
			});
			const reg = makeReg(self, TOPIC, { tier: 0 });
			const raw = await build(boundOf(reg));
			expect(raw, 'a key-ful node self-vouches at T0').to.not.equal(undefined);
			reg.bootstrapEvidence = bytesToB64url(raw!);
			expect(createReputationVerifier({ reputation: repView() })(reg), 'the referee verifier accepts the self-vouch').to.equal(true);
		});

		it('returns undefined when the difficulty cannot be solved within the iteration cap', async () => {
			const { bytes: participant } = await makeKey();
			// 256-bit difficulty over a 32-byte digest is effectively unsatisfiable; a tiny cap returns undefined fast.
			const build = createBootstrapEvidenceBuilder({ hash, bits: 256, maxIterations: 64 });
			expect(await build(boundOf(makeReg(participant, TOPIC, { tier: 2 })))).to.equal(undefined);
		});
	});
});
