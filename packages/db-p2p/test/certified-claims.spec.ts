/**
 * Ticket: certified-claim-selection (chain: accept-certified-claims-in-repair).
 *
 * The shared certification layer both repair paths run a peer-attached cohort commit proof
 * through (`src/cluster/certified-claims.ts`): the pre-verification signer cap, the
 * attributable/non-attributable failure classification, and the observational anchoring layer —
 * pinned hard here: cohort overlap is LOGGED, never a gate, so a proof for old data whose cohort
 * has fully rotated still certifies.
 *
 * Real proofs come from `support/commit-proof-fixtures.ts` — the same hash/signing recipe the
 * coordinator and members use.
 */

import { expect } from 'chai';
import { canonicalBlockHash } from '@optimystic/db-core';
import type { ActionId, BlockContentDigests, BlockId, CommitRequest, IBlock } from '@optimystic/db-core';
import {
	MAX_PROOF_SIGNERS, NON_ATTRIBUTABLE_PROOF_FAILURES, certifyClaim, certifyContent,
	isAttributableProofFailure, type ProofAnchoring, type UnanchoredProofAcceptance
} from '../src/cluster/certified-claims.js';
import type { BlockCommitProof, ProofClaim } from '../src/cluster/commit-proof.js';
import { PROOF_THRESHOLDS, makeSignedProof } from './support/commit-proof-fixtures.js';

const BLOCK = 'block-1' as BlockId;
const ACTION = 'action-1' as ActionId;

const makeCommit = (blockDigests?: BlockContentDigests, over: Partial<CommitRequest> = {}): CommitRequest => ({
	actionId: ACTION,
	blockIds: [BLOCK],
	tailId: BLOCK,
	rev: 1,
	...(blockDigests ? { blockDigests } : {}),
	...over
});

const claimFor = (commit: CommitRequest): ProofClaim =>
	({ blockId: BLOCK, rev: commit.rev, actionId: commit.actionId });

const testBlock = (payload = 'x'): IBlock => ({
	header: { id: BLOCK, type: 'test', collectionId: 'collection-1' as BlockId },
	items: [payload]
} as unknown as IBlock);

/** An anchoring whose onUnanchored records every call. */
const recordingAnchoring = (extra: Omit<ProofAnchoring, 'onUnanchored'> = {}): {
	anchoring: ProofAnchoring; calls: UnanchoredProofAcceptance[];
} => {
	const calls: UnanchoredProofAcceptance[] = [];
	return { anchoring: { ...extra, onUnanchored: info => { calls.push(info); } }, calls };
};

