import { expect } from 'chai';
import { matchesFilter } from '../../src/matchmaking/index.js';
import type { CapabilityFilter } from '../../src/matchmaking/index.js';

const provider = (capabilities: string[], capacityBudget = 4): { capabilities: string[]; capacityBudget: number } => ({ capabilities, capacityBudget });

describe('matchmaking / capability filter', () => {
	it('an absent filter matches every provider', () => {
		expect(matchesFilter(provider(['a']), undefined)).to.equal(true);
		expect(matchesFilter(provider([]), undefined)).to.equal(true);
	});

	it('requires every must tag to be present', () => {
		const f: CapabilityFilter = { must: ['gpu', 'pdf'], mustNot: [] };
		expect(matchesFilter(provider(['gpu', 'pdf', 'x']), f)).to.equal(true);
		expect(matchesFilter(provider(['gpu']), f)).to.equal(false);
	});

	it('rejects when any mustNot tag is present', () => {
		const f: CapabilityFilter = { must: [], mustNot: ['beta'] };
		expect(matchesFilter(provider(['stable']), f)).to.equal(true);
		expect(matchesFilter(provider(['stable', 'beta']), f)).to.equal(false);
	});

	it('enforces minBudget when set', () => {
		const f: CapabilityFilter = { must: [], mustNot: [], minBudget: 3 };
		expect(matchesFilter(provider(['x'], 3), f)).to.equal(true);
		expect(matchesFilter(provider(['x'], 2), f)).to.equal(false);
	});

	it('combines must / mustNot / minBudget (all must hold)', () => {
		const f: CapabilityFilter = { must: ['gpu'], mustNot: ['beta'], minBudget: 2 };
		expect(matchesFilter(provider(['gpu'], 2), f)).to.equal(true);
		expect(matchesFilter(provider(['gpu', 'beta'], 5), f)).to.equal(false); // mustNot hit
		expect(matchesFilter(provider(['gpu'], 1), f)).to.equal(false);         // below minBudget
		expect(matchesFilter(provider(['cpu'], 5), f)).to.equal(false);         // missing must
	});

	it('a pathological filter matching nothing is acceptable (returns false, never throws)', () => {
		const f: CapabilityFilter = { must: ['nonexistent'], mustNot: [] };
		expect(matchesFilter(provider(['a', 'b', 'c']), f)).to.equal(false);
	});
});
