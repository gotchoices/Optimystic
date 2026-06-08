import { expect } from 'chai';
import {
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	decodeCohortMessage,
	decodeRegisterV1,
	decodeRegisterReplyV1,
	decodeRenewV1,
	decodeRenewReplyV1,
	decodePromotionNoticeV1,
	decodeDemotionNoticeV1,
	decodeCohortGossipV1,
	decodeMembershipCertV1,
	CohortWireError,
	DEFAULT_MAX_MESSAGE_BYTES,
} from '../../src/cohort-topic/wire/index.js';
import type {
	RegisterV1,
	RegisterReplyV1,
	RenewV1,
	RenewReplyV1,
	PromotionNoticeV1,
	DemotionNoticeV1,
	CohortGossipV1,
	MembershipCertV1,
} from '../../src/cohort-topic/wire/index.js';

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

const sampleRegister = (): RegisterV1 => ({
	v: 1,
	topicId: b64(32, 1),
	tier: 2,
	treeTier: 3,
	participantCoord: b64(32, 2),
	ttl: 90000,
	bootstrap: true,
	appPayload: b64(48, 3),
	timestamp: 1_700_000_000_000,
	correlationId: b64(16, 4),
	signature: b64(64, 5),
});

const sampleRegisterReply = (): RegisterReplyV1 => ({
	v: 1,
	result: 'accepted',
	primary: 'peer-primary',
	backups: ['peer-b1', 'peer-b2'],
	cohortEpoch: b64(32, 6),
	cohortMembers: ['peer-a', 'peer-b', 'peer-c'],
	topicTraffic: {
		windowSeconds: 60,
		arrivalsPerMin: 12,
		queriesPerMin: 4,
		directParticipants: 40,
		childCohortCount: 2,
	},
});

const sampleRenew = (): RenewV1 => ({
	v: 1,
	topicId: b64(32, 7),
	participantId: 'peer-x',
	correlationId: b64(16, 8),
	timestamp: 1_700_000_001_000,
	signature: b64(64, 9),
});

const sampleRenewReply = (): RenewReplyV1 => ({
	v: 1,
	result: 'primary_moved',
	newPrimary: 'peer-new',
	newBackups: ['peer-nb'],
	cohortEpoch: b64(32, 10),
});

const samplePromotion = (): PromotionNoticeV1 => ({
	v: 1,
	topicId: b64(32, 11),
	fromTier: 1,
	toTier: 2,
	effectiveAt: 1_700_000_002_000,
	thresholdSig: b64(64, 12),
	signers: ['peer-1', 'peer-2', 'peer-3'],
	cohortEpoch: b64(32, 13),
});

const sampleDemotion = (): DemotionNoticeV1 => ({
	v: 1,
	topicId: b64(32, 14),
	tier: 2,
	parentCohortCoord: b64(32, 15),
	effectiveAt: 1_700_000_003_000,
	thresholdSig: b64(64, 16),
	signers: ['peer-1', 'peer-2'],
	cohortEpoch: b64(32, 17),
});

const sampleGossip = (): CohortGossipV1 => ({
	v: 1,
	fromMember: 'peer-member',
	cohortEpoch: b64(32, 18),
	willingnessBits: 'f',
	loadBuckets: [0, 3, 6, 7],
	windowSeconds: 30,
	topicSummaries: [
		{
			topicId: b64(32, 19),
			tier: 0,
			directParticipants: 10,
			arrivalsPerMin: 5,
			queriesPerMin: 1,
			promoted: false,
			childCohortCount: 0,
		},
		{
			topicId: b64(32, 20),
			tier: 3,
			directParticipants: 64,
			arrivalsPerMin: 30,
			queriesPerMin: 12,
			promoted: true,
			childCohortCount: 4,
		},
	],
	timestamp: 1_700_000_004_000,
	signature: b64(64, 21),
});

const sampleMembershipCert = (): MembershipCertV1 => ({
	v: 1,
	cohortCoord: b64(32, 22),
	cohortEpoch: b64(32, 23),
	members: ['peer-a', 'peer-b', 'peer-c'],
	stabilizedAt: 1_700_000_005_000,
	thresholdSig: b64(64, 24),
	signers: ['peer-a', 'peer-b'],
	fretAttestation: b64(40, 25),
});

