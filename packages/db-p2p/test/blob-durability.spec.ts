/**
 * Ticket: feat-blob-owed-ledger-and-durability-classes.
 *
 * `classifyBlobDurability` is docs/blobs.md §Placement, copying and durability, *Durability*, as
 * code: five rules in a fixed order over two counts. The order is the whole content of the rule —
 * what keeps a one-member cohort out of `full` and a node that holds its own blob out of `majority`
 * of itself — so it is pinned by a table rather than left to the drain's spec to discover.
 */

import { expect } from 'chai';
import type { BlobDurability } from '@optimystic/db-core';
import { classifyBlobDurability, type BlobCohortView } from '../src/blob/blob-durability.js';

const SELF = 'self-peer';
const OTHERS = ['peer-b', 'peer-c', 'peer-d', 'peer-e'];

interface Case {
	readonly what: string;
	readonly view: BlobCohortView;
	readonly holders: readonly string[];
	readonly expected: BlobDurability;
}

const CASES: readonly Case[] = [
	{
		what: 'an unresolved cohort is unrouted, naming nobody',
		view: { resolved: false, accepting: [] },
		holders: [SELF],
		expected: { quorum: 'unrouted', confirmed: 0, accepting: 0 },
	},
	{
		what: 'a resolved cohort that accepts from nobody is local',
		view: { resolved: true, accepting: [] },
		holders: [SELF],
		expected: { quorum: 'local', confirmed: 0, accepting: 0, unconfirmed: [] },
	},
	{
		what: 'this node the only accepting member, holding it, is local — not full',
		view: { resolved: true, accepting: [SELF] },
		holders: [SELF],
		expected: { quorum: 'local', confirmed: 1, accepting: 1, unconfirmed: [] },
	},
	{
		what: 'two of five is local, not majority',
		view: { resolved: true, accepting: [SELF, ...OTHERS] },
		holders: [SELF, 'peer-b'],
		expected: { quorum: 'local', confirmed: 2, accepting: 5, unconfirmed: ['peer-c', 'peer-d', 'peer-e'] },
	},
	{
		what: 'three of five is majority',
		view: { resolved: true, accepting: [SELF, ...OTHERS] },
		holders: [SELF, 'peer-b', 'peer-c'],
		expected: { quorum: 'majority', confirmed: 3, accepting: 5, unconfirmed: ['peer-d', 'peer-e'] },
	},
	{
		what: 'five of five with others among them is full, with nothing unconfirmed',
		view: { resolved: true, accepting: [SELF, ...OTHERS] },
		holders: [SELF, ...OTHERS],
		expected: { quorum: 'full', confirmed: 5, accepting: 5, unconfirmed: [] },
	},
	{
		what: 'this node outside the cohort, none holding, is local with every member unconfirmed',
		view: { resolved: true, accepting: ['peer-b', 'peer-c', 'peer-d'] },
		holders: [SELF],
		expected: { quorum: 'local', confirmed: 0, accepting: 3, unconfirmed: ['peer-b', 'peer-c', 'peer-d'] },
	},
	{
		what: 'this node outside the cohort, all three holding, is full',
		view: { resolved: true, accepting: ['peer-b', 'peer-c', 'peer-d'] },
		holders: [SELF, 'peer-b', 'peer-c', 'peer-d'],
		expected: { quorum: 'full', confirmed: 3, accepting: 3, unconfirmed: [] },
	},
];

describe('classifyBlobDurability', () => {
	for (const { what, view, holders, expected } of CASES) {
		it(what, () => {
			expect(classifyBlobDurability(view, new Set(holders), SELF)).to.deep.equal(expected);
		});
	}
});
