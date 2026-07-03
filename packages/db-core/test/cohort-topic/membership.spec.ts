import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCohortSigner } from '../../src/cohort-topic/sig/threshold.js';
import { membershipCertSigningPayload } from '../../src/cohort-topic/sig/payloads.js';
import { createMembershipVerifier } from '../../src/cohort-topic/membership/verifier.js';
import { createMembershipSourceRouter } from '../../src/cohort-topic/membership/source.js';
import { createMembershipCertPublisher } from '../../src/cohort-topic/membership/publisher.js';
import { bytesToB64url, encodeCohortMessage, decodeMembershipCertV1 } from '../../src/cohort-topic/wire/codec.js';
import { bytesEqual, compareBytes } from '../../src/cohort-topic/registration/bytes.js';
import type { ICohortThresholdCrypto, IMembershipSource, IMembershipTrustAnchor, RingCoord, TrustAnchorVerdict, TrustRoot } from '../../src/cohort-topic/ports.js';
import type { MembershipCertV1 } from '../../src/cohort-topic/wire/types.js';

const sigFor = (payload: Uint8Array): Uint8Array => sha256(payload).slice(0, 16);

function crypto(): ICohortThresholdCrypto {
	return {
		assemble: async (payload, minSigs) => ({ thresholdSig: sigFor(payload), signers: MEMBERS.slice(0, minSigs) }),
		verify: (payload, sig, signers) => bytesEqual(sig, sigFor(payload)) && signers.length > 0,
	};
}

function member(i: number): Uint8Array {
	return sha256(new TextEncoder().encode(`member-${i}`)).slice(0, 16);
}
const MEMBERS = Array.from({ length: 16 }, (_, i) => member(i));
const COORD: RingCoord = sha256(new TextEncoder().encode('cohort-coord')).slice(0, 32);
const EPOCH = sha256(new TextEncoder().encode('epoch')).slice(0, 32);
const MIN_SIGS = 14;

/** A self-consistent cert over `members`: signers are the first `MIN_SIGS` and sig covers the payload. */
function buildCert(members: Uint8Array[]): MembershipCertV1 {
	const membersB64 = members.map(bytesToB64url);
	const signable = { cohortCoord: bytesToB64url(COORD), cohortEpoch: bytesToB64url(EPOCH), members: membersB64, stabilizedAt: 1_000 };
	return { v: 1, ...signable, thresholdSig: bytesToB64url(sigFor(membershipCertSigningPayload(signable))), signers: membersB64.slice(0, MIN_SIGS) };
}

/** Configurable membership source recording call counts. */
class MockSource implements IMembershipSource {
	currentCalls = 0;
	fetchCalls = 0;
	constructor(private readonly currentEncoded?: Uint8Array, private readonly fetchEncoded?: Uint8Array) {}
	async current(_coord: RingCoord): Promise<Uint8Array | undefined> {
		this.currentCalls++;
		return this.currentEncoded;
	}
	async fetch(_coord: RingCoord): Promise<Uint8Array | undefined> {
		this.fetchCalls++;
		return this.fetchEncoded;
	}
}

// Good cohort = all 16 members; the message is signed by the first 14 (a quorum of the good cert).
const GOOD = buildCert(MEMBERS);
// Stale cohort = members 2..15 (missing member-0/1) — the message's signers are not all members here.
const STALE_MEMBERS = MEMBERS.slice(2);
const MESSAGE_SIGNERS = MEMBERS.slice(0, MIN_SIGS);
const PAYLOAD = new TextEncoder().encode('promotion-notice');
const SIG = sigFor(PAYLOAD);

