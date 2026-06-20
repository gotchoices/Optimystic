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
	handleInboundNotice,
	createPromoteGate,
	type NoticeApplyTarget,
	type InboundNoticeResult,
	type CoordRegistry,
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

/** Build the cohort's real, threshold-signed encoded `MembershipCertV1` over `members`. */
async function encodedCertOver(members: Member[], byId: Map<string, Member>, minSigs: number): Promise<Uint8Array> {
	const sink = new FretMembershipPublishSink();
	const signer = createCohortSigner(assemblerFor(members[0]!, members, byId, 'membership'), minSigs);
	const publisher = createMembershipCertPublisher({ signer, sink, minSigs });
	await publisher.onStabilized({ coord: COORD, cohortEpoch: EPOCH, members: members.map((m) => m.bytes), stabilizedAt: 1_000 }, 1_000);
	return sink.latest()!;
}

/** A participant-side verify-only verifier reading cohort membership from `source`. */
function verifierFromSource(source: IMembershipSource, minSigs: number): MembershipVerifier {
	const router: IMembershipSourceRouter = { for: (): IMembershipSource => source };
	return createMembershipVerifier({ signer: createCohortSigner(createVerifyOnlyThresholdCrypto(), minSigs), router, minSigs });
}

/** A participant-side verifier seeded (via its source) with the cohort's real, threshold-signed cert. */
async function verifierOver(members: Member[], byId: Map<string, Member>, minSigs: number): Promise<MembershipVerifier> {
	const encoded = await encodedCertOver(members, byId, minSigs);
	const source: IMembershipSource = { current: () => Promise.resolve(encoded), fetch: () => Promise.resolve(encoded) };
	return verifierFromSource(source, minSigs);
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

// --- inbound promote-handler anti-abuse gate (cohort-topic-promote-handler-verify-amplification) ---

/** A counting membership source: `current()` is the cheap local seed, `fetch()` is the amplified dial. */
function countingSource(encoded: Uint8Array): { source: IMembershipSource; fetches: () => number } {
	let fetches = 0;
	const source: IMembershipSource = {
		current: () => Promise.resolve(encoded),
		fetch: () => { fetches++; return Promise.resolve(encoded); },
	};
	return { source, fetches: () => fetches };
}

/** Wrap a verifier so the test can count how many notices actually reached `verifyMessage`. */
function countingVerifier(inner: MembershipVerifier): { verifier: MembershipVerifier; calls: () => number } {
	let calls = 0;
	const verifier: MembershipVerifier = {
		cache: (cert) => inner.cache(cert),
		verifyMessage: (signers, coord, tier, payload, sig, opts) => {
			calls++;
			return inner.verifyMessage(signers, coord, tier, payload, sig, opts);
		},
	};
	return { verifier, calls: () => calls };
}

/** A minimal {@link CoordRegistry} whose `findServing` always resolves to `target` (or nothing). */
function servingRegistry(target: NoticeApplyTarget | undefined): CoordRegistry {
	return { findServing: (): NoticeApplyTarget | undefined => target } as unknown as CoordRegistry;
}

/** A forged single-signer promotion notice (signers ⊄ a `minSigs ≥ 2` quorum) — always "untrusted". */
async function forgedPromotionNotice(members: Member[], effectiveAt: number): Promise<PromotionNoticeV1> {
	const signable = { topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, effectiveAt, cohortEpoch: bytesToB64url(EPOCH) };
	const sig = await signPeer(members[0]!.key, promotionNoticeSigningPayload(signable));
	return { v: 1, ...signable, thresholdSig: bytesToB64url(sig), signers: [bytesToB64url(members[0]!.bytes)] };
}

describe('cohort-topic: inbound promote-handler anti-abuse gate', () => {
	const minSigs = 3;

	it('a flood of forged promote notices drives a bounded membership refetch (one per coord per interval, not N)', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const encoded = await encodedCertOver(members, byId, minSigs);
		const { source, fetches } = countingSource(encoded);
		const verifier = verifierFromSource(source, minSigs);
		const { target } = remoteTarget(minSigs);
		const registry = servingRegistry(target);
		// Generous ceiling so the rate limiter does not shadow the refetch-count assertion (distinct peers too).
		const gate = createPromoteGate({ ratePerWindow: 10_000 });

		const N = 50;
		for (let i = 0; i < N; i++) {
			const forged = await forgedPromotionNotice(members, 1_000 + i);
			const from = peerIdToBytes(`attacker-${i}`);
			// Same `now` for all N so they fall inside one refetch interval for the served coord.
			const result = await handleInboundNotice(encodeCohortMessage(forged), from, registry, verifier, gate, 2_000);
			expect(result, 'each forged notice is untrusted').to.equal('untrusted');
		}
		// The pre-fix amplification was one refetch per frame (N); the bound caps it at one per coord/interval.
		expect(fetches(), `${N} forged notices drive at most one membership refetch (not ${N})`).to.be.at.most(1);
	});

	it('a single peer over the rate ceiling is dropped before the verifier runs', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const encoded = await encodedCertOver(members, byId, minSigs);
		const { source } = countingSource(encoded);
		const { verifier, calls } = countingVerifier(verifierFromSource(source, minSigs));
		const { target } = remoteTarget(minSigs);
		const registry = servingRegistry(target);
		const ratePerWindow = 4;
		const gate = createPromoteGate({ ratePerWindow });
		const from = peerIdToBytes('flooder');

		const results: InboundNoticeResult[] = [];
		for (let i = 0; i < 10; i++) {
			const forged = await forgedPromotionNotice(members, 1_000 + i);
			// Same `now` for all 10 so the sliding window does not drain between calls.
			results.push(await handleInboundNotice(encodeCohortMessage(forged), from, registry, verifier, gate, 2_000));
		}

		const reached = results.filter((r) => r === 'untrusted').length;
		const limited = results.filter((r) => r === 'rate-limited').length;
		expect(reached, 'only the first `ratePerWindow` frames reach the verifier').to.equal(ratePerWindow);
		expect(limited, 'the remainder are rate-limited').to.equal(10 - ratePerWindow);
		expect(calls(), 'the verifier ran only for the admitted frames').to.equal(ratePerWindow);
	});

	it('a notice at or below the (topic, tier) high-water is dropped before the verifier (replay)', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const encoded = await encodedCertOver(members, byId, minSigs);
		const { source } = countingSource(encoded);
		const { verifier, calls } = countingVerifier(verifierFromSource(source, minSigs));
		const { life, target } = remoteTarget(minSigs);
		const registry = servingRegistry(target);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		const from = peerIdToBytes('honest');

		// A real promotion at effectiveAt = 5_000 verifies, applies, and sets the high-water.
		const promo = await realPromotionNotice(members, byId, minSigs, 5_000);
		expect(await handleInboundNotice(encodeCohortMessage(promo), from, registry, verifier, gate, 6_000)).to.equal('applied');
		expect(life.isPromoted(TOPIC), 'the fresh promotion applied').to.be.true;
		const afterApply = calls();

		// A replay at the same effectiveAt, and an older one, are both dropped before the verifier runs.
		const replay = await realPromotionNotice(members, byId, minSigs, 5_000);
		expect(await handleInboundNotice(encodeCohortMessage(replay), from, registry, verifier, gate, 7_000)).to.equal('stale');
		const older = await realPromotionNotice(members, byId, minSigs, 4_000);
		expect(await handleInboundNotice(encodeCohortMessage(older), from, registry, verifier, gate, 8_000)).to.equal('stale');
		expect(calls(), 'neither stale notice reached the verifier').to.equal(afterApply);
	});

	it('a fresh legit notice above the high-water still applies, and advances the water', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const encoded = await encodedCertOver(members, byId, minSigs);
		const { source } = countingSource(encoded);
		const verifier = verifierFromSource(source, minSigs);
		const { life, target } = remoteTarget(minSigs);
		const registry = servingRegistry(target);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		const from = peerIdToBytes('honest');

		const first = await realPromotionNotice(members, byId, minSigs, 5_000);
		expect(await handleInboundNotice(encodeCohortMessage(first), from, registry, verifier, gate, 6_000)).to.equal('applied');

		// A later, genuinely fresh notice (effectiveAt 9_000 > 5_000) still verifies and applies.
		const fresh = await realPromotionNotice(members, byId, minSigs, 9_000);
		expect(await handleInboundNotice(encodeCohortMessage(fresh), from, registry, verifier, gate, 10_000)).to.equal('applied');
		expect(life.isPromoted(TOPIC), 'the fresh promotion applied').to.be.true;

		// The water advanced to 9_000: a replay at 9_000 is now stale.
		const replay = await realPromotionNotice(members, byId, minSigs, 9_000);
		expect(await handleInboundNotice(encodeCohortMessage(replay), from, registry, verifier, gate, 11_000)).to.equal('stale');
	});

	it('an undecodable promote frame is reported as such (no throw, no verify)', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const encoded = await encodedCertOver(members, byId, minSigs);
		const { source } = countingSource(encoded);
		const { verifier, calls } = countingVerifier(verifierFromSource(source, minSigs));
		const { target } = remoteTarget(minSigs);
		const gate = createPromoteGate();
		const result = await handleInboundNotice(
			encodeCohortMessage({ v: 1 } as never), peerIdToBytes('x'), servingRegistry(target), verifier, gate, 1_000,
		);
		expect(result, 'neither a promotion nor a demotion').to.equal('undecodable');
		expect(calls(), 'an undecodable frame never reaches the verifier').to.equal(0);
	});

	it('a notice with no serving engine is dropped before the verifier', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const encoded = await encodedCertOver(members, byId, minSigs);
		const { source } = countingSource(encoded);
		const { verifier, calls } = countingVerifier(verifierFromSource(source, minSigs));
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		const notice = await realPromotionNotice(members, byId, minSigs, 1_000);
		const result = await handleInboundNotice(
			encodeCohortMessage(notice), peerIdToBytes('honest'), servingRegistry(undefined), verifier, gate, 2_000,
		);
		expect(result, 'no engine serves (topic, tier) → dropped').to.equal('dropped');
		expect(calls(), 'a dropped notice never reaches the verifier').to.equal(0);
	});
});
