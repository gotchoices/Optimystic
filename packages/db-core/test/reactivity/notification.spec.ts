import { expect } from 'chai';
import {
	buildNotificationV1,
	sigDigest,
	dedupeKey,
	type OriginationContext,
} from '../../src/reactivity/index.js';
import type { CollectionChangeEvent, CommitCert } from '../../src/transactor/change-notifier.js';
import { bytesToB64url, b64urlToBytes } from '../../src/cohort-topic/wire/codec.js';

const event: CollectionChangeEvent = {
	collectionId: bytesToB64url(new Uint8Array([1, 2, 3, 4])),
	blockIds: [bytesToB64url(new Uint8Array([5, 6]))],
	actionId: 'action-abc-123',
	rev: 7,
};

const thresholdSig = new Uint8Array([10, 20, 30, 40, 50]);
const signedPayload = new TextEncoder().encode('commit-hash-abc:approve');
const cert: CommitCert = {
	thresholdSig,
	signers: ['12D3KooWAlice', '12D3KooWBob'],
	minSigs: 2,
	signedPayload,
};

const baseCtx = (over: Partial<OriginationContext> = {}): OriginationContext => ({
	tailId: bytesToB64url(new Uint8Array([9, 9, 9])),
	timestamp: 1_700_000_000_000,
	deltaMaxBytes: 4096,
	...over,
});

describe('reactivity notification origination', () => {
	it('reuses the commit cert threshold signature bit-for-bit (never re-signs)', () => {
		const n = buildNotificationV1(event, cert, baseCtx());
		expect([...b64urlToBytes(n.sig)]).to.deep.equal([...thresholdSig]);
	});

	it('sets digest from the commit-vote signed payload (the bytes thresholdSig was computed over)', () => {
		const n = buildNotificationV1(event, cert, baseCtx());
		expect(n.digest).to.equal(bytesToB64url(signedPayload));
		// b64urlToBytes(digest) recovers the exact signed image a subscriber threshold-verifies over.
		expect([...b64urlToBytes(n.digest)]).to.deep.equal([...signedPayload]);
	});

	it('derives digest from signedPayload independently of event.actionId', () => {
		const n = buildNotificationV1({ ...event, actionId: 'a-totally-different-action-id' }, cert, baseCtx());
		// digest tracks the cert preimage, not the transaction id — the two are distinct values.
		expect(n.digest).to.equal(bytesToB64url(signedPayload));
		expect(n.digest).to.not.equal(bytesToB64url(new TextEncoder().encode('a-totally-different-action-id')));
	});

	it('carries collectionId, revision, and tailId from the event/context', () => {
		const n = buildNotificationV1(event, cert, baseCtx());
		expect(n.collectionId).to.equal(event.collectionId);
		expect(n.revision).to.equal(event.rev);
		expect(n.tailId).to.equal(baseCtx().tailId);
	});

	it('encodes signers via the supplied encodeSigner seam', () => {
		const n = buildNotificationV1(event, cert, baseCtx({ encodeSigner: (s) => bytesToB64url(new TextEncoder().encode(s)) }));
		expect(n.signers).to.deep.equal(cert.signers.map((s) => bytesToB64url(new TextEncoder().encode(s))));
	});

	it('passes signers through unchanged when no encodeSigner is supplied', () => {
		const n = buildNotificationV1(event, cert, baseCtx());
		expect(n.signers).to.deep.equal([...cert.signers]);
	});

	it('includes a delta within the budget', () => {
		const delta = new Uint8Array([1, 2, 3]);
		const n = buildNotificationV1(event, cert, baseCtx({ delta, deltaMaxBytes: 16 }));
		expect(n.delta).to.equal(bytesToB64url(delta));
	});

	it('omits delta when delta_max is 0 (Edge / collection declines deltas)', () => {
		const delta = new Uint8Array([1, 2, 3]);
		const n = buildNotificationV1(event, cert, baseCtx({ delta, deltaMaxBytes: 0 }));
		expect(n).to.not.have.property('delta');
	});

	it('omits a delta that exceeds the budget', () => {
		const delta = new Uint8Array([1, 2, 3, 4, 5]);
		const n = buildNotificationV1(event, cert, baseCtx({ delta, deltaMaxBytes: 4 }));
		expect(n).to.not.have.property('delta');
	});

	it('embeds a rotation hint when supplied', () => {
		const rotationHint = { newTailId: bytesToB64url(new Uint8Array([7, 7])), effectiveAtRevision: 8 };
		const n = buildNotificationV1(event, cert, baseCtx({ rotationHint }));
		expect(n.rotationHint).to.deep.equal(rotationHint);
	});

	describe('dedupe key', () => {
		it('sigDigest is deterministic and compact', () => {
			expect(sigDigest('AAAA')).to.equal(sigDigest('AAAA'));
			expect(sigDigest('AAAA')).to.not.equal(sigDigest('BBBB'));
		});

		it('dedupeKey distinguishes distinct sigs at the same revision (partition-merge case)', () => {
			expect(dedupeKey(5, 'AAAA')).to.equal(dedupeKey(5, 'AAAA'));
			expect(dedupeKey(5, 'AAAA')).to.not.equal(dedupeKey(5, 'BBBB'));
			expect(dedupeKey(5, 'AAAA')).to.not.equal(dedupeKey(6, 'AAAA'));
		});
	});
});
