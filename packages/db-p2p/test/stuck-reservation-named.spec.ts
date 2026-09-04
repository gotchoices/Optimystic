/**
 * Ticket: name-a-block-that-is-stuck-behind-a-stale-reservation.
 *
 * A block whose pending record will never be promoted or removed refuses every later write, from
 * every writer, for as long as the process lives. Each of those refusals is logged as what it looks
 * like — an ordinary optimistic-concurrency loss, which is a normal and healthy event — so the logs
 * of a permanently wedged block read exactly like the logs of a busy one, and the only way to tell
 * them apart today is to notice that the same rival action id keeps appearing across unrelated
 * writers. `coordinator-repo:stuck-reservation` says the real condition out loud, once per episode.
 *
 * The three arms:
 *  - THRESHOLD: a wedged block stays quiet under the threshold, speaks exactly once at it, and stays
 *    quiet afterwards however many more writers it refuses.
 *  - SECOND EPISODE: after the cure the line names (a cancel for the holding action), a later wedge
 *    on the same block is named again — the say-once flag is per episode, not per block for ever.
 *  - HEALTHY CONTENTION: rivals genuinely losing to a holder that then commits emit nothing at all,
 *    and the measurement that calibrates the threshold — how many distinct actions one healthy
 *    holder refuses — is read off the classification lines rather than assumed.
 */

import { expect } from 'chai';
import type { BlockHeader, BlockId, IBlock, Transforms, ITransactor } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor, type Mesh } from '../src/testing/mesh-harness.js';
import { captureLog } from './support/capture-log.js';

/** Must match `STUCK_RESERVATION_DISTINCT_ACTIONS` in `repo/coordinator-repo.ts`. */
const THRESHOLD = 8;
const STUCK = 'coordinator-repo:stuck-reservation';
const CLASSIFIED = 'coordinator-repo:pend-conflict-classified';

const makeHeader = (id: string): BlockHeader => ({ id: id as BlockId, type: 'test', collectionId: 'stuck-reservation-collection' as BlockId });
const makeBlock = (id: string): IBlock => ({ header: makeHeader(id), entries: [] } as unknown as IBlock);
const insertsFor = (...ids: string[]): Transforms => ({ inserts: Object.fromEntries(ids.map(id => [id, makeBlock(id)])), updates: {}, deletes: [] });
const updatesFor = (tag: string, ...ids: string[]): Transforms => ({ inserts: {}, updates: Object.fromEntries(ids.map(id => [id, [['entries', 0, 0, [tag]]]])), deletes: [] }) as unknown as Transforms;

type StuckPayload = { blockId?: string; holdingActionIds?: string[]; distinctRefusedActions?: number; message?: string };
type ClassifiedPayload = { actionId?: string; rivals?: string[]; distinctRefusedActions?: number };

const linesWith = (captured: unknown[][], tag: string) =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(tag));
const payloadsOf = <T>(captured: unknown[][], tag: string): T[] =>
	linesWith(captured, tag).map(args => args[1] as T);

/** Every distinct-refusal count the coordinator reported while `fn` ran. */
const refusalCounts = (captured: unknown[][]): number[] =>
	payloadsOf<ClassifiedPayload>(captured, CLASSIFIED).map(p => p.distinctRefusedActions ?? 0);

const capture = (fn: () => Promise<void>) => captureLog('coordinator-repo', fn);

