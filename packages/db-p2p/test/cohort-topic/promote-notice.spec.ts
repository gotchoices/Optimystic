import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import {
	createCohortSigner,
	createMembershipCertPublisher,
	createMembershipVerifier,
	createPromotionLifecycle,
	bytesToB64url,
	b64urlToBytes,
	promotionNoticeSigningPayload,
	demotionNoticeSigningPayload,
	encodeCohortMessage,
	type DemotionNoticeV1,
	type IMembershipSource,
	type IMembershipSourceRouter,
	type MembershipVerifier,
	type PromotionLifecycle,
	type PromotionNoticeV1,
	type RingCoord,
	type SignKind,
	type SignReplyV1,
	type SignRequestV1,
} from '@optimystic/db-core';
import {
	FretCohortThresholdCrypto,
	createVerifyOnlyThresholdCrypto,
} from '../../src/cohort-topic/threshold-crypto.js';
import { FretMembershipPublishSink } from '../../src/cohort-topic/membership-publish-sink.js';
import {
	decodeInboundNotice,
	verifyAndApplyNotice,
	noticeBroadcastCoords,
	type NoticeApplyTarget,
} from '../../src/cohort-topic/host.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import { signPeer } from '../../src/cohort-topic/peer-sig.js';

/** A real cohort member: its libp2p key, peer-id string, and dialable member-id bytes. */
interface Member {
	key: PrivateKey;
	idStr: string;
	bytes: Uint8Array;
}

async function makeMembers(n: number): Promise<Member[]> {
	const out: Member[] = [];
	for (let i = 0; i < n; i++) {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		out.push({ key, idStr: peerId.toString(), bytes: peerIdToBytes(peerId) });
	}
	return out;
}

const COORD: RingCoord = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 1) & 0xff);
const EPOCH = Uint8Array.from({ length: 32 }, (_v, i) => (i * 3 + 9) & 0xff);
const PARENT: RingCoord = Uint8Array.from({ length: 32 }, (_v, i) => (i * 5 + 2) & 0xff);
const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i + 11) & 0xff);

/** `dialSign` that endorses honestly for every member in `byId`. */
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

/** A coord-scoped assembler bound to `self` over `members`, signing as `kind`. */
function assemblerFor(self: Member, members: Member[], byId: Map<string, Member>, kind: SignKind): FretCohortThresholdCrypto {
	return new FretCohortThresholdCrypto({
		kind,
		privateKey: self.key,
		selfMember: self.bytes,
		coord: (): RingCoord => COORD,
		cohortEpoch: (): Uint8Array => EPOCH,
		cohortMembers: (): string[] => members.map((m) => m.idStr),
		dialSign: honestDialSign(byId),
	});
}

/** A participant-side verifier seeded (via its source) with the cohort's real, threshold-signed cert. */
async function verifierOver(members: Member[], byId: Map<string, Member>, minSigs: number): Promise<MembershipVerifier> {
	const sink = new FretMembershipPublishSink();
	const signer = createCohortSigner(assemblerFor(members[0]!, members, byId, 'membership'), minSigs);
	const publisher = createMembershipCertPublisher({ signer, sink, minSigs });
	await publisher.onStabilized({ coord: COORD, cohortEpoch: EPOCH, members: members.map((m) => m.bytes), stabilizedAt: 1_000 }, 1_000);
	const encoded = sink.latest()!;
	const source: IMembershipSource = { current: () => Promise.resolve(encoded), fetch: () => Promise.resolve(encoded) };
	const router: IMembershipSourceRouter = { for: (): IMembershipSource => source };
	return createMembershipVerifier({ signer: createCohortSigner(createVerifyOnlyThresholdCrypto(), minSigs), router, minSigs });
}

/** A remote member's promotion lifecycle wrapped as the inbound-notice apply target around COORD. */
function remoteTarget(minSigs: number): { life: PromotionLifecycle; target: NoticeApplyTarget } {
	const life = createPromotionLifecycle({
		store: { directParticipants: (): number => 0 },
		loadBucket: (): number => 0,
		childCohortCount: (): number => 0,
		treeTier: (): number => 1,
		parentCoord: (): Uint8Array => PARENT,
		cohortEpoch: (): Uint8Array => EPOCH,
		// Apply never re-signs, so a verify-only signer is sufficient for the target.
		signer: createCohortSigner(createVerifyOnlyThresholdCrypto(), minSigs),
	});
	const target: NoticeApplyTarget = {
		servedCoord: COORD,
		applyPromotionNotice: (n, now): void => life.applyPromotionNotice(n, now),
		applyDemotionNotice: (n, now): void => life.applyDemotionNotice(n, now),
	};
	return { life, target };
}

/** Build a real, threshold-signed promotion notice over `members`. */
async function realPromotionNotice(members: Member[], byId: Map<string, Member>, minSigs: number, effectiveAt: number): Promise<PromotionNoticeV1> {
	const signable = { topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, effectiveAt, cohortEpoch: bytesToB64url(EPOCH) };
	const { thresholdSig, signers } = await assemblerFor(members[0]!, members, byId, 'promotion').assemble(promotionNoticeSigningPayload(signable), minSigs);
	return { v: 1, ...signable, thresholdSig: bytesToB64url(thresholdSig), signers: signers.map(bytesToB64url) };
}

