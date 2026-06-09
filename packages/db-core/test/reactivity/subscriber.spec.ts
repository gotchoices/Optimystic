import { expect } from 'chai';
import {
	createReactivitySubscriber,
	createNotificationVerifier,
	reactivityTopicId,
	type NotificationV1,
	type NotificationVerifier,
} from '../../src/reactivity/index.js';
import type { VerifyResult } from '../../src/cohort-topic/membership/verifier.js';
import { createMembershipVerifier } from '../../src/cohort-topic/membership/verifier.js';
import { createMembershipSourceRouter } from '../../src/cohort-topic/membership/source.js';
import { createCohortSigner } from '../../src/cohort-topic/sig/threshold.js';
import { createTierAddressing } from '../../src/cohort-topic/addressing.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { Tier } from '../../src/cohort-topic/tiers.js';
import type { ICohortThresholdCrypto, IMembershipSource } from '../../src/cohort-topic/ports.js';
import type { MembershipCertV1 } from '../../src/cohort-topic/wire/types.js';
import { bytesToB64url, b64urlToBytes, encodeCohortMessage } from '../../src/cohort-topic/wire/codec.js';

const COLLECTION = bytesToB64url(new Uint8Array([1]));
const TAIL = bytesToB64url(new Uint8Array([2, 2, 2, 2]));

function makeNotification(revision: number, over: Partial<NotificationV1> = {}): NotificationV1 {
	return {
		v: 1,
		collectionId: COLLECTION,
		tailId: TAIL,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [bytesToB64url(new Uint8Array([8, revision & 0xff]))],
		...over,
	};
}

class FakeVerifier implements NotificationVerifier {
	constructor(private readonly verdict: VerifyResult = 'verified') {}
	verify(): Promise<VerifyResult> {
		return Promise.resolve(this.verdict);
	}
}

/** Capture delivered notifications + backfill requests. */
function harness(deps: { verifier: NotificationVerifier; lastKnownRev?: number }) {
	const delivered: number[] = [];
	const backfills: Array<[number, number]> = [];
	const sub = createReactivitySubscriber({
		collectionId: COLLECTION,
		verifier: deps.verifier,
		deliver: (n) => delivered.push(n.revision),
		requestBackfill: (from, to) => backfills.push([from, to]),
		lastKnownRev: deps.lastKnownRev,
	});
	return { sub, delivered, backfills };
}

