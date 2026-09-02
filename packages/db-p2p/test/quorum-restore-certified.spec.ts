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
	certifiedContentEquivocation, certifiedEquivocation, selectQuorumBlock, selectQuorumRev,
	type BlockHashCandidate, type RevClaim
} from '../src/cluster/quorum-restore.js';

const THRESHOLD = 0.51;

const claim = (peerId: string, rev: number, actionId: string, certified?: boolean, signerCount?: number): RevClaim =>
	({
		peerId, rev, actionId,
		...(certified !== undefined ? { certified } : {}),
		...(signerCount !== undefined ? { certifiedSignerCount: signerCount } : {})
	});

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

		it('the equal-rev tie goes to a MULTI-SIGNER certified claim — the cohort proof outweighs votes', () => {
			// Two voters corroborate (5, 'votes-say') while one claim carries a verified THREE-signer
			// proof for (5, 'proof-says'): the pair the cohort actually SIGNED wins over what peers
			// now assert. (A single-signer proof does NOT get this — see the solo-proof cases below.)
			const claims = [
				claim('h1', 5, 'votes-say'),
				claim('h2', 5, 'votes-say'),
				claim('holder', 5, 'proof-says', true, 3)
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 5, actionId: 'proof-says', supporters: ['holder'], certified: true });
		});

		it('a SINGLE-SIGNER certified claim loses the equal-rev tie to multi-peer corroboration', () => {
			// The solo-fork case (ticket single-signer-proof-outweighs-corroboration): a machine that
			// was briefly alone self-signed (5, 'solo-fork'); the cohort's peers agree on (5, 'cohort')
			// without proofs. Several machines agreeing outweigh one machine's own receipt.
			const claims = [
				claim('h1', 5, 'cohort'),
				claim('h2', 5, 'cohort'),
				claim('solo', 5, 'solo-fork', true, 1)
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 5, actionId: 'cohort', supporters: ['h1', 'h2'] });
		});

		it('does NOT reach a solo fork one revision AHEAD of the cohort — a known residual', () => {
			// Scope boundary, pinned so nobody reads the equal-rev rule as a general fork defence.
			// The weighing only fires at an EQUAL revision, because at an unequal one the claim data
			// cannot tell a forked solo machine apart from a cohort that is merely lagging — both
			// look like "one peer ahead of two". A partitioned machine that commits twice while the
			// cohort commits once therefore still wins, and that is the ordinary solo-repair rule
			// doing its job on data that cannot distinguish the two cases. Closing it needs proofs
			// to carry lineage: `feat-commit-proofs-carry-predecessor-action`.
			const claims = [
				claim('h1', 5, 'cohort'),
				claim('h2', 5, 'cohort'),
				claim('solo', 6, 'solo-fork', true, 1)
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 6, actionId: 'solo-fork', supporters: ['solo'], certified: true });
		});

		it('a single-signer certified claim still wins where NOTHING multi-peer contests it', () => {
			const sel = selectQuorumRev([claim('solo', 5, 'a', true, 1)], THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 5, actionId: 'a', supporters: ['solo'], certified: true });
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

		it('MULTI-SIGNER equivocation declines even when a corroborated pair exists at the SAME rev', () => {
			// Two cohort-grade (multi-signer) proofs for distinct actions at one rev: the certified
			// path decides the tie and a certified conflict there declines everything — votes cannot
			// pick between two proofs the same keys plausibly signed.
			const claims = [
				claim('h1', 5, 'a'),
				claim('h2', 5, 'a'),
				claim('p1', 5, 'a', true, 3),
				claim('p2', 5, 'b', true, 3)
			];
			expect(selectQuorumRev(claims, THRESHOLD, 9)).to.equal(undefined);
		});

		it('two SINGLE-SIGNER certified actions at one rev yield to multi-peer corroboration instead of deadlocking', () => {
			const claims = [
				claim('h1', 5, 'a'),
				claim('h2', 5, 'a'),
				claim('solo1', 5, 'a', true, 1),
				claim('solo2', 5, 'b', true, 1)
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.not.equal(undefined);
			expect(sel!.actionId).to.equal('a');
			expect(sel!.certified).to.equal(undefined);
		});

		it('a multi-signer certified claim beats a single-signer one at the same rev — no equivocation decline', () => {
			// A solo machine's self-signed receipt cannot veto the cohort's own proof.
			const claims = [
				claim('cohort-holder', 5, 'cohort-action', true, 3),
				claim('solo', 5, 'solo-fork', true, 1)
			];
			const sel = selectQuorumRev(claims, THRESHOLD, 9);
			expect(sel).to.deep.equal({ rev: 5, actionId: 'cohort-action', supporters: ['cohort-holder'], certified: true });
			expect(certifiedEquivocation(claims)).to.equal(undefined);
		});

		it('certifiedEquivocation reports only the CONTENDING proofs when signer weights are mixed', () => {
			// Two cohort-grade proofs genuinely equivocate at rev 5; a third, solo-signed action is
			// not of comparable weight and must not appear in the incident. The reporter must agree
			// with the selector on who contends, or an operator reads a conflict the selector never
			// weighed.
			const claims = [
				claim('p1', 5, 'a', true, 3),
				claim('p2', 5, 'b', true, 3),
				claim('solo', 5, 'solo-fork', true, 1)
			];
			expect(selectQuorumRev(claims, THRESHOLD, 9)).to.equal(undefined);
			const conflict = certifiedEquivocation(claims);
			expect(conflict!.rev).to.equal(5);
			expect(conflict!.actionIds.sort()).to.deep.equal(['a', 'b']);
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

		it('reports equivocation that did NOT decline the selection — ask it only on a decline', () => {
			// A corroborated pair STRICTLY above the top certified rev wins, so selection succeeds
			// while `certifiedEquivocation` still reports the conflict beneath it. Callers must key
			// the distinct log line off the decline, never off this being non-undefined.
			const claims = [
				claim('h1', 9, 'z'),
				claim('h2', 9, 'z'),
				claim('p1', 5, 'a', true),
				claim('p2', 5, 'b', true)
			];
			expect(selectQuorumRev(claims, THRESHOLD, 9)!.rev).to.equal(9);
			expect(certifiedEquivocation(claims)).to.deep.equal({ rev: 5, actionIds: ['a', 'b'] });
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
		const hashed = async (peerId: string, b: IBlock, certified?: boolean, signerCount?: number): Promise<BlockHashCandidate> =>
			({
				peerId, hash: await canonicalBlockHash(b), block: b,
				...(certified !== undefined ? { certified } : {}),
				...(signerCount !== undefined ? { certifiedSignerCount: signerCount } : {})
			});

		it('accepts a single certified candidate outright, even as the only copy at large capacity', async () => {
			const only = block('b', { payload: 'proven' });
			const cands = [await hashed('sole-holder', only, true)];
			const sel = selectQuorumBlock(cands, THRESHOLD, 9);
			expect(sel).to.not.equal(undefined);
			expect(sel!.hash).to.equal(await canonicalBlockHash(only));
			expect(sel!.block).to.equal(only);
		});

		it('a MULTI-SIGNER certified candidate wins over an uncertified majority serving different bytes', async () => {
			const proven = block('b', { payload: 'proven' });
			const cands = await Promise.all([
				hashed('holder', proven, true, 3),
				hashed('m1', block('b', { payload: 'majority' })),
				hashed('m2', block('b', { payload: 'majority' }))
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD, 9);
			expect(sel!.hash).to.equal(await canonicalBlockHash(proven));
		});

		it('a SINGLE-SIGNER certified candidate loses to a multi-peer hash quorum serving different bytes', async () => {
			// Content-side sibling of the solo-fork rev case: one machine's self-signed bytes must not
			// displace several distinct carriers agreeing with each other.
			const majority = block('b', { payload: 'majority' });
			const cands = await Promise.all([
				hashed('solo', block('b', { payload: 'solo-fork' }), true, 1),
				hashed('m1', majority),
				hashed('m2', block('b', { payload: 'majority' }))
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD, 9);
			expect(sel!.hash).to.equal(await canonicalBlockHash(majority));
		});

		it('a single-signer certified candidate still wins where nothing multi-peer contests it', async () => {
			const solo = block('b', { payload: 'solo' });
			const cands = await Promise.all([
				hashed('solo-holder', solo, true, 1),
				hashed('bare', block('b', { payload: 'bare-word' })) // one uncertified dissenter, no quorum
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD, 9);
			expect(sel!.hash).to.equal(await canonicalBlockHash(solo));
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
			const a = block('b', { payload: 'A' });
			const b = block('b', { payload: 'B' });
			const cands = await Promise.all([hashed('h1', a, true), hashed('h2', b, true)]);
			expect(selectQuorumBlock(cands, THRESHOLD, 9)).to.equal(undefined);
			// Both declines return undefined, so the reporter is the only thing separating "the
			// cohort's keys signed two digests into one revision" from "not enough carriers agreed".
			const conflict = certifiedContentEquivocation(cands);
			expect(conflict).to.not.equal(undefined);
			expect(conflict!.hashes.sort())
				.to.deep.equal([await canonicalBlockHash(a), await canonicalBlockHash(b)].sort());
		});

		it('two SINGLE-SIGNER certified hashes yield to a multi-carrier quorum group instead of declining', async () => {
			// Solo-vs-solo would deadlock on its own, but several distinct carriers agreeing outrank
			// both self-signed forks — the content-side sibling of the two-single-signer rev case.
			const majority = block('b', { payload: 'majority' });
			const cands = await Promise.all([
				hashed('solo1', block('b', { payload: 'fork-A' }), true, 1),
				hashed('solo2', block('b', { payload: 'fork-B' }), true, 1),
				hashed('m1', majority),
				hashed('m2', block('b', { payload: 'majority' }))
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD, 9);
			expect(sel!.hash).to.equal(await canonicalBlockHash(majority));
			// Selection SUCCEEDED while the solo-vs-solo conflict is still reportable — so callers must
			// key the incident line off the decline, never off this being non-undefined.
			expect(certifiedContentEquivocation(cands)).to.not.equal(undefined);
		});

		it('a quorum-meeting group of ONE carrier does NOT displace a single-signer certified hash', async () => {
			// Capacity 1 drops the quorum to a single vote, so the lone dissenter's group "meets
			// quorum" on nothing but its own word. A verified proof still outranks a bare assertion;
			// only CORROBORATION_FLOOR-plus distinct carriers displace one.
			const proven = block('b', { payload: 'proven' });
			const cands = await Promise.all([
				hashed('solo-holder', proven, true, 1),
				hashed('bare', block('b', { payload: 'bare-word' }))
			]);
			const sel = selectQuorumBlock(cands, THRESHOLD, 1);
			expect(sel!.hash).to.equal(await canonicalBlockHash(proven));
		});

		it('certifiedContentEquivocation reports only the CONTENDING hashes when signer weights are mixed', async () => {
			const a = block('b', { payload: 'A' });
			const b = block('b', { payload: 'B' });
			// One solo-signed hash alongside a cohort-grade one is a fork losing, not equivocation.
			expect(certifiedContentEquivocation(await Promise.all([
				hashed('cohort', a, true, 3),
				hashed('solo', b, true, 1)
			]))).to.equal(undefined);
			// Two cohort-grade hashes DO equivocate, and the solo one stays out of the incident.
			const conflict = certifiedContentEquivocation(await Promise.all([
				hashed('c1', a, true, 3),
				hashed('c2', b, true, 3),
				hashed('solo', block('b', { payload: 'C' }), true, 1)
			]));
			expect(conflict!.hashes.sort())
				.to.deep.equal([await canonicalBlockHash(a), await canonicalBlockHash(b)].sort());
		});

		it('reports no content equivocation for an ordinary content-quorum shortfall', async () => {
			// A plain decline (one uncertified carrier where a second could exist) and a single
			// certified hash must both read as "no equivocation".
			const good = block('b', { payload: 'ok' });
			expect(certifiedContentEquivocation([await hashed('h1', good)])).to.equal(undefined);
			expect(certifiedContentEquivocation([await hashed('h1', good, true)])).to.equal(undefined);
			expect(certifiedContentEquivocation([])).to.equal(undefined);
			// Two DIFFERENT hashes where neither is certified is a content split, not equivocation.
			expect(certifiedContentEquivocation(await Promise.all([
				hashed('h1', block('b', { payload: 'A' })),
				hashed('h2', block('b', { payload: 'B' }))
			]))).to.equal(undefined);
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