/** Build a real, threshold-signed demotion notice over `members`. */
async function realDemotionNotice(members: Member[], byId: Map<string, Member>, minSigs: number, effectiveAt: number): Promise<DemotionNoticeV1> {
	const signable = { topicId: bytesToB64url(TOPIC), tier: 1, parentCohortCoord: bytesToB64url(PARENT), effectiveAt, cohortEpoch: bytesToB64url(EPOCH) };
	const { thresholdSig, signers } = await assemblerFor(members[0]!, members, byId, 'demotion').assemble(demotionNoticeSigningPayload(signable), minSigs);
	return { v: 1, ...signable, thresholdSig: bytesToB64url(thresholdSig), signers: signers.map(bytesToB64url) };
}

describe('cohort-topic: inbound promote-protocol notice verify + apply', () => {
	const minSigs = 3;

	it('a verified promotion notice flips a remote member isPromoted', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const notice = await realPromotionNotice(members, byId, minSigs, 1_000);
		const { life, target } = remoteTarget(minSigs);

		const inbound = decodeInboundNotice(encodeCohortMessage(notice));
		expect(inbound?.kind, 'decodes as a promotion notice').to.equal('promotion');

		expect(await verifyAndApplyNotice(inbound!, target, verifier, 2_000), 'verifies and applies').to.equal('applied');
		expect(life.isPromoted(TOPIC), 'the remote member now reports promoted').to.be.true;
	});

	it('a verified demotion notice clears a previously-promoted remote member', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const { life, target } = remoteTarget(minSigs);

		const promo = await realPromotionNotice(members, byId, minSigs, 1_000);
		expect(await verifyAndApplyNotice(decodeInboundNotice(encodeCohortMessage(promo))!, target, verifier, 2_000)).to.equal('applied');
		expect(life.isPromoted(TOPIC)).to.be.true;

		const demo = await realDemotionNotice(members, byId, minSigs, 3_000);
		const inbound = decodeInboundNotice(encodeCohortMessage(demo));
		expect(inbound?.kind, 'decodes as a demotion notice').to.equal('demotion');
		expect(await verifyAndApplyNotice(inbound!, target, verifier, 4_000), 'verifies and applies').to.equal('applied');
		expect(life.isPromoted(TOPIC), 'the remote member is no longer promoted').to.be.false;
	});

	it('a forged single-signer notice is rejected (untrusted), leaving state unchanged', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const { life, target } = remoteTarget(minSigs);

		// One member signs alone — the interim-style sig that minSigs = 3 must now reject.
		const signable = { topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, effectiveAt: 1_000, cohortEpoch: bytesToB64url(EPOCH) };
		const sig = await signPeer(members[0]!.key, promotionNoticeSigningPayload(signable));
		const forged: PromotionNoticeV1 = { v: 1, ...signable, thresholdSig: bytesToB64url(sig), signers: [bytesToB64url(members[0]!.bytes)] };

		const inbound = decodeInboundNotice(encodeCohortMessage(forged))!;
		expect(await verifyAndApplyNotice(inbound, target, verifier, 2_000), 'short-quorum notice rejected').to.equal('untrusted');
		expect(life.isPromoted(TOPIC), 'state untouched by an untrusted notice').to.be.false;
	});

	it('a notice whose signers are not in the cohort cert is rejected (untrusted)', async () => {
		const members = await makeMembers(4);
		const outsiders = await makeMembers(4); // a different cohort entirely
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const outsiderById = new Map(outsiders.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs); // cert lists `members`
		const { life, target } = remoteTarget(minSigs);

		// A perfectly-formed quorum signature — but by outsiders absent from the cohort cert.
		const notice = await realPromotionNotice(outsiders, outsiderById, minSigs, 1_000);
		const inbound = decodeInboundNotice(encodeCohortMessage(notice))!;
		expect(await verifyAndApplyNotice(inbound, target, verifier, 2_000), 'signers ⊄ cert.members → untrusted').to.equal('untrusted');
		expect(life.isPromoted(TOPIC)).to.be.false;
	});

	it('a notice with no local engine serving its (topic, tier) is dropped (a demotion at a parent with no child engine never throws)', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const demo = await realDemotionNotice(members, byId, minSigs, 1_000);
		const inbound = decodeInboundNotice(encodeCohortMessage(demo))!;
		// `undefined` target models registry.findServing returning nothing (no engine for this child cohort).
		expect(await verifyAndApplyNotice(inbound, undefined, verifier, 2_000), 'no target → dropped, no throw').to.equal('dropped');
	});

	it('decodeInboundNotice returns undefined for a frame that is neither notice', () => {
		expect(decodeInboundNotice(encodeCohortMessage({ v: 1 } as never)), 'a non-notice frame is undecodable').to.equal(undefined);
	});
});

describe('cohort-topic: notice broadcast fan-out targets', () => {
	it('a promotion broadcasts only to the served cohort; a demotion also targets the parent coord', () => {
		const promo: PromotionNoticeV1 = {
			v: 1, topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, effectiveAt: 1_000,
			thresholdSig: '', signers: [], cohortEpoch: bytesToB64url(EPOCH),
		};
		expect(noticeBroadcastCoords(promo, COORD).map(bytesToB64url), 'promotion → served cohort only')
			.to.deep.equal([bytesToB64url(COORD)]);

		const demo: DemotionNoticeV1 = {
			v: 1, topicId: bytesToB64url(TOPIC), tier: 1, parentCohortCoord: bytesToB64url(PARENT), effectiveAt: 1_000,
			thresholdSig: '', signers: [], cohortEpoch: bytesToB64url(EPOCH),
		};
		expect(noticeBroadcastCoords(demo, COORD).map(bytesToB64url), 'demotion → served cohort + parent coord')
			.to.deep.equal([bytesToB64url(COORD), bytesToB64url(PARENT)]);
	});
});
