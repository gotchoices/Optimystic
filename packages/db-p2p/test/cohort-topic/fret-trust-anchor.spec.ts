/**
 * Unit coverage for the FRET-ring direct trust anchor (`cohort-topic-trust-anchor-fret-binding`):
 * {@link FretTrustAnchor.directAnchor} judged over a small, deterministic in-memory ring.
 *
 * The ring is a {@link RingStub}: `assembleCohort(coord, wants)` returns the configured nearest-first
 * ordering for `coord`, truncated to `wants` — exactly the contract FRET's local two-sided closest-`k`
 * assembly presents, with full control over which peers are "near" a coord (so the stabilization-skew
 * case can place a rotated member at a precise ring position). The anchor reads only `cert.cohortCoord`
 * and `cert.signers`, so the certs here carry no real multisig — self-consistency / message verification
 * is the *verifier's* job (covered in db-core `membership.spec.ts`); this isolates the ring-agreement rule.
 *
 * Covered: covered-coord match → `"anchored"`; disjoint keyset → `"rejected"`; a coord the node is not
 * part of → `"unknown"`; a 1–2 member stabilization skew within slack → `"anchored"`; partial overlap
 * beyond slack → `"unknown"`; a cold/short ring → `"unknown"`; a partition → `"unknown"`; the committed
 * tiers (T0/T1) → `"unknown"` (the tx-log anchor's job); both FRET tiers (T2/T3) judged; and totality
 * against an undecodable signer. A **root-placed** cert (verified under a `RootPlacement`) is judged
 * against the root group the host holds for the coord, whatever the FRET cohort around it says, and is
 * `"unknown"` whenever the anchor holds no group it can judge by.
 */

import { expect } from 'chai';
import { bytesToB64url, createRootPlacement } from '@optimystic/db-core';
import type { MembershipCertV1 } from '@optimystic/db-core';
import { FretTrustAnchor, type FretRingView } from '../../src/cohort-topic/fret-trust-anchor.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';

const K = 4;
const SLACK = 2;
const SELF = 'p0';
const FRET_TIER = 2;

/** A deterministic ring: `assembleCohort(coord, wants)` returns the configured nearest-first ordering, truncated. */
class RingStub implements FretRingView {
	private readonly orderings = new Map<string, string[]>();
	public partitioned = false;

	set(coord: Uint8Array, nearestFirst: string[]): this {
		this.orderings.set(bytesToB64url(coord), nearestFirst);
		return this;
	}

	assembleCohort(coord: Uint8Array, wants: number): string[] {
		return (this.orderings.get(bytesToB64url(coord)) ?? []).slice(0, wants);
	}

	detectPartition(): boolean {
		return this.partitioned;
	}
}

/** A 32-byte coord from a seed byte. */
function coordOf(seed: number): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_v, i) => (seed + i) & 0xff);
}

/** The on-wire signer form for a peer-id string: base64url of the peer-codec bytes (UTF-8 of the id string). */
function signerWire(id: string): string {
	return bytesToB64url(peerIdToBytes(id));
}

/** A cert carrying just the fields the anchor reads (coord + signing quorum); the rest is placeholder. */
function certOver(coord: Uint8Array, signerIds: readonly string[]): MembershipCertV1 {
	const wire = signerIds.map(signerWire);
	return {
		v: 1,
		cohortCoord: bytesToB64url(coord),
		cohortEpoch: bytesToB64url(new Uint8Array(32)),
		members: wire,
		stabilizedAt: 1_000,
		thresholdSig: bytesToB64url(new Uint8Array(0)),
		signers: wire,
	};
}

function anchorOver(ring: RingStub): FretTrustAnchor {
	return new FretTrustAnchor(ring, { k: K, selfPeerId: SELF, churnSlack: SLACK });
}