describe('reactivity subscriber delivery', () => {
	it('verifies and delivers contiguous revisions, advancing lastRevision', async () => {
		const { sub, delivered } = harness({ verifier: new FakeVerifier('verified'), lastKnownRev: 9 });
		expect(await sub.onNotification(makeNotification(10))).to.equal('delivered');
		expect(await sub.onNotification(makeNotification(11))).to.equal('delivered');
		expect(delivered).to.deep.equal([10, 11]);
		expect(sub.lastRevision).to.equal(11);
	});

	it('adopts the first notification as baseline on a fresh subscribe (lastKnownRev = 0)', async () => {
		const { sub, delivered, backfills } = harness({ verifier: new FakeVerifier('verified') });
		expect(await sub.onNotification(makeNotification(1042))).to.equal('delivered');
		expect(delivered).to.deep.equal([1042]);
		expect(backfills).to.have.length(0);
		expect(sub.lastRevision).to.equal(1042);
	});

	it('discards an unverifiable notification', async () => {
		const { sub, delivered } = harness({ verifier: new FakeVerifier('untrusted'), lastKnownRev: 9 });
		expect(await sub.onNotification(makeNotification(10))).to.equal('untrusted');
		expect(delivered).to.have.length(0);
		expect(sub.lastRevision).to.equal(9);
	});

	it('ignores a notification for a different collection', async () => {
		const { sub } = harness({ verifier: new FakeVerifier('verified'), lastKnownRev: 9 });
		expect(await sub.onNotification(makeNotification(10, { collectionId: bytesToB64url(new Uint8Array([99])) }))).to.equal('foreign');
	});

	it('dedupes a duplicate (collectionId, revision) from a forwarder retry', async () => {
		const { sub, delivered } = harness({ verifier: new FakeVerifier('verified'), lastKnownRev: 9 });
		await sub.onNotification(makeNotification(10));
		expect(await sub.onNotification(makeNotification(10))).to.equal('duplicate');
		expect(delivered).to.deep.equal([10]);
	});

	it('detects a revision gap and requests a backfill for [lastRevision + 1, revision]', async () => {
		const { sub, delivered, backfills } = harness({ verifier: new FakeVerifier('verified'), lastKnownRev: 9 });
		await sub.onNotification(makeNotification(10));
		expect(await sub.onNotification(makeNotification(14))).to.equal('gap');
		expect(backfills).to.deep.equal([[11, 14]]);
		expect(delivered).to.deep.equal([10]); // the gapped notification is not surfaced until the gap closes
		expect(sub.lastRevision).to.equal(10);
	});

	it('closes a gap once the backfilled revisions arrive contiguously', async () => {
		const { sub, delivered } = harness({ verifier: new FakeVerifier('verified'), lastKnownRev: 9 });
		await sub.onNotification(makeNotification(10));
		await sub.onNotification(makeNotification(14)); // gap → backfill requested
		// Backfilled entries re-enter through onNotification, in order.
		for (const rev of [11, 12, 13, 14]) {
			expect(await sub.onNotification(makeNotification(rev))).to.equal('delivered');
		}
		expect(delivered).to.deep.equal([10, 11, 12, 13, 14]);
		expect(sub.lastRevision).to.equal(14);
	});

	describe('stale membership cache (real verifier path)', () => {
		// A crypto whose raw signature check always passes; verification therefore turns purely on the
		// member-subset check, so a cert whose members exclude the notification's signers fails until a
		// refetch returns the up-to-date members.
		const passCrypto: ICohortThresholdCrypto = {
			assemble: () => Promise.reject(new Error('verify-only')),
			verify: () => true,
		};
		const MIN_SIGS = 2;
		const signerStrs = [bytesToB64url(new Uint8Array([1, 1])), bytesToB64url(new Uint8Array([2, 2]))];

		const cert = (members: string[]): MembershipCertV1 => ({
			v: 1,
			cohortCoord: bytesToB64url(new Uint8Array(32)),
			cohortEpoch: bytesToB64url(new Uint8Array([7])),
			members,
			stabilizedAt: 1_700_000_000_000,
			thresholdSig: bytesToB64url(new Uint8Array([3, 3, 3])),
			signers: members.slice(0, MIN_SIGS),
		});

		it('triggers exactly one fetch-and-retry then verifies', async () => {
			const staleCert = cert([bytesToB64url(new Uint8Array([9, 9])), bytesToB64url(new Uint8Array([8, 8]))]);
			const freshCert = cert([...signerStrs]);
			let fetchCount = 0;
			let currentCount = 0;
			const source: IMembershipSource = {
				current: () => {
					currentCount++;
					return Promise.resolve(encodeCohortMessage(staleCert));
				},
				fetch: () => {
					fetchCount++;
					return Promise.resolve(encodeCohortMessage(freshCert));
				},
			};
			const membershipVerifier = createMembershipVerifier({
				signer: createCohortSigner(passCrypto, MIN_SIGS),
				router: createMembershipSourceRouter({ committed: source, fret: source }),
				minSigs: MIN_SIGS,
			});
			const notificationVerifier = createNotificationVerifier({ verifier: membershipVerifier, tier: Tier.T3 });

			// Sanity: the notification's tail anchors a real coord_0 the verifier resolves.
			const coord0 = createTierAddressing(createRingHash()).coord0(reactivityTopicId(b64urlToBytes(TAIL)));
			expect(coord0.length).to.equal(32);

			const delivered: number[] = [];
			const sub = createReactivitySubscriber({
				collectionId: COLLECTION,
				verifier: notificationVerifier,
				deliver: (n) => delivered.push(n.revision),
				lastKnownRev: 9,
			});

			const outcome = await sub.onNotification(makeNotification(10, { signers: [...signerStrs] }));
			expect(outcome).to.equal('delivered');
			expect(delivered).to.deep.equal([10]);
			expect(currentCount).to.equal(1);
			expect(fetchCount).to.equal(1); // exactly one refetch
		});
	});
});
