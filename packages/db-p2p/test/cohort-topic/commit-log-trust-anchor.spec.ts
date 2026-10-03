/**
 * Unit coverage for the commit-log direct trust anchor (`feat-reactivity-root-membership-anchored-by-the-commit-log`):
 * {@link CommitLogTrustAnchor.directAnchor} judged over real multi-peer commit proofs (the shared
 * `support/commit-proof-fixtures.ts` builders, so every proof here is one a real cohort would produce) and a
 * stub root group / latest-claim wire.
 *
 * The anchor reads only `cert.cohortCoord` and `cert.signers`, so the certs carry no real multisig —
 * self-consistency is the verifier's job (db-core `membership.spec.ts`); this isolates the commit-log rule.
 *
 * Covered: signers inside the committing cohort → `"anchored"`; a disjoint keyset → `"rejected"`; partial
 * overlap → `"unknown"`; no proof served → `"unknown"`; a root key that does not hash to the cert's coord →
 * `"unknown"` with no query; the highest certified revision wins over a lagging peer's older proof; two
 * certified actions at the top revision (equivocation) → `"unknown"`; and the per-tail cache with its
 * single in-flight fetch.
 */

import { expect } from 'chai';
import { bytesToB64url, createRingHash, createRootPlacement, routingKeyForBlock } from '@optimystic/db-core';
import type { BlockId, CommitRequest, MembershipCertV1 } from '@optimystic/db-core';
import { CommitLogTrustAnchor } from '../../src/cohort-topic/commit-log-trust-anchor.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';
import type { CertifiedActionRev } from '../../src/storage/block-archive.js';
import { PROOF_THRESHOLDS, makeKeyPairs, makeSignedProof, type KeyPair } from '../support/commit-proof-fixtures.js';

const HASH = createRingHash();
const TAIL = 'tail-block-1' as BlockId;
const TAIL_KEY = routingKeyForBlock(TAIL);
const TAIL_COORD = HASH.H(TAIL_KEY);
const RATIO = 0.75;

const commitOf = (rev: number, actionId: string): CommitRequest =>
	({ actionId, blockIds: [TAIL], tailId: TAIL, rev });

const ids = (keyPairs: readonly KeyPair[]): string[] => keyPairs.map((kp) => kp.peerId.toString());

/** The on-wire signer form for a peer-id string: base64url of the peer-codec bytes. */
const signerWire = (id: string): string => bytesToB64url(peerIdToBytes(id));

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

/** A stub root group: `members` are asked, and each answers from `answers` (a rejection is silence). */
class GroupStub {
	readonly asked: string[] = [];
	constructor(
		readonly members: readonly string[],
		private readonly answers: Record<string, CertifiedActionRev | undefined | Error>,
	) {}

	membersAt = (): Promise<readonly string[]> => Promise.resolve(this.members);

	latestClaimFrom = (peer: string): Promise<CertifiedActionRev | undefined> => {
		this.asked.push(peer);
		const answer = this.answers[peer];
		return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
	};
}

function anchorOver(group: GroupStub, extra: { now?: () => number; ttlMs?: number } = {}): CommitLogTrustAnchor {
	return new CommitLogTrustAnchor({
		membersAt: group.membersAt,
		latestClaimFrom: group.latestClaimFrom,
		thresholds: PROOF_THRESHOLDS,
		hash: HASH,
		...extra,
	});
}

const placement = createRootPlacement(RATIO, TAIL_KEY);