describe('cohort-topic / membership verification', () => {
	const signer = createCohortSigner(crypto());

	function verifier(source: MockSource) {
		const router = createMembershipSourceRouter({ committed: source, fret: source });
		return { v: createMembershipVerifier({ signer, router }), source };
	}

	it('verifies directly against a cached, current cert (no fetch)', async () => {
		const { v, source } = verifier(new MockSource());
		v.cache(GOOD);
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('verified');
		expect(source.fetchCalls).to.equal(0);
		expect(source.currentCalls).to.equal(0);
	});

	it('stale cached cert triggers exactly one refetch, then succeeds', async () => {
		// The stale cert is observed from the source (TOFU-cached, not self-published), so a later refetch of
		// the current cert can replace it. (Under the trust gate, a cert the node itself published via `cache`
		// is *trusted* and would NOT be silently overwritten by an un-anchored refetch — see the trust-anchor
		// suite below for that distinction.)
		const source = new MockSource(encodeCohortMessage(buildCert(STALE_MEMBERS)), encodeCohortMessage(GOOD));
		const { v } = verifier(source);
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('verified');
		expect(source.currentCalls, 'consulted current() for the stale cert').to.equal(1);
		expect(source.fetchCalls, 'exactly one refetch').to.equal(1);
	});

	it('returns untrusted when the refetched cert still does not verify (no second fetch)', async () => {
		const source = new MockSource(undefined, encodeCohortMessage(buildCert(STALE_MEMBERS)));
		const { v } = verifier(source);
		v.cache(buildCert(STALE_MEMBERS));
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('untrusted');
		expect(source.fetchCalls, 'still exactly one refetch').to.equal(1);
	});

	it('a refetch bound rate-limits the stale-cert refetch to one per coord per interval', async () => {
		const source = new MockSource(undefined, encodeCohortMessage(buildCert(STALE_MEMBERS))); // refetch never satisfies
		const { v } = verifier(source);
		v.cache(buildCert(STALE_MEMBERS)); // cached cert lacks the message signers → every attempt misses
		const bound = { minRefetchIntervalMs: 60_000, now: 1_000 };

		// First miss within the window refetches exactly once.
		expect(await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG, bound)).to.equal('untrusted');
		expect(source.fetchCalls, 'first miss refetches once').to.equal(1);

		// A flood of further misses inside the interval drives no additional refetch.
		for (let i = 0; i < 20; i++) {
			expect(await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG, { minRefetchIntervalMs: 60_000, now: 1_000 + i })).to.equal('untrusted');
		}
		expect(source.fetchCalls, 'further misses inside the interval are suppressed').to.equal(1);

		// Past the interval, one more refetch is permitted.
		expect(await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG, { minRefetchIntervalMs: 60_000, now: 61_001 })).to.equal('untrusted');
		expect(source.fetchCalls, 'a refetch is allowed again after the interval').to.equal(2);
	});

	it('a refetch bound still refetches once on a cold cache (eventual refetch preserved)', async () => {
		const source = new MockSource(undefined, encodeCohortMessage(GOOD)); // no current seed; refetch returns GOOD
		const { v } = verifier(source);
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG, { minRefetchIntervalMs: 60_000, now: 1_000 });
		expect(r, 'the bounded refetch still fetches the cert and verifies').to.equal('verified');
		expect(source.fetchCalls, 'a cold cache pays exactly one bounded refetch').to.equal(1);
	});

	it('with no cached cert, consults current() before forcing a fetch', async () => {
		const source = new MockSource(encodeCohortMessage(GOOD), undefined);
		const { v } = verifier(source);
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('verified');
		expect(source.currentCalls).to.equal(1);
		expect(source.fetchCalls).to.equal(0);
	});

	it('untrusted when no cert is available anywhere', async () => {
		const source = new MockSource(undefined, undefined);
		const { v } = verifier(source);
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('untrusted');
		expect(source.currentCalls).to.equal(1);
		expect(source.fetchCalls).to.equal(1);
	});

	it('rejects a refetched cert that is not self-consistently signed', async () => {
		const tampered = { ...GOOD, members: STALE_MEMBERS.map(bytesToB64url) }; // signers no longer a subset → self-check fails
		const source = new MockSource(undefined, encodeCohortMessage(tampered));
		const { v } = verifier(source);
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('untrusted');
	});

	it('routes T0/T1 to the committed source and T2/T3 to FRET', async () => {
		const committed = new MockSource(encodeCohortMessage(GOOD));
		const fret = new MockSource(undefined);
		const router = createMembershipSourceRouter({ committed, fret });

		// Fresh verifiers so a cached cert from one tier does not satisfy the other.
		const r1 = await createMembershipVerifier({ signer, router }).verifyMessage(MESSAGE_SIGNERS, COORD, 1, PAYLOAD, SIG);
		expect(r1).to.equal('verified');
		expect(committed.currentCalls, 'T1 used committed source').to.equal(1);
		expect(fret.currentCalls, 'T1 did not touch FRET').to.equal(0);

		const r3 = await createMembershipVerifier({ signer, router }).verifyMessage(MESSAGE_SIGNERS, COORD, 3, PAYLOAD, SIG);
		expect(r3).to.equal('untrusted');
		expect(fret.currentCalls, 'T3 used FRET source').to.equal(1);
		expect(committed.currentCalls, 'T3 did not touch committed source').to.equal(1);
	});
});

