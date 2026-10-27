/**
 * The judgement at the seams the SQL-level cases in offline-outlook.spec.ts cannot reach, pure, over
 * `judgeTransaction` with a hand-built schema; nothing is staged or queued. The dependency rule for
 * unchecked decisions (docs/offline-sync.md §Dependencies between entries): the schema the judgement is
 * handed, and the deferred journaled records ahead of the entry. And the three already-applied guard
 * kinds (docs/offline-sync.md §Guards that make idempotent writes assured), handed as staged actions:
 * judged as their base kinds, with `tolerates` on the exposures they produce.
 */

import { expect } from 'chai';
import type { Action } from '@optimystic/db-core';
import { judgeTransaction, renderCommitOutlook } from '../src/optimystic-adapter/commit-outlook.js';
import type { CommitOutlook, EarlierEntry, EntryFacts, OutlookSchema } from '../src/optimystic-adapter/commit-outlook.js';
import type { UncheckedRead } from '../src/optimystic-adapter/write-description.js';

const NOTES = 'outlook/notes';

/** A `row` read of `Notes` pinned to `n7`, as `uncheckedOf` records it. */
const readOfNote7: UncheckedRead = { table: { schema: 'main', table: 'notes' }, kind: 'read', scope: 'row', rows: [{ key: ['id'], values: ['n7'] }] };

const facts = (unchecked: readonly UncheckedRead[]): EntryFacts => ({ fresh: new Map(), unchecked, complete: true });

/** The schema with `Notes` published; its main tree encodes every pinned row to `K` once `initialized`. */
function schema(initialized: boolean): OutlookSchema {
	return {
		describe: () => ({ kind: 'unknown', table: undefined }),
		table: name => name.table === 'notes'
			? { name: 'main.Notes', ...(initialized ? { tree: { collectionId: NOTES, rowKey: () => 'K' } } : {}) }
			: undefined,
	};
}

/** An earlier entry whose segments are in `tables` but cannot be matched by key here: none are staged. */
const earlier = (transactionId: string, seq: number, tables: readonly string[]): EarlierEntry =>
	({ transactionId, seq, writes: new Map(), tables, assured: true, facts: undefined });

/** The schema with `Notes` published and initialized: its main tree is `NOTES`, each key decoding to itself. */
function notesSchema(singleWriter = false): OutlookSchema {
	return {
		describe: id => id === NOTES
			? { kind: 'main', table: 'main.Notes', freshKey: false, singleWriter, decodeKey: key => [key] }
			: { kind: 'unknown', table: undefined },
		table: () => undefined,
	};
}

/** A tree `replace` action over `elements`, each `[key, entry | undefined, guard]` as the vtab stages them. */
const replace = (...elements: readonly (readonly unknown[])[]): Action<unknown> => ({ type: 'replace', data: elements });

const NO_FACTS: EntryFacts = { fresh: new Map(), unchecked: [], complete: true };

/** The outlook of a transaction whose one segment, in `NOTES`, is `actions`, queued behind `ahead`. */
function judgedNotes(actions: readonly Action<unknown>[], schema: OutlookSchema, ahead: readonly EarlierEntry[] = []): CommitOutlook {
	return judgeTransaction({ writes: new Map([[NOTES, actions]]), tables: ['main.Notes'], facts: NO_FACTS }, schema, { earlier: ahead, deferred: [] }).outlook;
}

