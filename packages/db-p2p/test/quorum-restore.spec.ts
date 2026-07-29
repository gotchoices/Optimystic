/**
 * Ticket: p2p-read-repair-verify-peer-claims
 *
 * Unit specs for the quorum-corroboration primitives shared by the read-repair
 * and reconcile restoration paths. Covers rev selection (single/minority liars,
 * honest quorum, small-cluster fallback) and the reconcile CONTENT-agreement gate
 * (a cohort member serving content that hashes differently is rejected).
 */

import { expect } from 'chai';
import type { IBlock } from '@optimystic/db-core';
import {
	quorumSize, selectQuorumRev, selectQuorumBlock, canonicalBlockHash,
	type RevClaim, type BlockHashCandidate
} from '../src/cluster/quorum-restore.js';

const THRESHOLD = 0.51;

const block = (id: string, extra: Record<string, unknown> = {}): IBlock =>
	({ header: { id, type: 'test', collectionId: 'c', ...extra } } as unknown as IBlock);

describe('quorum-restore primitives', () => {
	describe('quorumSize', () => {
		it('is floor(threshold × responders) with an absolute minimum of 2', () => {
			expect(quorumSize(0, THRESHOLD)).to.equal(2);
			expect(quorumSize(1, THRESHOLD)).to.equal(2);
			expect(quorumSize(2, THRESHOLD)).to.equal(2); // floor(1.02)=1 → min 2
			expect(quorumSize(3, THRESHOLD)).to.equal(2); // floor(1.53)=1 → min 2
			expect(quorumSize(4, THRESHOLD)).to.equal(2); // floor(2.04)=2
			expect(quorumSize(6, THRESHOLD)).to.equal(3); // floor(3.06)=3
			expect(quorumSize(10, THRESHOLD)).to.equal(5);
		});
	});

	describe('selectQuorumRev', () => {
		it('returns undefined for no claims', () => {
			expect(selectQuorumRev([], THRESHOLD)).to.equal(undefined);
		});

		it('outvotes a single liar and picks the honest quorum pair', () => {
			const claims: RevClaim[] = [
				{ peerId: 'local', rev: 1, actionId: 'a' },
				{ peerId: 'h1', rev: 1, actionId: 'a' },
				{ peerId: 'h2', rev: 1, actionId: 'a' },
				{ peerId: 'liar', rev: 99, actionId: 'bogus' }
			];
			const sel = selectQuorumRev(claims, THRESHOLD);
			expect(sel).to.not.equal(undefined);
			expect(sel!.rev).to.equal(1);
			expect(sel!.actionId).to.equal('a');
			expect(sel!.supporters.sort()).to.deep.equal(['h1', 'h2', 'local']);
		});

		it('prefers the highest rev among quorum-corroborated pairs', () => {
			const claims: RevClaim[] = [
				{ peerId: 'local', rev: 1, actionId: 'a' },
				{ peerId: 'lag', rev: 1, actionId: 'a' },
				{ peerId: 'h1', rev: 5, actionId: 'e' },
				{ peerId: 'h2', rev: 5, actionId: 'e' }
			];
			const sel = selectQuorumRev(claims, THRESHOLD);
			expect(sel!.rev).to.equal(5);
			expect(sel!.actionId).to.equal('e');
		});

		it('declines when nothing reaches quorum and responders disagree', () => {
			const claims: RevClaim[] = [
				{ peerId: 'p1', rev: 1, actionId: 'a' },
				{ peerId: 'p2', rev: 2, actionId: 'b' },
				{ peerId: 'p3', rev: 3, actionId: 'c' }
			];
			expect(selectQuorumRev(claims, THRESHOLD)).to.equal(undefined);
		});

		it('falls back to a single responder when all agree (honest lagging peer)', () => {
			const claims: RevClaim[] = [{ peerId: 'only', rev: 2, actionId: 'x' }];
			const sel = selectQuorumRev(claims, THRESHOLD);
			expect(sel!.rev).to.equal(2);
			expect(sel!.actionId).to.equal('x');
		});

		it('does NOT fall back when the few responders disagree', () => {
			const claims: RevClaim[] = [
				{ peerId: 'p1', rev: 2, actionId: 'x' },
				{ peerId: 'p2', rev: 9, actionId: 'y' }
			];
			// 2 responders, quorum 2, neither pair seconded → decline (no fallback).
			expect(selectQuorumRev(claims, THRESHOLD)).to.equal(undefined);
		});

		/**
		 * Defect repro: 2-node cluster stale read reported as a successful sync.
		 *
		 * `clusterLatestCallback` self-short-circuits to local storage, so the READER'S
		 * OWN revision is one of the claims. In a 2-node cohort that leaves only two
		 * possible outcomes, and neither can ever repair a divergence:
		 *   - remote drops out (1 s timeout / unreachable) → the reader's own stale
		 *     claim is the lone group and the small-cluster fallback accepts it, so
		 *     `CoordinatorRepo` "restores" to the rev it already had;
		 *   - remote answers with a higher rev → 2 responders, quorum 2 (unanimity),
		 *     two singleton groups, `responderCount < quorum` is false → decline.
		 */
		it('DEFECT: accepts the reader\'s OWN stale claim when the only other peer drops out', () => {
			// Node B holds rev 1; node A committed rev 2 but its response timed out.
			const claims: RevClaim[] = [{ peerId: 'self-node-b', rev: 1, actionId: 'stale-action' }];
			const sel = selectQuorumRev(claims, THRESHOLD);
			// A single self-claim is corroborated by nobody, yet it is returned as the
			// quorum result — the caller cannot tell this apart from a real quorum.
			expect(sel, 'lone self-claim is accepted as a quorum result').to.not.equal(undefined);
			expect(sel!.rev).to.equal(1);
			expect(sel!.actionId).to.equal('stale-action');
			expect(sel!.supporters).to.deep.equal(['self-node-b']);
		});

		it('DEFECT: a 2-node divergence is structurally unrepairable (quorum 2 == unanimity)', () => {
			// Both nodes answer; they disagree, which is exactly the case read-repair exists for.
			const claims: RevClaim[] = [
				{ peerId: 'self-node-b', rev: 1, actionId: 'stale-action' },
				{ peerId: 'node-a', rev: 2, actionId: 'fresh-action' }
			];
			expect(quorumSize(2, THRESHOLD), '2 responders require 2 votes — unanimity').to.equal(2);
			// No group reaches 2, and the fallback needs responderCount < quorum (2 < 2 is false),
			// so the fresh rev 2 is never adopted no matter how many times the read is retried.
			expect(selectQuorumRev(claims, THRESHOLD)).to.equal(undefined);
		});

		it('counts one vote per distinct peer (duplicate peerId does not inflate a group)', () => {
			const claims: RevClaim[] = [
				{ peerId: 'liar', rev: 99, actionId: 'bogus' },
				{ peerId: 'liar', rev: 99, actionId: 'bogus' },
				{ peerId: 'h1', rev: 1, actionId: 'a' }
			];
			// The liar's pair has only ONE distinct voter; nothing reaches quorum 2,
			// and responders disagree → decline.
			expect(selectQuorumRev(claims, THRESHOLD)).to.equal(undefined);
		});
	});

	describe('canonicalBlockHash', () => {
		it('is stable across key ordering and differs on content', async () => {
			const h1 = await canonicalBlockHash(block('b', { x: 1, y: 2 }));
			const h2 = await canonicalBlockHash(block('b', { y: 2, x: 1 }));
			const h3 = await canonicalBlockHash(block('b', { x: 9, y: 2 }));
			expect(h1).to.equal(h2);
			expect(h1).to.not.equal(h3);
		});
	});

	describe('selectQuorumBlock (reconcile content agreement)', () => {
		const hashed = async (peerId: string, b: IBlock): Promise<BlockHashCandidate> =>
			({ peerId, hash: await canonicalBlockHash(b), block: b });

		it('accepts the block content agreed by a quorum', async () => {
			const good = block('b', { payload: 'ok' });
			const cands = await Promise.all([
				hashed('h1', good),
				hashed('h2', block('b', { payload: 'ok' })) // identical content, distinct instance
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD);
			expect(sel, 'quorum-agreed content persists').to.not.equal(undefined);
		});

		it('REJECTS a cohort member serving content that hashes differently', async () => {
			const good = block('b', { payload: 'ok' });
			const cands = await Promise.all([
				hashed('h1', good),
				hashed('h2', block('b', { payload: 'ok' })),
				hashed('evil', block('b', { payload: 'tampered' }))
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD);
			// 3 voters, quorum 2: only the honest 'ok' pair reaches quorum; the tampered
			// singleton is dropped. The persisted block is the honest one.
			expect(sel).to.not.equal(undefined);
			const honestHash = await canonicalBlockHash(good);
			expect(sel!.hash).to.equal(honestHash);
		});

		it('declines when only a single block is available (no content quorum)', async () => {
			const cands = await Promise.all([hashed('h1', block('b', { payload: 'ok' }))]);
			// quorum is 2; a lone block cannot be corroborated → skip persist.
			expect(selectQuorumBlock(cands, THRESHOLD)).to.equal(undefined);
		});

		it('declines on an even content split (ambiguous, no unique quorum)', async () => {
			const cands = await Promise.all([
				hashed('a1', block('b', { payload: 'A' })),
				hashed('a2', block('b', { payload: 'A' })),
				hashed('b1', block('b', { payload: 'B' })),
				hashed('b2', block('b', { payload: 'B' }))
			]);
			// 4 voters, quorum 2: both hash groups reach 2 → ambiguous → decline.
			expect(selectQuorumBlock(cands, THRESHOLD)).to.equal(undefined);
		});
	});
});
