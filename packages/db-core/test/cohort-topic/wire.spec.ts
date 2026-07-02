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
	decodeChildLinkV1,
	decodeChildLinkReplyV1,
	decodePromotionNoticeV1,
	decodeDemotionNoticeV1,
	decodeCohortGossipV1,
	decodeMembershipCertV1,
	validateChildLinkV1,
	registerSigningPayload,
	renewSigningPayload,
	CohortWireError,
	DEFAULT_MAX_MESSAGE_BYTES,
} from '../../src/cohort-topic/wire/index.js';
import { childLinkSigningPayload } from '../../src/cohort-topic/sig/index.js';
import type {
	RegisterV1,
	RegisterReplyV1,
	RenewV1,
	RenewReplyV1,
	ChildLinkV1,
	ChildLinkReplyV1,
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

const sampleChildLink = (): ChildLinkV1 => ({
	v: 1,
	topicId: b64(32, 30),
	childCohortCoord: b64(32, 31),
	childParticipantCoord: b64(32, 32),
	childTier: 1,
	tier: 2,
	effectiveAt: 1_700_000_006_000,
	thresholdSig: b64(64 * 3, 33),
	signers: ['peer-c1', 'peer-c2', 'peer-c3'],
	cohortEpoch: b64(32, 34),
});

const sampleChildLinkReply = (): ChildLinkReplyV1 => ({
	v: 1,
	result: 'linked',
});

const samplePromotion = (): PromotionNoticeV1 => ({
	v: 1,
	topicId: b64(32, 11),
	fromTier: 1,
	toTier: 2,
	cohortCoord: b64(32, 18),
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
	cohortCoord: b64(32, 19),
	effectiveAt: 1_700_000_003_000,
	thresholdSig: b64(64, 16),
	signers: ['peer-1', 'peer-2'],
	cohortEpoch: b64(32, 17),
});

const sampleGossip = (): CohortGossipV1 => ({
	v: 1,
	fromMember: 'peer-member',
	coord: b64(32, 23),
	cohortEpoch: b64(32, 18),
	treeTier: 0,
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
			['ChildLinkV1', sampleChildLink, (b: Uint8Array) => decodeChildLinkV1(b)],
			['ChildLinkReplyV1', sampleChildLinkReply, decodeChildLinkReplyV1],
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

		it('rejects a negative treeTier', () => {
			const bad = { ...sampleGossip(), treeTier: -1 };
			const frame = encodeCohortMessage(bad);
			expect(() => decodeCohortGossipV1(frame)).to.throw(CohortWireError, /treeTier/);
		});

		it('rejects a non-integer treeTier', () => {
			const bad = { ...sampleGossip(), treeTier: 1.5 };
			const frame = encodeCohortMessage(bad);
			expect(() => decodeCohortGossipV1(frame)).to.throw(CohortWireError, /treeTier/);
		});
	});

	describe('ChildLinkV1 validation + signing payload', () => {
		const MIN_SIGS = 3;

		it('accepts a well-formed signed child-link (signers >= minSigs)', () => {
			expect(() => validateChildLinkV1(sampleChildLink(), MIN_SIGS)).to.not.throw();
		});

		it('accepts an UNSIGNED (key-less interim) child-link even with a minSigs bound', () => {
			const keyless = { ...sampleChildLink(), thresholdSig: '', signers: [] };
			expect(() => validateChildLinkV1(keyless, MIN_SIGS)).to.not.throw();
		});

		it('rejects childTier < 1 (the root never links)', () => {
			const bad = { ...sampleChildLink(), childTier: 0 };
			expect(() => validateChildLinkV1(bad)).to.throw(CohortWireError, /childTier/);
		});

		it('rejects a non-32-byte coord field', () => {
			const bad = { ...sampleChildLink(), childCohortCoord: b64(16, 40) };
			expect(() => validateChildLinkV1(bad)).to.throw(CohortWireError, /childCohortCoord/);
		});

		it('rejects tier out of 0..3', () => {
			const bad = { ...sampleChildLink(), tier: 5 };
			expect(() => validateChildLinkV1(bad)).to.throw(CohortWireError, /tier/);
		});

		it('rejects a signed child-link whose signers.length < minSigs', () => {
			const bad = { ...sampleChildLink(), signers: [b64(32, 50)] };
			expect(() => validateChildLinkV1(bad, MIN_SIGS)).to.throw(CohortWireError, /signers\.length/);
		});

		it('childLinkSigningPayload keeps cohortEpoch as the last array element (the /sign positional read)', () => {
			const link = sampleChildLink();
			const image = JSON.parse(new TextDecoder().decode(childLinkSigningPayload(link))) as unknown[];
			expect(image[0]).to.equal('ChildLinkV1');
			expect(image[image.length - 1]).to.equal(link.cohortEpoch);
		});

		it('childLinkSigningPayload is deterministic and covers only the signable fields (not the sig envelope)', () => {
			const link = sampleChildLink();
			const a = childLinkSigningPayload(link);
			const b = childLinkSigningPayload(link);
			expect([...a]).to.deep.equal([...b]);
			// Changing only the threshold-sig envelope must NOT change the signed image.
			const reSigned = { ...link, thresholdSig: b64(64, 99), signers: ['x', 'y'] };
			expect([...childLinkSigningPayload(reSigned)]).to.deep.equal([...a]);
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

	describe('lookup probe flag', () => {
		it('round-trips a RegisterV1 carrying probe: true', () => {
			const msg: RegisterV1 = { ...sampleRegister(), bootstrap: false, probe: true };
			const decoded = decodeRegisterV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
			expect(decoded.probe).to.equal(true);
		});

		it('omits an absent probe on Register round-trip', () => {
			const { bootstrap: _b, probe: _p, ...minimal } = sampleRegister() as RegisterV1 & { probe?: boolean };
			const decoded = decodeRegisterV1(encodeCohortMessage(minimal as RegisterV1));
			expect(decoded).to.not.have.property('probe');
		});

		it('rejects a non-boolean probe', () => {
			const bad = { ...sampleRegister(), probe: 'yes' };
			const frame = encodeCohortMessage(bad as unknown as { v: 1 });
			expect(() => decodeRegisterV1(frame)).to.throw(CohortWireError, /probe/);
		});

		it('registerSigningPayload differs between probe:true and probe:false/absent', () => {
			const base = sampleRegister();
			const probeImage = registerSigningPayload({ ...base, probe: true });
			const falseImage = registerSigningPayload({ ...base, probe: false });
			const absentImage = registerSigningPayload(base); // probe absent
			expect([...probeImage], 'a probe signs a distinct image').to.not.deep.equal([...falseImage]);
			expect([...falseImage], 'probe:false and absent normalize to the same signed image').to.deep.equal([...absentImage]);
		});
	});

	describe('follow-on cold-start flag', () => {
		it('round-trips a RegisterV1 carrying followOn: true (treeTier >= 1)', () => {
			// sampleRegister has treeTier: 3; drop bootstrap (mutually exclusive) and set followOn.
			const msg: RegisterV1 = { ...sampleRegister(), bootstrap: false, followOn: true };
			const decoded = decodeRegisterV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
			expect(decoded.followOn).to.equal(true);
		});

		it('omits an absent followOn on Register round-trip', () => {
			const { bootstrap: _b, followOn: _f, ...minimal } = sampleRegister() as RegisterV1 & { followOn?: boolean };
			const decoded = decodeRegisterV1(encodeCohortMessage(minimal as RegisterV1));
			expect(decoded).to.not.have.property('followOn');
		});

		it('rejects a non-boolean followOn', () => {
			const bad = { ...sampleRegister(), bootstrap: false, followOn: 'yes' };
			const frame = encodeCohortMessage(bad as unknown as { v: 1 });
			expect(() => decodeRegisterV1(frame)).to.throw(CohortWireError, /followOn/);
		});

		it('rejects a frame that sets more than one of {bootstrap, followOn, probe}', () => {
			const both = { ...sampleRegister(), bootstrap: true, followOn: true };
			expect(() => decodeRegisterV1(encodeCohortMessage(both as unknown as { v: 1 })))
				.to.throw(CohortWireError, /at most one of bootstrap, followOn, probe/);
			const followProbe = { ...sampleRegister(), bootstrap: false, followOn: true, probe: true };
			expect(() => decodeRegisterV1(encodeCohortMessage(followProbe as unknown as { v: 1 })))
				.to.throw(CohortWireError, /at most one of bootstrap, followOn, probe/);
		});

		it('rejects followOn: true at the root (treeTier < 1)', () => {
			const rootFollowOn = { ...sampleRegister(), bootstrap: false, followOn: true, treeTier: 0 };
			expect(() => decodeRegisterV1(encodeCohortMessage(rootFollowOn as unknown as { v: 1 })))
				.to.throw(CohortWireError, /followOn requires treeTier >= 1/);
		});

		it('registerSigningPayload differs between followOn:true and followOn:false/absent', () => {
			const base = { ...sampleRegister(), bootstrap: false };
			const followImage = registerSigningPayload({ ...base, followOn: true });
			const falseImage = registerSigningPayload({ ...base, followOn: false });
			const absentImage = registerSigningPayload(base); // followOn absent
			expect([...followImage], 'a follow-on signs a distinct image').to.not.deep.equal([...falseImage]);
			expect([...falseImage], 'followOn:false and absent normalize to the same signed image').to.deep.equal([...absentImage]);
		});
	});

	describe('MembershipCert rotation attestation', () => {
		const withRotation = (): MembershipCertV1 => ({
			...sampleMembershipCert(),
			prevEpoch: b64(32, 30),
			rotationSig: b64(64, 31),
			rotationSigners: ['peer-a', 'peer-b'],
		});

		it('round-trips a cert carrying a full rotation attestation', () => {
			const msg = withRotation();
			const decoded = decodeMembershipCertV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
		});

		it('decodes a legacy cert (no rotation fields) to an object lacking them', () => {
			const decoded = decodeMembershipCertV1(encodeCohortMessage(sampleMembershipCert()));
			expect(decoded).to.not.have.property('prevEpoch');
			expect(decoded).to.not.have.property('rotationSig');
			expect(decoded).to.not.have.property('rotationSigners');
		});

		it('rejects a partial rotation attestation (all-or-nothing)', () => {
			const partials: Array<Partial<MembershipCertV1>> = [
				{ prevEpoch: b64(32, 30) },
				{ rotationSig: b64(64, 31) },
				{ rotationSigners: ['peer-a', 'peer-b'] },
				{ prevEpoch: b64(32, 30), rotationSig: b64(64, 31) }, // missing rotationSigners
				{ prevEpoch: b64(32, 30), rotationSigners: ['peer-a'] }, // missing rotationSig
				{ rotationSig: b64(64, 31), rotationSigners: ['peer-a'] }, // missing prevEpoch
			];
			for (const partial of partials) {
				const frame = encodeCohortMessage({ ...sampleMembershipCert(), ...partial });
				expect(() => decodeMembershipCertV1(frame), JSON.stringify(Object.keys(partial))).to.throw(CohortWireError, /rotation attestation/);
			}
		});

		it('rejects a non-base64url prevEpoch / rotationSig', () => {
			const badPrev = encodeCohortMessage({ ...withRotation(), prevEpoch: 'not base64url!!' });
			expect(() => decodeMembershipCertV1(badPrev)).to.throw(CohortWireError, /base64url/);
			const badSig = encodeCohortMessage({ ...withRotation(), rotationSig: 'not base64url!!' });
			expect(() => decodeMembershipCertV1(badSig)).to.throw(CohortWireError, /base64url/);
		});

		it('rejects a non-array rotationSigners', () => {
			const bad = encodeCohortMessage({ ...withRotation(), rotationSigners: 'peer-a' } as unknown as { v: 1 });
			expect(() => decodeMembershipCertV1(bad)).to.throw(CohortWireError, /rotationSigners/);
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

		it('round-trips a RenewV1 carrying the signed reattach flag', () => {
			const msg: RenewV1 = { ...sampleRenew(), reattach: true };
			const decoded = decodeRenewV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
			expect(decoded.reattach).to.equal(true);
		});

		it('decodes a RenewV1 without reattach to an object lacking the field (back-compat plain ping)', () => {
			const decoded = decodeRenewV1(encodeCohortMessage(sampleRenew()));
			expect(decoded).to.not.have.property('reattach');
		});

		it('rejects a non-boolean reattach', () => {
			const bad = { ...sampleRenew(), reattach: 'yes' };
			const frame = encodeCohortMessage(bad as unknown as { v: 1 });
			expect(() => decodeRenewV1(frame)).to.throw(CohortWireError, /reattach/);
		});

		it('round-trips a RenewV1 carrying the signed withdraw flag', () => {
			const msg: RenewV1 = { ...sampleRenew(), withdraw: true };
			const decoded = decodeRenewV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
			expect(decoded.withdraw).to.equal(true);
		});

		it('decodes a RenewV1 without withdraw to an object lacking the field (back-compat plain ping)', () => {
			const decoded = decodeRenewV1(encodeCohortMessage(sampleRenew()));
			expect(decoded).to.not.have.property('withdraw');
		});

		it('rejects a non-boolean withdraw', () => {
			const bad = { ...sampleRenew(), withdraw: 'yes' };
			const frame = encodeCohortMessage(bad as unknown as { v: 1 });
			expect(() => decodeRenewV1(frame)).to.throw(CohortWireError, /withdraw/);
		});

		it('round-trips a RenewReply carrying the withdrawn result', () => {
			const msg: RenewReplyV1 = { v: 1, result: 'withdrawn' };
			const decoded = decodeRenewReplyV1(encodeCohortMessage(msg));
			expect(decoded).to.deep.equal(msg);
		});

		it('the renew signing image distinguishes withdraw, reattach, and a plain ping over the same fields', () => {
			const base = sampleRenew();
			const plain = bytesToB64url(renewSigningPayload(base));
			const withdraw = bytesToB64url(renewSigningPayload({ ...base, withdraw: true }));
			const reattach = bytesToB64url(renewSigningPayload({ ...base, reattach: true }));
			expect(withdraw, 'withdraw signs a distinct image from a plain ping').to.not.equal(plain);
			expect(withdraw, 'withdraw signs a distinct image from a reattach').to.not.equal(reattach);
			// An absent flag and an explicit-false flag normalize to the same image (no signature ambiguity).
			expect(bytesToB64url(renewSigningPayload({ ...base, withdraw: false })), 'withdraw:false === absent').to.equal(plain);
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