describe('cohort-topic / membership cert publication', () => {
	const signer = createCohortSigner(crypto());

	function mkMember(i: number): Uint8Array {
		const b = new Uint8Array(16);
		b[0] = i;
		return b; // ordering is by the leading byte, so member sets are easy to control
	}

	function capturingSink() {
		const published: MembershipCertV1[] = [];
		return { published, sink: { publish: (encoded: Uint8Array) => { published.push(decodeMembershipCertV1(encoded)); } } };
	}

	// The cohort epoch is a pure function of the sorted member SET (production: `cohortEpoch = H(sorted all
	// members)`), so ANY member change — head or tail — yields a distinct epoch, while reordering the same
	// set does not. Deriving it here (rather than a constant `EPOCH`) is what lets these tests exercise the
	// publisher's real republish signal; a constant epoch masked the post-firstKx (tail) change entirely.
	function epochOf(members: Uint8Array[]): Uint8Array {
		const joined = new TextEncoder().encode([...members].sort(compareBytes).map(bytesToB64url).join('|'));
		return sha256(joined).slice(0, 32);
	}
	function snapshot(members: Uint8Array[], stabilizedAt = 1_000) {
		return { coord: COORD, cohortEpoch: epochOf(members), members, stabilizedAt };
	}

	it('publishes a signed cert at first stabilization', async () => {
		const { published, sink } = capturingSink();
		const pub = createMembershipCertPublisher({ signer, sink });
		const cert = await pub.onStabilized(snapshot([mkMember(0), mkMember(1), mkMember(2), mkMember(3)]), 1_000);
		expect(cert, 'cert returned').to.not.be.undefined;
		expect(published).to.have.length(1);
		expect(published[0]!.signers.length).to.be.gte(2);
		// Members are sorted ascending in the cert.
		expect(published[0]!.members).to.deep.equal([mkMember(0), mkMember(1), mkMember(2), mkMember(3)].map(bytesToB64url));
	});

	it('republishes on any member change — head OR tail — since the epoch tracks the whole member set', async () => {
		const { published, sink } = capturingSink();
		const pub = createMembershipCertPublisher({ signer, sink });
		await pub.onStabilized(snapshot([mkMember(0), mkMember(1), mkMember(2), mkMember(3)]), 1_000);
		expect(published).to.have.length(1);

		// A TAIL-only change (positions beyond a first-`k − x` core are what the OLD firstKx gate ignored) now
		// rotates the epoch → prompt republish. This is the regression this fix closes: the first two members
		// (0,1) are unchanged, only the tail (2,3 → 2,20) moves, yet a fresh cert is served.
		const tail = await pub.onStabilized(snapshot([mkMember(0), mkMember(1), mkMember(2), mkMember(20)]), 1_100);
		expect(tail, 'tail-only change now republishes (epoch changed)').to.not.be.undefined;
		expect(published).to.have.length(2);

		// A head change of course republishes too.
		const head = await pub.onStabilized(snapshot([mkMember(9), mkMember(1), mkMember(2), mkMember(20)]), 1_200);
		expect(head, 'head change republishes').to.not.be.undefined;
		expect(published).to.have.length(3);
	});

	it('does not republish when the member set (epoch) is unchanged', async () => {
		const { published, sink } = capturingSink();
		const pub = createMembershipCertPublisher({ signer, sink });
		const members = [mkMember(0), mkMember(1), mkMember(2), mkMember(3)];
		await pub.onStabilized(snapshot(members), 1_000);
		expect(published).to.have.length(1);

		// Same set (a different order, a later stabilizedAt) → same epoch → no spurious republish.
		const same = await pub.onStabilized(snapshot([mkMember(3), mkMember(2), mkMember(1), mkMember(0)], 1_100), 1_100);
		expect(same, 'unchanged identity is not republished').to.be.undefined;
		expect(published).to.have.length(1);
	});

	it('refreshes on tick only after T_membership_refresh elapses', async () => {
		const { published, sink } = capturingSink();
		const pub = createMembershipCertPublisher({ signer, sink, refreshMs: 1_000 });
		const members = [mkMember(0), mkMember(1), mkMember(2), mkMember(3)];
		await pub.onStabilized(snapshot(members), 10_000);
		expect(published).to.have.length(1);

		expect(await pub.tick(snapshot(members), 10_500), 'too soon').to.be.undefined;
		expect(published).to.have.length(1);

		expect(await pub.tick(snapshot(members), 11_000), 'refresh interval elapsed').to.not.be.undefined;
		expect(published).to.have.length(2);
	});

	it('attaches a rotation attestation on a tail-only change; the default publish emits no rotation fields', async () => {
		const { published, sink } = capturingSink();
		const pub = createMembershipCertPublisher({ signer, sink });

		// Default path (no rotation arg): the cert carries none of the rotation fields.
		await pub.onStabilized(snapshot([mkMember(0), mkMember(1), mkMember(2), mkMember(3)]), 1_000);
		expect(published[0]).to.not.have.property('prevEpoch');
		expect(published[0]).to.not.have.property('rotationSig');
		expect(published[0]).to.not.have.property('rotationSigners');

		// A TAIL-only change (the first two members are unchanged, so the OLD firstKx gate would NOT have
		// republished or attested) now rotates the epoch and carries the attestation verbatim — the host
		// attaches a rotation on any epoch change, mirroring this republish gate. The threshold sig still
		// covers only the non-rotation signing image, so the cert stays self-consistent (verifier suite).
		const prevEpoch = new Uint8Array(32).fill(7);
		const rotationSig = new Uint8Array(16).fill(9);
		const rotationSigners = [mkMember(0), mkMember(1)];
		const rotated = [mkMember(0), mkMember(1), mkMember(2), mkMember(30)]; // tail change → epoch rotates, first two unchanged
		const cert = await pub.onStabilized(snapshot(rotated), 1_100, { prevEpoch, rotationSig, rotationSigners });
		expect(cert, 'republished on a tail-only (epoch) change').to.not.be.undefined;
		expect(published).to.have.length(2);
		expect(published[1]!.prevEpoch).to.equal(bytesToB64url(prevEpoch));
		expect(published[1]!.rotationSig).to.equal(bytesToB64url(rotationSig));
		expect(published[1]!.rotationSigners).to.deep.equal(rotationSigners.map(bytesToB64url));
	});
});

// --- Trust anchoring: a self-consistent cert must also be anchored (trust root / direct anchor / chain) ---

/** Adversary keyset — a self-consistent cert over these proves nothing about who owns the coord. */
const ADV = Array.from({ length: 16 }, (_, i) => sha256(new TextEncoder().encode(`adversary-${i}`)).slice(0, 16));
/** A second legitimate keyset, used as the *successor* cohort in an epoch rotation. */
const ROTATED = Array.from({ length: 16 }, (_, i) => sha256(new TextEncoder().encode(`rotated-${i}`)).slice(0, 16));
const EPOCH_N = sha256(new TextEncoder().encode('epoch-n')).slice(0, 32);
const EPOCH_N1 = sha256(new TextEncoder().encode('epoch-n+1')).slice(0, 32);
/** A *second* rotation past N+1 — the epoch a node that missed the intermediate N+1 rotation lands on. */
const EPOCH_N2 = sha256(new TextEncoder().encode('epoch-n+2')).slice(0, 32);

