/**
 * Guard-carrying tree actions (ticket `concurrent-insert-guard-refuses-taken-key`).
 *
 * A `TreeReplaceAction` entry may carry a `TreeEntryGuard` stating the intent the SQL
 * layer's pre-stage probe otherwise discards: `absent` (INSERT — the key must not
 * exist), `keepExisting` (INSERT OR IGNORE — skip silently if it does). The `replace`
 * handler enforces the guard on EVERY run — initial staging and every conflict replay —
 * so a losing concurrent writer is REFUSED (`TreeKeyTakenError`) instead of silently
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
	});
});
