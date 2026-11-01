/**
 * Ticket: repair-asks-a-lone-ahead-claimant-for-its-lineage.
 *
 * The lineage round both repair paths run for the one shape the selector cannot settle on the claim
 * data (`soloAheadOfCohort` in `cluster/quorum-restore.ts`): a lone single-signer certified claim
 * strictly ahead of a pair the rest of the cohort backs. `settleSoloAhead` asks each claimant of the
 * lone pair whether its history contains the group's pair and folds the answers. Pinned here: who is
 * asked and about what; the fold table (`excludes` → fork, `contains` → same lineage, anything else →
 * unknown, with `excludes` winning a mixed set); that a `fork` marks every claim at the lone pair in
 * place and nothing else does; and that an absent ask, or a claim set without the shape, asks nobody.
 */

import { expect } from 'chai';
import type { ActionRev, BlockId, BlockLineage } from '@optimystic/db-core';
import { settleSoloAhead, type BlockLineageAsk } from '../src/cluster/solo-ahead.js';
import type { RevClaim } from '../src/cluster/quorum-restore.js';

const BLOCK_ID = 'block-solo-ahead' as BlockId;
const SETTINGS = { simpleMajorityThreshold: 0.51, corroboratorCapacity: 9 };
const GROUP: ActionRev = { actionId: 'cohort', rev: 5 };

const claim = (peerId: string, rev: number, actionId: string, signerCount?: number): RevClaim =>
	({ peerId, rev, actionId, ...(signerCount !== undefined ? { certified: true, certifiedSignerCount: signerCount } : {}) });

/** The shape every case starts from: the group at (5, cohort), one machine certified alone at (6, solo-fork). */
const shaped = (): RevClaim[] => [claim('h1', 5, 'cohort'), claim('h2', 5, 'cohort'), claim('solo', 6, 'solo-fork', 1)];

/** An ask answering per peer from a table; a peer the table does not name is unreachable (the ask throws). */
const answering = (table: Record<string, BlockLineage>) => {
	const asked: { peerId: string; blockId: BlockId; target: ActionRev }[] = [];
	const ask: BlockLineageAsk = async (peerId, blockId, target) => {
		asked.push({ peerId, blockId, target });
		const answer = table[peerId];
		if (answer === undefined) throw new Error(`${peerId} unreachable`);
		return answer;
	};
	return { ask, asked };
};

const marked = (claims: RevClaim[]): string[] => claims.filter(c => c.forkedFromCohort === true).map(c => c.peerId);

describe('settleSoloAhead (the lineage round)', () => {
	it('asks each claimant of the lone pair whether its history contains the group pair', async () => {
		const claims = [...shaped(), claim('pushed', 6, 'solo-fork')];
		const { ask, asked } = answering({ solo: 'contains', pushed: 'unknown' });

		const outcome = await settleSoloAhead(claims, BLOCK_ID, SETTINGS, ask);

		expect(asked.map(a => a.peerId).sort(), 'every distinct claimant, certified or not').to.deep.equal(['pushed', 'solo']);
		for (const a of asked) {
			expect(a.blockId).to.equal(BLOCK_ID);
			expect(a.target, 'the question names the group pair').to.deep.equal(GROUP);
		}
		expect(outcome.verdict).to.equal('same-lineage');
		if (outcome.verdict === 'not-asked') throw new Error('unreachable');
		expect(outcome.solo).to.deep.equal({ actionId: 'solo-fork', rev: 6 });
		expect(outcome.cohort).to.deep.equal(GROUP);
		expect(outcome.answers).to.deep.equal({ solo: 'contains', pushed: 'unknown' });
	});

	it('excludes → fork, and every claim at the lone pair is marked in place', async () => {
		// The pushed replica answers `unknown` (its content past the asked revision came from the
		// lone machine, so it cannot vouch) while the originator's own index names another action at
		// rev 5. One `excludes` settles it, and the replica is marked with it: same commit.
		const claims = [...shaped(), claim('pushed', 6, 'solo-fork')];
		const { ask } = answering({ solo: 'excludes', pushed: 'unknown' });

		const outcome = await settleSoloAhead(claims, BLOCK_ID, SETTINGS, ask);

		expect(outcome.verdict).to.equal('fork');
		expect(marked(claims).sort()).to.deep.equal(['pushed', 'solo']);
	});

	it('contains → same-lineage, and nothing is marked', async () => {
		const claims = shaped();
		const { ask } = answering({ solo: 'contains' });

		const outcome = await settleSoloAhead(claims, BLOCK_ID, SETTINGS, ask);

		expect(outcome.verdict).to.equal('same-lineage');
		expect(marked(claims)).to.deep.equal([]);
	});

	it('behind, unknown or a throwing ask → unknown, and nothing is marked', async () => {
		// `behind` contradicts the claim the peer just made, and a throw is a claimant that could not
		// be asked; neither is evidence either way, so the default stays the one that keeps the
		// ordinary lagging-cohort repair working.
		const tables: Record<string, BlockLineage>[] = [{ solo: 'behind' }, { solo: 'unknown' }, {}];
		for (const table of tables) {
			const claims = shaped();
			const outcome = await settleSoloAhead(claims, BLOCK_ID, SETTINGS, answering(table).ask);
			expect(outcome.verdict, JSON.stringify(table)).to.equal('unknown');
			expect(marked(claims), JSON.stringify(table)).to.deep.equal([]);
		}
		const claims = shaped();
		const outcome = await settleSoloAhead(claims, BLOCK_ID, SETTINGS, answering({}).ask);
		if (outcome.verdict === 'not-asked') throw new Error('unreachable');
		expect(outcome.answers, 'a throw is recorded as a silent claimant').to.deep.equal({ solo: 'silent' });
	});

	it('contains beside excludes → fork: two holders of one pair disagreeing about its origin resolve toward the group', async () => {
		const claims = [...shaped(), claim('pushed', 6, 'solo-fork')];
		const { ask } = answering({ solo: 'excludes', pushed: 'contains' });

		const outcome = await settleSoloAhead(claims, BLOCK_ID, SETTINGS, ask);

		expect(outcome.verdict).to.equal('fork');
		expect(marked(claims).sort()).to.deep.equal(['pushed', 'solo']);
	});

	it('an absent ask → not-asked, nothing marked', async () => {
		const claims = shaped();

		const outcome = await settleSoloAhead(claims, BLOCK_ID, SETTINGS, undefined);

		expect(outcome).to.deep.equal({ verdict: 'not-asked' });
		expect(marked(claims)).to.deep.equal([]);
	});

	it('a claim set without the shape asks nobody', async () => {
		// The equal-revision contest the selector already settles: no second round.
		const claims = [claim('h1', 5, 'cohort'), claim('h2', 5, 'cohort'), claim('solo', 5, 'solo-fork', 1)];
		const { ask, asked } = answering({ solo: 'excludes' });

		const outcome = await settleSoloAhead(claims, BLOCK_ID, SETTINGS, ask);

		expect(outcome).to.deep.equal({ verdict: 'not-asked' });
		expect(asked).to.deep.equal([]);
	});
});