/** Build a self-consistent cert over an explicit coord/epoch/member set, optionally carrying a rotation attestation. */
function buildCertOver(opts: {
	coord?: Uint8Array;
	epoch: Uint8Array;
	members: Uint8Array[];
	stabilizedAt?: number;
	rotation?: { prevEpoch: Uint8Array; rotationSig: Uint8Array; rotationSigners: Uint8Array[] };
}): MembershipCertV1 {
	const membersB64 = opts.members.map(bytesToB64url);
	const signable = {
		cohortCoord: bytesToB64url(opts.coord ?? COORD),
		cohortEpoch: bytesToB64url(opts.epoch),
		members: membersB64,
		stabilizedAt: opts.stabilizedAt ?? 1_000,
	};
	const cert: MembershipCertV1 = {
		v: 1,
		...signable,
		thresholdSig: bytesToB64url(sigFor(membershipCertSigningPayload(signable))),
		signers: membersB64.slice(0, MIN_SIGS),
	};
	if (opts.rotation !== undefined) {
		cert.prevEpoch = bytesToB64url(opts.rotation.prevEpoch);
		cert.rotationSig = bytesToB64url(opts.rotation.rotationSig);
		cert.rotationSigners = opts.rotation.rotationSigners.map(bytesToB64url);
	}
	return cert;
}

/** A predecessor cohort's threshold signature over the successor cert's signing payload (the rotation proof). */
function rotationSigOver(successor: MembershipCertV1): Uint8Array {
	const { v: _v, thresholdSig: _t, signers: _s, prevEpoch: _p, rotationSig: _r, rotationSigners: _rs, ...signable } = successor;
	return sigFor(membershipCertSigningPayload(signable));
}

/** A constant-verdict trust anchor (models a node with / without local authority for the coord). */
function constAnchor(verdict: TrustAnchorVerdict): IMembershipTrustAnchor {
	return { directAnchor: () => verdict };
}

/** A membership source whose `fetch()` returns a fixed sequence of encoded certs (for multi-refetch tests). */
class QueueSource implements IMembershipSource {
	currentCalls = 0;
	fetchCalls = 0;
	constructor(private readonly fetches: Array<Uint8Array | undefined>) {}
	async current(_coord: RingCoord): Promise<Uint8Array | undefined> {
		this.currentCalls++;
		return undefined;
	}
	async fetch(_coord: RingCoord): Promise<Uint8Array | undefined> {
		this.fetchCalls++;
		return this.fetches.shift();
	}
}

const sign = (payload: Uint8Array): Uint8Array => sigFor(payload);
const advSignersFirstKx = ADV.slice(0, MIN_SIGS);
/** A generic message payload; the cohort binding is carried by the `signers`, not this payload. */
const MSG = new TextEncoder().encode('cohort-message');

