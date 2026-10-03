/**
 * The notification verifier's placement names the tail (`feat-reactivity-root-membership-anchored-by-the-commit-log`).
 *
 * Deliberately a wiring test: `createNotificationVerifier` must hand the membership verifier a `RootPlacement`
 * whose `rootKey` is the notification's tail bytes on every call, because that key is the only thing the
 * commit-log direct anchor (db-p2p) can locate the tail's storage group and commit proof from. Dropping it
 * does not fail any other test — the anchor just answers `"unknown"` and every distant subscriber silently
 * falls back to trusting the root group's certificate on first use.
 */

import { expect } from 'chai';
import { createNotificationVerifier, reactivityRootCoord, type NotificationV1 } from '../../src/reactivity/index.js';
import { createMembershipVerifier } from '../../src/cohort-topic/membership/verifier.js';
import { createMembershipSourceRouter } from '../../src/cohort-topic/membership/source.js';
import { createCohortSigner } from '../../src/cohort-topic/sig/threshold.js';
import { Tier } from '../../src/cohort-topic/tiers.js';
import type { ICohortThresholdCrypto, IMembershipSource, IMembershipTrustAnchor, RootPlacement } from '../../src/cohort-topic/ports.js';
import type { MembershipCertV1 } from '../../src/cohort-topic/wire/types.js';
import { bytesToB64url, b64urlToBytes, encodeCohortMessage } from '../../src/cohort-topic/wire/codec.js';

const TAIL_BYTES = new TextEncoder().encode('tail-block-7');
const TAIL = bytesToB64url(TAIL_BYTES);
const RATIO = 0.75;

/** A crypto whose raw signature check always passes, so verification turns on membership alone. */
const passCrypto: ICohortThresholdCrypto = {
	assemble: () => Promise.reject(new Error('verify-only')),
	verify: () => true,
};

describe('reactivity / notification verifier placement', () => {
	it('hands the direct anchor a placement whose rootKey is the notification\'s tail bytes', async () => {
		const signers = [bytesToB64url(new Uint8Array([1, 1])), bytesToB64url(new Uint8Array([2, 2]))];
		const cert: MembershipCertV1 = {
			v: 1,
			cohortCoord: bytesToB64url(reactivityRootCoord(TAIL_BYTES)),
			cohortEpoch: bytesToB64url(new Uint8Array(32).fill(7)),
			members: signers,
			stabilizedAt: 1_700_000_000_000,
			thresholdSig: bytesToB64url(new Uint8Array([3, 3, 3])),
			signers,
		};
		const source: IMembershipSource = {
			current: () => Promise.resolve(encodeCohortMessage(cert)),
			fetch: () => Promise.resolve(undefined),
		};
		const placements: Array<RootPlacement | undefined> = [];
		const anchor: IMembershipTrustAnchor = {
			directAnchor: (_cert, _tier, placement) => {
				placements.push(placement);
				return 'anchored';
			},
		};
		const membershipVerifier = createMembershipVerifier({
			signer: createCohortSigner(passCrypto, 2),
			router: createMembershipSourceRouter({ committed: source, fret: source }),
			anchor,
		});
		const verifier = createNotificationVerifier({ verifier: membershipVerifier, tier: Tier.T3, quorumRatio: RATIO });

		const notification: NotificationV1 = {
			v: 1,
			collectionId: bytesToB64url(new Uint8Array([1])),
			tailId: TAIL,
			revision: 10,
			digest: bytesToB64url(new Uint8Array([10])),
			timestamp: 1_700_000_000_010,
			sig: bytesToB64url(new Uint8Array([0xaa, 10])),
			signers,
		};
		expect(await verifier.verify(notification)).to.equal('verified');
		expect(placements, 'the anchor was consulted once, for the fetched cert').to.have.length(1);
		expect(placements[0]?.quorumRatio).to.equal(RATIO);
		expect(placements[0]?.rootKey, 'the placement carries the tail bytes the root coord was derived from').to.deep.equal(b64urlToBytes(TAIL));
	});
});
