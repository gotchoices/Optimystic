/**
 * Guard-carrying tree actions (tickets `concurrent-insert-guard-refuses-taken-key` and
 * `tree-entry-unchanged-guard`).
 *
 * A `TreeReplaceAction` entry may carry a `TreeEntryGuard` stating the intent the SQL
 * layer's pre-stage probe otherwise discards: `absent` (INSERT — the key must not
 * exist), `keepExisting` (INSERT OR IGNORE — skip silently if it does), `absentRange`
 * (secondary-UNIQUE — nothing foreign inside a key prefix range) and `unchanged` (the
 * lost-update check — the entry at the key must still be exactly the one this write read).
 * The `replace` handler enforces the guard on EVERY run — initial staging and every
 * conflict replay — so a losing concurrent writer is REFUSED instead of silently
 * overwriting the winner's committed row when its pending action replays against the
 * adopted revision.
 *
 * Both write paths are pinned here:
 *  - the single-collection sync path (`Tree.sync` → `Collection.updateAndSync`), where
 *    the refusal surfaces out of the leading refresh or the stale-failure retry refresh;
 *  - the coordinator path (`TransactionCoordinator.commit`), where it surfaces out of
 *    the inter-attempt blanket `update()` after a clean stale loss — driven by a REAL
 *    competing writer (`CompetingWriterTransactor`), not a faked failure.
 */

import { expect } from 'chai';
import {
	Tree,
	TreeDeleteGuardKindError,
	TreeEntryChangedError,
	TreeGuardRefusedError,
	TreeKeyTakenError,
	TreeRangeTakenError,
	KeyRange,
	TransactionCoordinator,
	createTransactionStamp,
	createTransactionId,
	ACTIONS_ENGINE_ID,
	blockIdsForTransforms,
	type Transaction,
	type BlockId,
	type ITransactor,
	type TreeEntryGuard,
	type TreeReplaceAction,
} from '../src/index.js';
import {
	TestTransactor,
	CompetingWriterTransactor,
	commitRivalTreeWrite,
} from '../src/testing/test-transactor.js';

interface Entry {
	key: number;
	name: string;
}

const byKey = (e: Entry) => e.key;

