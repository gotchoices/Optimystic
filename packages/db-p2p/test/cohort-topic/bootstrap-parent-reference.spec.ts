import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import {
	RingHash,
	createTierAddressing,
	bytesToB64url,
	serializeBootstrapEvidenceEnvelope,
	parentRefSigningImage,
	bootstrapBoundImage,
	type RegisterV1,
	type RingCoord,
} from '@optimystic/db-core';
import {
	createParentReferenceVerifier,
	createDefaultParentTopicView,
	type BootstrapParentTopicView,
} from '../../src/cohort-topic/bootstrap-parent-reference.js';
import { FretMembershipSource } from '../../src/cohort-topic/membership-source.js';
import { signPeerSig } from '../../src/cohort-topic/peer-sig.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';

const hash = new RingHash();
const addressing = createTierAddressing(hash);

const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 3) & 0xff);
const PARENT = Uint8Array.from({ length: 32 }, (_v, i) => (i + 40) & 0xff);
const PARENT2 = Uint8Array.from({ length: 32 }, (_v, i) => (i + 99) & 0xff);

/** A real keypair → dialable peer-id bytes (a valid `participantCoord`). */
async function makeKey(): Promise<{ key: PrivateKey; bytes: Uint8Array }> {
	const key = await generateKeyPair('Ed25519');
	return { key, bytes: peerIdToBytes(peerIdFromPrivateKey(key)) };
}

/** A bootstrap tier-`tier` `RegisterV1` (optionally carrying `bootstrapEvidence`). */
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

/** A signed parent-reference field: `participantKey` signs the parentRef image binding `reg` + `parentTopicId`. */
function parentRefField(reg: RegisterV1, parentTopicId: Uint8Array, participantKey: PrivateKey): string {
	const sig = signPeerSig(participantKey, parentRefSigningImage(reg, bytesToB64url(parentTopicId)));
	return serializeBootstrapEvidenceEnvelope({ v: 1, parentRef: { parentTopicId: bytesToB64url(parentTopicId), sig: bytesToB64url(sig) } });
}

/** A view stub with a fixed `exists` answer. */
const view = (exists: BootstrapParentTopicView['exists']): BootstrapParentTopicView => ({ exists });
/** A view stub that always answers `value`. */
const fixedView = (value: boolean): BootstrapParentTopicView => view(() => value);

