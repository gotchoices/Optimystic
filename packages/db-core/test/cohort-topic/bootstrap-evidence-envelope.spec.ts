import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	bootstrapBoundImage,
	parentRefSigningImage,
	powPreimage,
	meetsDifficulty,
	DEFAULT_POW_DIFFICULTY_BITS,
	serializeBootstrapEvidenceEnvelope,
	parseBootstrapEvidenceEnvelope,
	type BootstrapEvidenceEnvelopeV1,
	type BootstrapBoundFields,
} from '../../src/cohort-topic/antidos/bootstrap-evidence-envelope.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import { registerSigningPayload } from '../../src/cohort-topic/wire/payloads.js';
import { validateRegisterV1, CohortWireError } from '../../src/cohort-topic/wire/validate.js';
import { createCohortTopicService, type CohortTopicServiceDeps, type ParticipantSigner } from '../../src/cohort-topic/service.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { encodeCohortMessage, decodeRegisterV1 } from '../../src/cohort-topic/wire/codec.js';
import type { ITopicRouter, PeerRef, RingCoord, ISizeEstimator } from '../../src/cohort-topic/ports.js';
import type { CohortGossipBus } from '../../src/cohort-topic/gossip/bus.js';
import type { MembershipVerifier } from '../../src/cohort-topic/membership/verifier.js';
import type { RegisterReplyV1, RegisterV1 } from '../../src/cohort-topic/wire/types.js';
import type { Tier } from '../../src/cohort-topic/tiers.js';

const utf8 = new TextEncoder();
const td = new TextDecoder();

function bytes(label: string, len = 32): Uint8Array {
	return sha256(utf8.encode(label)).slice(0, len);
}

const TOPIC = bytes('bee-topic', 32);
const TOPIC2 = bytes('bee-topic-2', 32);
const COORD = bytes('bee-coord', 32);
const COORD2 = bytes('bee-coord-2', 32);

/** A bound-fields tuple for the canonical image / preimage helpers. */
const boundBase: BootstrapBoundFields = {
	topicId: bytesToB64url(TOPIC),
	tier: 0,
	participantCoord: bytesToB64url(COORD),
	timestamp: 1_700_000_000_000,
};

const b64 = (label: string, len = 16): string => bytesToB64url(bytes(label, len));