describe('cohort-topic / membership trust anchoring', () => {
	const signer = createCohortSigner(crypto());

	function makeVerifier(source: MockSource, extra?: { anchor?: IMembershipTrustAnchor; trustRoots?: readonly TrustRoot[] }) {
		const router = createMembershipSourceRouter({ committed: source, fret: source });
		return createMembershipVerifier({ signer, router, anchor: extra?.anchor, trustRoots: extra?.trustRoots });
	}

	it('rejects a forged unrelated-keyset cert when the direct anchor says "rejected" (headline security property)', async () => {
		const forged = buildCertOver({ epoch: EPOCH, members: ADV }); // self-consistent over an adversary keyset
		const source = new MockSource(encodeCohortMessage(forged), encodeCohortMessage(forged));
		const v = makeVerifier(source, { anchor: constAnchor('rejected') });
		// The message is genuinely signed by the forged cohort — it would pass were the cert believed.
		const r = await v.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG));
		expect(r).to.equal('untrusted');
	});

	it('accepts a cert the direct anchor vouches for ("anchored")', async () => {
		const source = new MockSource(encodeCohortMessage(GOOD));
		const v = makeVerifier(source, { anchor: constAnchor('anchored') });
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('verified');
	});

	it('threads the verifying cert and the router tier into the direct anchor', async () => {
		// A recording anchor proves the gate consults `directAnchor` with the *same* cert it is deciding on
		// and the *same* tier the router dispatched (the binding is tier-scoped). Use T3 (FRET) so a stray
		// default tier would be observable.
		const calls: Array<{ cohortCoord: string; cohortEpoch: string; tier: number }> = [];
		const recordingAnchor: IMembershipTrustAnchor = {
			directAnchor: (cert, tier) => {
				calls.push({ cohortCoord: cert.cohortCoord, cohortEpoch: cert.cohortEpoch, tier });
				return 'anchored';
			},
		};
		const source = new MockSource(encodeCohortMessage(GOOD));
		const v = makeVerifier(source, { anchor: recordingAnchor });
		expect(await v.verifyMessage(MESSAGE_SIGNERS, COORD, 3, PAYLOAD, SIG)).to.equal('verified');
		expect(calls, 'the anchor is consulted exactly once for the loaded cert').to.have.length(1);
		expect(calls[0]).to.deep.equal({ cohortCoord: bytesToB64url(COORD), cohortEpoch: bytesToB64url(EPOCH), tier: 3 });
	});

	it('TOFU-accepts a self-consistent cert on an "unknown" coord (no regression where nothing can anchor)', async () => {
		const source = new MockSource(encodeCohortMessage(GOOD));
		const v = makeVerifier(source, { anchor: constAnchor('unknown') });
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('verified');
	});

	it('a "rejected" verdict overrides the TOFU fallback that an "unknown" verdict would allow', async () => {
		const forged = buildCertOver({ epoch: EPOCH, members: ADV });
		// Same forged cert + same forged-but-valid message; only the anchor verdict differs.
		const tofu = makeVerifier(new MockSource(encodeCohortMessage(forged)), { anchor: constAnchor('unknown') });
		expect(await tofu.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'unknown → TOFU accepts').to.equal('verified');

		const rejected = makeVerifier(new MockSource(encodeCohortMessage(forged), encodeCohortMessage(forged)), { anchor: constAnchor('rejected') });
		expect(await rejected.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'rejected → forgery dropped').to.equal('untrusted');
	});

	it('a legit epoch rotation inherits trust via the attestation chain (anchor "unknown")', async () => {
		const predecessor = buildCertOver({ epoch: EPOCH_N, members: MEMBERS });
		const successor = buildCertOver({ epoch: EPOCH_N1, members: ROTATED, rotation: { prevEpoch: EPOCH_N, rotationSig: new Uint8Array(0), rotationSigners: MEMBERS.slice(0, MIN_SIGS) } });
		// The predecessor cohort signs the successor's payload — the proof a real rotation carries.
		successor.rotationSig = bytesToB64url(rotationSigOver(successor));

		const source = new MockSource(undefined, encodeCohortMessage(successor));
		const v = makeVerifier(source, { anchor: constAnchor('unknown') });
		v.cache(predecessor); // the node trusts a cert it itself published → a valid chain anchor

		const rotatedSigners = ROTATED.slice(0, MIN_SIGS);
		const r = await v.verifyMessage(rotatedSigners, COORD, 2, MSG, sign(MSG));
		expect(r).to.equal('verified');
	});

	it('rejects a forged rotation whose attestation is signed by the wrong (non-predecessor) keys', async () => {
		const predecessor = buildCertOver({ epoch: EPOCH_N, members: MEMBERS });
		// Adversary mints a successor over its own keyset, signing the attestation with its OWN keys (∉ predecessor).
		const forged = buildCertOver({ epoch: EPOCH_N1, members: ADV, rotation: { prevEpoch: EPOCH_N, rotationSig: new Uint8Array(0), rotationSigners: ADV.slice(0, MIN_SIGS) } });
		forged.rotationSig = bytesToB64url(rotationSigOver(forged));

		const source = new MockSource(undefined, encodeCohortMessage(forged));
		const v = makeVerifier(source, { anchor: constAnchor('unknown') });
		v.cache(predecessor); // trusted predecessor → the coord is trust-established, so TOFU cannot rescue the forgery

		const r = await v.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG));
		expect(r).to.equal('untrusted');
	});

	it('the chain requires a *trusted* predecessor: a merely TOFU-cached predecessor cannot anchor a successor', async () => {
		// Same forged successor as above, but the predecessor reaches the cache via TOFU (source), not `cache`.
		const predecessor = buildCertOver({ epoch: EPOCH_N, members: MEMBERS });
		const forged = buildCertOver({ epoch: EPOCH_N1, members: ADV, rotation: { prevEpoch: EPOCH_N, rotationSig: new Uint8Array(0), rotationSigners: ADV.slice(0, MIN_SIGS) } });
		forged.rotationSig = bytesToB64url(rotationSigOver(forged));

		const source = new MockSource(encodeCohortMessage(predecessor), encodeCohortMessage(forged));
		const v = makeVerifier(source, { anchor: constAnchor('unknown') });

		// First, the predecessor is observed from the source → TOFU-cached (NOT trusted).
		expect(await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG), 'predecessor TOFU-accepted').to.equal('verified');

		// The forged successor's chain step is rejected (predecessor not trusted); because the coord was only
		// ever TOFU'd (never trust-established), it stays in the interim-TOFU regime — the documented limit —
		// rather than being trust-locked. Contrast the previous test, where a *trusted* predecessor causes the
		// identical forgery to be rejected. The trust-anchor binding (db-p2p) is what closes this TOFU gap.
		expect(await v.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'forgery not chain-trusted; coord stays TOFU').to.equal('verified');
	});

	it('a chain-trusted successor itself becomes a trusted anchor for the next rotation', async () => {
		const predecessor = buildCertOver({ epoch: EPOCH_N, members: MEMBERS });
		const successor = buildCertOver({ epoch: EPOCH_N1, members: ROTATED, rotation: { prevEpoch: EPOCH_N, rotationSig: new Uint8Array(0), rotationSigners: MEMBERS.slice(0, MIN_SIGS) } });
		successor.rotationSig = bytesToB64url(rotationSigOver(successor));
		// A forged grandchild claiming to rotate from the (now trusted) successor, but signed by adversary keys.
		const forgedGrandchild = buildCertOver({ epoch: EPOCH, members: ADV, rotation: { prevEpoch: EPOCH_N1, rotationSig: new Uint8Array(0), rotationSigners: ADV.slice(0, MIN_SIGS) } });
		forgedGrandchild.rotationSig = bytesToB64url(rotationSigOver(forgedGrandchild));

		// fetch() yields the successor on the first refetch, then the forged grandchild on the second.
		const source = new QueueSource([encodeCohortMessage(successor), encodeCohortMessage(forgedGrandchild)]);
		const v = makeVerifier(source, { anchor: constAnchor('unknown') });
		v.cache(predecessor);

		const rotatedSigners = ROTATED.slice(0, MIN_SIGS);
		expect(await v.verifyMessage(rotatedSigners, COORD, 2, MSG, sign(MSG)), 'successor chain-verified').to.equal('verified');

		// The successor is now trusted-cached, so the coord is trust-established: the forged grandchild's bad
		// attestation cannot launder it in (its signers are not the successor's, and the locked coord refuses
		// the un-anchored TOFU downgrade).
		expect(await v.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'grandchild rejected — successor became a trusted anchor').to.equal('untrusted');
	});

	it('trust-root match is by (coord, epoch, member-set) and is checked before the direct anchor', async () => {
		const roots: TrustRoot[] = [{ coord: COORD, epoch: EPOCH, members: MEMBERS }];
		// A genesis cert matching the root is trusted even though the anchor would "reject" it (root precedes anchor).
		const genesis = buildCertOver({ epoch: EPOCH, members: MEMBERS });
		const v1 = makeVerifier(new MockSource(encodeCohortMessage(genesis)), { anchor: constAnchor('rejected'), trustRoots: roots });
		expect(await v1.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG), 'root cert trusted ahead of the anchor').to.equal('verified');

		// Same genesis coord+epoch but a swapped keyset is NOT a root → the "rejected" anchor drops it.
		const swapped = buildCertOver({ epoch: EPOCH, members: ADV });
		const v2 = makeVerifier(new MockSource(encodeCohortMessage(swapped), encodeCohortMessage(swapped)), { anchor: constAnchor('rejected'), trustRoots: roots });
		expect(await v2.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'swapped keyset is not a root').to.equal('untrusted');
	});

	it('rejects a self-referential rotation (prevEpoch === cohortEpoch)', async () => {
		const predecessor = buildCertOver({ epoch: EPOCH_N, members: MEMBERS });
		const selfRef = buildCertOver({ epoch: EPOCH_N1, members: ADV, rotation: { prevEpoch: EPOCH_N1, rotationSig: new Uint8Array(0), rotationSigners: ADV.slice(0, MIN_SIGS) } });
		selfRef.rotationSig = bytesToB64url(rotationSigOver(selfRef));

		const source = new MockSource(undefined, encodeCohortMessage(selfRef));
		const v = makeVerifier(source, { anchor: constAnchor('unknown') });
		v.cache(predecessor); // trust-established coord → a cert that cannot rotate from itself is rejected

		const r = await v.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG));
		expect(r).to.equal('untrusted');
	});
});