describe('cohort-topic / parent-reference bootstrap-evidence verifier (db-p2p)', () => {
	describe('createParentReferenceVerifier', () => {
		it('admits a valid signed parent-ref to an existing parent', async () => {
			const { key, bytes: participant } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			reg.bootstrapEvidence = parentRefField(reg, PARENT, key);
			expect(createParentReferenceVerifier({ parentTopicView: fixedView(true) })(reg)).to.equal(true);
		});

		it('rejects an existing parent with a bad signature (wrong signer key)', async () => {
			const { bytes: participant } = await makeKey();
			const { key: otherKey } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			// Signed by a key that is not the participant's → does not bind to participantCoord.
			reg.bootstrapEvidence = parentRefField(reg, PARENT, otherKey);
			expect(createParentReferenceVerifier({ parentTopicView: fixedView(true) })(reg)).to.equal(false);
		});

		it('rejects a signature over the wrong image (the plain bound image, not the parent-ref image)', async () => {
			const { key, bytes: participant } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			// A reputation-style signature over bootstrapBoundImage must NOT satisfy the parent-ref verifier
			// (the parentRef image is domain-separated by tag + appended parentTopicId).
			const sig = signPeerSig(key, bootstrapBoundImage(reg));
			reg.bootstrapEvidence = serializeBootstrapEvidenceEnvelope({ v: 1, parentRef: { parentTopicId: bytesToB64url(PARENT), sig: bytesToB64url(sig) } });
			expect(createParentReferenceVerifier({ parentTopicView: fixedView(true) })(reg)).to.equal(false);
		});

		it('rejects a valid signature to an unknown parent (exists → false)', async () => {
			const { key, bytes: participant } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			reg.bootstrapEvidence = parentRefField(reg, PARENT, key);
			expect(createParentReferenceVerifier({ parentTopicView: fixedView(false) })(reg)).to.equal(false);
		});

		it('rejects an absent / non-parent-ref envelope (never throws)', async () => {
			const { bytes: participant } = await makeKey();
			const verify = createParentReferenceVerifier({ parentTopicView: fixedView(true) });
			// No bootstrapEvidence at all → not offered.
			expect(verify(makeReg(participant, TOPIC)), 'absent envelope').to.equal(false);
			// A PoW-only envelope carries no parentRef.
			const powOnly = makeReg(participant, TOPIC);
			powOnly.bootstrapEvidence = serializeBootstrapEvidenceEnvelope({ v: 1, pow: { nonce: bytesToB64url(Uint8Array.from([0, 0, 0, 0])) } });
			expect(verify(powOnly), 'a pow-only envelope offers no parentRef').to.equal(false);
			// A structurally-broken field → fails closed (no throw).
			const broken = makeReg(participant, TOPIC);
			broken.bootstrapEvidence = bytesToB64url(new TextEncoder().encode('not an envelope'));
			expect(verify(broken), 'malformed envelope').to.equal(false);
		});

		it('rejects a parent-ref minted for a different register (topic / participant / timestamp / parentTopicId)', async () => {
			const { key, bytes: participant } = await makeKey();
			const { bytes: participant2 } = await makeKey();
			const verify = createParentReferenceVerifier({ parentTopicView: fixedView(true) });

			const regA = makeReg(participant, TOPIC);
			const field = parentRefField(regA, PARENT, key);

			// Different topic → the parentRef image differs → signature misses.
			const regDiffTopic = makeReg(participant, PARENT2, { bootstrapEvidence: field });
			expect(verify(regDiffTopic), 'replayed onto a different topic').to.equal(false);
			// Different participant coord (and the sig was over participant's image with regA's coord).
			const regDiffPeer = makeReg(participant2, TOPIC, { bootstrapEvidence: field });
			expect(verify(regDiffPeer), 'replayed onto a different participant').to.equal(false);
			// Different timestamp.
			const regDiffTime = makeReg(participant, TOPIC, { timestamp: 1_700_000_000_001, bootstrapEvidence: field });
			expect(verify(regDiffTime), 'replayed at a different timestamp').to.equal(false);

			// Different parentTopicId: sign for PARENT but claim PARENT2 in the envelope → image mismatch.
			const sigForParent = signPeerSig(key, parentRefSigningImage(regA, bytesToB64url(PARENT)));
			const mismatchedField = serializeBootstrapEvidenceEnvelope({ v: 1, parentRef: { parentTopicId: bytesToB64url(PARENT2), sig: bytesToB64url(sigForParent) } });
			const regSwapParent = makeReg(participant, TOPIC, { bootstrapEvidence: mismatchedField });
			expect(verify(regSwapParent), 'a sig minted for a different parentTopicId').to.equal(false);
		});

		it('rejects a self-referential parent-ref (parentTopicId == topicId), even with a valid sig + existing parent', async () => {
			const { key, bytes: participant } = await makeKey();
			const reg = makeReg(participant, TOPIC);
			// parentTopicId = the register's own topicId; the participant validly signs it.
			reg.bootstrapEvidence = parentRefField(reg, TOPIC, key);
			expect(createParentReferenceVerifier({ parentTopicView: fixedView(true) })(reg)).to.equal(false);
		});

		it('passes the registering child tier through to the existence view', async () => {
			const { key, bytes: participant } = await makeKey();
			const reg = makeReg(participant, TOPIC, { tier: 3 });
			reg.bootstrapEvidence = parentRefField(reg, PARENT, key);
			let seenTier = -1;
			const v = view((_parent, tier) => {
				seenTier = tier;
				return true;
			});
			expect(createParentReferenceVerifier({ parentTopicView: v })(reg)).to.equal(true);
			expect(seenTier, 'the verifier routes the existence check by the register tier').to.equal(3);
		});
	});

	describe('createDefaultParentTopicView', () => {
		it('T2/T3: a cert cached in the FRET membership source means the parent exists; absent means it does not', () => {
			const source = new FretMembershipSource({} as never, {} as never);
			const v = createDefaultParentTopicView({ membershipSource: source, addressing });

			expect(v.exists(PARENT, 2), 'unseeded parent → not exists').to.equal(false);
			source.cache(addressing.coord0(PARENT), new TextEncoder().encode('encoded-cert'));
			expect(v.exists(PARENT, 2), 'a cached cert for coord_0(parent) → exists').to.equal(true);
			expect(v.exists(PARENT2, 3), 'a different uncached parent → not exists').to.equal(false);
		});

		it('committed-tier integrity: a FRET-only cached cert does NOT satisfy a T0/T1 existence check', () => {
			const source = new FretMembershipSource({} as never, {} as never);
			source.cache(addressing.coord0(PARENT), new TextEncoder().encode('encoded-cert'));
			// No committedReader → committed tiers fail closed even though the FRET cache holds the cert.
			const v = createDefaultParentTopicView({ membershipSource: source, addressing });
			expect(v.exists(PARENT, 0), 'T0 must not be satisfied by a FRET-only cert').to.equal(false);
			expect(v.exists(PARENT, 1), 'T1 must not be satisfied by a FRET-only cert').to.equal(false);
			expect(v.exists(PARENT, 2), 'T2 IS satisfied by the FRET cert (same cache)').to.equal(true);
		});

		it('tier routing: T0/T1 consults the committed reader, T2/T3 the FRET membership source (distinct backends)', () => {
			const committedCoords: string[] = [];
			const fretCoords: string[] = [];
			const committedReader = (coord: RingCoord): boolean => {
				committedCoords.push(bytesToB64url(coord));
				return true;
			};
			const membershipSource = {
				has: (coord: RingCoord): boolean => {
					fretCoords.push(bytesToB64url(coord));
					return true;
				},
			};
			const v = createDefaultParentTopicView({ membershipSource, addressing, committedReader });

			expect(v.exists(PARENT, 0), 'T0 routed to committed').to.equal(true);
			expect(v.exists(PARENT, 1), 'T1 routed to committed').to.equal(true);
			expect(committedCoords, 'committed reader consulted for T0/T1, FRET untouched').to.deep.equal([
				bytesToB64url(addressing.coord0(PARENT)),
				bytesToB64url(addressing.coord0(PARENT)),
			]);
			expect(fretCoords, 'FRET source NOT consulted for the committed tiers').to.deep.equal([]);

			expect(v.exists(PARENT, 2), 'T2 routed to FRET').to.equal(true);
			expect(v.exists(PARENT, 3), 'T3 routed to FRET').to.equal(true);
			expect(fretCoords, 'FRET source consulted for T2/T3').to.deep.equal([
				bytesToB64url(addressing.coord0(PARENT)),
				bytesToB64url(addressing.coord0(PARENT)),
			]);
			expect(committedCoords.length, 'committed reader not consulted again for T2/T3').to.equal(2);
		});

		it('honours a supplied committedReader for the committed tiers', () => {
			const source = new FretMembershipSource({} as never, {} as never);
			const known = new Set([bytesToB64url(addressing.coord0(PARENT))]);
			const v = createDefaultParentTopicView({
				membershipSource: source,
				addressing,
				committedReader: (coord) => known.has(bytesToB64url(coord)),
			});
			expect(v.exists(PARENT, 0), 'a committed reader that knows the parent → exists').to.equal(true);
			expect(v.exists(PARENT2, 1), 'a committed reader that does not → not exists').to.equal(false);
		});
	});
});