describe('cohort-topic / FretTrustAnchor (FRET-ring direct anchor)', () => {
	// A coord the node covers: a populated nearest-first ring that includes self at the front.
	const COVERED = coordOf(10);
	const coveredRing = (): RingStub => new RingStub().set(COVERED, ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);

	it('anchors a cert whose signing quorum is the ring cohort (covered coord)', () => {
		const verdict = anchorOver(coveredRing()).directAnchor(certOver(COVERED, ['p0', 'p1', 'p2', 'p3']), FRET_TIER);
		expect(verdict).to.equal('anchored');
	});

	it('rejects a disjoint (unrelated) keyset on a covered coord — the forged-cert attack', () => {
		const verdict = anchorOver(coveredRing()).directAnchor(certOver(COVERED, ['adv0', 'adv1', 'adv2', 'adv3']), FRET_TIER);
		expect(verdict).to.equal('rejected');
	});

	it('anchors through a 1–2 member stabilization skew within the churn slack', () => {
		// p4 is the (k+1)th-nearest (index 4) — just outside the tight top-k but inside the k+slack widening.
		// A legit cert whose quorum still names p4 (rotated out since stabilization) must stay anchored.
		const verdict = anchorOver(coveredRing()).directAnchor(certOver(COVERED, ['p0', 'p1', 'p2', 'p4']), FRET_TIER);
		expect(verdict).to.equal('anchored');
	});

	it('returns "unknown" on partial overlap beyond the slack (ambiguous churn, do not over-reject)', () => {
		// p6 is index 6 — outside the k+slack=6 widening (indices 0..5); adv0 is not in the ring at all. Two
		// signers in-ring, two out → neither a full subset nor wholly disjoint → unknown, not a reject.
		const verdict = anchorOver(coveredRing()).directAnchor(certOver(COVERED, ['p0', 'p1', 'p6', 'adv0']), FRET_TIER);
		expect(verdict).to.equal('unknown');
	});

	it('returns "unknown" for a coord the node is not part of (distant — no local authority)', () => {
		const DISTANT = coordOf(50);
		// Self (p0) is absent from the nearest-first ordering → the node does not cover this coord.
		const ring = new RingStub().set(DISTANT, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
		const verdict = anchorOver(ring).directAnchor(certOver(DISTANT, ['p1', 'p2', 'p3', 'p4']), FRET_TIER);
		expect(verdict).to.equal('unknown');
	});

	it('returns "unknown" for a cold / sub-k ring (bootstrap / partition shape), never "rejected"', () => {
		const COLD = coordOf(70);
		// Even with a disjoint quorum, a ring that yields fewer than k members cannot judge — must not reject.
		const ring = new RingStub().set(COLD, ['p0', 'p1']);
		const verdict = anchorOver(ring).directAnchor(certOver(COLD, ['adv0', 'adv1', 'adv2', 'adv3']), FRET_TIER);
		expect(verdict).to.equal('unknown');
	});

	it('returns "unknown" while the node believes it is partitioned (never reject during a partition)', () => {
		const ring = coveredRing();
		ring.partitioned = true;
		// A disjoint quorum that would otherwise be rejected is deferred to TOFU while partitioned.
		const verdict = anchorOver(ring).directAnchor(certOver(COVERED, ['adv0', 'adv1', 'adv2', 'adv3']), FRET_TIER);
		expect(verdict).to.equal('unknown');
	});

	it('returns "unknown" for the committed tiers T0/T1 (the tx-log anchor\'s job, not the FRET ring)', () => {
		const anchor = anchorOver(coveredRing());
		// A would-be-rejected forged quorum and a would-be-anchored legit quorum both defer at T0/T1.
		expect(anchor.directAnchor(certOver(COVERED, ['adv0', 'adv1', 'adv2', 'adv3']), 0), 'T0 defers').to.equal('unknown');
		expect(anchor.directAnchor(certOver(COVERED, ['p0', 'p1', 'p2', 'p3']), 1), 'T1 defers').to.equal('unknown');
	});

	it('judges both FRET tiers (T2 and T3)', () => {
		const anchor = anchorOver(coveredRing());
		expect(anchor.directAnchor(certOver(COVERED, ['p0', 'p1', 'p2', 'p3']), 2), 'T2 anchored').to.equal('anchored');
		expect(anchor.directAnchor(certOver(COVERED, ['p0', 'p1', 'p2', 'p3']), 3), 'T3 anchored').to.equal('anchored');
		expect(anchor.directAnchor(certOver(COVERED, ['adv0', 'adv1', 'adv2', 'adv3']), 3), 'T3 rejected').to.equal('rejected');
	});

	it('is total: an undecodable signer yields "unknown", never a throw', () => {
		// A signer whose bytes are not valid UTF-8 fails the peer-id decode; the anchor must swallow it.
		const badSigner = bytesToB64url(Uint8Array.from([0xff, 0xfe, 0xfd]));
		const cert = certOver(COVERED, ['p0', 'p1', 'p2']);
		cert.signers = [badSigner, ...cert.signers];
		expect(anchorOver(coveredRing()).directAnchor(cert, FRET_TIER)).to.equal('unknown');
	});

	it('returns "unknown" for an empty signing quorum (defensive — nothing to judge), never "rejected"', () => {
		// A cert with no signers cannot pass self-consistency upstream, but the anchor must still be total: an
		// empty quorum is neither a subset nor wholly disjoint, so the guard short-circuits to "unknown".
		const cert = certOver(COVERED, []);
		expect(anchorOver(coveredRing()).directAnchor(cert, FRET_TIER)).to.equal('unknown');
	});

	it('applies the default churn slack and committed-tier when options omit them', () => {
		// Construct with neither churnSlack nor maxCommittedTier so the `?? DEFAULT_*` fallbacks are exercised:
		// the default slack (2) still anchors a k+1 stabilization skew, and the default committed tier (1)
		// still defers T0/T1 while judging T2.
		const anchor = new FretTrustAnchor(coveredRing(), { k: K, selfPeerId: SELF });
		expect(anchor.directAnchor(certOver(COVERED, ['p0', 'p1', 'p2', 'p4']), FRET_TIER), 'default slack anchors a k+1 skew').to.equal('anchored');
		expect(anchor.directAnchor(certOver(COVERED, ['adv0', 'adv1', 'adv2', 'adv3']), 1), 'default committed tier defers T1').to.equal('unknown');
		expect(anchor.directAnchor(certOver(COVERED, ['adv0', 'adv1', 'adv2', 'adv3']), FRET_TIER), 'default still rejects a disjoint quorum at T2').to.equal('rejected');
	});

	// --- root placement (cohort-topic-host-serves-a-root-at-a-storage-group) ---
	describe('a root-placed coord', () => {
		const ROOT = coordOf(90);
		const PLACEMENT = createRootPlacement(0.75);
		/** A ring whose `wantK` cohort around ROOT (self included) shares nothing with the root group, over an anchor reading `groups`. */
		function rootAnchor(groups: Map<string, readonly string[]>): FretTrustAnchor {
			const ring = new RingStub().set(ROOT, ['p0', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4']);
			return new FretTrustAnchor(ring, { k: K, selfPeerId: SELF, churnSlack: SLACK, rootGroupAt: (coord): readonly string[] | undefined => groups.get(bytesToB64url(coord)) });
		}
		const groupOf = (members: readonly string[]): Map<string, readonly string[]> => new Map([[bytesToB64url(ROOT), members]]);

		it('is judged against the root group, whatever the FRET cohort around the coord says', () => {
			const anchor = rootAnchor(groupOf(['p0', 'p1', 'p2']));
			expect(anchor.directAnchor(certOver(ROOT, ['p0', 'p1', 'p2']), 0, PLACEMENT), 'signers = the group → anchored, at the committed tier too').to.equal('anchored');
			expect(anchor.directAnchor(certOver(ROOT, ['adv0', 'adv1']), 0, PLACEMENT), 'a disjoint keyset → rejected').to.equal('rejected');
			expect(anchor.directAnchor(certOver(ROOT, ['p0', 'p1', 'p9']), 0, PLACEMENT), 'a signer outside the group (rotated out, or a ring neighbour) → unknown, never rejected').to.equal('unknown');
			expect(anchor.directAnchor(certOver(ROOT, ['p1']), 0, PLACEMENT), 'one group member listing itself alone is under the quorum of the group → unknown').to.equal('unknown');
			expect(anchor.directAnchor(certOver(ROOT, ['p0', 'p1', 'p2']), FRET_TIER), 'without the placement the ring is consulted, and it does not vouch for the group').to.equal('unknown');
		});

		it('is "unknown" when the anchor holds no group it can judge by: no snapshot, a group omitting self, a group of self alone, no reader', () => {
			const cert = certOver(ROOT, ['p0', 'p1', 'p2']);
			expect(rootAnchor(new Map()).directAnchor(cert, 0, PLACEMENT), 'no snapshot read for the coord').to.equal('unknown');
			expect(rootAnchor(groupOf(['p1', 'p2', 'p3'])).directAnchor(cert, 0, PLACEMENT), 'a group this node is not in').to.equal('unknown');
			expect(rootAnchor(groupOf(['p0'])).directAnchor(certOver(ROOT, ['adv0']), 0, PLACEMENT), 'a group of self alone, which a cold table answers for every key').to.equal('unknown');
			expect(anchorOver(coveredRing()).directAnchor(certOver(COVERED, ['p0', 'p1', 'p2', 'p3']), FRET_TIER, PLACEMENT), 'an anchor with no root-group reader').to.equal('unknown');
		});
	});
});
