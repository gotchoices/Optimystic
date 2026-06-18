import { expect } from 'chai';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
	backfillSigningPayload,
	resumeSigningPayload,
	encodeRecoverRequestV1,
	decodeRecoverRequestV1,
	encodeRecoverReplyV1,
	decodeRecoverReplyV1,
	RollingCheckpoint,
	type BackfillSignable,
	type ResumeSignable,
	type BackfillV1,
	type ResumeV1,
	type RecoverRequestV1,
	type RecoverReplyV1,
	type RotationRedirectV1,
	type NotificationV1,
} from '../../src/reactivity/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import { CohortWireError } from '../../src/cohort-topic/wire/validate.js';

const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));
const TAIL = bytesToB64url(new Uint8Array([2, 2, 2, 2]));
const COORD = bytesToB64url(new Uint8Array([5, 5, 5, 5]));
const SIG = bytesToB64url(new Uint8Array([9, 9]));
const TS = 1_700_000_000_500;

const backfillSignable: BackfillSignable = { v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: TS };
const resumeSignable: ResumeSignable = { v: 1, collectionId: COLLECTION, fromRevision: 11, latestKnownTailId: TAIL, subscriberCoord: COORD, timestamp: TS };

const backfill: BackfillV1 = { ...backfillSignable, signature: SIG };
const resume: ResumeV1 = { ...resumeSignable, signature: SIG };

const NEW_TAIL = bytesToB64url(new Uint8Array([6, 6, 6, 6]));
const NEW_TOPIC = bytesToB64url(new Uint8Array([7, 7, 7, 7]));
const rotated: RotationRedirectV1 = { v: 1, result: 'rotated', newTailId: NEW_TAIL, newTopicId: NEW_TOPIC, effectiveAtRevision: 5401 };

function note(revision: number): NotificationV1 {
	return {
		v: 1,
		collectionId: COLLECTION,
		tailId: TAIL,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [bytesToB64url(new Uint8Array([8]))],
	};
}

describe('reactivity recover — signing payloads', () => {
	it('backfillSigningPayload is byte-for-byte deterministic for a fixed body', () => {
		expect([...backfillSigningPayload(backfillSignable)]).to.deep.equal([...backfillSigningPayload({ ...backfillSignable })]);
	});

	it('resumeSigningPayload is byte-for-byte deterministic for a fixed body', () => {
		expect([...resumeSigningPayload(resumeSignable)]).to.deep.equal([...resumeSigningPayload({ ...resumeSignable })]);
	});

	it('a change to any non-signature backfill field changes the bytes', () => {
		const base = bytesToB64url(backfillSigningPayload(backfillSignable));
		expect(bytesToB64url(backfillSigningPayload({ ...backfillSignable, fromRevision: 12 }))).to.not.equal(base);
		expect(bytesToB64url(backfillSigningPayload({ ...backfillSignable, toRevision: 15 }))).to.not.equal(base);
		expect(bytesToB64url(backfillSigningPayload({ ...backfillSignable, timestamp: TS + 1 }))).to.not.equal(base);
		expect(bytesToB64url(backfillSigningPayload({ ...backfillSignable, collectionId: TAIL }))).to.not.equal(base);
	});

	it('a change to any non-signature resume field changes the bytes', () => {
		const base = bytesToB64url(resumeSigningPayload(resumeSignable));
		expect(bytesToB64url(resumeSigningPayload({ ...resumeSignable, fromRevision: 12 }))).to.not.equal(base);
		expect(bytesToB64url(resumeSigningPayload({ ...resumeSignable, latestKnownTailId: COORD }))).to.not.equal(base);
		expect(bytesToB64url(resumeSigningPayload({ ...resumeSignable, subscriberCoord: TAIL }))).to.not.equal(base);
		expect(bytesToB64url(resumeSigningPayload({ ...resumeSignable, timestamp: TS + 1 }))).to.not.equal(base);
	});

	it('backfill and resume images with otherwise-identical shared fields never collide (the type tag differs)', () => {
		// Same v / collectionId / fromRevision / timestamp on both — only the type tag (and trailing shape) differ.
		const b = backfillSigningPayload({ v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 11, timestamp: TS });
		const r = resumeSigningPayload({ v: 1, collectionId: COLLECTION, fromRevision: 11, latestKnownTailId: COLLECTION, subscriberCoord: COLLECTION, timestamp: TS });
		expect(bytesToB64url(b)).to.not.equal(bytesToB64url(r));
	});

	it('round-trips a real Ed25519 signature and rejects a mutated field', () => {
		const priv = new Uint8Array(32).fill(7); // fixed seed → deterministic test key
		const pub = ed25519.getPublicKey(priv);
		const payload = backfillSigningPayload(backfillSignable);
		const sig = ed25519.sign(payload, priv);
		expect(ed25519.verify(sig, payload, pub)).to.equal(true);
		// The same signature must NOT verify over a mutated body (the forged-fresh-timestamp attack).
		const mutated = backfillSigningPayload({ ...backfillSignable, timestamp: TS + 1 });
		expect(ed25519.verify(sig, mutated, pub)).to.equal(false);
	});
});