describe('A block stuck behind a reservation that will never clear is named as such', function () {
	this.timeout(60_000);

	let mesh: Mesh;
	let transactor: ITransactor;

	beforeEach(async () => {
		mesh = await createMesh(3, {
			responsibilityK: 3,
			clusterSize: 3,
			superMajorityThreshold: 0.67
		});
		transactor = buildNetworkTransactor(mesh);
	});

	/**
	 * The wedge, produced exactly as `torn-commit-cancels-abandoned-blocks.spec.ts` produces it and
	 * for the same reason: pend two blocks through consensus and commit only the tail. Nothing is
	 * injected — this is a client that walked away from the sibling, which is what any tear reduces
	 * to at the storage layer. Afterwards every member holds `holder`'s pending record for `S`, and
	 * no later call will ever promote or remove it.
	 */
	const wedgeSideBlock = async (holder: string, rev: number): Promise<void> => {
		const pend = await transactor.pend({ actionId: holder, transforms: updatesFor(holder, 'T', 'S'), rev, policy: 'c' });
		expect(pend.success, `wedging pend (${holder}) must succeed`).to.equal(true);
		const commit = await transactor.commit({ actionId: holder, blockIds: ['T'] as BlockId[], tailId: 'T' as BlockId, rev });
		expect(commit.success, `tail-only commit (${holder}) must succeed`).to.equal(true);
	};

	/** Seed both blocks at revision 1 so the wedge below is an ordinary update, not a create. */
	const seed = async (): Promise<void> => {
		const pend = await transactor.pend({ actionId: 'seed', transforms: insertsFor('T', 'S'), rev: 1, policy: 'c' });
		expect(pend.success, 'seed pend must succeed').to.equal(true);
		const commit = await transactor.commit({ actionId: 'seed', blockIds: ['T', 'S'] as BlockId[], tailId: 'T' as BlockId, rev: 1 });
		expect(commit.success, 'seed commit must succeed').to.equal(true);
	};

	/** `count` further writers, each a DISTINCT action, all refused by the standing reservation. */
	const driveRefusedWrites = async (prefix: string, count: number, rev: number): Promise<void> => {
		for (let i = 0; i < count; i++) {
			const result = await transactor.pend({ actionId: `${prefix}-${i}`, transforms: updatesFor(`${prefix}-${i}`, 'S'), rev, policy: 'c' });
			expect(result.success, `write ${prefix}-${i} must be refused by the standing reservation`).to.equal(false);
		}
	};

	it('stays quiet under the threshold, names the condition exactly once at it, and stays quiet after', async () => {
		await seed();
		await wedgeSideBlock('holder-a', 2);

		// One short of the threshold: every refusal is still just a lost race as far as this node can
		// prove, and the line that would claim otherwise must not fire.
		const below = await capture(async () => { await driveRefusedWrites('below', THRESHOLD - 1, 2); });
		expect(linesWith(below, CLASSIFIED), 'the refusals must be classified as pending conflicts').to.have.lengthOf(THRESHOLD - 1);
		expect(linesWith(below, STUCK), 'nothing may be named stuck below the threshold').to.have.lengthOf(0);
		expect(Math.max(...refusalCounts(below)), 'the counter must have reached one short of the threshold')
			.to.equal(THRESHOLD - 1);

		// The refusal that crosses it: said once, with the block and the holding action as data and the
		// operator-facing explanation as prose.
		const at = await capture(async () => { await driveRefusedWrites('at', 1, 2); });
		const stuck = payloadsOf<StuckPayload>(at, STUCK);
		expect(stuck, 'crossing the threshold must name the condition exactly once').to.have.lengthOf(1);
		expect(stuck[0]!.blockId, 'the wedged block must be named as data').to.equal('S');
		expect(stuck[0]!.holdingActionIds, 'the holding action must be named as data').to.deep.equal(['holder-a']);
		expect(stuck[0]!.distinctRefusedActions, 'the count that made it provable must be carried').to.equal(THRESHOLD);
		const message = String(stuck[0]!.message ?? '');
		expect(message, 'the message must name the holding action an operator has to cancel').to.include('holder-a');
		expect(message, 'the message must say a cancel is one of the two cures').to.match(/cancel/i);
		expect(message, 'the message must say the holder committing is the other cure').to.match(/commit/i);

		// Every later writer meets the same wall, and the log says so exactly zero more times — a
		// thousand slightly different lines would be the same failure this replaces.
		const after = await capture(async () => { await driveRefusedWrites('after', 4, 2); });
		expect(linesWith(after, CLASSIFIED), 'later writers are still refused and still classified').to.have.lengthOf(4);
		expect(linesWith(after, STUCK), 'the condition must be said once per episode, not once per refusal').to.have.lengthOf(0);
	});

	it('names a SECOND episode on the same block after the first one is cured', async () => {
		await seed();
		await wedgeSideBlock('holder-a', 2);
		const first = await capture(async () => { await driveRefusedWrites('first', THRESHOLD, 2); });
		expect(linesWith(first, STUCK), 'the first episode must be named').to.have.lengthOf(1);

		// The cure the message names, taken: the record is dropped on every member and the block writes
		// normally again.
		await transactor.cancel({ actionId: 'holder-a', blockIds: ['S'] as BlockId[] });
		const healthy = await transactor.pend({ actionId: 'after-cancel', transforms: updatesFor('after-cancel', 'S'), rev: 2, policy: 'c' });
		expect(healthy.success, 'after the cancel the block must accept writes again').to.equal(true);
		const healthyCommit = await transactor.commit({ actionId: 'after-cancel', blockIds: ['S'] as BlockId[], tailId: 'S' as BlockId, rev: 2 });
		expect(healthyCommit.success, 'after the cancel the block must commit again').to.equal(true);

		// A second wedge, by a different holder. `T` is at revision 2 from the first wedge and `S` at
		// revision 2 from the write above, so revision 3 is the next one for both.
		await wedgeSideBlock('holder-b', 3);
		const second = await capture(async () => { await driveRefusedWrites('second', THRESHOLD, 3); });
		const stuck = payloadsOf<StuckPayload>(second, STUCK);
		expect(stuck, 'a later wedge on the same block must be named again').to.have.lengthOf(1);
		expect(stuck[0]!.holdingActionIds, 'the second episode must name its OWN holder').to.deep.equal(['holder-b']);
	});

	/**
	 * The negative control, and the measurement behind `STUCK_RESERVATION_DISTINCT_ACTIONS`.
	 *
	 * Genuinely contended writing produces the exact per-refusal shape this ticket keys off: a holder
	 * reserves the block, rivals lose to it and are refused with a pending conflict, and the holder
	 * then commits and releases it. The only thing that separates that from the wedge above is
	 * repetition against an UNCHANGED holder, so this arm both asserts silence and reads back how
	 * high a healthy holder's distinct-refusal count actually gets.
	 */
	it('a genuinely contended run — rivals losing to a holder that then commits — says nothing', async () => {
		const pendC = (actionId: string, rev: number) =>
			transactor.pend({ actionId, transforms: rev === 1 ? insertsFor('C') : updatesFor(actionId, 'C'), rev, policy: 'c' });

		const seedC = await pendC('c-seed', 1);
		expect(seedC.success, 'seed pend must succeed').to.equal(true);
		expect((await transactor.commit({ actionId: 'c-seed', blockIds: ['C'] as BlockId[], tailId: 'C' as BlockId, rev: 1 })).success).to.equal(true);

		const ROUNDS = 6;
		const RIVALS_PER_ROUND = 2;
		const captured = await capture(async () => {
			for (let round = 0; round < ROUNDS; round++) {
				const rev = round + 2;
				const holder = `hold-${round}`;
				const held = await pendC(holder, rev);
				expect(held.success, `round ${round}: the winner's pend must succeed`).to.equal(true);
				// Distinct rivals, refused inside the winner's pend-to-commit window. This is the honest
				// upper bound on a healthy holder's count: at most (concurrent writers - 1) can lose to
				// one winner before that winner releases the block.
				for (let rival = 0; rival < RIVALS_PER_ROUND; rival++) {
					const lost = await pendC(`lose-${round}-${rival}`, rev);
					expect(lost.success, `round ${round}: rival ${rival} must lose the race`).to.equal(false);
				}
				// The window closes exactly as a healthy one does, and the block changes hands.
				const committed = await transactor.commit({ actionId: holder, blockIds: ['C'] as BlockId[], tailId: 'C' as BlockId, rev });
				expect(committed.success, `round ${round}: the winner must commit`).to.equal(true);
			}
		});

		const counts = refusalCounts(captured);
		expect(counts.length, 'the run must actually have produced pending-conflict refusals')
			.to.equal(ROUNDS * RIVALS_PER_ROUND);
		expect(linesWith(captured, STUCK), 'healthy contention must never be named as stuck').to.have.lengthOf(0);
		// The calibration figure, asserted rather than assumed: a healthy holder tops out at the number
		// of rivals that can lose to it inside one window, and the count resets on every holder change.
		// If this ever climbs, `STUCK_RESERVATION_DISTINCT_ACTIONS` has lost its margin.
		expect(Math.max(...counts), 'a healthy holder must refuse at most its rivals, and never approach the threshold')
			.to.equal(RIVALS_PER_ROUND);
	});
});