/** Run `fn` and hand back what it threw; fails the test if it resolved. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected operation to throw, but it resolved');
}

describe('Tree entry guards (concurrent-insert refusal)', function () {
	this.timeout(20000);

	// The class lattice is dispatched on, not just thrown: the Quereus bridge walks a commit
	// failure's cause chain and renders by class (`mapCommitRefusal`), so which refusal is a
	// subclass of which decides what message a client sees. Pinned once here, in one place, rather
	// than left to be inferred from the scattered `instanceOf` assertions on each thrown instance —
	// a future subclass added to the wrong parent silently re-renders a refusal as something else.
	describe('refusal class lattice', () => {
		it('splits uniqueness refusals from lost-update refusals under one guard-refusal base', () => {
			const taken = new TreeKeyTakenError<number>('c', 1);
			const range = new TreeRangeTakenError<number>(
				'c', 1, { first: { key: 0, inclusive: true }, isAscending: true }, 2);
			const changed = new TreeEntryChangedError<number, Entry>('c', 1, { key: 1, name: 'x' }, undefined);
			const malformed = new TreeDeleteGuardKindError<number>('c', 1, 'absent');

			// Every concurrency refusal shares the base contract (discard the action, never retry).
			for (const err of [taken, range, changed]) {
				expect(err, `${err.name} is a guard refusal`).to.be.instanceOf(TreeGuardRefusedError);
				expect(err.collectionId).to.equal('c');
				expect(err.key).to.equal(1);
			}
			// A range refusal is a uniqueness refusal; a lost update is NOT, or the bridge would
			// render it as `UNIQUE constraint failed`.
			expect(range).to.be.instanceOf(TreeKeyTakenError);
			expect(changed).to.not.be.instanceOf(TreeKeyTakenError);
			expect(taken).to.not.be.instanceOf(TreeEntryChangedError);
			// A malformed action is a caller bug, not a refusal anything should retry or map.
			expect(malformed).to.not.be.instanceOf(TreeGuardRefusedError);
			expect(malformed).to.be.instanceOf(Error);
		});
	});

	describe('sync path (Tree.sync / updateAndSync)', () => {
		it('refuses an absent-guarded insert whose key a rival committed first, keeping the winner\'s row', async () => {
			const transactor = new TestTransactor();
			const winner = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const loser = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);

			// Both writers probe an empty view and stage the same key — the racing shape.
			await winner.stage([[1, { key: 1, name: 'winner' }, { kind: 'absent' }]]);
			await loser.stage([[1, { key: 1, name: 'loser' }, { kind: 'absent' }]]);

			await winner.sync();
			const err = await capture(() => loser.sync());
			expect(err, 'the loser is refused, not silently absorbed').to.be.instanceOf(TreeKeyTakenError);
			expect((err as TreeKeyTakenError).collectionId).to.equal('users');
			expect((err as TreeKeyTakenError<number>).key).to.equal(1);

			// The winner's row survives — on a FRESH reader sharing no cache with either writer.
			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'the winner\'s row is the durable one').to.deep.equal({ key: 1, name: 'winner' });
			// Exactly one durable action landed (the winner's) — the loser committed nothing.
			expect(transactor.getCommittedActions().size, 'only the winner landed').to.equal(1);
		});

		it('refuses via the stale-failure retry refresh when the rival lands mid-pend', async () => {
			// The rival fires INSIDE the loser's first pend, so the loser's leading refresh saw
			// nothing and the refusal must come from the retry loop's own refresh+replay — the
			// choke point the design leans on.
			const inner = new TestTransactor();
			const transactor = new CompetingWriterTransactor(
				inner,
				unwrapped => commitRivalTreeWrite<number, Entry>(
					unwrapped, 'users', byKey, [[1, { key: 1, name: 'rival' }]]),
			);
			const loser = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			await loser.stage([[1, { key: 1, name: 'loser' }, { kind: 'absent' }]]);

			const err = await capture(() => loser.sync());
			expect(err).to.be.instanceOf(TreeKeyTakenError);
			expect(transactor.rivalRuns, 'the competing writer really ran').to.equal(1);

			const fresh = await Tree.createOrOpen<number, Entry>(inner, 'users', byKey);
			expect(await fresh.get(1)).to.deep.equal({ key: 1, name: 'rival' });
		});

		it('keepExisting skips the entry silently: the loser\'s sync succeeds and the winner\'s row survives', async () => {
			const transactor = new TestTransactor();
			const winner = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const ignorer = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);

			await winner.stage([[1, { key: 1, name: 'winner' }, { kind: 'absent' }]]);
			await ignorer.stage([[1, { key: 1, name: 'ignored' }, { kind: 'keepExisting' }]]);

			await winner.sync();
			// INSERT OR IGNORE semantics under concurrency: no throw, no overwrite.
			await ignorer.sync();

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'the existing row was kept').to.deep.equal({ key: 1, name: 'winner' });
		});

		it('three concurrent writers on one key: exactly one wins, every other writer is refused', async () => {
			const transactor = new TestTransactor();
			const writers = await Promise.all(['a', 'b', 'c'].map(async name => {
				const tree = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
				await tree.stage([[1, { key: 1, name }, { kind: 'absent' }]]);
				return { name, tree };
			}));

			const results = await Promise.allSettled(writers.map(w => w.tree.sync()));
			const fulfilled = results
				.map((r, i) => ({ r, w: writers[i]! }))
				.filter(({ r }) => r.status === 'fulfilled');
			const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

			expect(fulfilled.length, 'exactly one writer wins').to.equal(1);
			expect(rejected.length, 'every other writer is refused').to.equal(2);
			for (const r of rejected) {
				expect(r.reason, 'each loser gets the structured refusal').to.be.instanceOf(TreeKeyTakenError);
			}

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'the surviving row is the winner\'s').to.deep.equal({ key: 1, name: fulfilled[0]!.w.name });
			expect(transactor.getCommittedActions().size, 'exactly one durable data action').to.equal(1);
		});

		it('allows a legitimate re-insert of a key the winner deleted (guard reads the adopted state, not history)', async () => {
			const transactor = new TestTransactor();
			const older = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			// Seed so the collection exists in storage before the second handle opens.
			await older.replace([[0, { key: 0, name: 'seed' }]]);
			const behind = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);

			// The other writer inserts key 1, then deletes it — two committed revisions the
			// behind handle has not seen.
			await older.replace([[1, { key: 1, name: 'ghost' }]]);
			await older.replace([[1, undefined]]);

			// The behind handle probes clear (its view predates both commits) and stages a
			// guarded insert. Its refresh adopts the delete along with the insert, so the
			// replayed guard sees the key ABSENT and the re-insert proceeds.
			await behind.stage([[1, { key: 1, name: 'reborn' }, { kind: 'absent' }]]);
			await behind.sync();

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'a deleted key is legitimately reusable').to.deep.equal({ key: 1, name: 'reborn' });
		});

		it('enforces the guard at INITIAL staging too: staging over an already-visible key throws', async () => {
			const transactor = new TestTransactor();
			const first = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			await first.replace([[1, { key: 1, name: 'original' }]]);

			const second = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			// The SQL layer probes before staging, so this shape is a second line of defence:
			// a caller that skips the probe still cannot silently overwrite.
			const err = await capture(() => second.stage([[1, { key: 1, name: 'clobber' }, { kind: 'absent' }]]));
			expect(err).to.be.instanceOf(TreeKeyTakenError);

			// The throw discarded the whole action's staged writes: nothing pends, and the
			// original row is untouched.
			expect(second.hasUnsyncedChanges(), 'the refused action left nothing staged').to.be.false;
			expect(await second.get(1)).to.deep.equal({ key: 1, name: 'original' });
		});

	});

	// A UNIQUE secondary index is a Tree<string, [treeKey, pk]> keyed on `value#pk`, so two
	// rows sharing a unique value but differing in PK occupy DIFFERENT tree keys inside one
	// value prefix. The `absentRange` guard claims the whole prefix range minus its own key.
	describe('absentRange guard (secondary-UNIQUE prefix enforcement)', () => {
		type IdxEntry = [string, string]; // [treeKey, primaryKey]
		const byTreeKey = (e: IdxEntry) => e[0];
		// The tree-key range holding every entry for value `v`: keys are `v#<pk>`, and '#'
		// (0x23) < '$' (0x24), so [`v#`, `v$`) brackets exactly the `v#*` family.
		const valueRange = (v: string): KeyRange<string> =>
			new KeyRange<string>({ key: `${v}#`, inclusive: true }, { key: `${v}$`, inclusive: false }, true);
		const uniqueGuard = (v: string) => ({ kind: 'absentRange' as const, range: valueRange(v) });
		const entryFor = (v: string, pk: string): IdxEntry => [`${v}#${pk}`, pk];
		const stageUnique = (tree: Tree<string, IdxEntry>, v: string, pk: string) =>
			tree.stage([[`${v}#${pk}`, entryFor(v, pk), uniqueGuard(v)]]);

		it('refuses a losing writer whose unique VALUE a rival committed under a different PK', async () => {
			const transactor = new TestTransactor();
			const winner = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			const loser = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);

			// Both probe an empty prefix and stage the SAME value under DIFFERENT pks.
			await stageUnique(winner, 'v', 'a');
			await stageUnique(loser, 'v', 'b');

			await winner.sync();
			const err = await capture(() => loser.sync());
			expect(err, 'the loser is refused for the range, not the exact key').to.be.instanceOf(TreeRangeTakenError);
			expect((err as TreeRangeTakenError).collectionId).to.equal('ux');
			expect((err as TreeRangeTakenError<string>).occupant, 'the refusal names the rival key it collided with').to.equal('v#a');
			// TreeRangeTakenError IS a TreeKeyTakenError, so a consumer refusing on the base
			// class handles it with no new arm.
			expect(err, 'subclass of the exact-key refusal').to.be.instanceOf(TreeKeyTakenError);

			// Exactly one entry survives for value 'v' — the winner's.
			const fresh = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			const survivors: string[] = [];
			for await (const path of fresh.range(valueRange('v'))) {
				const e = fresh.at(path); if (e) survivors.push(e[1]);
			}
			expect(survivors, 'only the winning row is durable').to.deep.equal(['a']);
		});

		it('self-exclusion: a guarded entry never refuses itself on its own key (initial stage and clean sync)', async () => {
			const transactor = new TestTransactor();
			const tree = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			// No rival — the guard scans the range, finds only its OWN key, excludes it, proceeds.
			await stageUnique(tree, 'v', 'a');
			await tree.sync();
			const fresh = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			expect(await fresh.get('v#a')).to.deep.equal(['v#a', 'a']);
		});

		it('does not refuse a different unique value (discriminator against over-broad ranges)', async () => {
			const transactor = new TestTransactor();
			const first = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			const second = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			await stageUnique(first, 'v1', 'a');
			await stageUnique(second, 'v2', 'b');
			await first.sync();
			await second.sync(); // disjoint values — no false refusal
			const fresh = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			expect(await fresh.get('v1#a')).to.not.be.undefined;
			expect(await fresh.get('v2#b')).to.not.be.undefined;
		});

		it('allows re-use of a unique value the winner DELETED (guard reads adopted state, not history)', async () => {
			const transactor = new TestTransactor();
			const older = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			await older.replace([['seed#0', ['seed#0', '0']]]); // materialise the collection
			const behind = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);

			// The other writer inserts value 'v' then deletes it — two revisions behind hasn't seen.
			await older.replace([['v#a', ['v#a', 'a']]]);
			await older.replace([['v#a', undefined]]);

			// behind probed clear (its view predates both) and stages a guarded insert of the
			// same value under a different pk. Its refresh adopts the delete, so the replayed
			// guard sees the prefix empty and proceeds.
			await stageUnique(behind, 'v', 'b');
			await behind.sync();
			const fresh = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			expect(await fresh.get('v#b'), 'a deleted unique value is reusable').to.deep.equal(['v#b', 'b']);
		});

		it('enforces the range guard at INITIAL staging over an already-visible foreign key', async () => {
			const transactor = new TestTransactor();
			const first = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			await first.replace([['v#a', ['v#a', 'a']]]);
			const second = await Tree.createOrOpen<string, IdxEntry>(transactor, 'ux', byTreeKey);
			const err = await capture(() => stageUnique(second, 'v', 'b'));
			expect(err).to.be.instanceOf(TreeRangeTakenError);
			expect(second.hasUnsyncedChanges(), 'the refused action left nothing staged').to.be.false;
		});
	});

	// The `unchanged` guard is the only kind that says something must still BE at the key: the
	// optimistic-concurrency (lost-update) check. It is the one kind a DELETE can also carry, and
	// it treats an ABSENT entry as changed — the staged effect was computed from an image that no
	// longer exists, so re-applying it would resurrect a deleted row (upsert) or be the second of
	// two racing deletes.
	describe('unchanged guard (lost-update refusal)', () => {
		const original: Entry = { key: 1, name: 'original' };
		const unchangedGuard = (expected: Entry) => ({ kind: 'unchanged' as const, expected });

		/** Commit `original` at key 1 through its own handle, so every writer below opens onto a
		 *  collection that already holds the entry their guard names. */
		async function seedOriginal(transactor: ITransactor): Promise<void> {
			const seeder = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			await seeder.replace([[1, original]]);
		}

		it('commits a guarded upsert while the committed entry is still the one that was read', async () => {
			const transactor = new TestTransactor();
			await seedOriginal(transactor);

			const writer = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			await writer.stage([[1, { key: 1, name: 'updated' }, unchangedGuard(original)]]);
			await writer.sync();

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'an uncontested guarded update lands normally').to.deep.equal({ key: 1, name: 'updated' });
		});

		it('refuses an upsert whose entry a rival CHANGED first, keeping the rival\'s entry', async () => {
			const transactor = new TestTransactor();
			await seedOriginal(transactor);
			const rival = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const loser = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);

			// The loser stages against the image it read; the rival then lands a different one.
			await loser.stage([[1, { key: 1, name: 'loser' }, unchangedGuard(original)]]);
			await rival.replace([[1, { key: 1, name: 'rival' }]]);

			const err = await capture(() => loser.sync());
			expect(err, 'the loser is refused, not silently applied over the rival').to.be.instanceOf(TreeEntryChangedError);
			const refusal = err as TreeEntryChangedError<number, Entry>;
			expect(refusal.collectionId).to.equal('users');
			expect(refusal.key).to.equal(1);
			expect(refusal.expected, 'the refusal carries the image the write read').to.deep.equal(original);
			expect(refusal.actual, 'and what is committed there now').to.deep.equal({ key: 1, name: 'rival' });
			// A lost update is NOT a uniqueness failure: the Quereus bridge renders every
			// TreeKeyTakenError as `UNIQUE constraint failed`, which would misreport this one.
			expect(err, 'shares the guard-refusal contract').to.be.instanceOf(TreeGuardRefusedError);
			expect(err, 'but is not a uniqueness refusal').to.not.be.instanceOf(TreeKeyTakenError);

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'the rival\'s entry is the durable one').to.deep.equal({ key: 1, name: 'rival' });
		});

		it('refuses an upsert whose entry a rival DELETED — absence counts as changed, so no row is resurrected', async () => {
			const transactor = new TestTransactor();
			await seedOriginal(transactor);
			const rival = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const loser = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);

			await loser.stage([[1, { key: 1, name: 'loser' }, unchangedGuard(original)]]);
			await rival.replace([[1, undefined]]);

			const err = await capture(() => loser.sync());
			expect(err).to.be.instanceOf(TreeEntryChangedError);
			expect((err as TreeEntryChangedError<number, Entry>).actual, 'nothing is committed at the key').to.be.undefined;

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'the deleted row stays deleted').to.be.undefined;
		});

		it('commits a guarded DELETE while the entry is unchanged', async () => {
			const transactor = new TestTransactor();
			await seedOriginal(transactor);

			const writer = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			await writer.stage([[1, undefined, unchangedGuard(original)]]);
			await writer.sync();

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'an uncontested guarded delete lands normally').to.be.undefined;
		});

		it('refuses a guarded DELETE whose entry a rival changed — the delete was decided on a stale image', async () => {
			const transactor = new TestTransactor();
			await seedOriginal(transactor);
			const rival = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const loser = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);

			await loser.stage([[1, undefined, unchangedGuard(original)]]);
			await rival.replace([[1, { key: 1, name: 'rival' }]]);

			const err = await capture(() => loser.sync());
			expect(err, 'the delete branch evaluates its guard too').to.be.instanceOf(TreeEntryChangedError);
			expect((err as TreeEntryChangedError<number, Entry>).actual).to.deep.equal({ key: 1, name: 'rival' });

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'the rival\'s change is not deleted out from under it').to.deep.equal({ key: 1, name: 'rival' });
		});

		it('discards the WHOLE action when only one of its entries is refused', async () => {
			const transactor = new TestTransactor();
			await seedOriginal(transactor);
			const rival = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const loser = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);

			// One action, two entries: a guarded delete of key 1 and a clean insert of key 2.
			await loser.stage([
				[1, undefined, unchangedGuard(original)],
				[2, { key: 2, name: 'sibling' }, { kind: 'absent' }],
			]);
			await rival.replace([[1, { key: 1, name: 'rival' }]]);

			const err = await capture(() => loser.sync());
			expect(err).to.be.instanceOf(TreeEntryChangedError);

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(2), 'the sibling entry of a refused action never lands').to.be.undefined;
			expect(await fresh.get(1), 'and the refused entry is untouched').to.deep.equal({ key: 1, name: 'rival' });
		});

		it('compares a guard that round-tripped through JSON exactly like a live one', async () => {
			// A guard rides in the log beside its action, so by the time a conflict replay reads it
			// back it is plain deserialized data — a different object graph than the one staged.
			const roundTrip = (guard: TreeEntryGuard<number, Entry>) =>
				JSON.parse(JSON.stringify(guard)) as TreeEntryGuard<number, Entry>;

			const transactor = new TestTransactor();
			await seedOriginal(transactor);
			const writer = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			await writer.stage([[1, { key: 1, name: 'updated' }, roundTrip(unchangedGuard(original))]]);
			await writer.sync();
			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'a round-tripped expected still compares equal').to.deep.equal({ key: 1, name: 'updated' });

			// ...and still refuses a genuinely different entry.
			const other = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const err = await capture(() => other.stage([[1, { key: 1, name: 'stale' }, roundTrip(unchangedGuard(original))]]));
			expect(err).to.be.instanceOf(TreeEntryChangedError);
		});

		it('compares a Uint8Array-bearing entry by BYTES, not by object identity', async () => {
			interface BlobEntry { key: number; blob: Uint8Array }
			const byBlobKey = (e: BlobEntry) => e.key;
			const seed: BlobEntry = { key: 1, blob: new Uint8Array([1, 2, 3]) };

			const transactor = new TestTransactor();
			const seeder = await Tree.createOrOpen<number, BlobEntry>(transactor, 'blobs', byBlobKey);
			await seeder.replace([[1, seed]]);

			// A DIFFERENT Uint8Array instance carrying the same bytes must satisfy the guard —
			// the entry read back out of the tree is a clone, never the object that was written.
			const writer = await Tree.createOrOpen<number, BlobEntry>(transactor, 'blobs', byBlobKey);
			const expected: BlobEntry = { key: 1, blob: new Uint8Array([1, 2, 3]) };
			await writer.stage([[1, { key: 1, blob: new Uint8Array([9]) }, { kind: 'unchanged', expected }]]);
			await writer.sync();
			const fresh = await Tree.createOrOpen<number, BlobEntry>(transactor, 'blobs', byBlobKey);
			expect(await fresh.get(1)).to.deep.equal({ key: 1, blob: new Uint8Array([9]) });

			// One differing byte is a differing entry.
			const other = await Tree.createOrOpen<number, BlobEntry>(transactor, 'blobs', byBlobKey);
			const err = await capture(() => other.stage([
				[1, { key: 1, blob: new Uint8Array([0]) }, { kind: 'unchanged', expected: { key: 1, blob: new Uint8Array([9, 9]) } }],
			]));
			expect(err).to.be.instanceOf(TreeEntryChangedError);
		});

		it('rejects a DELETE carrying any other guard kind — at the type level and at runtime', async () => {
			const transactor = new TestTransactor();
			await seedOriginal(transactor);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);

			// The delete element type admits only an `unchanged` guard; every other kind asserts
			// that nothing is present, which would make the delete a no-op by construction.
			// @ts-expect-error - 'absent' is not a TreeUnchangedGuard
			const illTyped: TreeReplaceAction<number, Entry> = [[1, undefined, { kind: 'absent' }]];

			// The handler re-checks at runtime because a replayed log entry is deserialized data
			// no type policed: better a loud failure than a guard the writer believes is enforced.
			const err = await capture(() => tree.stage(illTyped));
			// A malformed action, not a concurrency refusal — so deliberately NOT a
			// TreeGuardRefusedError, whose contract ("a rival won; retry sequentially") does not
			// describe a caller bug.
			expect(err).to.be.instanceOf(TreeDeleteGuardKindError);
			expect(err, 'a malformed action is not a guard refusal').to.not.be.instanceOf(TreeGuardRefusedError);
			expect((err as TreeDeleteGuardKindError<number>).guardKind).to.equal('absent');
			expect((err as Error).message).to.match(/only 'unchanged' is meaningful on a delete/);
			expect(tree.hasUnsyncedChanges(), 'the rejected action left nothing staged').to.be.false;
		});

		it('is not retried by the sync loop: the refusal escapes on the FIRST attempt', async () => {
			// The rival fires inside the loser's first pend, so the refusal comes out of the
			// stale-failure retry refresh. It must end the sync there — a TreeEntryChangedError is
			// not a StaleFailure, so nothing may absorb it into another attempt.
			const inner = new TestTransactor();
			await seedOriginal(inner);
			const transactor = new CompetingWriterTransactor(
				inner,
				unwrapped => commitRivalTreeWrite<number, Entry>(
					unwrapped, 'users', byKey, [[1, { key: 1, name: 'rival' }]]),
			);
			const loser = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			await loser.stage([[1, { key: 1, name: 'loser' }, unchangedGuard(original)]]);

			const err = await capture(() => loser.sync());
			expect(err).to.be.instanceOf(TreeEntryChangedError);
			expect(transactor.rivalRuns, 'the competing writer really ran').to.equal(1);
			expect(transactor.pendCalls, 'no second attempt was made').to.equal(1);
		});

		it('reads a JSON round-tripped empty slot as "no entry" / "no guard", never as a value', async () => {
			// JSON renders the empty slots of `[key, undefined]` and `[key, entry, undefined]` as
			// `null` — and that is exactly what a conflict replay reads back out of the log. The
			// delete slot must stay a delete, and the absent guard slot must stay "unguarded"
			// rather than have `.kind` read off null mid-replay.
			const transactor = new TestTransactor();
			const tree = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			await tree.replace([[1, original], [2, { key: 2, name: 'two' }]]);

			const roundTripped = JSON.parse(JSON.stringify([
				[1, undefined],									// a delete
				[2, { key: 2, name: 'updated' }, undefined],	// an unguarded upsert (the shape every
			])) as TreeReplaceAction<number, Entry>;			// non-unique index write stages)
			expect(roundTripped[0]![1], 'JSON really does produce null in the entry slot').to.be.null;
			expect(roundTripped[1]![2], 'and in the guard slot').to.be.null;

			await tree.replace(roundTripped);

			const fresh = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			expect(await fresh.get(1), 'the null entry slot still means delete').to.be.undefined;
			expect(await fresh.get(2), 'the null guard slot still means unguarded upsert').to.deep.equal({ key: 2, name: 'updated' });
		});
	});

	describe('coordinator path (TransactionCoordinator.commit inter-attempt refresh)', () => {
		it('a real competing commit turns the retry into a refusal, and the multi-collection transaction lands NOTHING', async () => {
			const inner = new TestTransactor();
			const usersBlockIds = new Set<BlockId>();
			const transactor = new CompetingWriterTransactor(
				inner,
				unwrapped => commitRivalTreeWrite<number, Entry>(
					unwrapped, 'users', byKey, [[1, { key: 1, name: 'rival' }]]),
				// Fire on the pend that carries the users collection's staged blocks, not on
				// pend call order (pendPhase's fan-out order is a map-iteration detail).
				{ when: request => blockIdsForTransforms(request.transforms).some(id => usersBlockIds.has(id)) },
			);

			const usersTree = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const postsTree = await Tree.createOrOpen<number, Entry>(transactor, 'posts', byKey);
			const coordinator = new TransactionCoordinator(transactor, new Map<string, any>([
				['users', usersTree.getCollection()],
				['posts', postsTree.getCollection()],
			]));

			// Stage through the vtab's deferred-DML path (Tree.stage → Collection.act): the
			// guarded insert that will collide, plus a clean sibling-collection write that
			// must NOT land once the transaction is refused.
			await usersTree.stage([[1, { key: 1, name: 'loser' }, { kind: 'absent' }]]);
			await postsTree.stage([[100, { key: 100, name: 'clean' }]]);
			for (const id of blockIdsForTransforms(usersTree.getCollection().tracker.transforms)) {
				usersBlockIds.add(id);
			}

			const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
			const statements = ['insert users 1 + posts 100'];
			const transaction: Transaction = {
				stamp, statements, reads: [],
				id: await createTransactionId(stamp.id, statements, []),
			};

			const err = await capture(() => coordinator.commit(transaction, { baseBackoffMs: 1, maxBackoffMs: 5 }));
			// The refusal escapes the retry loop as the structured error — the stale-loss
			// wrapper must not absorb it into another attempt.
			expect(err, 'the inter-attempt refresh surfaces the refusal').to.be.instanceOf(TreeKeyTakenError);
			expect((err as TreeKeyTakenError).collectionId).to.equal('users');
			expect(transactor.rivalRuns, 'the competing writer really ran').to.equal(1);

			// Durable state: the rival's row is the only users row, and the posts half of the
			// refused transaction landed NOTHING (the first attempt's pends were cancelled;
			// posts was never committed, so a pure open resolves undefined).
			const freshUsers = await Tree.createOrOpen<number, Entry>(inner, 'users', byKey);
			expect(await freshUsers.get(1)).to.deep.equal({ key: 1, name: 'rival' });
			expect(await Tree.open<number, Entry>(inner, 'posts', byKey), 'the sibling collection never committed').to.be.undefined;
			expect(inner.getCommittedActions().size, 'only the rival\'s action is durable').to.equal(1);
		});

		it('surfaces an unchanged-guard refusal out of the inter-attempt refresh, landing NOTHING', async () => {
			// Same shape as the absent-guard case above, for the lost-update guard: the refusal
			// must escape the coordinator's stale-loss re-drive rather than be absorbed into
			// another attempt, and the sibling collection's clean write must not land either.
			const inner = new TestTransactor();
			const original: Entry = { key: 1, name: 'original' };
			const seeder = await Tree.createOrOpen<number, Entry>(inner, 'users', byKey);
			await seeder.replace([[1, original]]);

			const usersBlockIds = new Set<BlockId>();
			const transactor = new CompetingWriterTransactor(
				inner,
				unwrapped => commitRivalTreeWrite<number, Entry>(
					unwrapped, 'users', byKey, [[1, { key: 1, name: 'rival' }]]),
				{ when: request => blockIdsForTransforms(request.transforms).some(id => usersBlockIds.has(id)) },
			);

			const usersTree = await Tree.createOrOpen<number, Entry>(transactor, 'users', byKey);
			const postsTree = await Tree.createOrOpen<number, Entry>(transactor, 'posts', byKey);
			const coordinator = new TransactionCoordinator(transactor, new Map<string, any>([
				['users', usersTree.getCollection()],
				['posts', postsTree.getCollection()],
			]));

			await usersTree.stage([[1, { key: 1, name: 'loser' }, { kind: 'unchanged', expected: original }]]);
			await postsTree.stage([[100, { key: 100, name: 'clean' }]]);
			for (const id of blockIdsForTransforms(usersTree.getCollection().tracker.transforms)) {
				usersBlockIds.add(id);
			}

			const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
			const statements = ['update users 1 + insert posts 100'];
			const transaction: Transaction = {
				stamp, statements, reads: [],
				id: await createTransactionId(stamp.id, statements, []),
			};

			const err = await capture(() => coordinator.commit(transaction, { baseBackoffMs: 1, maxBackoffMs: 5 }));
			expect(err, 'the inter-attempt refresh surfaces the refusal').to.be.instanceOf(TreeEntryChangedError);
			expect((err as TreeEntryChangedError<number, Entry>).actual).to.deep.equal({ key: 1, name: 'rival' });
			expect(transactor.rivalRuns, 'the competing writer really ran').to.equal(1);

			const freshUsers = await Tree.createOrOpen<number, Entry>(inner, 'users', byKey);
			expect(await freshUsers.get(1), 'the rival\'s row is the durable one').to.deep.equal({ key: 1, name: 'rival' });
			expect(await Tree.open<number, Entry>(inner, 'posts', byKey), 'the sibling collection never committed').to.be.undefined;
			// The seeder's action plus the rival's — the refused transaction added nothing.
			expect(inner.getCommittedActions().size, 'nothing of the refused transaction is durable').to.equal(2);
		});
	});
});