// --- Stale trust-lock recovery: a former cohort member self-heals a lock it can no longer anchor ---
//
// A node that served coord C, self-published its cert (trust-LOCKING C at epoch N), then left C's cohort keeps
// distrusting every later-epoch message from C: the anchor now says "unknown" for C, and if the node missed an
// intermediate rotation the refetched later cert's prevEpoch (N+1) no longer matches the cached N, so the chain
// gap keeps it rejected. Bounded re-TOFU on a *demonstrated gap* is the exit. The N+2 cert whose prevEpoch is
// N+1 (≠ the cached N) is the "gap" signal; ROTATED is C's cohort at N+2.

/** The gap cert a node cached at N sees after C rotated N → N+1 → N+2 without it: epoch N+2, prevEpoch N+1. */
function gapCertN2(): MembershipCertV1 {
	// The rotationSig is never decoded here — chainGrantsTrust bails on the prevEpoch/predecessor epoch mismatch
	// (cached N ≠ prevEpoch N+1) before verifying it — so a filler is fine; only its *presence* matters.
	return buildCertOver({ epoch: EPOCH_N2, members: ROTATED, rotation: { prevEpoch: EPOCH_N1, rotationSig: new Uint8Array(16).fill(3), rotationSigners: ROTATED.slice(0, MIN_SIGS) } });
}
const rotatedSignersFirstKx = ROTATED.slice(0, MIN_SIGS);
const memberSignersFirstKx = MEMBERS.slice(0, MIN_SIGS);