describe('reactivity recover — RecoverRequestV1 / RecoverReplyV1 envelope', () => {
	it('round-trips a backfill request', () => {
		const req: RecoverRequestV1 = { v: 1, kind: 'backfill', backfill };
		expect(decodeRecoverRequestV1(encodeRecoverRequestV1(req))).to.deep.equal(req);
	});

	it('round-trips a resume request', () => {
		const req: RecoverRequestV1 = { v: 1, kind: 'resume', resume };
		expect(decodeRecoverRequestV1(encodeRecoverRequestV1(req))).to.deep.equal(req);
	});

	it('round-trips a backfill reply', () => {
		const reply: RecoverReplyV1 = { v: 1, kind: 'backfill', backfillReply: { v: 1, entries: [note(11), note(12)], available: { fromRevision: 10, toRevision: 15 } } };
		expect(decodeRecoverReplyV1(encodeRecoverReplyV1(reply))).to.deep.equal(reply);
	});

	it('round-trips a resume reply', () => {
		const reply: RecoverReplyV1 = { v: 1, kind: 'resume', resumeReply: { v: 1, result: 'backfill', entries: [note(18), note(19)], currentRevision: 19 } };
		expect(decodeRecoverReplyV1(encodeRecoverReplyV1(reply))).to.deep.equal(reply);
	});

	it('round-trips a checkpoint_window resume reply (the envelope carries the summary + recentEntries)', () => {
		// The one inner resume variant whose extra fields (`checkpoint`, `recentEntries`) ride the envelope;
		// the others only carry `entries`/scalars. Pins that the recover wrapper does not drop them.
		const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 8 });
		for (let rev = 9; rev <= 16; rev++) cp.retire({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
		const reply: RecoverReplyV1 = { v: 1, kind: 'resume', resumeReply: { v: 1, result: 'checkpoint_window', checkpoint: cp.summary()!, recentEntries: [note(17), note(18)], currentRevision: 18 } };
		expect(decodeRecoverReplyV1(encodeRecoverReplyV1(reply))).to.deep.equal(reply);
	});

	it('rejects a kind: "backfill" frame carrying a resume body', () => {
		const bad = { v: 1, kind: 'backfill', resume };
		expect(() => encodeRecoverRequestV1(bad as unknown as RecoverRequestV1)).to.throw(CohortWireError, /does not match/);
	});

	it('rejects a frame whose declared kind has no matching body', () => {
		const bad = { v: 1, kind: 'resume' }; // neither branch present
		expect(() => encodeRecoverRequestV1(bad as unknown as RecoverRequestV1)).to.throw(CohortWireError);
	});

	it('rejects an unknown kind', () => {
		const bad = { v: 1, kind: 'rotate', backfill };
		expect(() => encodeRecoverRequestV1(bad as unknown as RecoverRequestV1)).to.throw(CohortWireError, /kind/);
	});

	it('rejects a reply carrying both branches', () => {
		const bad = { v: 1, kind: 'backfill', backfillReply: { v: 1, entries: [], available: { fromRevision: 0, toRevision: 0 } }, resumeReply: { v: 1, result: 'out_of_window', currentTailId: TAIL, currentRevision: 1 } };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /does not match/);
	});

	it('rejects a reply whose body is the wrong branch for its declared kind', () => {
		// Mirror of the request-side "kind carrying the wrong body": a `kind: "resume"` reply must not carry
		// a `backfillReply` (and the absent `resumeReply` must not be silently tolerated).
		const bad = { v: 1, kind: 'resume', backfillReply: { v: 1, entries: [], available: { fromRevision: 0, toRevision: 0 } } };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /does not match/);
	});

	it('rejects a reply whose declared kind has no matching body', () => {
		const bad = { v: 1, kind: 'backfill' }; // neither branch present
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError);
	});

	it('rejects a reply with an unknown kind', () => {
		const bad = { v: 1, kind: 'rotate', backfillReply: { v: 1, entries: [], available: { fromRevision: 0, toRevision: 0 } } };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /kind/);
	});

	it('round-trips a rotated reply (the RotationRedirectV1 rides the recover reply as kind "rotated")', () => {
		const reply: RecoverReplyV1 = { v: 1, kind: 'rotated', rotated };
		expect(decodeRecoverReplyV1(encodeRecoverReplyV1(reply))).to.deep.equal(reply);
	});

	it('rejects a rotated reply carrying a stray resumeReply', () => {
		const bad = { v: 1, kind: 'rotated', rotated, resumeReply: { v: 1, result: 'out_of_window', currentTailId: TAIL, currentRevision: 1 } };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /does not match/);
	});

	it('rejects a rotated reply carrying a stray backfillReply', () => {
		const bad = { v: 1, kind: 'rotated', rotated, backfillReply: { v: 1, entries: [], available: { fromRevision: 0, toRevision: 0 } } };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /does not match/);
	});

	it('rejects a resume reply carrying a stray rotated body', () => {
		const bad = { v: 1, kind: 'resume', resumeReply: { v: 1, result: 'out_of_window', currentTailId: TAIL, currentRevision: 1 }, rotated };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /does not match/);
	});

	it('rejects a backfill reply carrying a stray rotated body', () => {
		const bad = { v: 1, kind: 'backfill', backfillReply: { v: 1, entries: [], available: { fromRevision: 0, toRevision: 0 } }, rotated };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /does not match/);
	});

	it('rejects a rotated reply with no rotated body', () => {
		const bad = { v: 1, kind: 'rotated' }; // the declared kind has no matching body
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError);
	});

	it('rejects a rotated reply with a malformed newTopicId', () => {
		const bad = { v: 1, kind: 'rotated', rotated: { ...rotated, newTopicId: '@@@@' } };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /newTopicId/);
	});

	it('rejects a rotated reply with a negative effectiveAtRevision', () => {
		const bad = { v: 1, kind: 'rotated', rotated: { ...rotated, effectiveAtRevision: -1 } };
		expect(() => encodeRecoverReplyV1(bad as unknown as RecoverReplyV1)).to.throw(CohortWireError, /effectiveAtRevision/);
	});

	it('respects the maxMessageBytes bound like the sibling codecs', () => {
		const req: RecoverRequestV1 = { v: 1, kind: 'backfill', backfill };
		expect(() => encodeRecoverRequestV1(req, 8)).to.throw(CohortWireError, /max_message_bytes/);
	});
});
