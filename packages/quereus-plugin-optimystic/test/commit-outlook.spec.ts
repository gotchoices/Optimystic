/**
 * The dependency rule for unchecked decisions (docs/offline-sync.md §Dependencies between entries) at
 * the seams the SQL-level cases in offline-outlook.spec.ts cannot reach: the schema the judgement is
 * handed, and the deferred journaled records ahead of the entry. Pure, over `judgeTransaction` with a
 * hand-built schema; nothing is staged or queued.
 */

import { expect } from 'chai';
import { judgeTransaction } from '../src/optimystic-adapter/commit-outlook.js';
import type { EarlierEntry, EntryFacts, OutlookSchema } from '../src/optimystic-adapter/commit-outlook.js';
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
