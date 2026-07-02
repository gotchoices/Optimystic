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
	applyDemotionUnlinkAtParent,
	noticeBroadcastCoords,
	handleInboundNotice,
	createPromoteGate,
	PROMOTE_HIGHWATER_MAX_KEYS,
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
/** A second served coord for the same `(topic, tier)` — a sibling cohort a multi-cohort node also serves. */
const OTHER_COORD: RingCoord = Uint8Array.from({ length: 32 }, (_v, i) => (i * 11 + 3) & 0xff);
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

/** A remote member's promotion lifecycle wrapped as the inbound-notice apply target around `coord` (default COORD). */
function remoteTargetAt(coord: RingCoord, minSigs: number): { life: PromotionLifecycle; target: NoticeApplyTarget } {
	const life = createPromotionLifecycle({
		store: { directParticipants: (): number => 0 },
		loadBucket: (): number => 0,
		childCohortCount: (): number => 0,
		treeTier: (): number => 1,
		parentCoord: (): Uint8Array => PARENT,
		cohortCoord: (): Uint8Array => coord,
		cohortEpoch: (): Uint8Array => EPOCH,
		// Apply never re-signs, so a verify-only signer is sufficient for the target.
		signer: createCohortSigner(createVerifyOnlyThresholdCrypto(), minSigs),
	});
	const target: NoticeApplyTarget = {
		servedCoord: coord,
		applyPromotionNotice: (n, now): void => life.applyPromotionNotice(n, now),
		applyDemotionNotice: (n, now): void => life.applyDemotionNotice(n, now),
		// This lifecycle-only stand-in parents no children; the parent-unlink path (which resolves a target for
		// the notice's parentCohortCoord) is a no-op here. The child-tracking parent double covers the real unlink.
		unrecordChild: (): void => undefined,
	};
	return { life, target };
}

function remoteTarget(minSigs: number): { life: PromotionLifecycle; target: NoticeApplyTarget } {
	return remoteTargetAt(COORD, minSigs);
}

/** Build a real, threshold-signed promotion notice over `members`, decided at `coord` (default COORD). */
async function realPromotionNotice(members: Member[], byId: Map<string, Member>, minSigs: number, effectiveAt: number, coord: RingCoord = COORD): Promise<PromotionNoticeV1> {
	const signable = { topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, effectiveAt, cohortEpoch: bytesToB64url(EPOCH), cohortCoord: bytesToB64url(coord) };
	const { thresholdSig, signers } = await assemblerFor(members[0]!, members, byId, 'promotion').assemble(promotionNoticeSigningPayload(signable), minSigs);
	return { v: 1, ...signable, thresholdSig: bytesToB64url(thresholdSig), signers: signers.map(bytesToB64url) };
}

/** Build a real, threshold-signed demotion notice over `members`, decided at `coord` (default COORD). */
async function realDemotionNotice(members: Member[], byId: Map<string, Member>, minSigs: number, effectiveAt: number, coord: RingCoord = COORD): Promise<DemotionNoticeV1> {
	const signable = { topicId: bytesToB64url(TOPIC), tier: 1, parentCohortCoord: bytesToB64url(PARENT), effectiveAt, cohortEpoch: bytesToB64url(EPOCH), cohortCoord: bytesToB64url(coord) };
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
		const signable = { topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, effectiveAt: 1_000, cohortEpoch: bytesToB64url(EPOCH), cohortCoord: bytesToB64url(COORD) };
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

	it('a notice with no local engine serving its coord is dropped (a demotion at a parent with no child engine never throws)', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const demo = await realDemotionNotice(members, byId, minSigs, 1_000);
		const inbound = decodeInboundNotice(encodeCohortMessage(demo))!;
		// `undefined` target models registry.findByCoord returning nothing (no engine at the notice's coord).
		expect(await verifyAndApplyNotice(inbound, undefined, verifier, 2_000), 'no target → dropped, no throw').to.equal('dropped');
	});

	it('rewriting cohortCoord on a validly-signed notice makes it fail verification (the coord is covered by the signature)', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const { life, target } = remoteTarget(minSigs); // servedCoord = COORD, cert over COORD

		const notice = await realPromotionNotice(members, byId, minSigs, 1_000); // threshold-signed at COORD
		expect(notice.cohortCoord, 'signed at COORD').to.equal(bytesToB64url(COORD));

		// Rewrite the carried coord to a sibling's: the signed image covers `cohortCoord`, so the receiver's
		// recomputed image no longer matches what the cohort signed → the multisig fails to verify.
		const tampered: PromotionNoticeV1 = { ...notice, cohortCoord: bytesToB64url(OTHER_COORD) };
		const inbound = decodeInboundNotice(encodeCohortMessage(tampered))!;
		expect(await verifyAndApplyNotice(inbound, target, verifier, 2_000), 'tampered coord → untrusted').to.equal('untrusted');
		expect(life.isPromoted(TOPIC), 'the tampered notice never applied').to.be.false;
	});

	it('decodeInboundNotice returns undefined for a frame that is neither notice', () => {
		expect(decodeInboundNotice(encodeCohortMessage({ v: 1 } as never)), 'a non-notice frame is undecodable').to.equal(undefined);
	});
});