describe('cohort-topic / membership stale trust-lock recovery', () => {
	const signer = createCohortSigner(crypto());

	function makeVerifier(source: IMembershipSource, extra?: { anchor?: IMembershipTrustAnchor; staleGapRecoveryStrikes?: number }) {
		const router = createMembershipSourceRouter({ committed: source, fret: source });
		return createMembershipVerifier({ signer, router, anchor: extra?.anchor, staleGapRecoveryStrikes: extra?.staleGapRecoveryStrikes });
	}

	/** Trust-lock COORD at epoch N (self-publish the N cert), mirroring the demoted former-member start state. */
	function lockedAtN(v: ReturnType<typeof makeVerifier>): void {
		v.cache(buildCertOver({ epoch: EPOCH_N, members: MEMBERS }));
	}

	it('recovers a stale-locked coord after N consecutive gap-signalled refetches, then verifies from cache', async () => {
		const gap = gapCertN2();
		// The refetch keeps returning the same N+2 gap cert (prevEpoch N+1 ≠ the cached N → an explicit gap).
		const source = new QueueSource([encodeCohortMessage(gap), encodeCohortMessage(gap), encodeCohortMessage(gap)]);
		const v = makeVerifier(source, { anchor: constAnchor('unknown') }); // default threshold = 3
		lockedAtN(v);

		// The first two gap-signalled misses stay untrusted — the lock holds...
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'strike 1 stays locked').to.equal('untrusted');
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'strike 2 stays locked').to.equal('untrusted');
		// ...the third strike releases the lock back to TOFU and the N+2 message finally verifies.
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'strike 3 recovers').to.equal('verified');
		expect(source.fetchCalls, 'recovery paid exactly one refetch per strike').to.equal(3);

		// The lock is now replaced by the N+2 cert (cached), so subsequent messages verify with no further refetch.
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'stays recovered').to.equal('verified');
		expect(source.fetchCalls, 'a recovered coord verifies from cache — no extra refetch').to.equal(3);
	});

	it('a forged rotation off the current predecessor never strikes: it stays untrusted and cannot recover on its own', async () => {
		// Forged N+1 cert over an adversary keyset claiming prevEpoch == N (the cached epoch) — NOT a gap.
		const forged = buildCertOver({ epoch: EPOCH_N1, members: ADV, rotation: { prevEpoch: EPOCH_N, rotationSig: new Uint8Array(0), rotationSigners: ADV.slice(0, MIN_SIGS) } });
		forged.rotationSig = bytesToB64url(rotationSigOver(forged));
		const gap = gapCertN2();
		// 12 forged refetches, then the 3 genuine gap refetches.
		const fetches = [...Array.from({ length: 12 }, () => encodeCohortMessage(forged)), encodeCohortMessage(gap), encodeCohortMessage(gap), encodeCohortMessage(gap)];
		const source = new QueueSource(fetches);
		const v = makeVerifier(source, { anchor: constAnchor('unknown') });
		lockedAtN(v);

		// The forged cert, presented far more than the threshold, never counts as a strike → always untrusted.
		for (let i = 0; i < 12; i++) {
			expect(await v.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG)), `forged attempt ${i} stays locked`).to.equal('untrusted');
		}
		// The genuine gap cert still needs its full 3 *consecutive* strikes (the forged ones accrued nothing).
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'gap strike 1').to.equal('untrusted');
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'gap strike 2').to.equal('untrusted');
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'gap strike 3 recovers').to.equal('verified');
	});

	it('a forged-off-predecessor cert interleaved with the real gap cert stays untrusted and neither blocks nor accelerates recovery', async () => {
		const forged = buildCertOver({ epoch: EPOCH_N1, members: ADV, rotation: { prevEpoch: EPOCH_N, rotationSig: new Uint8Array(0), rotationSigners: ADV.slice(0, MIN_SIGS) } });
		forged.rotationSig = bytesToB64url(rotationSigOver(forged));
		const gap = gapCertN2();
		// Alternate gap / forged / gap / forged / gap. The forged calls neither reset (they never verify) nor
		// strike (not a gap), so the real gap's consecutive count is 1 → 2 → 3 across its own three refetches.
		const source = new QueueSource([encodeCohortMessage(gap), encodeCohortMessage(forged), encodeCohortMessage(gap), encodeCohortMessage(forged), encodeCohortMessage(gap)]);
		const v = makeVerifier(source, { anchor: constAnchor('unknown') });
		lockedAtN(v);

		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'gap strike 1').to.equal('untrusted');
		expect(await v.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'interleaved forged stays untrusted').to.equal('untrusted');
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'gap strike 2').to.equal('untrusted');
		expect(await v.verifyMessage(advSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'interleaved forged stays untrusted').to.equal('untrusted');
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'gap strike 3 recovers on its own count').to.equal('verified');
	});

	it('a gap cert whose direct anchor says "rejected" is dropped regardless of strike count', async () => {
		const gap = gapCertN2();
		const source = new QueueSource(Array.from({ length: 6 }, () => encodeCohortMessage(gap)));
		const v = makeVerifier(source, { anchor: constAnchor('rejected') }); // a "rejected" verdict is fatal, pre-empts recovery
		lockedAtN(v);
		for (let i = 0; i < 6; i++) {
			expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), `rejected-anchor attempt ${i}`).to.equal('untrusted');
		}
	});

	it('does not recover below the configured strike threshold', async () => {
		const gap = gapCertN2();
		const source = new QueueSource(Array.from({ length: 4 }, () => encodeCohortMessage(gap)));
		const v = makeVerifier(source, { anchor: constAnchor('unknown'), staleGapRecoveryStrikes: 5 }); // 4 strikes is one short
		lockedAtN(v);
		for (let i = 0; i < 4; i++) {
			expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), `strike ${i + 1} < 5, still locked`).to.equal('untrusted');
		}
	});

	it('a successful verify between strikes resets the consecutive counter', async () => {
		const gap = gapCertN2();
		// gap (strike 1) → an N-cohort message (verifies from the still-cached N cert, resets) → three fresh gaps.
		const source = new QueueSource(Array.from({ length: 4 }, () => encodeCohortMessage(gap)));
		const v = makeVerifier(source, { anchor: constAnchor('unknown') }); // default threshold = 3
		lockedAtN(v);

		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'gap strike 1').to.equal('untrusted');
		// A legit message still signed by the cached N cohort verifies from cache → resets the consecutive count.
		expect(await v.verifyMessage(memberSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'N-cohort message verifies (resets)').to.equal('verified');
		// The counter is back to zero, so three fresh consecutive gap strikes are required again.
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'fresh strike 1').to.equal('untrusted');
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'fresh strike 2').to.equal('untrusted');
		expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), 'fresh strike 3 recovers').to.equal('verified');
	});

	it('with recovery disabled (staleGapRecoveryStrikes = 0) a stale-locked coord never self-heals', async () => {
		// The documented "0 (or negative) disables recovery — which re-opens the stale-lock liveness bug"
		// contract: the `> 0` gate in staleGapRecovery must short-circuit so even a genuine gap never strikes.
		const gap = gapCertN2();
		const source = new QueueSource(Array.from({ length: 8 }, () => encodeCohortMessage(gap)));
		const v = makeVerifier(source, { anchor: constAnchor('unknown'), staleGapRecoveryStrikes: 0 });
		lockedAtN(v);
		for (let i = 0; i < 8; i++) {
			expect(await v.verifyMessage(rotatedSignersFirstKx, COORD, 2, MSG, sign(MSG)), `disabled: attempt ${i} stays locked`).to.equal('untrusted');
		}
	});
});

