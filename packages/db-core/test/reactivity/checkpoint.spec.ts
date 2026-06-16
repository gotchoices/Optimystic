import { expect } from 'chai';
import {
	RollingCheckpoint,
	defaultDigestFold,
	defaultDeltaCoalesce,
	verifyCheckpointEndpoints,
	validateCheckpointSummary,
	createNotificationVerifier,
	reactivityTopicId,
	type CheckpointSummary,
	type NotificationV1,
	type RevisionEntry,
} from '../../src/reactivity/index.js';
import { createMembershipVerifier } from '../../src/cohort-topic/membership/verifier.js';
import { createMembershipSourceRouter } from '../../src/cohort-topic/membership/source.js';
import { createCohortSigner } from '../../src/cohort-topic/sig/threshold.js';
import { createTierAddressing } from '../../src/cohort-topic/addressing.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { Tier } from '../../src/cohort-topic/tiers.js';
import { bytesToB64url, b64urlToBytes } from '../../src/cohort-topic/wire/codec.js';
import { CohortWireError } from '../../src/cohort-topic/wire/validate.js';
import type { ICohortThresholdCrypto, IMembershipSource } from '../../src/cohort-topic/ports.js';
import type { MembershipCertV1 } from '../../src/cohort-topic/wire/types.js';

const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));
const TAIL = bytesToB64url(new Uint8Array([2, 2, 2, 2]));
const SIGNER_A = bytesToB64url(new Uint8Array([0xa1, 0xa1]));
const SIGNER_B = bytesToB64url(new Uint8Array([0xb2, 0xb2]));

function note(revision: number, over: Partial<NotificationV1> = {}): NotificationV1 {
	return {
		v: 1,
		collectionId: COLLECTION,
		tailId: TAIL,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [SIGNER_A, SIGNER_B],
		...over,
	};
}

const entry = (revision: number, over: Partial<NotificationV1> = {}): RevisionEntry => ({ revision, payload: note(revision, over), receivedAt: 1000 + revision });

/** A verifier whose raw crypto always passes, so the verdict turns purely on the signer-subset check. */
function realishVerifier(members: string[], minSigs: number) {
	const crypto: ICohortThresholdCrypto = { assemble: () => Promise.reject(new Error('verify-only')), verify: () => true };
	const empty: IMembershipSource = { current: () => Promise.resolve(undefined), fetch: () => Promise.resolve(undefined) };
	const expectedCoord = createTierAddressing(createRingHash()).coord0(reactivityTopicId(b64urlToBytes(TAIL)));
	const cert: MembershipCertV1 = {
		v: 1,
		cohortCoord: bytesToB64url(expectedCoord),
		cohortEpoch: bytesToB64url(new Uint8Array([7])),
		members,
		stabilizedAt: 1_700_000_000_000,
		thresholdSig: bytesToB64url(new Uint8Array([0])),
		signers: members.slice(0, minSigs),
	};
	const mv = createMembershipVerifier({ signer: createCohortSigner(crypto, minSigs), router: createMembershipSourceRouter({ committed: empty, fret: empty }), minSigs });
	mv.cache(cert);
	return createNotificationVerifier({ verifier: mv, tier: Tier.T3 });
}