describe('cohort-topic: notice broadcast fan-out targets', () => {
	it('a promotion broadcasts only to the served cohort; a demotion also targets the parent coord', () => {
		const promo: PromotionNoticeV1 = {
			v: 1, topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, cohortCoord: bytesToB64url(COORD), effectiveAt: 1_000,
			thresholdSig: '', signers: [], cohortEpoch: bytesToB64url(EPOCH),
		};
		expect(noticeBroadcastCoords(promo, COORD).map(bytesToB64url), 'promotion → served cohort only')
			.to.deep.equal([bytesToB64url(COORD)]);

		const demo: DemotionNoticeV1 = {
			v: 1, topicId: bytesToB64url(TOPIC), tier: 1, parentCohortCoord: bytesToB64url(PARENT), cohortCoord: bytesToB64url(COORD), effectiveAt: 1_000,
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

/** A minimal {@link CoordRegistry} whose `findByCoord` always resolves to `target` (or nothing) — the
 * single-cohort node the pre-existing gate tests model (routing is not what they exercise). */
function servingRegistry(target: NoticeApplyTarget | undefined): CoordRegistry {
	return { findByCoord: (): NoticeApplyTarget | undefined => target } as unknown as CoordRegistry;
}

/** A {@link CoordRegistry} that routes a notice to the target whose `servedCoord` matches the queried coord —
 * the multi-cohort node the disambiguation tests exercise. A coord no target serves resolves to `undefined`. */
function coordRegistry(...targets: NoticeApplyTarget[]): CoordRegistry {
	return {
		findByCoord: (coord: RingCoord): NoticeApplyTarget | undefined =>
			targets.find((t) => bytesToB64url(t.servedCoord) === bytesToB64url(coord)),
	} as unknown as CoordRegistry;
}

/** A verifier that trusts every notice — isolates the ROUTING / high-water behavior under test from crypto
 * (the signature binding is covered separately by the coord-tamper test with real threshold signatures). */
const trustAllVerifier: MembershipVerifier = {
	cache: (): void => undefined,
	verifyMessage: (): Promise<'verified'> => Promise.resolve('verified'),
};

/** A structurally-valid promotion notice decided at `coord` (dummy sig — only used with {@link trustAllVerifier}). */
function promotionNoticeAtCoord(coord: RingCoord, effectiveAt: number): PromotionNoticeV1 {
	return {
		v: 1, topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, cohortCoord: bytesToB64url(coord), effectiveAt,
		thresholdSig: DUMMY_SIG, signers: [bytesToB64url(TOPIC)], cohortEpoch: bytesToB64url(EPOCH),
	};
}

/** A forged single-signer promotion notice (signers ⊄ a `minSigs ≥ 2` quorum) — always "untrusted". */
async function forgedPromotionNotice(members: Member[], effectiveAt: number): Promise<PromotionNoticeV1> {
	const signable = { topicId: bytesToB64url(TOPIC), fromTier: 1, toTier: 2, effectiveAt, cohortEpoch: bytesToB64url(EPOCH), cohortCoord: bytesToB64url(COORD) };
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

	it('a notice whose coord this node does not serve is dropped before the verifier (coord miss)', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const encoded = await encodedCertOver(members, byId, minSigs);
		const { source } = countingSource(encoded);
		const { verifier, calls } = countingVerifier(verifierFromSource(source, minSigs));
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		// The node serves only OTHER_COORD; the notice is decided at COORD → findByCoord miss → dropped.
		const { target: otherTarget } = remoteTargetAt(OTHER_COORD, minSigs);
		const notice = await realPromotionNotice(members, byId, minSigs, 1_000, COORD);
		const result = await handleInboundNotice(
			encodeCohortMessage(notice), peerIdToBytes('honest'), coordRegistry(otherTarget), verifier, gate, 2_000,
		);
		expect(result, 'no engine at the notice’s coord → dropped').to.equal('dropped');
		expect(calls(), 'a dropped notice never reaches the verifier').to.equal(0);
	});

	it('routes a notice to the engine for its carried coord, leaving a sibling cohort at a different coord unchanged', async () => {
		// Two cohorts this one node serves for the SAME (topic, tier) under distinct coords — the multi-cohort
		// case the coord routing exists for. Routing is what is under test, so a trust-all verifier isolates it.
		const a = remoteTargetAt(COORD, minSigs);
		const b = remoteTargetAt(OTHER_COORD, minSigs);
		const registry = coordRegistry(a.target, b.target);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		const from = peerIdToBytes('honest');

		const noticeA = promotionNoticeAtCoord(COORD, 1_000);
		expect(await handleInboundNotice(encodeCohortMessage(noticeA), from, registry, trustAllVerifier, gate, 2_000)).to.equal('applied');
		expect(a.life.isPromoted(TOPIC), 'target A (the notice’s coord) adopted it').to.be.true;
		expect(b.life.isPromoted(TOPIC), 'sibling target B at a different coord is untouched').to.be.false;
	});

	it('a notice for cohort A does not advance or stale-drop cohort B (per-coord high-water)', async () => {
		// Pre-fix, both cohorts shared a `${topicId}|${tier}` high-water, so A applying at effectiveAt = t would
		// stale-drop a legitimate B notice at the same t. Per-coord keying keeps their waters independent.
		const a = remoteTargetAt(COORD, minSigs);
		const b = remoteTargetAt(OTHER_COORD, minSigs);
		const registry = coordRegistry(a.target, b.target);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		const from = peerIdToBytes('honest');

		// A applies at effectiveAt = 5_000 → advances ONLY A's water.
		expect(await handleInboundNotice(encodeCohortMessage(promotionNoticeAtCoord(COORD, 5_000)), from, registry, trustAllVerifier, gate, 6_000)).to.equal('applied');
		// B's own notice at the SAME effectiveAt must still apply — B's water was never touched by A.
		expect(await handleInboundNotice(encodeCohortMessage(promotionNoticeAtCoord(OTHER_COORD, 5_000)), from, registry, trustAllVerifier, gate, 7_000)).to.equal('applied');
		expect(b.life.isPromoted(TOPIC), 'B adopted its own notice despite an equal effectiveAt to A').to.be.true;
		// Sanity: an A replay at 5_000 IS stale — A's own per-coord water sits at 5_000.
		expect(await handleInboundNotice(encodeCohortMessage(promotionNoticeAtCoord(COORD, 5_000)), from, registry, trustAllVerifier, gate, 8_000)).to.equal('stale');
	});
});

// --- promote-gate bounded memory (cohort-topic-promote-gate-map-eviction) ---

/** A structurally-valid forged promotion notice for an arbitrary `topicId` (dummy sig — always untrusted). */
const DUMMY_SIG = bytesToB64url(Uint8Array.from({ length: 64 }, () => 7));
function forgedNoticeForTopic(member: Member, topicId: Uint8Array, effectiveAt: number): PromotionNoticeV1 {
	return {
		v: 1,
		topicId: bytesToB64url(topicId),
		fromTier: 1,
		toTier: 2,
		cohortCoord: bytesToB64url(COORD),
		effectiveAt,
		thresholdSig: DUMMY_SIG,
		signers: [bytesToB64url(member.bytes)],
		cohortEpoch: bytesToB64url(EPOCH),
	};
}

describe('cohort-topic: promote-gate bounded memory', () => {
	const minSigs = 3;

	it('a distinct-topicId flood holds the limiter at maxKeys, not unbounded', async () => {
		// The core acceptance criterion: one peer spraying notices with distinct attacker-chosen topicIds (each
		// allocating a `(peer, topic)` limiter key *before* findServing) must hold the limiter at its cap, not
		// grow it without bound. The prereq's inline `maxKeys` LRU cap enforces this in `check()`.
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const { target } = remoteTarget(minSigs);
		const registry = servingRegistry(target);
		const maxKeys = 8;
		const gate = createPromoteGate({ ratePerWindow: 10_000, maxKeys });
		const from = peerIdToBytes('topic-sprayer');

		const N = 50;
		for (let i = 0; i < N; i++) {
			const topicId = Uint8Array.from({ length: 32 }, (_v, j) => (j + i * 13 + 1) & 0xff);
			const forged = forgedNoticeForTopic(members[0]!, topicId, 1_000 + i);
			await handleInboundNotice(encodeCohortMessage(forged), from, registry, verifier, gate, 2_000);
		}
		expect(gate.rateLimiter.size, `${N} distinct forged topicIds stay capped at maxKeys`).to.be.at.most(maxKeys);
		expect(gate.rateLimiter.size, 'the cap is actually reached (flood >> maxKeys)').to.equal(maxKeys);
	});

	it('highWater is an LRU map capped at PROMOTE_HIGHWATER_MAX_KEYS; the least-recently-set entry is evicted', () => {
		const gate = createPromoteGate();
		const overflow = 10;
		for (let i = 0; i < PROMOTE_HIGHWATER_MAX_KEYS + overflow; i++) {
			gate.highWater.set(`topic-${i}|0`, 1_000 + i);
		}
		expect(gate.highWater.size, 'capped at the max').to.equal(PROMOTE_HIGHWATER_MAX_KEYS);
		// The first `overflow` keys are the least-recently-set → evicted; the most recent survive.
		expect(gate.highWater.has('topic-0|0'), 'the oldest entry was evicted').to.equal(false);
		expect(gate.highWater.has(`topic-${overflow - 1}|0`), 'the (overflow)-th oldest was also evicted').to.equal(false);
		expect(gate.highWater.has(`topic-${overflow}|0`), 'the oldest surviving entry').to.equal(true);
		expect(gate.highWater.has(`topic-${PROMOTE_HIGHWATER_MAX_KEYS + overflow - 1}|0`), 'the newest entry survives').to.equal(true);
	});

	it('an evicted high-water lets a stale replay re-verify but the engine idempotently no-ops it (no regression)', async () => {
		// The headline safety test for `highWater` eviction. The gate's high-water is a strictly-weaker
		// early-drop optimization; the engine's PromotionLifecycle is the idempotency authority (lastEffectiveAt).
		// Evicting a water therefore only trades a tiny re-verify for memory — it can never let a stale notice
		// (re-)apply, because the engine no-ops any notice whose effectiveAt <= lastEffectiveAt.
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const { life, target } = remoteTarget(minSigs);
		const registry = servingRegistry(target);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		const from = peerIdToBytes('honest');

		// Apply a real promotion at effectiveAt = 10_000 → promoted, lastEffectiveAt = 10_000, water set.
		const promo = await realPromotionNotice(members, byId, minSigs, 10_000);
		expect(await handleInboundNotice(encodeCohortMessage(promo), from, registry, verifier, gate, 11_000)).to.equal('applied');
		expect(life.isPromoted(TOPIC), 'the promotion applied').to.be.true;

		// Evict the (TOPIC, tier) water by overflowing the LruMap cap with unrelated entries. The applied water
		// is the only — hence least-recently-set — entry, so the overflow pushes exactly it out.
		for (let i = 0; i < PROMOTE_HIGHWATER_MAX_KEYS; i++) {
			gate.highWater.set(`filler-${i}|9`, i);
		}

		// A *stale* demotion (effectiveAt 8_000 < 10_000) now passes the absent water gate and re-verifies —
		// but the engine no-ops it (8_000 <= lastEffectiveAt 10_000), so the promotion does NOT regress.
		const staleDemo = await realDemotionNotice(members, byId, minSigs, 8_000);
		const result = await handleInboundNotice(encodeCohortMessage(staleDemo), from, registry, verifier, gate, 12_000);
		expect(result, 'the eviction re-opened the gate (re-verified, not dropped as stale)').to.equal('applied');
		expect(life.isPromoted(TOPIC), 'the engine idempotently ignored the stale demotion — no regression').to.be.true;
	});

	it('a flood of forged (never-applied) notices leaves highWater empty — only verified applies write it', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const { target } = remoteTarget(minSigs);
		const registry = servingRegistry(target);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		const from = peerIdToBytes('forger');

		for (let i = 0; i < 40; i++) {
			const forged = forgedNoticeForTopic(members[0]!, TOPIC, 1_000 + i);
			const r = await handleInboundNotice(encodeCohortMessage(forged), from, registry, verifier, gate, 2_000);
			expect(r, 'a forged single-signer notice is untrusted').to.equal('untrusted');
		}
		expect(gate.highWater.size, 'no forged notice wrote the high-water (only an `applied` outcome does)').to.equal(0);
	});
});

// --- parent-side child unlink on demotion (cohort-topic-child-link-replicate-unlink) ---

/**
 * A parent-cohort {@link CoordEngine} stand-in that tracks its child set (freshness-ordered per child coord,
 * mirroring the real child registry). Only `unrecordChild` is exercised by the parent-unlink path; `recordChild`
 * seeds a pre-existing child, `childCohortCount` reads the demotion-gate input. It also satisfies
 * {@link NoticeApplyTarget} so it can double as the sibling-adopt target on a dual-role node.
 */
function childTrackingParent(coord: RingCoord): NoticeApplyTarget & {
	recordChild: (t: Uint8Array, c: Uint8Array, e: number) => void;
	unrecordChild: (t: Uint8Array, c: Uint8Array, e: number) => void;
	childCohortCount: (t: Uint8Array) => number;
} {
	const entries = new Map<string, { linked: boolean; at: number }>();
	const key = (t: Uint8Array, c: Uint8Array): string => `${bytesToB64url(t)}|${bytesToB64url(c)}`;
	const apply = (t: Uint8Array, c: Uint8Array, e: number, linked: boolean): void => {
		const k = key(t, c);
		const held = entries.get(k);
		if (held === undefined || e > held.at) {
			entries.set(k, { linked, at: e });
		}
	};
	return {
		servedCoord: coord,
		recordChild: (t, c, e): void => apply(t, c, e, true),
		unrecordChild: (t, c, e): void => apply(t, c, e, false),
		childCohortCount: (t): number => {
			const prefix = `${bytesToB64url(t)}|`;
			let n = 0;
			for (const [k, v] of entries) {
				if (k.startsWith(prefix) && v.linked) n++;
			}
			return n;
		},
		applyPromotionNotice: (): void => undefined,
		applyDemotionNotice: (): void => undefined,
	};
}

describe('cohort-topic: demotion notice unlinks the child at its parent cohort', () => {
	const minSigs = 3;

	it('a parent-only node unrecords the demoting child and reports "unlinked" (no sibling-adopt engine)', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		// The verifier is seeded with the CHILD cohort cert (over COORD) — the demotion is child-signed at COORD.
		const verifier = await verifierOver(members, byId, minSigs);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });

		// The node serves ONLY the parent coord (PARENT); it does not serve the child coord (COORD).
		const parent = childTrackingParent(PARENT);
		parent.recordChild(TOPIC, COORD, 500); // the parent had recorded this child earlier
		expect(parent.childCohortCount(TOPIC), 'the parent holds one child before the demotion').to.equal(1);
		const registry = coordRegistry(parent);

		const demo = await realDemotionNotice(members, byId, minSigs, 1_000); // cohortCoord = COORD, parentCohortCoord = PARENT
		const result = await handleInboundNotice(encodeCohortMessage(demo), peerIdToBytes('honest'), registry, verifier, gate, 2_000);
		expect(result, 'sibling-adopt dropped (no child engine) but the parent-unlink applied').to.equal('unlinked');
		expect(parent.childCohortCount(TOPIC), 'the demoting child was released at the parent').to.equal(0);
	});

	it('a forged (under-quorum) demotion does NOT unrecord the child at the parent', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });
		const parent = childTrackingParent(PARENT);
		parent.recordChild(TOPIC, COORD, 500);
		const registry = coordRegistry(parent);

		// A single-signer demotion at the child coord — the same forge the sibling-adopt path rejects.
		const signable = { topicId: bytesToB64url(TOPIC), tier: 1, parentCohortCoord: bytesToB64url(PARENT), effectiveAt: 1_000, cohortEpoch: bytesToB64url(EPOCH), cohortCoord: bytesToB64url(COORD) };
		const sig = await signPeer(members[0]!.key, demotionNoticeSigningPayload(signable));
		const forged: DemotionNoticeV1 = { v: 1, ...signable, thresholdSig: bytesToB64url(sig), signers: [bytesToB64url(members[0]!.bytes)] };

		const result = await handleInboundNotice(encodeCohortMessage(forged), peerIdToBytes('honest'), registry, verifier, gate, 2_000);
		expect(result, 'a forged demotion is untrusted at the parent').to.equal('untrusted');
		expect(parent.childCohortCount(TOPIC), 'the child was NOT released by an unverified demotion').to.equal(1);
	});

	it('applyDemotionUnlinkAtParent returns "no-parent" when this node does not serve the parent coord', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		// The registry serves the child coord but NOT the parent coord.
		const { target: childOnly } = remoteTargetAt(COORD, minSigs);
		const registry = coordRegistry(childOnly);
		const demo = await realDemotionNotice(members, byId, minSigs, 1_000);
		expect(await applyDemotionUnlinkAtParent(demo, registry, verifier, 2_000), 'no parent engine here → no-parent').to.equal('no-parent');
	});

	it('a dual-role node (serves BOTH the child and the parent coord) applies the sibling-adopt AND the parent-unlink from one demotion', async () => {
		const members = await makeMembers(4);
		const byId = new Map(members.map((m) => [m.idStr, m]));
		const verifier = await verifierOver(members, byId, minSigs);
		const gate = createPromoteGate({ ratePerWindow: 10_000 });

		// The child-sibling engine (at COORD) — promote it first so the demotion has something to clear.
		const child = remoteTargetAt(COORD, minSigs);
		const parent = childTrackingParent(PARENT);
		parent.recordChild(TOPIC, COORD, 500);
		const registry = coordRegistry(child.target, parent);
		const from = peerIdToBytes('honest');

		const promo = await realPromotionNotice(members, byId, minSigs, 900, COORD);
		expect(await handleInboundNotice(encodeCohortMessage(promo), from, registry, verifier, gate, 950)).to.equal('applied');
		expect(child.life.isPromoted(TOPIC), 'the child sibling is promoted').to.be.true;

		// One demotion frame: the sibling-adopt clears `promoted` at COORD; the parent-unlink releases the child.
		const demo = await realDemotionNotice(members, byId, minSigs, 1_000, COORD);
		const result = await handleInboundNotice(encodeCohortMessage(demo), from, registry, verifier, gate, 2_000);
		expect(result, 'the sibling-adopt is the reported outcome on a dual-role node').to.equal('applied');
		expect(child.life.isPromoted(TOPIC), 'the sibling-adopt cleared promoted').to.be.false;
		expect(parent.childCohortCount(TOPIC), 'the parent-unlink released the child — neither path shadows the other').to.equal(0);

		// The sibling-adopt advanced the COORD high-water to 1_000; a replay of the SAME frame stale-drops the
		// sibling path but the parent-unlink still runs (independent freshness) — a registry no-op, no throw.
		const replay = await handleInboundNotice(encodeCohortMessage(demo), from, registry, verifier, gate, 3_000);
		expect(result === 'applied' && replay === 'unlinked', 'the replay: sibling stale, parent-unlink still runs').to.be.true;
		expect(parent.childCohortCount(TOPIC), 'the child stays released across the replay').to.equal(0);
	});
});
