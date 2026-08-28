/**
 * Ticket: certified-claim-selection (chain: accept-certified-claims-in-repair).
 *
 * The certified short-circuit in the shared repair-selection helpers: a claim whose cohort commit
 * proof a caller has verified (injected `certified: true` — verification never happens in the
 * selectors) carries the cohort's signature set as its corroboration, so a lone honest holder is
 * sufficient. Pins the settled precedence rules exactly:
 *
 *  - certified beats an UNcorroborated higher rev (which failed quorum and is no evidence);
 *  - a CORROBORATED strictly-higher rev beats certified (legacy uncertified tail stays readable);
 *  - equal-rev tie → certified (the proof outweighs votes);
 *  - two actions certified at the same top rev = equivocation → decline the whole selection;
 *  - no certified claims → byte-identical behavior to the uncertified rules.
 */

import { expect } from 'chai';
import type { IBlock } from '@optimystic/db-core';
import { canonicalBlockHash } from '@optimystic/db-core';
import {
	certifiedEquivocation, selectQuorumBlock, selectQuorumRev,
	type BlockHashCandidate, type RevClaim
} from '../src/cluster/quorum-restore.js';

const THRESHOLD = 0.51;

const claim = (peerId: string, rev: number, actionId: string, certified?: boolean): RevClaim =>
	({ peerId, rev, actionId, ...(certified !== undefined ? { certified } : {}) });

const block = (id: string, extra: Record<string, unknown> = {}): IBlock =>
	({ header: { id, type: 'test', collectionId: 'c', ...extra } } as unknown as IBlock);

