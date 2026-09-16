/**
 * Ticket: commit-result-carries-durability-class.
 *
 * The action-level durability report is assembled from per-cohort reports by ONE rule
 * (`mergeDurability`): the weakest cohort is the scalar answer, the rest ride in `otherCohorts`,
 * and `torn` is the union. `isFullyDurable` is the only "completely saved" test, and it must say
 * no for a torn action even when every cohort reported `full`. These are pinned at the unit level
 * because the multi-cohort shape is structurally hard to reach on an in-process mesh
 * (`consolidateCoordinators` collapses most pends onto one coordinator — see backlog
 * `debt-no-mesh-fixture-forces-two-coordinator-batches`).
 */
import { expect } from 'chai';
import type { BlockId, DurabilityQuorum, WriteDurability } from '../src/index.js';
import { durabilityRank, isFullyDurable, localDurability, mergeDurability, unroutedDurability, withTornBlocks } from '../src/index.js';

const CLASSES: readonly DurabilityQuorum[] = ['unrouted', 'local', 'majority', 'full'];

/** A cohort report of the given class, distinguishable from every other by its cohort size. */
const report = (quorum: DurabilityQuorum, cohort: number): WriteDurability => ({
	quorum,
	confirmed: quorum === 'unrouted' ? 1 : quorum === 'full' ? cohort : Math.max(1, cohort - 1),
	cohort: quorum === 'unrouted' ? 0 : cohort,
	cohortPeerIds: Array.from({ length: quorum === 'unrouted' ? 0 : cohort }, (_, i) => `${quorum}-peer-${i}`)
});

/** Every ordering of `items` — small inputs only. */
const permutations = <T>(items: readonly T[]): T[][] =>
	items.length <= 1 ? [[...items]] : items.flatMap((item, i) =>
		permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));

describe('durabilityRank', () => {
	it('orders the four classes unrouted < local < majority < full', () => {
		const ranks = CLASSES.map(durabilityRank);
		expect(ranks).to.deep.equal([...ranks].sort((a, b) => a - b));
		expect(new Set(ranks).size, 'every class has its own rank').to.equal(4);
	});
});

describe('mergeDurability', () => {
	it('picks the weakest class in every ordering of the four, and parks the rest in otherCohorts', () => {
		const reports = CLASSES.map((q, i) => report(q, i + 2));
		for (const ordering of permutations(reports)) {
			const merged = mergeDurability(ordering);
			expect(merged.quorum, `ordering ${ordering.map(r => r.quorum).join(',')}`).to.equal('unrouted');
			expect(merged.cohort, 'the scalar fields are the weakest report\'s own').to.equal(0);
			expect((merged.otherCohorts ?? []).map(r => r.quorum), 'the rest, strongest last').to.deep.equal(['local', 'majority', 'full']);
		}
	});

	it('picks the weakest of any pair', () => {
		for (const a of CLASSES) {
			for (const b of CLASSES) {
				const merged = mergeDurability([report(a, 3), report(b, 4)]);
				const weakest = durabilityRank(a) <= durabilityRank(b) ? a : b;
				expect(merged.quorum, `${a} + ${b}`).to.equal(weakest);
			}
		}
	});

	it('a single report merges to itself, with no otherCohorts', () => {
		const only = report('majority', 3);
		const merged = mergeDurability([only]);
		expect(merged).to.deep.equal(only);
		expect(merged.otherCohorts).to.equal(undefined);
	});

	it('an unrouted batch beside a full one reports unrouted — the weakest is the binding constraint', () => {
		const merged = mergeDurability([report('full', 3), unroutedDurability()]);
		expect(merged.quorum).to.equal('unrouted');
		expect(merged.cohort).to.equal(0);
		expect(merged.otherCohorts).to.have.length(1);
		expect(merged.otherCohorts![0]!.quorum).to.equal('full');
	});

	it('unions torn blocks across the inputs and flattens an already-merged report', () => {
		const first = withTornBlocks(report('full', 2), ['b1' as BlockId]);
		const second = withTornBlocks(mergeDurability([report('full', 3), report('majority', 4)]), ['b2' as BlockId, 'b1' as BlockId]);
		const merged = mergeDurability([first, second]);
		expect([...(merged.torn ?? [])].sort()).to.deep.equal(['b1', 'b2']);
		// The nested `otherCohorts` of `second` are flattened, not nested a level deeper: the merge
		// sees `first` (clamped to majority), `second`'s own scalar (majority) and `second`'s parked
		// full cohort — three reports, the weakest of which becomes the scalar answer.
		expect((merged.otherCohorts ?? []).map(r => r.quorum)).to.deep.equal(['majority', 'full']);
		expect((merged.otherCohorts ?? []).every(r => r.otherCohorts === undefined && r.torn === undefined)).to.equal(true);
	});

	it('THROWS on an empty input rather than fabricating an answer', () => {
		expect(() => mergeDurability([])).to.throw(/no durability reports/);
	});
});

describe('withTornBlocks', () => {
	it('clamps full down, never raises, and is a no-op for an empty list', () => {
		const full = report('full', 3);
		expect(withTornBlocks(full, []).quorum).to.equal('full');
		expect(withTornBlocks(full, ['x' as BlockId]).quorum).to.equal('majority');
		expect(withTornBlocks(report('local', 1), ['x' as BlockId]).quorum).to.equal('local');
		expect(withTornBlocks(unroutedDurability(), ['x' as BlockId]).quorum).to.equal('unrouted');
	});

	it('is idempotent on the torn set', () => {
		const once = withTornBlocks(report('full', 3), ['x' as BlockId]);
		const twice = withTornBlocks(once, ['x' as BlockId]);
		expect(twice.torn).to.deep.equal(['x']);
	});
});

describe('isFullyDurable', () => {
	it('is true for a full report with no torn blocks', () => {
		expect(isFullyDurable(report('full', 3))).to.equal(true);
		expect(isFullyDurable({ ...report('full', 3), torn: [] })).to.equal(true);
	});

	it('is false for a full report carrying a torn block — full alone is not enough', () => {
		expect(isFullyDurable({ ...report('full', 3), torn: ['b1' as BlockId] })).to.equal(false);
	});

	it('is false for every class below full', () => {
		expect(isFullyDurable(report('majority', 3))).to.equal(false);
		expect(isFullyDurable(localDurability())).to.equal(false);
		expect(isFullyDurable(unroutedDurability())).to.equal(false);
	});
});

describe('localDurability / unroutedDurability', () => {
	it('a local answer is one of one; with a peer id it also names the cohort', () => {
		expect(localDurability()).to.deep.equal({ quorum: 'local', confirmed: 1, cohort: 1 });
		expect(localDurability('me')).to.deep.equal({ quorum: 'local', confirmed: 1, cohort: 1, unconfirmed: [], cohortPeerIds: ['me'] });
	});

	it('an unrouted answer has a cohort of zero and names nobody', () => {
		const unrouted = unroutedDurability();
		expect(unrouted.cohort).to.equal(0);
		expect(unrouted.cohortPeerIds).to.equal(undefined);
		expect(unrouted.unconfirmed).to.equal(undefined);
	});
});