describe('certified-claims (shared proof certification)', () => {
	describe('certifyClaim', () => {
		it('certifies a genuine fully-signed proof', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const result = await certifyClaim(proof, claimFor(commit), PROOF_THRESHOLDS);
			expect(result.certified).to.equal(true);
			expect(result.failure).to.equal(undefined);
		});

		it('declines an oversized signer list BEFORE any hash/signature work, non-attributably', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(2, commit);
			// A peerIds list this size would fail membership-mismatch if verification ran at all;
			// seeing 'oversized-cohort' instead proves the cap fired first, before hashing.
			const oversized: BlockCommitProof = {
				...proof,
				peerIds: Array.from({ length: MAX_PROOF_SIGNERS + 1 }, (_, i) => `fake-peer-${i}`)
			};
			const result = await certifyClaim(oversized, claimFor(commit), PROOF_THRESHOLDS);
			expect(result.certified).to.equal(false);
			expect(result.failure).to.equal('oversized-cohort');
			expect(NON_ATTRIBUTABLE_PROOF_FAILURES.has(result.failure!)).to.equal(true);
			expect(isAttributableProofFailure(result.failure!)).to.equal(false);
		});

		it('a cohort exactly AT the cap still verifies structurally (cap is >, not >=)', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(2, commit);
			const atCap: BlockCommitProof = {
				...proof,
				peerIds: Array.from({ length: MAX_PROOF_SIGNERS }, (_, i) => `fake-peer-${i}`)
			};
			// Passes the cap, then fails real verification (the digest no longer matches) — the
			// point is only that the failure is NOT 'oversized-cohort'.
			const result = await certifyClaim(atCap, claimFor(commit), PROOF_THRESHOLDS);
			expect(result.certified).to.equal(false);
			expect(result.failure).to.not.equal('oversized-cohort');
		});

		it('classifies a replayed proof (genuine, but for a different claim) as attributable', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const replayed = await certifyClaim(
				proof, { blockId: BLOCK, rev: 9, actionId: commit.actionId }, PROOF_THRESHOLDS);
			expect(replayed.certified).to.equal(false);
			expect(replayed.failure).to.equal('claim-not-in-message');
			expect(NON_ATTRIBUTABLE_PROOF_FAILURES.has(replayed.failure!)).to.equal(false);
			expect(isAttributableProofFailure(replayed.failure!)).to.equal(true);
		});

		it('classifies structural garbage as non-attributable and never throws', async () => {
			const commit = makeCommit();
			const result = await certifyClaim(
				null as unknown as BlockCommitProof, claimFor(commit), PROOF_THRESHOLDS);
			expect(result.certified).to.equal(false);
			expect(result.failure).to.equal('malformed-proof');
			expect(isAttributableProofFailure(result.failure!)).to.equal(false);
		});
	});

	describe('anchoring (observational — never a gate)', () => {
		it('with no recompute capability: certifies AND surfaces onUnanchored(no-recompute-capability)', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const { anchoring, calls } = recordingAnchoring();
			const result = await certifyClaim(proof, claimFor(commit), PROOF_THRESHOLDS, anchoring);
			expect(result.certified).to.equal(true);
			expect(calls).to.deep.equal([{
				blockId: BLOCK, rev: commit.rev, actionId: commit.actionId,
				signerCount: 3, reason: 'no-recompute-capability'
			}]);
		});

		it('with an infeasible recompute: certifies AND surfaces onUnanchored(recompute-infeasible)', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const { anchoring, calls } = recordingAnchoring({
				recomputeBlockCohort: async () => ({ feasible: false })
			});
			const result = await certifyClaim(proof, claimFor(commit), PROOF_THRESHOLDS, anchoring);
			expect(result.certified).to.equal(true);
			expect(calls.map(c => c.reason)).to.deep.equal(['recompute-infeasible']);
		});

		it('feasible recompute with ZERO cohort overlap still certifies — overlap is never a gate', async () => {
			// Historic cohort rotation makes zero overlap legitimate for old data; gating here
			// would re-create the lone-holder-unreadable defect this whole path exists to fix.
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const { anchoring, calls } = recordingAnchoring({
				recomputeBlockCohort: async () => ({ feasible: true, cohortPeerIds: ['unrelated-1', 'unrelated-2'] })
			});
			const result = await certifyClaim(proof, claimFor(commit), PROOF_THRESHOLDS, anchoring);
			expect(result.certified).to.equal(true);
			// The comparison ran, so this acceptance is anchored (however poor the overlap): no
			// unanchored surfacing.
			expect(calls).to.deep.equal([]);
		});

		it('a THROWING recompute degrades to recompute-infeasible instead of un-certifying', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const { anchoring, calls } = recordingAnchoring({
				recomputeBlockCohort: async () => { throw new Error('routing view unavailable'); }
			});
			const result = await certifyClaim(proof, claimFor(commit), PROOF_THRESHOLDS, anchoring);
			expect(result.certified).to.equal(true);
			expect(calls.map(c => c.reason)).to.deep.equal(['recompute-infeasible']);
		});

		it('a THROWING onUnanchored is swallowed — certification stands', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const result = await certifyClaim(proof, claimFor(commit), PROOF_THRESHOLDS, {
				onUnanchored: () => { throw new Error('observer exploded'); }
			});
			expect(result.certified).to.equal(true);
		});
	});

	describe('certifyContent', () => {
		it('certifies rev AND content when the declared digest matches the served bytes', async () => {
			const served = testBlock('committed-content');
			const digest = await canonicalBlockHash(served);
			const commit = makeCommit({ [BLOCK]: { digest } });
			const { proof } = await makeSignedProof(3, commit);
			const { anchoring, calls } = recordingAnchoring();
			const result = await certifyContent(proof, claimFor(commit), served, PROOF_THRESHOLDS, anchoring);
			expect(result).to.deep.equal({ revCertified: true, contentCertified: true });
			expect(calls.map(c => c.reason)).to.deep.equal(['no-recompute-capability']);
		});

		it('digest-mismatch: rev stays certified, content does not, and the failure is attributable', async () => {
			const committed = testBlock('committed-content');
			const digest = await canonicalBlockHash(committed);
			const commit = makeCommit({ [BLOCK]: { digest } });
			const { proof } = await makeSignedProof(3, commit);
			const result = await certifyContent(
				proof, claimFor(commit), testBlock('tampered-content'), PROOF_THRESHOLDS);
			expect(result.revCertified).to.equal(true);
			expect(result.contentCertified).to.equal(false);
			expect(result.failure).to.equal('digest-mismatch');
			expect(isAttributableProofFailure(result.failure!)).to.equal(true);
		});

		it('no-digest-declared: rev stays certified, content does not, and NO penalty attaches', async () => {
			const commit = makeCommit(); // no blockDigests — nothing to compare against
			const { proof } = await makeSignedProof(3, commit);
			const result = await certifyContent(
				proof, claimFor(commit), testBlock(), PROOF_THRESHOLDS);
			expect(result.revCertified).to.equal(true);
			expect(result.contentCertified).to.equal(false);
			expect(result.failure).to.equal('no-digest-declared');
			expect(isAttributableProofFailure(result.failure!)).to.equal(false);
		});

		it('a claim-half failure certifies NEITHER half', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const result = await certifyContent(
				proof, { blockId: BLOCK, rev: 9, actionId: commit.actionId }, testBlock(), PROOF_THRESHOLDS);
			expect(result).to.deep.equal({
				revCertified: false, contentCertified: false, failure: 'claim-not-in-message'
			});
		});

		it('declines an oversized signer list before verification, like the claim half', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(2, commit);
			const oversized: BlockCommitProof = {
				...proof,
				peerIds: Array.from({ length: MAX_PROOF_SIGNERS + 1 }, (_, i) => `fake-peer-${i}`)
			};
			const result = await certifyContent(
				oversized, claimFor(commit), testBlock(), PROOF_THRESHOLDS);
			expect(result).to.deep.equal({
				revCertified: false, contentCertified: false, failure: 'oversized-cohort'
			});
		});
	});
});