describe('commit-outlook: the already-applied guard kinds', () => {
	it('each variant is judged as its base kind, its exposure tolerating the same change, beside the base kind\'s which does not', () => {
		const outlook = judgedNotes([replace(
			['n1', ['n1', 'row'], { kind: 'absentOrEqual' }],
			['n2', ['n2', 'row'], { kind: 'unchangedOrEqual', expected: ['n2', 'old'] }],
			['n3', undefined, { kind: 'unchangedOrAbsent', expected: ['n3', 'old'] }],
			['n4', ['n4', 'row'], { kind: 'unchanged', expected: ['n4', 'old'] }],
		)], notesSchema());
		expect(outlook.kind).to.equal('exposed');
		expect(outlook.exposures).to.deep.equal([
			{ table: 'main.Notes', rule: 'primary-key', key: ['n1'], tolerates: 'same-change' },
			{ table: 'main.Notes', rule: 'row', key: ['n2'], tolerates: 'same-change' },
			{ table: 'main.Notes', rule: 'row', key: ['n3'], tolerates: 'same-change' },
			{ table: 'main.Notes', rule: 'row', key: ['n4'] },
		]);
		const rendered = JSON.parse(renderCommitOutlook(outlook)) as { exposures: Record<string, unknown>[] };
		expect(rendered.exposures.map(exposure => exposure['tolerates'])).to.deep.equal(['same-change', 'same-change', 'same-change', undefined]);
	});

	it('under a single-writer table the two unchanged variants are not exposed, as unchanged is not', () => {
		const outlook = judgedNotes([replace(
			['n2', ['n2', 'row'], { kind: 'unchangedOrEqual', expected: ['n2', 'old'] }],
			['n3', undefined, { kind: 'unchangedOrAbsent', expected: ['n3', 'old'] }],
		)], notesSchema(true));
		expect(outlook).to.deep.equal({ kind: 'assured', exposures: [], dependsOn: [], unchecked: [] });
	});

	it('an absentOrEqual insert covers a later check at its key, and counts as an insert under a fresh key for the entries behind it', () => {
		const insert = replace(['n5', ['n5', 'row'], { kind: 'absentOrEqual' }]);
		const update = replace(['n5', ['n5', 'row2'], { kind: 'unchanged', expected: ['n5', 'row'] }]);
		expect(judgedNotes([insert, update], notesSchema()).exposures, 'judged once, by the insert')
			.to.deep.equal([{ table: 'main.Notes', rule: 'primary-key', key: ['n5'], tolerates: 'same-change' }]);

		const inserter: EarlierEntry = {
			transactionId: 'inserter', seq: 1, writes: new Map([[NOTES, [insert]]]), tables: ['main.Notes'], assured: true,
			facts: { fresh: new Map([[NOTES, new Set(['n5'])]]), unchecked: [], complete: true },
		};
		expect(judgedNotes([update], notesSchema(), [inserter]), 'no other machine can know the row yet')
			.to.deep.equal({ kind: 'assured', exposures: [], dependsOn: [{ transactionId: 'inserter', via: 'guard' }], unchecked: [] });
	});
});

describe('commit-outlook: matching an unchecked decision against what is ahead', () => {
	it('a row read on a published table not yet initialized is named by the table\'s rendering and matched by table', () => {
		const { outlook } = judgeTransaction(
			{ writes: new Map(), tables: ['main.Memos'], facts: facts([readOfNote7]) },
			schema(false),
			{ earlier: [earlier('writer-of-notes', 1, ['main.Notes']), earlier('writer-of-users', 2, ['main.Users'])], deferred: [] },
		);
		expect(outlook.unchecked).to.deep.equal([{ table: 'main.Notes', kind: 'read', scope: 'row' }]);
		expect(outlook.dependsOn).to.deep.equal([{ transactionId: 'writer-of-notes', via: 'unchecked' }]);
	});

	it('a row read matched by key still depends on a deferred record that wrote the table, whose writes cannot be matched by key', () => {
		const { outlook } = judgeTransaction(
			{ writes: new Map(), tables: ['main.Memos'], facts: facts([readOfNote7]) },
			schema(true),
			{ earlier: [], deferred: [{ transactionId: 'deferred-notes', seq: 1, tables: ['main.Notes'] }, { transactionId: 'deferred-users', seq: 2, tables: ['main.Users'] }] },
		);
		expect(outlook.dependsOn).to.deep.equal([{ transactionId: 'deferred-notes', via: 'unchecked' }]);
		expect(outlook.kind, 'a dependency through a decision does not bear on the kind').to.equal('assured');
	});
});
