/**
 * Ticket: p2p-read-repair-verify-peer-claims
 *
 * Unit specs for the quorum-corroboration primitives shared by the read-repair
 * and reconcile restoration paths. Covers rev selection (single/minority liars,
 * honest quorum, and the corroborator-capacity cap that keeps a cohort too small to
 * supply two corroborators from being permanently unrepairable — ticket
 * `bug-read-repair-unrepairable-small-cluster`) and the reconcile CONTENT-agreement
 * gate (a cohort member serving content that hashes differently is rejected).
 */

import { expect } from 'chai';
import type { IBlock } from '@optimystic/db-core';
import {
	quorumSize, corroboratorCapacity, selectQuorumRev, selectQuorumBlock, canonicalBlockHash,
	type RevClaim, type BlockHashCandidate
} from '../src/cluster/quorum-restore.js';
import { resolveClusterPolicy } from '../src/cluster/cluster-policy.js';

const THRESHOLD = 0.51;

const block = (id: string, extra: Record<string, unknown> = {}): IBlock =>
	({ header: { id, type: 'test', collectionId: 'c', ...extra } } as unknown as IBlock);

describe('quorum-restore primitives', () => {
	describe('quorumSize', () => {
		it('is floor(threshold × responders) with a floor of 2 when the capacity is unstated', () => {
			expect(quorumSize(0, THRESHOLD)).to.equal(2);
			expect(quorumSize(1, THRESHOLD)).to.equal(2);
			expect(quorumSize(2, THRESHOLD)).to.equal(2); // floor(1.02)=1 → min 2
			expect(quorumSize(3, THRESHOLD)).to.equal(2); // floor(1.53)=1 → min 2
			expect(quorumSize(4, THRESHOLD)).to.equal(2); // floor(2.04)=2
			expect(quorumSize(6, THRESHOLD)).to.equal(3); // floor(3.06)=3
			expect(quorumSize(10, THRESHOLD)).to.equal(5);
		});

		it('caps the floor at the number of peers that could corroborate', () => {
			// One other peer in the cohort: demanding two corroborators cannot be satisfied by
			// anyone, ever — that is a deadlock, not a safety property.
			expect(quorumSize(1, THRESHOLD, 1)).to.equal(1);
			// A second peer exists and merely did not answer → still needs seconding.
			expect(quorumSize(1, THRESHOLD, 2)).to.equal(2);
			expect(quorumSize(1, THRESHOLD, 9)).to.equal(2);
			// Never below a single vote, even with a degenerate capacity.
			expect(quorumSize(0, THRESHOLD, 0)).to.equal(1);
		});

		it('caps the FLOOR only — the proportional majority term still grows', () => {
			// capacity 1 lowers the floor to 1, but 6 responders still demand floor(3.06)=3.
			expect(quorumSize(6, THRESHOLD, 1)).to.equal(3);
			expect(quorumSize(10, THRESHOLD, 1)).to.equal(5);
		});
	});

	/**
	 * The rule both restoration paths measure their floor against. It was written twice — once in
	 * `CoordinatorRepo`, once in `reconcile-block` — and is now shared, so it is pinned here rather
	 * than only through its two callers. The second argument is `assumedClusterSize` — the smallest
	 * cohort the operator asserts this deployment can genuinely field — not the replication factor
	 * (`clusterSize`); see the doc comment on `corroboratorCapacity`.
	 */
	describe('corroboratorCapacity', () => {
		it('is the visible peer count when the cohort is at or above the asserted size', () => {
			expect(corroboratorCapacity(9, 10)).to.equal(9);
			expect(corroboratorCapacity(12, 10)).to.equal(12); // an oversized cohort raises the bar
		});

		it('holds the asserted size as a floor so a shrunken view cannot relax anything', () => {
			// One peer visible in a cohort whose assumedClusterSize is ten: the requirement stays at
			// what ten members could supply, so a partition (or a routing-level attacker) gains nothing.
			expect(corroboratorCapacity(1, 10)).to.equal(9);
			expect(quorumSize(1, THRESHOLD, corroboratorCapacity(1, 10))).to.equal(2);
		});

		it('relaxes only for a cohort explicitly declared that small', () => {
			expect(corroboratorCapacity(1, 2)).to.equal(1);
			expect(quorumSize(1, THRESHOLD, corroboratorCapacity(1, 2))).to.equal(1);
		});

		it('never goes negative for a degenerate asserted size', () => {
			// assumedClusterSize 1 (or 0) implies no other peer at all; the capacity must not underflow
			// the `Math.max(1, ...)` guard in quorumSize into accepting a claim from nobody.
			expect(corroboratorCapacity(0, 1)).to.equal(0);
			expect(corroboratorCapacity(0, 0)).to.equal(0);
			expect(selectQuorumRev([], THRESHOLD, corroboratorCapacity(0, 1))).to.equal(undefined);
		});
	});

	/**
	 * Ticket: repair-deadlock-is-never-named.
	 *
	 * The rule an OPERATOR needs, stated as a count of machines rather than as a restatement of the
	 * formula: **how many cohort peers besides the reader have to answer that reader, and agree,
	 * before a repair can converge?** Everything else in this file pins the arithmetic; this pins the
	 * consequence, so the arithmetic cannot drift underneath the advisory text in
	 * `cluster-policy.ts`, the `cluster-fetch:repair-deadlock` message in `CoordinatorRepo`, or
	 * `docs/internals.md` without a spec turning red.
	 *
	 * Read through the composition root (`resolveClusterPolicy`) rather than by hand, because that is
	 * the layer a real deployment runs on and the layer where a wrong default has hidden before.
	 */
	describe('how many answering peers a repair needs, by deployment size', () => {
		/**
		 * The smallest number of ANSWERING cohort peers (reader excluded) that can carry a repair to
		 * convergence, given a deployment of `nodes` machines. `undefined` means no number of answering
		 * peers is enough — the deployment can never repair a block, however healthy it is.
		 *
		 * Every peer is assumed to answer with the same `(rev, actionId)`; disagreement only ever makes
		 * the requirement harder, so this is the optimistic bound.
		 */
		const answeringPeersNeeded = (
			opts: { nodes: number; clusterSize?: number; declared?: number }
		): number | undefined => {
			const policy = resolveClusterPolicy({
				clusterSize: opts.clusterSize ?? opts.nodes,
				...(opts.declared !== undefined ? { clusterPolicy: { assumedClusterSize: opts.declared } } : {})
			});
			// What `CoordinatorRepo.queryClusterForLatest` computes: capacity from the peers VISIBLE in
			// the cohort (self excluded), quorum from the peers that actually answered.
			const cohortPeers = opts.nodes - 1;
			const capacity = corroboratorCapacity(cohortPeers, policy.repairCorroborationClusterSize);
			for (let answering = 1; answering <= cohortPeers; answering++) {
				if (answering >= quorumSize(answering, policy.simpleMajorityThreshold, capacity)) return answering;
			}
			return undefined;
		};

		it('needs TWO answering peers besides the reader once the deployment is three machines or more', () => {
			for (const nodes of [3, 4, 5, 6]) {
				expect(answeringPeersNeeded({ nodes }), `${nodes} machines, size undeclared`).to.equal(2);
				expect(answeringPeersNeeded({ nodes, declared: nodes }), `${nodes} machines, size declared`).to.equal(2);
			}
		});

		it('gives a three-machine deployment ZERO fault tolerance — it has two peers and needs both', () => {
			const cohortPeers = 3 - 1;
			expect(answeringPeersNeeded({ nodes: 3 })).to.equal(cohortPeers);
			expect(answeringPeersNeeded({ nodes: 3, declared: 3 })).to.equal(cohortPeers);
			// One peer unreachable FROM THIS READER — healthy and reachable from everyone else — and
			// this reader's copy is unrepairable for as long as that holds.
			expect(answeringPeersNeeded({ nodes: 3 })).to.be.greaterThan(cohortPeers - 1);
		});

		it('gives four machines the first real margin — one peer may be unreachable', () => {
			for (const nodes of [4, 5, 6]) {
				const cohortPeers = nodes - 1;
				expect(answeringPeersNeeded({ nodes }), `${nodes} machines`).to.be.at.most(cohortPeers - 1);
			}
		});

		it('lets a two-machine deployment converge on its single peer — but only once its size is stated', () => {
			// An honest clusterSize: 2 is one way to state it...
			expect(answeringPeersNeeded({ nodes: 2 })).to.equal(1);
			// ...and clusterPolicy.assumedClusterSize: 2 is the other, without lowering replication.
			expect(answeringPeersNeeded({ nodes: 2, clusterSize: 10, declared: 2 })).to.equal(1);
			// It still has no margin at all: its one peer must answer every single pass.
			expect(answeringPeersNeeded({ nodes: 2 })).to.equal(2 - 1);
		});

		it('leaves an UNSTATED two-machine deployment unable to repair anything, ever', () => {
			// repairCorroborationClusterSize falls back to clusterSize (10 by default), so the floor of
			// two never relaxes and the single peer can never second itself. No answering count helps.
			expect(answeringPeersNeeded({ nodes: 2, clusterSize: 10 })).to.equal(undefined);
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

		it('declines a lone responder when a second peer could have corroborated it', () => {
			const claims: RevClaim[] = [{ peerId: 'only', rev: 2, actionId: 'x' }];
			// The old "too few responders but they all agree" fallback accepted this at ANY
			// cohort size, so a peer that simply out-raced the others' timeouts was believed
			// on its own word. Unstated capacity ⇒ floor 2 ⇒ decline.
			expect(selectQuorumRev(claims, THRESHOLD)).to.equal(undefined);
			expect(selectQuorumRev(claims, THRESHOLD, 4)).to.equal(undefined);
		});

		it('accepts a lone responder only when it is the ONLY peer that could corroborate', () => {
			const claims: RevClaim[] = [{ peerId: 'only', rev: 2, actionId: 'x' }];
			const sel = selectQuorumRev(claims, THRESHOLD, 1);
			expect(sel!.rev).to.equal(2);
			expect(sel!.actionId).to.equal('x');
			expect(sel!.supporters).to.deep.equal(['only']);
		});

		it('does NOT accept either side when the few responders disagree', () => {
			const claims: RevClaim[] = [
				{ peerId: 'p1', rev: 2, actionId: 'x' },
				{ peerId: 'p2', rev: 9, actionId: 'y' }
			];
			// 2 responders, quorum 2, neither pair seconded → decline.
			expect(selectQuorumRev(claims, THRESHOLD)).to.equal(undefined);
			expect(selectQuorumRev(claims, THRESHOLD, 2)).to.equal(undefined);
		});

		/**
		 * These two were committed in `ff2cbbf` asserting the *broken* behavior of a 2-node
		 * cohort (ticket `bug-read-repair-unrepairable-small-cluster`); they now assert the fix.
		 * Both failure modes came from the reader's own revision being one of the claims —
		 * `clusterLatestCallback` short-circuits self to local storage — combined with a
		 * corroboration floor of 2 that no 2-node cohort can ever reach. The caller now strips
		 * its own claim before calling, and states how many peers could corroborate.
		 */
		it('a 2-node divergence IS repairable: the sole other peer\'s newer rev is adopted', () => {
			// Node B (reader, rev 1) asks node A, which answers rev 2. B's own claim is excluded
			// by the caller, so one claim remains and exactly one peer could ever have made it.
			const claims: RevClaim[] = [{ peerId: 'node-a', rev: 2, actionId: 'fresh-action' }];
			expect(quorumSize(1, THRESHOLD, 1), 'one possible corroborator ⇒ one vote').to.equal(1);
			const sel = selectQuorumRev(claims, THRESHOLD, 1);
			expect(sel, 'the fresh rev must now be adoptable').to.not.equal(undefined);
			expect(sel!.rev).to.equal(2);
			expect(sel!.actionId).to.equal('fresh-action');
			expect(sel!.supporters).to.deep.equal(['node-a']);
		});

		it('the reader cannot corroborate itself when its only peer stays silent', () => {
			// Self-exclusion happens in the caller, so a silent peer leaves NO claims at all —
			// there is nothing to restore to and, crucially, nothing that looks like a quorum.
			expect(selectQuorumRev([], THRESHOLD, 1)).to.equal(undefined);
			// And a single voter never seconds itself where a second corroborator should exist.
			const selfClaim: RevClaim[] = [{ peerId: 'self-node-b', rev: 1, actionId: 'stale-action' }];
			expect(selectQuorumRev(selfClaim, THRESHOLD, 4)).to.equal(undefined);
		});

		/**
		 * Honest exposure note: relaxing the floor for a cohort with one other peer means that
		 * peer is believed unconditionally. Claims are bare assertions — a `BlockArchive` carries
		 * no commit certificate — so nothing here can tell a lag from a lie. A 2-member cohort has
		 * no Byzantine tolerance to lose (there is no honest majority to appeal to), and the
		 * capacity is measured against the ASSERTED cluster size (`assumedClusterSize`) so a shrunken
		 * view of a larger network cannot reach this branch. See `debt-read-repair-commit-cert-verification`.
		 */
		it('a sole cohort peer is believed even when its rev is absurd (documented exposure)', () => {
			const claims: RevClaim[] = [{ peerId: 'node-a', rev: 999_999, actionId: 'absurd' }];
			expect(selectQuorumRev(claims, THRESHOLD, 1)!.rev).to.equal(999_999);
			// In any cohort that could supply a second corroborator, the same claim is refused.
			expect(selectQuorumRev(claims, THRESHOLD, 2)).to.equal(undefined);
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
			// Unstated capacity ⇒ floor 2; a lone block cannot be corroborated → skip persist.
			expect(selectQuorumBlock(cands, THRESHOLD)).to.equal(undefined);
			// A second block-carrier could have existed and merely did not answer → still declines.
			expect(selectQuorumBlock(cands, THRESHOLD, 4)).to.equal(undefined);
		});

		/**
		 * Ticket: bug-reconcile-cannot-heal-two-node-cohort. The content gate was left on the
		 * strict floor when `50af693` capped the revision-claim gate, so a cohort with exactly one
		 * other peer could select the right revision and then decline its only copy of the bytes —
		 * a permanent decline, not a safety property.
		 */
		it('accepts a lone block only when it is the ONLY peer that could carry one', async () => {
			const only = block('b', { payload: 'ok' });
			const cands = await Promise.all([hashed('node-a', only)]);
			const sel = selectQuorumBlock(cands, THRESHOLD, 1);
			expect(sel, 'a two-node cohort must be able to move bytes').to.not.equal(undefined);
			expect(sel!.hash).to.equal(await canonicalBlockHash(only));
		});

		it('caps the FLOOR only — a larger carrier set still needs a proportional majority', async () => {
			// 6 carriers split 3/3 with capacity 1: floor drops to 1 but floor(0.51×6)=3 still rules,
			// and both groups reach 3 → ambiguous → decline.
			const cands = await Promise.all([
				hashed('a1', block('b', { payload: 'A' })), hashed('a2', block('b', { payload: 'A' })),
				hashed('a3', block('b', { payload: 'A' })), hashed('b1', block('b', { payload: 'B' })),
				hashed('b2', block('b', { payload: 'B' })), hashed('b3', block('b', { payload: 'B' }))
			]);
			expect(selectQuorumBlock(cands, THRESHOLD, 1)).to.equal(undefined);
		});

		it('counts one vote per distinct peer (a repeated peer cannot second itself)', async () => {
			const dup = block('b', { payload: 'ok' });
			const cands = await Promise.all([hashed('same-peer', dup), hashed('same-peer', dup)]);
			// Two candidates but ONE voter; the floor of 2 is not met by a peer echoing itself.
			expect(selectQuorumBlock(cands, THRESHOLD, 4)).to.equal(undefined);
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
