import { expect } from 'chai';
import {
	encodeSubscribeAppPayload,
	decodeSubscribeAppPayload,
	encodeNotificationV1,
	decodeNotificationV1,
	DEFAULT_MAX_SUBSCRIBE_PAYLOAD_BYTES,
} from '../../src/reactivity/index.js';
import type { SubscribeAppPayloadV1, NotificationV1 } from '../../src/reactivity/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import { CohortWireError } from '../../src/cohort-topic/wire/validate.js';

/** Deterministic pseudo-random bytes (no Math.random — keeps the test reproducible). */
function seededBytes(len: number, seed: number): Uint8Array {
	const out = new Uint8Array(len);
	let s = (seed * 2654435761) >>> 0;
	for (let i = 0; i < len; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		out[i] = (s >>> 24) & 0xff;
	}
	return out;
}

const b64 = (len: number, seed: number): string => bytesToB64url(seededBytes(len, seed));

const sampleSubscribe = (): SubscribeAppPayloadV1 => ({
	kind: 'reactivity',
	collectionId: b64(32, 1),
	tailIdAtAttach: b64(32, 2),
	lastKnownRev: 0,
	deltaMaxBytes: 4096,
});

const sampleNotification = (): NotificationV1 => ({
	v: 1,
	collectionId: b64(32, 3),
	tailId: b64(32, 4),
	revision: 1042,
	digest: b64(32, 5),
	delta: b64(128, 6),
	timestamp: 1_700_000_000_000,
	sig: b64(96, 7),
	signers: [b64(20, 8), b64(20, 9)],
	rotationHint: { newTailId: b64(32, 10), effectiveAtRevision: 1100 },
});

describe('reactivity wire', () => {
	describe('SubscribeAppPayloadV1 (opaque RegisterV1.appPayload bytes)', () => {
		it('round-trips a subscribe payload losslessly', () => {
			const decoded = decodeSubscribeAppPayload(encodeSubscribeAppPayload(sampleSubscribe()));
			expect(decoded).to.deep.equal(sampleSubscribe());
		});

		it('preserves lastKnownRev = 0 (fresh subscribe) and deltaMaxBytes = 0 (Edge decline)', () => {
			const edge: SubscribeAppPayloadV1 = { ...sampleSubscribe(), lastKnownRev: 0, deltaMaxBytes: 0 };
			const decoded = decodeSubscribeAppPayload(encodeSubscribeAppPayload(edge));
			expect(decoded.lastKnownRev).to.equal(0);
			expect(decoded.deltaMaxBytes).to.equal(0);
		});

		it('rejects a wrong kind discriminant', () => {
			const bad = { ...sampleSubscribe(), kind: 'match-provider' };
			expect(() => decodeSubscribeAppPayload(new TextEncoder().encode(JSON.stringify(bad)))).to.throw(CohortWireError, /kind/);
		});

		it('rejects a negative lastKnownRev', () => {
			const bad = { ...sampleSubscribe(), lastKnownRev: -1 };
			expect(() => decodeSubscribeAppPayload(new TextEncoder().encode(JSON.stringify(bad)))).to.throw(CohortWireError, /lastKnownRev/);
		});

		it('rejects a non-base64url collectionId', () => {
			const bad = { ...sampleSubscribe(), collectionId: 'not valid base64url!!' };
			expect(() => decodeSubscribeAppPayload(new TextEncoder().encode(JSON.stringify(bad)))).to.throw(CohortWireError, /base64url/);
		});

		it('rejects an oversized subscribe payload', () => {
			const bytes = encodeSubscribeAppPayload(sampleSubscribe());
			expect(() => decodeSubscribeAppPayload(bytes, 8)).to.throw(CohortWireError, /exceeds max/);
		});

		it('rejects non-JSON payload bytes', () => {
			expect(() => decodeSubscribeAppPayload(new TextEncoder().encode('not json'))).to.throw(CohortWireError, /JSON/);
		});

		it('has a non-trivial default app-payload ceiling', () => {
			expect(DEFAULT_MAX_SUBSCRIBE_PAYLOAD_BYTES).to.be.greaterThan(1024);
		});
	});

	describe('NotificationV1 (length-framed)', () => {
		it('round-trips a notification losslessly', () => {
			expect(decodeNotificationV1(encodeNotificationV1(sampleNotification()))).to.deep.equal(sampleNotification());
		});

		it('round-trips a notification without optional delta / rotationHint', () => {
			const { delta: _d, rotationHint: _r, ...minimal } = sampleNotification();
			const decoded = decodeNotificationV1(encodeNotificationV1(minimal));
			expect(decoded).to.not.have.property('delta');
			expect(decoded).to.not.have.property('rotationHint');
			expect(decoded).to.deep.equal(minimal);
		});

		it('keeps sig / signers byte-stable across re-encode (encode→decode→encode)', () => {
			const once = encodeNotificationV1(sampleNotification());
			const twice = encodeNotificationV1(decodeNotificationV1(once));
			expect([...twice]).to.deep.equal([...once]);
		});

		it('rejects v !== 1', () => {
			const bad = { ...sampleNotification(), v: 2 };
			expect(() => encodeNotificationV1(bad as unknown as NotificationV1)).to.throw(CohortWireError, /v === 1/);
		});

		it('rejects a negative revision', () => {
			const bad = { ...sampleNotification(), revision: -1 };
			expect(() => encodeNotificationV1(bad as NotificationV1)).to.throw(CohortWireError, /revision/);
		});

		it('rejects a non-base64url sig', () => {
			const bad = { ...sampleNotification(), sig: '!!nope!!' };
			expect(() => encodeNotificationV1(bad as NotificationV1)).to.throw(CohortWireError, /base64url/);
		});

		it('rejects a signers entry that is not base64url', () => {
			const bad = { ...sampleNotification(), signers: ['!!bad!!'] };
			expect(() => encodeNotificationV1(bad as NotificationV1)).to.throw(CohortWireError, /base64url/);
		});

		it('rejects a non-array signers field', () => {
			const bad = { ...sampleNotification(), signers: 'nope' };
			expect(() => encodeNotificationV1(bad as unknown as NotificationV1)).to.throw(CohortWireError, /signers/);
		});

		it('rejects a frame whose body exceeds the supplied ceiling', () => {
			expect(() => encodeNotificationV1(sampleNotification(), 16)).to.throw(CohortWireError, /max_message_bytes/);
		});
	});
});