describe('cohort-topic wire', () => {
	describe('base64url helpers', () => {
		it('round-trips random 32-byte and 16-byte values exactly', () => {
			for (const len of [16, 32]) {
				for (let seed = 0; seed < 8; seed++) {
					const bytes = seededBytes(len, seed + 1);
					const round = b64urlToBytes(bytesToB64url(bytes));
					expect([...round]).to.deep.equal([...bytes]);
				}
			}
		});

		it('handles every remainder length and the empty input', () => {
			for (let len = 0; len <= 10; len++) {
				const bytes = seededBytes(len, 99);
				expect([...b64urlToBytes(bytesToB64url(bytes))]).to.deep.equal([...bytes]);
			}
		});

		it('emits url-safe alphabet with no padding', () => {
			const s = bytesToB64url(seededBytes(96, 7));
			expect(s).to.not.match(/[+/=]/);
		});

		it('rejects invalid characters and lengths', () => {
			expect(() => b64urlToBytes('abc+')).to.throw(CohortWireError);
			expect(() => b64urlToBytes('a')).to.throw(CohortWireError);
		});
	});

	describe('framing', () => {
		it('produces a 4-byte big-endian length prefix', () => {
			const frame = encodeCohortMessage(sampleRenew());
			const declared = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
			expect(declared).to.equal(frame.length - 4);
		});

		it('rejects encoding a body over the ceiling', () => {
			const big = { v: 1 as const, reason: 'x'.repeat(64) };
			expect(() => encodeCohortMessage(big, 16)).to.throw(CohortWireError, /max_message_bytes/);
		});

		it('rejects a declared length over the ceiling', () => {
			const frame = encodeCohortMessage(sampleRenew());
			new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(0, DEFAULT_MAX_MESSAGE_BYTES + 1, false);
			expect(() => decodeCohortMessage(frame)).to.throw(CohortWireError, /exceeds max_message_bytes/);
		});

		it('rejects a frame whose declared length mismatches its body', () => {
			const frame = encodeCohortMessage(sampleRenew());
			const truncated = frame.subarray(0, frame.length - 1);
			expect(() => decodeCohortMessage(truncated)).to.throw(CohortWireError, /mismatch/);
		});

		it('rejects a frame too short for the prefix', () => {
			expect(() => decodeCohortMessage(new Uint8Array([0, 0]))).to.throw(CohortWireError, /too short/);
		});

		it('rejects a non-JSON body', () => {
			const body = new TextEncoder().encode('not json');
			const frame = new Uint8Array(4 + body.length);
			new DataView(frame.buffer).setUint32(0, body.length, false);
			frame.set(body, 4);
			expect(() => decodeCohortMessage(frame)).to.throw(CohortWireError, /JSON/);
		});
	});

	describe('round-trip per message type', () => {
		const cases: Array<[string, () => { v: 1 }, (b: Uint8Array) => unknown]> = [
			['RegisterV1', sampleRegister, decodeRegisterV1],
			['RegisterReplyV1', sampleRegisterReply, decodeRegisterReplyV1],
			['RenewV1', sampleRenew, decodeRenewV1],
			['RenewReplyV1', sampleRenewReply, decodeRenewReplyV1],
			['PromotionNoticeV1', samplePromotion, decodePromotionNoticeV1],
			['DemotionNoticeV1', sampleDemotion, decodeDemotionNoticeV1],
			['CohortGossipV1', sampleGossip, decodeCohortGossipV1],
			['MembershipCertV1', sampleMembershipCert, decodeMembershipCertV1],
		];

		for (const [name, make, decode] of cases) {
			it(`encodes then decodes ${name} losslessly`, () => {
				const msg = make();
				const decoded = decode(encodeCohortMessage(msg));
				expect(decoded).to.deep.equal(msg);
			});
		}

		it('preserves 32-byte topicId and 16-byte correlationId fidelity through Register round-trip', () => {
			const topicBytes = seededBytes(32, 555);
			const corrBytes = seededBytes(16, 777);
			const msg = { ...sampleRegister(), topicId: bytesToB64url(topicBytes), correlationId: bytesToB64url(corrBytes) };
			const decoded = decodeRegisterV1(encodeCohortMessage(msg));
			expect([...b64urlToBytes(decoded.topicId)]).to.deep.equal([...topicBytes]);
			expect([...b64urlToBytes(decoded.correlationId)]).to.deep.equal([...corrBytes]);
		});
	});

	describe('validation rejects malformed messages', () => {
		it('rejects a missing required field', () => {
			const { topicId: _drop, ...rest } = sampleRegister();
			const frame = encodeCohortMessage(rest as unknown as { v: 1 });
			expect(() => decodeRegisterV1(frame)).to.throw(CohortWireError, /topicId/);
		});

		it('rejects a bad enum discriminant', () => {
			const bad = { ...sampleRegisterReply(), result: 'maybe' };
			const frame = encodeCohortMessage(bad as unknown as { v: 1 });
			expect(() => decodeRegisterReplyV1(frame)).to.throw(CohortWireError, /result/);
		});

		it('rejects a non-finite timestamp', () => {
			// JSON cannot carry NaN, so inject it into an already-parsed object path.
			const msg = sampleRenew();
			const body = new TextEncoder().encode(JSON.stringify({ ...msg, timestamp: 1 }).replace('"timestamp":1', '"timestamp":null'));
			const frame = new Uint8Array(4 + body.length);
			new DataView(frame.buffer).setUint32(0, body.length, false);
			frame.set(body, 4);
			expect(() => decodeRenewV1(frame)).to.throw(CohortWireError, /timestamp/);
		});

		it('rejects v !== 1', () => {
			const bad = { ...sampleRenew(), v: 2 };
			const frame = encodeCohortMessage(bad as unknown as { v: 1 });
			expect(() => decodeRenewV1(frame)).to.throw(CohortWireError, /v === 1/);
		});

		it('rejects tier out of 0..3', () => {
			const bad = { ...sampleRegister(), tier: 5 };
			const frame = encodeCohortMessage(bad);
			expect(() => decodeRegisterV1(frame)).to.throw(CohortWireError, /tier/);
		});

		it('rejects a byte field that is not base64url', () => {
			const bad = { ...sampleRegister(), topicId: 'not valid base64url!!' };
			const frame = encodeCohortMessage(bad);
			expect(() => decodeRegisterV1(frame)).to.throw(CohortWireError, /base64url/);
		});

		it('rejects loadBuckets of wrong length', () => {
			const bad = { ...sampleGossip(), loadBuckets: [1, 2, 3] };
			const frame = encodeCohortMessage(bad);
			expect(() => decodeCohortGossipV1(frame)).to.throw(CohortWireError, /loadBuckets/);
		});

		it('rejects a loadBuckets entry out of 0..7', () => {
			const bad = { ...sampleGossip(), loadBuckets: [0, 0, 0, 8] };
			const frame = encodeCohortMessage(bad);
			expect(() => decodeCohortGossipV1(frame)).to.throw(CohortWireError, /0\.\.7/);
		});

		it('rejects non-hex willingnessBits', () => {
			const bad = { ...sampleGossip(), willingnessBits: 'zz' };
			const frame = encodeCohortMessage(bad);
			expect(() => decodeCohortGossipV1(frame)).to.throw(CohortWireError, /willingnessBits/);
		});
	});

	describe('optional fields', () => {
		it('omits absent optionals on Register round-trip', () => {
			const { bootstrap: _b, appPayload: _a, ...minimal } = sampleRegister();
			const decoded = decodeRegisterV1(encodeCohortMessage(minimal as RegisterV1));
			expect(decoded).to.not.have.property('bootstrap');
			expect(decoded).to.not.have.property('appPayload');
		});

		it('omits absent fretAttestation on MembershipCert round-trip', () => {
			const { fretAttestation: _f, ...minimal } = sampleMembershipCert();
			const decoded = decodeMembershipCertV1(encodeCohortMessage(minimal as MembershipCertV1));
			expect(decoded).to.not.have.property('fretAttestation');
		});
	});

	describe('reply discriminant variants', () => {
		it('round-trips a minimal no_state RegisterReply', () => {
			const msg: RegisterReplyV1 = { v: 1, result: 'no_state' };
			const decoded = decodeRegisterReplyV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
		});

		it('round-trips an unwilling_cohort RegisterReply with retry fields', () => {
			const msg: RegisterReplyV1 = { v: 1, result: 'unwilling_cohort', retryAfterMs: 1500, reason: 'busy' };
			const decoded = decodeRegisterReplyV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
		});

		it('round-trips an unwilling_member RegisterReply with candidates', () => {
			const msg: RegisterReplyV1 = { v: 1, result: 'unwilling_member', candidateMembers: ['peer-c1', 'peer-c2'] };
			const decoded = decodeRegisterReplyV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
		});

		it('round-trips a minimal ok RenewReply', () => {
			const msg: RenewReplyV1 = { v: 1, result: 'ok' };
			const decoded = decodeRenewReplyV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
		});
	});

	describe('decoder robustness', () => {
		it('decodes a frame that is a subarray aliasing a larger buffer', () => {
			const frame = encodeCohortMessage(sampleRenew());
			const backing = new Uint8Array(frame.length + 10);
			backing.set(frame, 5);
			const aliased = backing.subarray(5, 5 + frame.length);
			expect(aliased.byteOffset).to.equal(5);
			const decoded = decodeRenewV1(aliased);
			expect(decoded).to.deep.equal(sampleRenew());
		});

		it('rejects decoding a Renew frame through the Register decoder', () => {
			const frame = encodeCohortMessage(sampleRenew());
			expect(() => decodeRegisterV1(frame)).to.throw(CohortWireError);
		});

		it('round-trips a gossip with an empty topicSummaries list', () => {
			const msg: CohortGossipV1 = { ...sampleGossip(), topicSummaries: [] };
			const decoded = decodeCohortGossipV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
		});

		it('rejects willingnessBits wider than a single nibble', () => {
			const bad = { ...sampleGossip(), willingnessBits: 'ff' };
			const frame = encodeCohortMessage(bad);
			expect(() => decodeCohortGossipV1(frame)).to.throw(CohortWireError, /willingnessBits/);
		});
	});
});