// --- Per-coord map caps (anti-DoS): byCoord / lastFetchAt / staleGapStrikes are LRU-bounded ---
//
// The three per-coord verifier maps are keyed by `coordKey` (base64url of an attacker-derivable RingCoord).
// Under a flood of verify-misses against attacker-chosen coords they must not grow without bound. They share
// the reusable `LruMap` (its own eviction is unit-tested in `test/lru-map.spec.ts`); these tests pin the
// verifier-level contract: the positive-integer `maxCoords` guard, and that `byCoord` actually evicts.

describe('cohort-topic / membership verifier map caps', () => {
	const signer = createCohortSigner(crypto());

	it('rejects a non-positive-integer maxCoords (mirrors the sibling anti-DoS maxKeys guard)', () => {
		const router = createMembershipSourceRouter({ committed: new MockSource(), fret: new MockSource() });
		for (const bad of [0, -1, 2.5, Number.NaN]) {
			expect(() => createMembershipVerifier({ signer, router, maxCoords: bad }), `maxCoords=${bad}`).to.throw(RangeError);
		}
	});

	it('LRU-caps byCoord: an attacker-coord burst evicts an earlier trust-locked entry (best-effort trust lock)', async () => {
		// A per-coord source so byCoord (keyed by cert.cohortCoord) grows one entry per distinct coord.
		const coordFor = (label: string): RingCoord => sha256(new TextEncoder().encode(label)).slice(0, 32);
		const certs = new Map<string, Uint8Array>();
		const certOverCoord = (coord: RingCoord): Uint8Array => encodeCohortMessage(buildCertOver({ coord, epoch: EPOCH, members: MEMBERS }));
		const coordA = coordFor('cap-coord-A');
		certs.set(bytesToB64url(coordA), certOverCoord(coordA));
		const floodCoords = ['B', 'C', 'D', 'E'].map((s) => coordFor(`cap-coord-${s}`));
		for (const c of floodCoords) certs.set(bytesToB64url(c), certOverCoord(c));

		class PerCoordSource implements IMembershipSource {
			readonly currentCalls = new Map<string, number>();
			readonly fetchCalls = new Map<string, number>();
			async current(coord: RingCoord): Promise<Uint8Array | undefined> {
				const k = bytesToB64url(coord);
				this.currentCalls.set(k, (this.currentCalls.get(k) ?? 0) + 1);
				return certs.get(k);
			}
			async fetch(coord: RingCoord): Promise<Uint8Array | undefined> {
				const k = bytesToB64url(coord);
				this.fetchCalls.set(k, (this.fetchCalls.get(k) ?? 0) + 1);
				return certs.get(k);
			}
		}
		const source = new PerCoordSource();
		const router = createMembershipSourceRouter({ committed: source, fret: source });
		const v = createMembershipVerifier({ signer, router, anchor: constAnchor('unknown'), maxCoords: 4 });
		const keyA = bytesToB64url(coordA);

		// coordA is self-published → trust-locked and cached; its message verifies straight from cache (no source).
		v.cache(buildCertOver({ coord: coordA, epoch: EPOCH, members: MEMBERS }));
		expect(await v.verifyMessage(MESSAGE_SIGNERS, coordA, 2, PAYLOAD, SIG)).to.equal('verified');
		expect(source.currentCalls.get(keyA) ?? 0, 'coordA served from the trusted cache — no source call').to.equal(0);

		// Flood four distinct attacker coords (cap = 4). Each TOFU-caches, LRU-evicting the coldest — coordA.
		for (const c of floodCoords) {
			expect(await v.verifyMessage(MESSAGE_SIGNERS, c, 2, PAYLOAD, SIG), `flood coord ${bytesToB64url(c)}`).to.equal('verified');
		}

		// coordA's trusted entry was evicted under the flood: verifying it now MISSES the cache and must consult
		// the source (re-TOFU) — proving byCoord is bounded, and that the trust lock is best-effort under pressure.
		expect(await v.verifyMessage(MESSAGE_SIGNERS, coordA, 2, PAYLOAD, SIG)).to.equal('verified');
		expect(source.currentCalls.get(keyA) ?? 0, 'coordA was evicted → forced back to the source').to.equal(1);
	});
});
