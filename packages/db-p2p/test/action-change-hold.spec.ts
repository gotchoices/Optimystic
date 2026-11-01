/**
 * The pure state behind `StorageRepo`'s per-collection change hold (`src/storage/action-change-hold.ts`).
 * The open/close/hold/release path is pinned end to end through storage in `storage-repo.spec.ts`
 * ("a hold while another collection of the action is still pending"); what is pinned here is the
 * bookkeeping that storage never reaches in a short test: the memory bound, and the retry rule.
 */

import { expect } from 'chai';
import type { ActionId, BlockId, CollectionChangeEvent } from '@optimystic/db-core';
import { ActionChangeHold } from '../src/storage/action-change-hold.js';

const event = (actionId: string, collectionId: string): CollectionChangeEvent =>
	({ collectionId: collectionId as BlockId, blockIds: [], actionId: actionId as ActionId, rev: 1 });

describe('ActionChangeHold', () => {
	it('a re-delivered pend over blocks of an existing group extends that group instead of adding a second', () => {
		const hold = new ActionChangeHold();
		hold.notePendGroup('a1' as ActionId, ['x', 'y'] as BlockId[], 0);
		hold.notePendGroup('a1' as ActionId, ['y', 'z'] as BlockId[], 0);
		hold.notePendGroup('a1' as ActionId, ['q'] as BlockId[], 0);

		const groups = hold.openGroups('a1' as ActionId);
		expect(groups.map(group => [...group.blockIds].sort())).to.deep.equal([['x', 'y', 'z'], ['q']]);

		// Landing any block of the merged group closes the whole of it, and only it.
		hold.closeGroups('a1' as ActionId, ['z'] as BlockId[]);
		expect(hold.openGroups('a1' as ActionId).map(group => [...group.blockIds])).to.deep.equal([['q']]);
	});

	it('at capacity, a new action evicts the oldest and hands back its held events rather than dropping them', () => {
		const hold = new ActionChangeHold({ maxActions: 2 });
		hold.notePendGroup('old' as ActionId, ['o1'] as BlockId[], 0);
		hold.notePendGroup('old' as ActionId, ['o2'] as BlockId[], 0);
		hold.closeGroups('old' as ActionId, ['o1'] as BlockId[]);
		hold.hold('old' as ActionId, event('old', 'collection-O'));
		hold.notePendGroup('mid' as ActionId, ['m1'] as BlockId[], 1);

		const evicted = hold.notePendGroup('new' as ActionId, ['n1'] as BlockId[], 2);

		expect(evicted?.actionId).to.equal('old');
		expect(evicted?.held.map(e => e.collectionId)).to.deep.equal(['collection-O']);
		expect(hold.knows('old' as ActionId), 'the evicted action is forgotten').to.equal(false);
		expect(hold.size).to.equal(2);
		// Extending a tracked action never evicts anyone.
		expect(hold.notePendGroup('mid' as ActionId, ['m2'] as BlockId[], 3)).to.equal(undefined);
	});

	it('ageOut drops stale actions that hold no events and keeps young ones and ones with held events', () => {
		const hold = new ActionChangeHold({ staleEntryMs: 100 });
		hold.notePendGroup('vanished' as ActionId, ['v1'] as BlockId[], 0);
		hold.notePendGroup('holding' as ActionId, ['h1'] as BlockId[], 0);
		hold.notePendGroup('holding' as ActionId, ['h2'] as BlockId[], 0);
		hold.closeGroups('holding' as ActionId, ['h1'] as BlockId[]);
		hold.hold('holding' as ActionId, event('holding', 'collection-H'));
		hold.notePendGroup('young' as ActionId, ['y1'] as BlockId[], 50);

		hold.ageOut(120);

		expect(hold.knows('vanished' as ActionId), 'old and holding nothing: dropped').to.equal(false);
		expect(hold.knows('holding' as ActionId), 'old but holding an event: left to its timer').to.equal(true);
		expect(hold.knows('young' as ActionId), 'not yet stale: kept').to.equal(true);
		expect(hold.release('holding' as ActionId).map(e => e.collectionId)).to.deep.equal(['collection-H']);
		expect(hold.release('holding' as ActionId), 'a second release finds nothing').to.deep.equal([]);
	});
});