describe('cohort-topic / bootstrap-evidence envelope', () => {
	describe('serialize ↔ parse round-trip', () => {
		const envelopes: Array<[string, BootstrapEvidenceEnvelopeV1]> = [
			['pow only', { v: 1, pow: { nonce: b64('nonce', 8) } }],
			['parentRef only', { v: 1, parentRef: { parentTopicId: b64('parent', 32), sig: b64('psig', 64) } }],
			['reputation only', { v: 1, reputation: { referee: b64('referee', 20), sig: b64('rsig', 64) } }],
			['multi-kind', {
				v: 1,
				pow: { nonce: b64('nonce', 8) },
				parentRef: { parentTopicId: b64('parent', 32), sig: b64('psig', 64) },
				reputation: { referee: b64('referee', 20), sig: b64('rsig', 64) },
			}],
		];

		for (const [name, env] of envelopes) {
			it(`round-trips a ${name} envelope`, () => {
				const field = serializeBootstrapEvidenceEnvelope(env);
				expect(field).to.be.a('string');
				const parsed = parseBootstrapEvidenceEnvelope({ bootstrapEvidence: field });
				expect(parsed).to.deep.equal(env);
			});
		}

		it('serialize is canonical: independent of source key order (serialize∘parse stable)', () => {
			// Same logical content, keys declared in a different order.
			const a: BootstrapEvidenceEnvelopeV1 = { v: 1, reputation: { sig: b64('rsig', 64), referee: b64('referee', 20) }, pow: { nonce: b64('nonce', 8) } };
			const b: BootstrapEvidenceEnvelopeV1 = { v: 1, pow: { nonce: b64('nonce', 8) }, reputation: { referee: b64('referee', 20), sig: b64('rsig', 64) } };
			expect(serializeBootstrapEvidenceEnvelope(a)).to.equal(serializeBootstrapEvidenceEnvelope(b));
		});
	});

	describe('parse is total (fails closed, never throws)', () => {
		it('returns undefined for an absent field', () => {
			expect(parseBootstrapEvidenceEnvelope({})).to.equal(undefined);
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: undefined })).to.equal(undefined);
		});

		it('returns undefined for an empty-string field', () => {
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: '' })).to.equal(undefined);
		});

		it('returns undefined for a non-base64url field', () => {
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: 'not valid base64url!!' })).to.equal(undefined);
		});

		it('returns undefined for a base64url body that is not JSON', () => {
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: bytesToB64url(utf8.encode('not json')) })).to.equal(undefined);
		});

		it('returns undefined for a wrong/future version (v: 2 fails closed under the v1 reader)', () => {
			const field = bytesToB64url(utf8.encode(JSON.stringify({ v: 2, pow: { nonce: b64('nonce', 8) } })));
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: field })).to.equal(undefined);
		});

		it('returns undefined when a present kind is missing a required sub-field', () => {
			const noSig = bytesToB64url(utf8.encode(JSON.stringify({ v: 1, parentRef: { parentTopicId: b64('parent', 32) } })));
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: noSig })).to.equal(undefined);
			const emptyNonce = bytesToB64url(utf8.encode(JSON.stringify({ v: 1, pow: { nonce: '' } })));
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: emptyNonce })).to.equal(undefined);
			const nonStringNonce = bytesToB64url(utf8.encode(JSON.stringify({ v: 1, pow: { nonce: 7 } })));
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: nonStringNonce })).to.equal(undefined);
		});

		it('returns undefined for a non-object / array body', () => {
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: bytesToB64url(utf8.encode(JSON.stringify([1, 2, 3]))) })).to.equal(undefined);
			expect(parseBootstrapEvidenceEnvelope({ bootstrapEvidence: bytesToB64url(utf8.encode(JSON.stringify(null))) })).to.equal(undefined);
		});

		it('reads a known kind even when an unknown future key is present (forward-compatible, fails closed on the kind it does not know)', () => {
			const field = bytesToB64url(utf8.encode(JSON.stringify({ v: 1, pow: { nonce: b64('nonce', 8) }, futureKind: { x: 1 } })));
			const parsed = parseBootstrapEvidenceEnvelope({ bootstrapEvidence: field });
			expect(parsed).to.deep.equal({ v: 1, pow: { nonce: b64('nonce', 8) } });
		});
	});

	describe('bootstrapBoundImage (anti-replay binding)', () => {
		const image = (f: BootstrapBoundFields): string => bytesToB64url(bootstrapBoundImage(f));

		it('is stable for the same tuple', () => {
			expect(image(boundBase)).to.equal(image({ ...boundBase }));
		});

		it('differs across topicId / tier / participantCoord / timestamp', () => {
			const base = image(boundBase);
			expect(image({ ...boundBase, topicId: bytesToB64url(TOPIC2) }), 'topicId').to.not.equal(base);
			expect(image({ ...boundBase, tier: 1 }), 'tier').to.not.equal(base);
			expect(image({ ...boundBase, participantCoord: bytesToB64url(COORD2) }), 'participantCoord').to.not.equal(base);
			expect(image({ ...boundBase, timestamp: boundBase.timestamp + 1 }), 'timestamp').to.not.equal(base);
		});

		it('emits the documented canonical array shape', () => {
			const arr = JSON.parse(td.decode(bootstrapBoundImage(boundBase)));
			expect(arr).to.deep.equal(['BootstrapEvidenceV1', boundBase.topicId, boundBase.tier, boundBase.participantCoord, boundBase.timestamp]);
		});
	});

	describe('parentRefSigningImage (signed parent-reference binding)', () => {
		const PARENT = bytesToB64url(bytes('bee-parent', 32));
		const PARENT2 = bytesToB64url(bytes('bee-parent-2', 32));
		const image = (f: BootstrapBoundFields, parent: string): string => bytesToB64url(parentRefSigningImage(f, parent));

		it('is stable for the same tuple + parent', () => {
			expect(image(boundBase, PARENT)).to.equal(image({ ...boundBase }, PARENT));
		});

		it('differs across topicId / tier / participantCoord / timestamp / parentTopicId', () => {
			const base = image(boundBase, PARENT);
			expect(image({ ...boundBase, topicId: bytesToB64url(TOPIC2) }, PARENT), 'topicId').to.not.equal(base);
			expect(image({ ...boundBase, tier: 1 }, PARENT), 'tier').to.not.equal(base);
			expect(image({ ...boundBase, participantCoord: bytesToB64url(COORD2) }, PARENT), 'participantCoord').to.not.equal(base);
			expect(image({ ...boundBase, timestamp: boundBase.timestamp + 1 }, PARENT), 'timestamp').to.not.equal(base);
			expect(image(boundBase, PARENT2), 'parentTopicId').to.not.equal(base);
		});

		it('is domain-separated from bootstrapBoundImage (distinct tag) so neither signature can be replayed onto the other path', () => {
			expect(bytesToB64url(parentRefSigningImage(boundBase, PARENT)))
				.to.not.equal(bytesToB64url(bootstrapBoundImage(boundBase)));
		});

		it('emits the documented canonical array shape', () => {
			const arr = JSON.parse(td.decode(parentRefSigningImage(boundBase, PARENT)));
			expect(arr).to.deep.equal(['BootstrapParentRefV1', boundBase.topicId, boundBase.tier, boundBase.participantCoord, boundBase.timestamp, PARENT]);
		});
	});

	describe('powPreimage', () => {
		it('is the bound image followed by the nonce', () => {
			const nonce = bytes('pow-nonce', 12);
			const pre = powPreimage(boundBase, nonce);
			const img = bootstrapBoundImage(boundBase);
			expect(pre.length).to.equal(img.length + nonce.length);
			expect([...pre.subarray(0, img.length)]).to.deep.equal([...img]);
			expect([...pre.subarray(img.length)]).to.deep.equal([...nonce]);
		});

		it('changes when the nonce changes (binds the work to the nonce)', () => {
			const a = bytesToB64url(powPreimage(boundBase, bytes('nonce-a', 8)));
			const b = bytesToB64url(powPreimage(boundBase, bytes('nonce-b', 8)));
			expect(a).to.not.equal(b);
		});
	});

	describe('meetsDifficulty', () => {
		it('exposes the simulator-suggested default difficulty', () => {
			expect(DEFAULT_POW_DIFFICULTY_BITS).to.equal(20);
		});

		it('bits = 0 is trivially met by any hash', () => {
			expect(meetsDifficulty(new Uint8Array([0xff, 0xff]), 0)).to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x00]), 0)).to.equal(true);
		});

		it('bits = 1 reads the most-significant bit first (MSB-first byte order)', () => {
			expect(meetsDifficulty(new Uint8Array([0x00]), 1)).to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x7f]), 1), '0x7f top bit is 0').to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x40]), 1), '0x40 top bit is 0').to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x80]), 1), '0x80 top bit is 1').to.equal(false);
		});

		it('bits = 8 requires a zero leading byte', () => {
			expect(meetsDifficulty(new Uint8Array([0x00, 0xff]), 8)).to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x01, 0x00]), 8)).to.equal(false);
		});

		it('bits = 9 requires a zero leading byte and a zero top bit of the next', () => {
			expect(meetsDifficulty(new Uint8Array([0x00, 0x00]), 9)).to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x00, 0x7f]), 9)).to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x00, 0x80]), 9)).to.equal(false);
			expect(meetsDifficulty(new Uint8Array([0x01, 0x00]), 9)).to.equal(false);
		});

		it('bits = 20 checks the top 4 bits of the third byte', () => {
			expect(meetsDifficulty(new Uint8Array([0x00, 0x00, 0x0f]), 20), '0x0f top 4 bits zero').to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x00, 0x00, 0x08]), 20), '0x08 top 4 bits zero').to.equal(true);
			expect(meetsDifficulty(new Uint8Array([0x00, 0x00, 0x10]), 20), '0x10 sets a top-4 bit').to.equal(false);
			expect(meetsDifficulty(new Uint8Array([0x00, 0x01, 0x00]), 20), 'second byte nonzero').to.equal(false);
		});

		it('oversize bits (> hash bit-width) is unsatisfiable even for an all-zero hash', () => {
			expect(meetsDifficulty(new Uint8Array(4), 32), 'exactly the hash width, all zero → met').to.equal(true);
			expect(meetsDifficulty(new Uint8Array(4), 33), 'one bit past the hash width → never met').to.equal(false);
		});

		it('guards non-finite / negative bits defensively (never throws)', () => {
			expect(meetsDifficulty(new Uint8Array([0x80]), Number.NaN)).to.equal(false);
			expect(meetsDifficulty(new Uint8Array([0x80]), Number.POSITIVE_INFINITY)).to.equal(false);
			expect(meetsDifficulty(new Uint8Array([0xff]), -5), 'negative clamps to 0 → met').to.equal(true);
		});
	});

	describe('registerSigningPayload includes bootstrapEvidence at a fixed position', () => {
		const baseBody = (): Omit<RegisterV1, 'signature'> => ({
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 2,
			treeTier: 3,
			participantCoord: bytesToB64url(COORD),
			ttl: 90_000,
			timestamp: 1_700_000_000_000,
			correlationId: b64('corr', 16),
		});

		const image = (body: Omit<RegisterV1, 'signature'>): unknown[] => JSON.parse(td.decode(registerSigningPayload(body)));

		it('a non-bootstrap register normalizes the new slot to null at a fixed position (snapshot)', () => {
			const body = baseBody();
			expect(image(body)).to.deep.equal([
				'RegisterV1',
				1,
				body.topicId,
				body.tier,
				body.treeTier,
				body.participantCoord,
				body.ttl,
				false, // bootstrap absent
				null, // appPayload absent
				null, // bootstrapEvidence absent
				body.timestamp,
				body.correlationId,
			]);
		});

		it('absent and empty-string bootstrapEvidence produce the identical image', () => {
			const body = baseBody();
			expect(image({ ...body, bootstrapEvidence: '' })).to.deep.equal(image(body));
		});

		it('a present bootstrapEvidence occupies the fixed slot and changes nothing else', () => {
			const body = baseBody();
			const baseline = image(body);
			const withEv = image({ ...body, bootstrapEvidence: 'EVIDENCE' });
			expect(withEv[9], 'bootstrapEvidence sits at index 9').to.equal('EVIDENCE');
			const restored = [...withEv];
			restored[9] = null;
			expect(restored, 'only the evidence slot differs').to.deep.equal(baseline);
		});
	});

	describe('validateRegisterV1 accepts / rejects bootstrapEvidence', () => {
		const reg = (extra: Record<string, unknown>): unknown => ({
			v: 1,
			topicId: bytesToB64url(TOPIC),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesToB64url(COORD),
			ttl: 90_000,
			timestamp: 0,
			correlationId: b64('cid', 16),
			signature: b64('sig', 64),
			...extra,
		});

		it('accepts a register with a valid base64url bootstrapEvidence', () => {
			const field = serializeBootstrapEvidenceEnvelope({ v: 1, pow: { nonce: b64('nonce', 8) } });
			const out = validateRegisterV1(reg({ bootstrap: true, bootstrapEvidence: field }));
			expect(out.bootstrapEvidence).to.equal(field);
		});

		it('accepts a register without bootstrapEvidence (field absent on the output)', () => {
			const out = validateRegisterV1(reg({}));
			expect(out).to.not.have.property('bootstrapEvidence');
		});

		it('treats an empty-string bootstrapEvidence as absent', () => {
			const out = validateRegisterV1(reg({ bootstrapEvidence: '' }));
			expect(out).to.not.have.property('bootstrapEvidence');
		});

		it('rejects a non-string bootstrapEvidence as malformed', () => {
			expect(() => validateRegisterV1(reg({ bootstrapEvidence: 123 }))).to.throw(CohortWireError, /bootstrapEvidence/);
		});

		it('rejects a non-base64url bootstrapEvidence', () => {
			expect(() => validateRegisterV1(reg({ bootstrapEvidence: 'not base64url!!' }))).to.throw(CohortWireError, /base64url/);
		});
	});

	describe('service factory: buildBootstrapEvidence attach seam', () => {
		const accepted: RegisterReplyV1 = {
			v: 1,
			result: 'accepted',
			primary: bytesToB64url(bytes('primary', 16)),
			cohortEpoch: bytesToB64url(bytes('epoch', 32)),
		};
		const noState: RegisterReplyV1 = { v: 1, result: 'no_state' };

		/** Records every register frame it sees, replying from a fixed script. */
		class CapturingRouter implements ITopicRouter {
			readonly registers: RegisterV1[] = [];
			private i = 0;
			constructor(private readonly replies: readonly RegisterReplyV1[]) {}
			async routeAndAct(_key: RingCoord, activity: Uint8Array): Promise<Uint8Array> {
				this.registers.push(decodeRegisterV1(activity));
				return encodeCohortMessage(this.next());
			}
			async dialMember(_m: PeerRef, activity: Uint8Array): Promise<Uint8Array> {
				this.registers.push(decodeRegisterV1(activity));
				return encodeCohortMessage(this.next());
			}
			private next(): RegisterReplyV1 {
				const r = this.replies[this.i++];
				if (r === undefined) throw new Error(`CapturingRouter out of replies at ${this.i - 1}`);
				return r;
			}
		}

		class RecordingSigner implements ParticipantSigner {
			readonly signed: Array<Omit<RegisterV1, 'signature'>> = [];
			async signRegister(body: Omit<RegisterV1, 'signature'>): Promise<string> {
				this.signed.push(body);
				return bytesToB64url(bytes('sig', 8));
			}
			async signRenew(): Promise<string> {
				return bytesToB64url(bytes('sig', 8));
			}
		}

		// nEst = 1, confidence = 1 → d_max = 0, so the walk probes only the root.
		const sizeEstimator: ISizeEstimator = { estimate: () => ({ nEst: 1, confidence: 1 }) };
		const self = bytes('svc-self', 16);

		function makeService(router: ITopicRouter, signer: ParticipantSigner, builder: CohortTopicServiceDeps['buildBootstrapEvidence']): ReturnType<typeof createCohortTopicService> {
			const deps: CohortTopicServiceDeps = {
				self,
				hash: createRingHash(),
				router,
				sizeEstimator,
				signer,
				gossipBus: {} as unknown as CohortGossipBus,
				verifier: {} as unknown as MembershipVerifier,
				clock: () => 1_000,
				buildBootstrapEvidence: builder,
			};
			return createCohortTopicService(deps);
		}

		it('on the bootstrap re-issue, mints and signs the evidence; the field round-trips to the minted envelope', async () => {
			const env: BootstrapEvidenceEnvelopeV1 = { v: 1, pow: { nonce: bytesToB64url(bytes('svc-nonce', 8)) } };
			const evidenceBytes = utf8.encode(JSON.stringify(env)); // raw envelope JSON; the service base64url-encodes it
			const calls: Array<{ topicId: string; tier: number; participantCoord: string; timestamp: number }> = [];

			const router = new CapturingRouter([noState, accepted]); // root cold → bootstrap re-issue → accepted
			const signer = new RecordingSigner();
			const service = makeService(router, signer, async (p) => {
				calls.push(p);
				return evidenceBytes;
			});

			await service.register({ topicId: TOPIC, tier: 0 as Tier });

			// Two probes: the first a plain root probe, the second the bootstrap re-issue.
			expect(router.registers).to.have.length(2);
			expect(router.registers[0]!.bootstrap, 'first probe is not a bootstrap').to.not.equal(true);
			expect(router.registers[0]!.bootstrapEvidence, 'no evidence on the non-bootstrap probe').to.equal(undefined);
			expect(router.registers[1]!.bootstrap, 'second probe is the bootstrap re-issue').to.equal(true);

			// The builder ran exactly once, bound to the register's own canonical fields.
			expect(calls).to.deep.equal([{ topicId: bytesToB64url(TOPIC), tier: 0, participantCoord: bytesToB64url(self), timestamp: 1_000 }]);

			// The field is present on the wire, equals the canonical serialize(), and round-trips to the envelope.
			const field = router.registers[1]!.bootstrapEvidence;
			expect(field, 'evidence rides on the wire').to.be.a('string');
			expect(field).to.equal(serializeBootstrapEvidenceEnvelope(env));
			expect(parseBootstrapEvidenceEnvelope(router.registers[1]!)).to.deep.equal(env);

			// The evidence was set BEFORE signing → the participant signature covers it.
			const bootBody = signer.signed.find((b) => b.bootstrap === true);
			expect(bootBody?.bootstrapEvidence, 'signed body carries the evidence (so the signature covers it)').to.equal(field);
		});

		it('does not call the builder on a non-bootstrap register', async () => {
			let called = 0;
			const router = new CapturingRouter([accepted]); // accepted at the first (non-bootstrap) probe
			const signer = new RecordingSigner();
			const service = makeService(router, signer, async () => {
				called++;
				return utf8.encode('should-not-run');
			});

			await service.register({ topicId: TOPIC, tier: 0 as Tier });

			expect(called, 'builder never invoked when no bootstrap re-issue happens').to.equal(0);
			expect(router.registers).to.have.length(1);
			expect(router.registers[0]!.bootstrap).to.not.equal(true);
			expect(router.registers[0]!.bootstrapEvidence).to.equal(undefined);
		});
	});
});