describe('reactivity rolling checkpoint', () => {
	it('rolls forward as revisions retire and trims to its span (the window below the ring)', () => {
		const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 4 });
		for (let rev = 1; rev <= 7; rev++) {
			cp.retire(entry(rev));
		}
		// Span 4 keeps only the highest 4 retired revisions.
		expect(cp.size).to.equal(4);
		expect(cp.fromRevision).to.equal(4);
		expect(cp.toRevision).to.equal(7);
		expect(cp.covers(4)).to.equal(true);
		expect(cp.covers(7)).to.equal(true);
		expect(cp.covers(3)).to.equal(false);
		expect(cp.covers(8)).to.equal(false);
	});

	it('summarizes the range with bracketing endpoints and a folded digest', () => {
		const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 8 });
		for (let rev = 10; rev <= 13; rev++) {
			cp.retire(entry(rev));
		}
		const summary = cp.summary()!;
		expect(summary.fromRevision).to.equal(10);
		expect(summary.toRevision).to.equal(13);
		expect(summary.bracketingEntries[0].revision).to.equal(10);
		expect(summary.bracketingEntries[1].revision).to.equal(13);
		// mergedDigest is the deterministic fold over the per-revision digests.
		const expected = defaultDigestFold()([10, 11, 12, 13].map((r) => b64urlToBytes(note(r).digest)));
		expect(summary.mergedDigest).to.equal(bytesToB64url(expected));
	});

	it('returns undefined for an empty checkpoint', () => {
		expect(new RollingCheckpoint({ collectionId: COLLECTION }).summary()).to.equal(undefined);
	});

	it('ignores a retired entry from a different collection', () => {
		const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 4 });
		cp.retire(entry(10, { collectionId: bytesToB64url(new Uint8Array([9])) }));
		expect(cp.size).to.equal(0);
	});

	describe('mergedDelta vs delta_max (resolved → omit when oversize, never split)', () => {
		const withDelta = (revision: number, bytes: number): RevisionEntry => entry(revision, { delta: bytesToB64url(new Uint8Array(bytes)) });

		it('omits the delta entirely when delta_max is 0 (default)', () => {
			const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 4 });
			cp.retire(withDelta(10, 8));
			expect(cp.summary()!.mergedDelta).to.equal(undefined);
		});

		it('emits the coalesced delta when it fits within delta_max', () => {
			const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 4, deltaMaxBytes: 16 });
			cp.retire(withDelta(10, 4));
			cp.retire(withDelta(11, 4));
			const merged = cp.summary()!.mergedDelta;
			expect(merged).to.be.a('string');
			expect(b64urlToBytes(merged!).length).to.equal(8); // 4 + 4 concatenated
		});

		it('omits the delta when the coalesced size would exceed delta_max', () => {
			const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 4, deltaMaxBytes: 6 });
			cp.retire(withDelta(10, 4));
			cp.retire(withDelta(11, 4)); // 8 > 6 → omit
			expect(cp.summary()!.mergedDelta).to.equal(undefined);
		});
	});
});

describe('reactivity checkpoint digest fold', () => {
	it('is deterministic and order-dependent', () => {
		const a = new Uint8Array([1, 2]);
		const b = new Uint8Array([3, 4]);
		const fold = defaultDigestFold();
		expect([...fold([a, b])]).to.deep.equal([...fold([a, b])]);
		expect([...fold([a, b])]).to.not.deep.equal([...fold([b, a])]);
	});

	it('default delta coalesce concatenates in order', () => {
		const out = defaultDeltaCoalesce([new Uint8Array([1, 2]), new Uint8Array([3])]);
		expect([...out]).to.deep.equal([1, 2, 3]);
	});
});

describe('reactivity checkpoint endpoint verification', () => {
	function summaryWith(from: NotificationV1, to: NotificationV1): CheckpointSummary {
		return { collectionId: COLLECTION, fromRevision: from.revision, toRevision: to.revision, mergedDigest: bytesToB64url(new Uint8Array([1])), bracketingEntries: [from, to] };
	}

	it('verifies when both bracketing endpoints are real committed revisions', async () => {
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const summary = summaryWith(note(100), note(200));
		expect(await verifyCheckpointEndpoints(summary, verifier)).to.equal('verified');
	});

	it('rejects a forged endpoint whose signers are not in the cohort membership', async () => {
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const forged = note(200, { signers: [bytesToB64url(new Uint8Array([0xde, 0xad])), bytesToB64url(new Uint8Array([0xbe, 0xef]))] });
		const summary = summaryWith(note(100), forged);
		expect(await verifyCheckpointEndpoints(summary, verifier)).to.equal('untrusted');
	});

	it('rejects when a bracketing endpoint revision does not match the summarized bound', async () => {
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		// The summary claims [100,200] but its `to` endpoint is actually revision 199 — a structural forgery.
		const summary: CheckpointSummary = { collectionId: COLLECTION, fromRevision: 100, toRevision: 200, mergedDigest: bytesToB64url(new Uint8Array([1])), bracketingEntries: [note(100), note(199)] };
		expect(await verifyCheckpointEndpoints(summary, verifier)).to.equal('untrusted');
	});
});

describe('reactivity checkpoint summary validation', () => {
	it('round-trips a structurally valid summary', () => {
		const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 8 });
		for (let rev = 10; rev <= 13; rev++) cp.retire(entry(rev));
		const summary = cp.summary()!;
		expect(validateCheckpointSummary(JSON.parse(JSON.stringify(summary)))).to.deep.equal(summary);
	});

	it('rejects a summary whose bracketingEntries is not length 2', () => {
		const summary = { collectionId: COLLECTION, fromRevision: 10, toRevision: 13, mergedDigest: bytesToB64url(new Uint8Array([1])), bracketingEntries: [note(10)] };
		expect(() => validateCheckpointSummary(summary)).to.throw(CohortWireError, /bracketingEntries/);
	});
});
