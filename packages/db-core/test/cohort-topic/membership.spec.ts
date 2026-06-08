import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCohortSigner } from '../../src/cohort-topic/sig/threshold.js';
import { membershipCertSigningPayload } from '../../src/cohort-topic/sig/payloads.js';
import { createMembershipVerifier } from '../../src/cohort-topic/membership/verifier.js';
import { createMembershipSourceRouter } from '../../src/cohort-topic/membership/source.js';
import { createMembershipCertPublisher } from '../../src/cohort-topic/membership/publisher.js';
import { bytesToB64url, encodeCohortMessage, decodeMembershipCertV1 } from '../../src/cohort-topic/wire/codec.js';
import { bytesEqual } from '../../src/cohort-topic/registration/bytes.js';
import type { ICohortThresholdCrypto, IMembershipSource, RingCoord } from '../../src/cohort-topic/ports.js';
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
		const source = new MockSource(undefined, encodeCohortMessage(GOOD));
		const { v } = verifier(source);
		v.cache(buildCert(STALE_MEMBERS)); // cached cert lacks the message signers
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('verified');
		expect(source.fetchCalls, 'exactly one refetch').to.equal(1);
		expect(source.currentCalls, 'current() skipped when a cert is already cached').to.equal(0);
	});

	it('returns untrusted when the refetched cert still does not verify (no second fetch)', async () => {
		const source = new MockSource(undefined, encodeCohortMessage(buildCert(STALE_MEMBERS)));
		const { v } = verifier(source);
		v.cache(buildCert(STALE_MEMBERS));
		const r = await v.verifyMessage(MESSAGE_SIGNERS, COORD, 2, PAYLOAD, SIG);
		expect(r).to.equal('untrusted');
		expect(source.fetchCalls, 'still exactly one refetch').to.equal(1);
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

	function snapshot(members: Uint8Array[], stabilizedAt = 1_000) {
		return { coord: COORD, cohortEpoch: EPOCH, members, stabilizedAt };
	}

	it('publishes a signed cert at first stabilization', async () => {
		const { published, sink } = capturingSink();
		const pub = createMembershipCertPublisher({ signer, sink, minSigs: 2 });
		const cert = await pub.onStabilized(snapshot([mkMember(0), mkMember(1), mkMember(2), mkMember(3)]), 1_000);
		expect(cert, 'cert returned').to.not.be.undefined;
		expect(published).to.have.length(1);
		expect(published[0]!.signers.length).to.be.gte(2);
		// Members are sorted ascending in the cert.
		expect(published[0]!.members).to.deep.equal([mkMember(0), mkMember(1), mkMember(2), mkMember(3)].map(bytesToB64url));
	});

	it('republishes when the first k − x members change, not when only the tail changes', async () => {
		const { published, sink } = capturingSink();
		const pub = createMembershipCertPublisher({ signer, sink, minSigs: 2 });
		await pub.onStabilized(snapshot([mkMember(0), mkMember(1), mkMember(2), mkMember(3)]), 1_000);
		expect(published).to.have.length(1);

		// Only positions 2,3 (beyond the first k − x = 2) change → no republish.
		const tail = await pub.onStabilized(snapshot([mkMember(0), mkMember(1), mkMember(20), mkMember(21)]), 1_100);
		expect(tail, 'tail-only change is not republished').to.be.undefined;
		expect(published).to.have.length(1);

		// The first k − x set changes → republish.
		const head = await pub.onStabilized(snapshot([mkMember(1), mkMember(2), mkMember(3), mkMember(5)]), 1_200);
		expect(head, 'first k − x change republishes').to.not.be.undefined;
		expect(published).to.have.length(2);
	});

	it('refreshes on tick only after T_membership_refresh elapses', async () => {
		const { published, sink } = capturingSink();
		const pub = createMembershipCertPublisher({ signer, sink, minSigs: 2, refreshMs: 1_000 });
		const members = [mkMember(0), mkMember(1), mkMember(2), mkMember(3)];
		await pub.onStabilized(snapshot(members), 10_000);
		expect(published).to.have.length(1);

		expect(await pub.tick(snapshot(members), 10_500), 'too soon').to.be.undefined;
		expect(published).to.have.length(1);

		expect(await pub.tick(snapshot(members), 11_000), 'refresh interval elapsed').to.not.be.undefined;
		expect(published).to.have.length(2);
	});
});