describe('cohort-topic / CommitLogTrustAnchor (commit-log direct anchor)', () => {
	it('anchors a cert whose signers are in the committing cohort of the tail\'s certified proof', async () => {
		const { keyPairs, proof } = await makeSignedProof(4, commitOf(3, 'a3'));
		const cohort = ids(keyPairs);
		const claim: CertifiedActionRev = { actionId: 'a3', rev: 3, proof };
		const group = new GroupStub(cohort, Object.fromEntries(cohort.map((id) => [id, claim])));
		const verdict = await anchorOver(group).directAnchor(certOver(TAIL_COORD, cohort.slice(0, 3)), 3, placement);
		expect(verdict).to.equal('anchored');
		expect(group.asked, 'every group member was asked once').to.have.members(cohort);
	});

	it('rejects a cert whose signing quorum is disjoint from the committing cohort', async () => {
		const { keyPairs, proof } = await makeSignedProof(3, commitOf(3, 'a3'));
		const cohort = ids(keyPairs);
		const forgers = ids(await makeKeyPairs(3));
		const claim: CertifiedActionRev = { actionId: 'a3', rev: 3, proof };
		const group = new GroupStub(cohort, Object.fromEntries(cohort.map((id) => [id, claim])));
		expect(await anchorOver(group).directAnchor(certOver(TAIL_COORD, forgers), 3, placement)).to.equal('rejected');
	});

	it('is unknown on a partial overlap (membership churned between the commit and the cert)', async () => {
		const { keyPairs, proof } = await makeSignedProof(3, commitOf(3, 'a3'));
		const cohort = ids(keyPairs);
		const [newcomer] = ids(await makeKeyPairs(1));
		const claim: CertifiedActionRev = { actionId: 'a3', rev: 3, proof };
		const group = new GroupStub(cohort, Object.fromEntries(cohort.map((id) => [id, claim])));
		expect(await anchorOver(group).directAnchor(certOver(TAIL_COORD, [cohort[0]!, newcomer!]), 3, placement)).to.equal('unknown');
	});

	it('is unknown for a cert signed by fewer of the committing cohort than its quorum (one member listing itself alone)', async () => {
		// A root-placed cert's own threshold is a ratio of the members it lists, so a single real member is a
		// full quorum of a one-member list; the anchor counts the quorum against the committing cohort instead.
		const { keyPairs, proof } = await makeSignedProof(4, commitOf(3, 'a3'));
		const cohort = ids(keyPairs);
		const claim: CertifiedActionRev = { actionId: 'a3', rev: 3, proof };
		const group = new GroupStub(cohort, Object.fromEntries(cohort.map((id) => [id, claim])));
		const anchor = anchorOver(group);
		expect(await anchor.directAnchor(certOver(TAIL_COORD, [cohort[0]!]), 3, placement), 'one of four').to.equal('unknown');
		expect(await anchor.directAnchor(certOver(TAIL_COORD, cohort.slice(0, 2)), 3, placement), 'two of four, under ceil(4 × 0.75)').to.equal('unknown');
	});

	it('is unknown when no member serves a proof (pre-proof tail, or every peer silent)', async () => {
		const cohort = ids(await makeKeyPairs(3));
		const group = new GroupStub(cohort, {
			[cohort[0]!]: { actionId: 'a3', rev: 3 }, // a claim with no proof: an un-upgraded or diverged peer
			[cohort[1]!]: undefined, // holds nothing
			[cohort[2]!]: new Error('dial timeout'), // silence
		});
		expect(await anchorOver(group).directAnchor(certOver(TAIL_COORD, cohort), 3, placement)).to.equal('unknown');
	});

	it('is unknown, without asking anyone, when the root key does not hash to the cert\'s coord', async () => {
		const { keyPairs, proof } = await makeSignedProof(3, commitOf(3, 'a3'));
		const cohort = ids(keyPairs);
		const claim: CertifiedActionRev = { actionId: 'a3', rev: 3, proof };
		const group = new GroupStub(cohort, Object.fromEntries(cohort.map((id) => [id, claim])));
		const otherKey = routingKeyForBlock('some-other-block' as BlockId);
		const verdict = await anchorOver(group).directAnchor(certOver(TAIL_COORD, cohort), 3, createRootPlacement(RATIO, otherKey));
		expect(verdict).to.equal('unknown');
		expect(group.asked, 'a key for another coordinate is never judged against this one').to.have.length(0);
	});

	it('takes the highest certified revision, so a lagging peer\'s older proof does not decide', async () => {
		const old = await makeSignedProof(3, commitOf(2, 'a2'));
		const current = await makeSignedProof(3, commitOf(5, 'a5'));
		const oldCohort = ids(old.keyPairs);
		const currentCohort = ids(current.keyPairs);
		// The group as this node derives it is the current cohort; one member lags and still serves rev 2.
		const group = new GroupStub(currentCohort, {
			[currentCohort[0]!]: { actionId: 'a2', rev: 2, proof: old.proof },
			[currentCohort[1]!]: { actionId: 'a5', rev: 5, proof: current.proof },
			[currentCohort[2]!]: { actionId: 'a5', rev: 5, proof: current.proof },
		});
		const anchor = anchorOver(group);
		expect(await anchor.directAnchor(certOver(TAIL_COORD, currentCohort), 3, placement), 'the current cohort').to.equal('anchored');
		expect(await anchor.directAnchor(certOver(TAIL_COORD, oldCohort), 3, placement), 'the superseded cohort').to.equal('rejected');
	});

	it('is unknown on an equivocation: two certified actions at the top revision', async () => {
		const left = await makeSignedProof(3, commitOf(5, 'a5-left'));
		const right = await makeSignedProof(3, commitOf(5, 'a5-right'));
		const cohort = ids(left.keyPairs);
		const group = new GroupStub(cohort, {
			[cohort[0]!]: { actionId: 'a5-left', rev: 5, proof: left.proof },
			[cohort[1]!]: { actionId: 'a5-right', rev: 5, proof: right.proof },
			[cohort[2]!]: { actionId: 'a5-left', rev: 5, proof: left.proof },
		});
		expect(await anchorOver(group).directAnchor(certOver(TAIL_COORD, cohort), 3, placement)).to.equal('unknown');
	});

	it('caches one anchoring set per tail for the window, and concurrent first calls share one fetch', async () => {
		const { keyPairs, proof } = await makeSignedProof(3, commitOf(3, 'a3'));
		const cohort = ids(keyPairs);
		const claim: CertifiedActionRev = { actionId: 'a3', rev: 3, proof };
		const group = new GroupStub(cohort, Object.fromEntries(cohort.map((id) => [id, claim])));
		let now = 1_000;
		const anchor = anchorOver(group, { now: () => now, ttlMs: 30_000 });
		const cert = certOver(TAIL_COORD, cohort);

		const verdicts = await Promise.all([anchor.directAnchor(cert, 3, placement), anchor.directAnchor(cert, 3, placement)]);
		expect(verdicts).to.deep.equal(['anchored', 'anchored']);
		expect(group.asked, 'two concurrent first calls issue one round of queries').to.have.length(cohort.length);

		now += 29_000;
		expect(await anchor.directAnchor(cert, 3, placement)).to.equal('anchored');
		expect(group.asked, 'a call inside the window issues no query').to.have.length(cohort.length);

		now += 2_000;
		expect(await anchor.directAnchor(cert, 3, placement)).to.equal('anchored');
		expect(group.asked, 'past the window the group is asked again').to.have.length(2 * cohort.length);
	});
});