describe('certified claim selection (quorum-restore)', () => {
	describe('selectQuorumRev', () => {
		it('selects a single certified claim outright, with no second supporter, at large capacity', () => {
			// Capacity 9 would demand two distinct voters of an uncertified claim; the proof's
			// signature set replaces that seconding.
			const sel = selectQuorumRev([claim('sole-holder', 5, 'a', true)], THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 5, actionId: 'a', supporters: ['sole-holder'], certified: true });
		});

		it('certified 5 beats an UNCORROBORATED 9 — a claim that failed quorum is no evidence', () => {
			const claims = [
				claim('holder', 5, 'a', true),
				claim('lone-latest', 9, 'z') // one voter, quorum needs two → not corroborated
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 5, actionId: 'a', supporters: ['holder'], certified: true });
		});

		it('a CORROBORATED 9 beats certified 5 — corroboration stays a legitimate weaker path', () => {
			// A legacy uncertified tail written after the last proven rev must stay readable.
			const claims = [
				claim('holder', 5, 'a', true),
				claim('h1', 9, 'z'),
				claim('h2', 9, 'z')
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.not.equal(undefined);
			expect(sel!.rev).to.equal(9);
			expect(sel!.actionId).to.equal('z');
			expect(sel!.certified).to.equal(undefined);
		});

		it('the equal-rev tie goes to certified — the proof outweighs votes', () => {
			// Two voters corroborate (5, 'votes-say') while one certified claim proves (5,
			// 'proof-says'): the pair the cohort actually SIGNED wins over what peers now assert.
			const claims = [
				claim('h1', 5, 'votes-say'),
				claim('h2', 5, 'votes-say'),
				claim('holder', 5, 'proof-says', true)
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 5, actionId: 'proof-says', supporters: ['holder'], certified: true });
		});

		it('declines outright on two actions certified at the same top rev (equivocation)', () => {
			const claims = [
				claim('p1', 5, 'a', true),
				claim('p2', 5, 'b', true)
			];
			expect(selectQuorumRev(claims, THRESHOLD, 9)).to.equal(undefined);
			const conflict = certifiedEquivocation(claims);
			expect(conflict).to.not.equal(undefined);
			expect(conflict!.rev).to.equal(5);
			expect(conflict!.actionIds.sort()).to.deep.equal(['a', 'b']);
		});

		it('equivocation declines even when a corroborated pair exists at the SAME rev', () => {
			// Step 4 only yields to a corroborated rev STRICTLY above the top certified rev; at a
			// tie the certified path decides, and a certified conflict there declines everything.
			const claims = [
				claim('h1', 5, 'a'),
				claim('h2', 5, 'a'),
				claim('p1', 5, 'a', true),
				claim('p2', 5, 'b', true)
			];
			expect(selectQuorumRev(claims, THRESHOLD, 9)).to.equal(undefined);
		});

		it('ignores a certified conflict at a LOWER rev than the certified winner', () => {
			// Superseded history, not live equivocation: only the TOP certified rev is examined.
			const claims = [
				claim('winner', 5, 'x', true),
				claim('old1', 3, 'a', true),
				claim('old2', 3, 'b', true)
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 5, actionId: 'x', supporters: ['winner'], certified: true });
			expect(certifiedEquivocation(claims)).to.equal(undefined);
		});

		it('ignores a certified conflict at a LOWER rev than a corroborated winner', () => {
			const claims = [
				claim('h1', 9, 'z'),
				claim('h2', 9, 'z'),
				claim('old1', 3, 'a', true),
				claim('old2', 3, 'b', true)
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel!.rev).to.equal(9);
			expect(sel!.certified).to.equal(undefined);
		});

		it('pools distinct certified claimants of the winning pair as its supporters', () => {
			const claims = [
				claim('p1', 5, 'a', true),
				claim('p2', 5, 'a', true),
				claim('p2', 5, 'a', true) // duplicate peer counted once
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel!.supporters.sort()).to.deep.equal(['p1', 'p2']);
			expect(sel!.certified).to.equal(true);
		});

		it('a certified: false claim is treated exactly as an uncertified one', () => {
			// The flag records a verdict, not a vote weight: an explicit failed verification must
			// not differ from an absent one.
			expect(selectQuorumRev([claim('only', 2, 'x', false)], THRESHOLD, 9)).to.equal(undefined);
			expect(certifiedEquivocation([claim('p1', 5, 'a', false), claim('p2', 5, 'b', false)]))
				.to.equal(undefined);
		});

		describe('with no certified claims, behavior is unchanged', () => {
			it('outvotes a single liar and picks the honest quorum pair', () => {
				const claims = [
					claim('local', 1, 'a'), claim('h1', 1, 'a'), claim('h2', 1, 'a'),
					claim('liar', 99, 'bogus')
				];
				const sel = selectQuorumRev(claims, THRESHOLD);
				expect(sel!.rev).to.equal(1);
				expect(sel!.actionId).to.equal('a');
				expect(sel!.supporters.sort()).to.deep.equal(['h1', 'h2', 'local']);
				expect('certified' in sel!).to.equal(false);
			});

			it('declines a lone uncertified responder where a second corroborator could exist', () => {
				expect(selectQuorumRev([claim('only', 2, 'x')], THRESHOLD, 4)).to.equal(undefined);
			});

			it('still accepts a lone uncertified responder on a declared two-member cohort', () => {
				const sel = selectQuorumRev([claim('only', 2, 'x')], THRESHOLD, 1);
				expect(sel!.rev).to.equal(2);
				expect('certified' in sel!).to.equal(false);
			});
		});
	});

	describe('selectQuorumBlock', () => {
		const hashed = async (peerId: string, b: IBlock, certified?: boolean): Promise<BlockHashCandidate> =>
			({ peerId, hash: await canonicalBlockHash(b), block: b, ...(certified !== undefined ? { certified } : {}) });

		it('accepts a single certified candidate outright, even as the only copy at large capacity', async () => {
			const only = block('b', { payload: 'proven' });
			const cands = [await hashed('sole-holder', only, true)];
			const sel = selectQuorumBlock(cands, THRESHOLD, 9);
			expect(sel).to.not.equal(undefined);
			expect(sel!.hash).to.equal(await canonicalBlockHash(only));
			expect(sel!.block).to.equal(only);
		});

		it('a certified candidate wins over an uncertified majority serving different bytes', async () => {
			const proven = block('b', { payload: 'proven' });
			const cands = await Promise.all([
				hashed('holder', proven, true),
				hashed('m1', block('b', { payload: 'majority' })),
				hashed('m2', block('b', { payload: 'majority' }))
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD, 9);
			expect(sel!.hash).to.equal(await canonicalBlockHash(proven));
		});

		it('two certified candidates agreeing on one hash still win as that single hash', async () => {
			const proven = block('b', { payload: 'proven' });
			const cands = await Promise.all([
				hashed('h1', proven, true),
				hashed('h2', block('b', { payload: 'proven' }), true) // identical content, distinct instance
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD, 9);
			expect(sel!.hash).to.equal(await canonicalBlockHash(proven));
		});

		it('declines on two certified candidates with DIFFERENT hashes (certified content equivocation)', async () => {
			const cands = await Promise.all([
				hashed('h1', block('b', { payload: 'A' }), true),
				hashed('h2', block('b', { payload: 'B' }), true)
			]);
			expect(selectQuorumBlock(cands, THRESHOLD, 9)).to.equal(undefined);
		});

		it('with no certified candidate the hash quorum is unchanged', async () => {
			const good = block('b', { payload: 'ok' });
			const agreeing = await Promise.all([
				hashed('h1', good), hashed('h2', block('b', { payload: 'ok' }))
			]);
			expect(selectQuorumBlock(agreeing, THRESHOLD), 'quorum-agreed content persists').to.not.equal(undefined);
			// A lone uncertified copy still declines where a second carrier could exist...
			expect(selectQuorumBlock([await hashed('h1', good)], THRESHOLD, 4)).to.equal(undefined);
			// ...and a certified: false candidate is exactly an uncertified one.
			expect(selectQuorumBlock([await hashed('h1', good, false)], THRESHOLD, 4)).to.equal(undefined);
		});
	});
});
