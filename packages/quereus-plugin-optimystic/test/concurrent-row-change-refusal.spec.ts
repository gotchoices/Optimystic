/**
 * Concurrent same-ROW change refusal (ticket `refuse-concurrent-row-change-loser`, on the
 * `unchanged` tree-entry guard from `tree-entry-unchanged-guard`).
 *
 * A statement's secondary-index delta is computed from the row image it read: an UPDATE
 * deletes the old value's entry and adds the new one, a DELETE deletes the old entry, and
 * a REPLACE deletes the entries of the row it displaces or evicts. The main-table action
 * used to be staged with no tie to that image, so when two writers changed the same row
 * at the same moment, the loser's conflict replay re-applied its main-table action over
 * the winner's row while its index delta — computed against a row image the collection
 * no longer held — landed beside it. That left an index entry no row implies (a wrong
 * answer for any lookup of that value, and a permanent false `UNIQUE constraint failed`
 * under a unique index), or resurrected a row the winner had deleted.
 *
 * Every main-table entry whose index delta was derived from a pre-write image now carries
 * an `unchanged` guard on the stored entry it read, so the loser is REFUSED at commit with
 * `concurrent modification: another writer changed or removed the row in <table> at
 * primary key (…)`. Under concurrency every conflict disposition (`or ignore`, `or replace`,
 * `on conflict … do nothing`) resolves to refusal too; the sequential retry then sees the
 * rival's change and honours the disposition. A racing INSERT of a DIFFERENT key that
 * shares the indexed value must still commit: the guard is keyed to the row, not the leaf.
 *
 * Two `Database` handles over ONE `FileRawStorage` directory, one `tree://` URI per table —
 * the same cheap one-node repro shape `concurrent-secondary-unique-refusal.spec.ts` uses;
 * the first shape above reproduces here exactly as on a two-node mesh. Every refused case
 * asserts on BOTH handles that the rows equal the winner's outcome and that the index agrees
 * with the table in both directions, then re-runs the loser's statement sequentially and
 * asserts the documented outcome. Legacy and session (coordinator) commit modes both covered.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { TransactionCoordinator } from '@optimystic/db-core';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import { QuereusEngine } from '../dist/index.js';
import {
	captureThrowMessage, captureThrown, expectConcurrentModificationRefusal, expectIndexAgreesWithScan, expectIndexesIntact, queryAll,
} from './query-helpers.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

type Plugin = ReturnType<typeof register>;

function createDb(dir: string): { db: Database; plugin: Plugin } {
	const db = new Database();
	const config = {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => new FileRawStorage(dir),
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	return { db, plugin };
}

/** The refusal names the TABLE and the refused row's logical primary key, never a framed tree key. */
const concurrentModificationOf = (id: number): RegExp =>
	new RegExp(`concurrent modification: another writer changed or removed the row in T at primary key \\(${id}\\)`);
/** A racing INSERT of a key a rival took first is a duplicate key, whatever its disposition. */
const UNIQUE_T_ID = /UNIQUE constraint failed: T\.id/;

/** `(id, v)` pairs, the whole table in id order. */
type TableRows = readonly (readonly [number, string])[];

interface Handles {
	a: Database;
	b: Database;
	/** Whether `T` carries the declared index `T_by_v`, which is what makes `v` lookups index-routable. */
	declaredIndex: boolean;
	dispose: () => Promise<void>;
}

const DECLARED_INDEX = 'create index T_by_v on T(v)';

describe('Concurrent same-ROW change refusal (two handles, one dir)', function () {
	this.timeout(60000);

	let dir: string;
	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-concurrent-row-change', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	/**
	 * Two handles over one dir, both declaring `T` with `columns` over `uri` plus `indexSql`
	 * (the declared index `T_by_v` on `v` by default; `null` declares none, for a table whose
	 * only index is the tree enforcing a `unique` column — `null` rather than `undefined`,
	 * which would select the default), and `seed` rows.
	 *
	 * `seedThrough` chooses who inserts the seed rows. The default `alternate` splits them
	 * between A and B, as the two-node mutation sweep seeds, so that each handle's index tree
	 * has synced at least once and holds the other's entries. That keeps the racing cases
	 * about the guard and nothing else. `a` inserts every seed row through A, which leaves B's
	 * index tree never having fetched the entries it later deletes — the shape the blind-delete
	 * case below is about. Either way B's scan is confirmed to hold every seed row before
	 * anything races.
	 */
	async function twoHandles(
		uri: string,
		columns: string,
		seed: TableRows,
		indexSql: string | null = DECLARED_INDEX,
		seedThrough: 'alternate' | 'a' = 'alternate',
	): Promise<Handles> {
		const { db: a, plugin: pluginA } = createDb(dir);
		const { db: b, plugin: pluginB } = createDb(dir);
		for (const db of [a, b]) {
			await db.exec(`create table T (${columns}) using optimystic('${uri}')`);
			if (indexSql !== null) await db.exec(indexSql);
		}
		for (const [i, [id, v]] of seed.entries()) {
			const writer = seedThrough === 'a' ? a : (i % 2 === 0 ? a : b);
			await writer.exec(`insert into T (id, v) values (${id}, '${v}')`);
		}
		await expectRows(b, seed, 'B must see the seed rows before racing');
		return {
			a, b, declaredIndex: indexSql !== null,
			dispose: async () => {
				a.close();
				b.close();
				await pluginA.dispose();
				await pluginB.dispose();
			},
		};
	}

	async function expectRows(db: Database, expected: TableRows, why: string): Promise<void> {
		const rows = await queryAll(db, 'select id, v from T order by id');
		expect(rows.map(row => [Number(row.id), String(row.v)]), why).to.deep.equal(expected.map(pair => [...pair]));
	}

	/**
	 * THE closing assertion for every case: on BOTH handles the rows are exactly `expected`,
	 * and every index `T` maintains agrees with the table in both directions — no entry left
	 * pointing at a row that is gone or at a value its row no longer holds, no row without
	 * its entry, and (when `T_by_v` is declared, so `v` lookups route through an index) every
	 * value's index-routed lookup equal to the scan.
	 */
	async function expectStateOnBoth(handles: Handles, expected: TableRows, when: string): Promise<void> {
		for (const [name, db] of [['A', handles.a], ['B', handles.b]] as const) {
			await expectRows(db, expected, `handle ${name}'s rows ${when}`);
			try {
				if (handles.declaredIndex) await expectIndexAgreesWithScan(db, 'T', 'v');
				else await expectIndexesIntact(db, 'T');
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`handle ${name}'s index ${when}: ${detail}`, { cause: error });
			}
		}
	}

	/**
	 * The deterministic loser shape, immune to race luck: A stages `staged` in an open
	 * transaction, B commits `rival`, then A commits. The refusal can only come from A's
	 * commit-time conflict replay, never from its pre-stage probe. Returns A's commit error.
	 */
	async function stageThenRivalError(handles: Handles, staged: string, rival: string): Promise<Error> {
		await handles.a.exec('begin');
		await handles.a.exec(staged);
		await handles.b.exec(rival);
		return captureThrown(() => handles.a.exec('commit'));
	}

	/** {@link stageThenRivalError}, for the cases that assert only the loser's message. */
	async function stageThenRival(handles: Handles, staged: string, rival: string): Promise<string> {
		return (await stageThenRivalError(handles, staged, rival)).message;
	}

	const SEED: TableRows = [[1, 'seed-1'], [2, 'seed-2']];
	const PLAIN = 'id integer primary key, v text';

	/**
	 * Not a race at all — the end-to-end shape of `blind-index-delete-is-logged-but-never-applied`.
	 * Every seed row is written through A, so B's copy of `T_by_v` has never fetched the entry for
	 * id 1. B's DELETE stages a delete of that entry against a tree that cannot see it: the tree's
	 * `replace` handler misses, nothing is written, and the action reaches commit having changed no
	 * block. Nothing conflicts, so the refresh has no conflict to detect — the fix is that
	 * `updateInternal` replays pending actions whenever it adopts a newer revision at all. Without
	 * it the row went but its index entry stayed behind, on both handles, permanently.
	 */
	it('a row deleted through a handle whose index tree never saw the entry leaves no orphan', async () => {
		const handles = await twoHandles('tree://row-race/blind-index-delete', PLAIN, SEED, DECLARED_INDEX, 'a');
		try {
			await handles.b.exec('delete from T where id = 1');
			await expectStateOnBoth(handles, [[2, 'seed-2']], 'after B deleted a row only A had written');
		} finally {
			await handles.dispose();
		}
	});

	it('UPDATE vs a rival UPDATE of the same row: the loser is refused, the retry applies over the rival\'s value', async () => {
		const handles = await twoHandles('tree://row-race/update-update', PLAIN, SEED);
		try {
			const refusal = await stageThenRivalError(handles,
				`update T set v = 'from-A' where id = 1`,
				`update T set v = 'from-B' where id = 1`);
			expect(refusal.message, 'the loser is refused naming the row, not as a UNIQUE failure').to.match(concurrentModificationOf(1));
			expectConcurrentModificationRefusal(refusal, 'the loser\'s COMMIT');
			await expectStateOnBoth(handles, [[1, 'from-B'], [2, 'seed-2']], 'after the refused race');

			// Sequentially the same statement is an ordinary update over the rival's value.
			await handles.a.exec(`update T set v = 'from-A' where id = 1`);
			await expectStateOnBoth(handles, [[1, 'from-A'], [2, 'seed-2']], 'after the sequential retry');
		} finally {
			await handles.dispose();
		}
	});

	it('DELETE vs a rival UPDATE of the row: the delete is refused, the retry removes the rival\'s row', async () => {
		const handles = await twoHandles('tree://row-race/delete-update', PLAIN, SEED);
		try {
			const message = await stageThenRival(handles,
				`delete from T where id = 1`,
				`update T set v = 'from-B' where id = 1`);
			expect(message).to.match(concurrentModificationOf(1));
			// Pre-guard, the loser's blind delete removed the rival's row while its index delete
			// named the OLD value, leaving `from-B ‖ 1` pointing at nothing.
			await expectStateOnBoth(handles, [[1, 'from-B'], [2, 'seed-2']], 'after the refused race');

			await handles.a.exec(`delete from T where id = 1`);
			await expectStateOnBoth(handles, [[2, 'seed-2']], 'after the sequential retry');
		} finally {
			await handles.dispose();
		}
	});

	it('UPDATE vs a rival DELETE of the row: the update is refused and the deleted row is NOT resurrected; the retry touches nothing', async () => {
		const handles = await twoHandles('tree://row-race/update-delete', PLAIN, SEED);
		try {
			const message = await stageThenRival(handles,
				`update T set v = 'from-A' where id = 1`,
				`delete from T where id = 1`);
			expect(message, 'an absent entry counts as changed').to.match(concurrentModificationOf(1));
			// Pre-guard, the loser's blind upsert brought the deleted row back.
			await expectStateOnBoth(handles, [[2, 'seed-2']], 'after the refused race: no resurrection');

			// Sequentially the update finds no row 1 and affects zero rows.
			await handles.a.exec(`update T set v = 'from-A' where id = 1`);
			await expectStateOnBoth(handles, [[2, 'seed-2']], 'after the sequential retry');
		} finally {
			await handles.dispose();
		}
	});

	it('DELETE vs a rival DELETE of the same row: the second deleter is refused; its retry affects zero rows', async () => {
		// The guard treats an absent entry as changed, on deletes too: the loser's delete was
		// computed from a row that is gone, so it is refused rather than replayed as a silent
		// no-op — the ordinary optimistic-concurrency answer. The sequential retry then finds
		// no row and does nothing, which is exactly what a second delete does sequentially.
		const handles = await twoHandles('tree://row-race/delete-delete', PLAIN, SEED);
		try {
			const message = await stageThenRival(handles,
				`delete from T where id = 1`,
				`delete from T where id = 1`);
			expect(message).to.match(concurrentModificationOf(1));
			await expectStateOnBoth(handles, [[2, 'seed-2']], 'after the refused race');

			await handles.a.exec(`delete from T where id = 1`);
			await expectStateOnBoth(handles, [[2, 'seed-2']], 'after the sequential retry');
		} finally {
			await handles.dispose();
		}
	});

	it('CONTROL — UPDATE vs a rival INSERT of a DIFFERENT key sharing the indexed value: both commit, no false refusal, the index holds both entries', async () => {
		// The guard is keyed to the ROW: the two writers touch different main-table keys
		// and different index-tree keys (`shared ‖ 1` and `shared ‖ 3`) that happen to share
		// a value prefix and, in a small table, a leaf block.
		const handles = await twoHandles('tree://row-race/shared-value', PLAIN, SEED);
		try {
			await handles.a.exec('begin');
			await handles.a.exec(`update T set v = 'shared' where id = 1`);
			await handles.b.exec(`insert into T (id, v) values (3, 'shared')`);
			await handles.a.exec('commit');
			// The lookup arm of the closing check seeks 'shared' and must find both rows.
			await expectStateOnBoth(handles, [[1, 'shared'], [2, 'seed-2'], [3, 'shared']], 'after both commits');
		} finally {
			await handles.dispose();
		}
	});

	for (const clause of ['or ignore', 'or replace'] as const) {
		it(`INSERT ${clause} at a clear key vs a rival INSERT of that key, on the indexed table: the loser is refused, the retry honours the disposition`, async () => {
			// Neither disposition can be honoured at replay: IGNORE would skip only the
			// main-table entry while the index add replayed beside the rival's row, and
			// REPLACE would displace the rival without the index deletes a sequential REPLACE
			// stages for it. Both stage 'absent', so the refusal is the ordinary duplicate-key
			// one; the retry's probe then sees the rival's row and resolves the clause.
			const handles = await twoHandles(`tree://row-race/insert-${clause.replace(' ', '-')}`, PLAIN, SEED);
			try {
				const message = await stageThenRival(handles,
					`insert ${clause} into T (id, v) values (3, 'from-A')`,
					`insert into T (id, v) values (3, 'from-B')`);
				expect(message, `an insert ${clause} loser is refused as a duplicate key`).to.match(UNIQUE_T_ID);
				await expectStateOnBoth(handles, [...SEED, [3, 'from-B']], 'after the refused race');

				await handles.a.exec(`insert ${clause} into T (id, v) values (3, 'from-A')`);
				const survivor = clause === 'or ignore' ? 'from-B' : 'from-A';
				await expectStateOnBoth(handles, [...SEED, [3, survivor]], `after the sequential retry (${clause})`);
			} finally {
				await handles.dispose();
			}
		});
	}

	it('INSERT OR REPLACE at an OCCUPIED key vs a rival UPDATE of that row: the replacement is refused, the retry replaces', async () => {
		const handles = await twoHandles('tree://row-race/replace-occupied', PLAIN, SEED);
		try {
			const message = await stageThenRival(handles,
				`insert or replace into T (id, v) values (1, 'from-A')`,
				`update T set v = 'from-B' where id = 1`);
			expect(message, 'the replacement\'s index delta was computed from the seed image').to.match(concurrentModificationOf(1));
			await expectStateOnBoth(handles, [[1, 'from-B'], [2, 'seed-2']], 'after the refused race');

			await handles.a.exec(`insert or replace into T (id, v) values (1, 'from-A')`);
			await expectStateOnBoth(handles, [[1, 'from-A'], [2, 'seed-2']], 'after the sequential retry');
		} finally {
			await handles.dispose();
		}
	});

	it('PRIMARY KEY move vs a rival UPDATE of the moving row: the move is refused, the retry moves the rival\'s row', async () => {
		const handles = await twoHandles('tree://row-race/pk-move', PLAIN, SEED);
		try {
			const message = await stageThenRival(handles,
				`update T set id = 9 where id = 1`,
				`update T set v = 'from-B' where id = 1`);
			expect(message, 'the delete half of the move is guarded on the row it leaves').to.match(concurrentModificationOf(1));
			await expectStateOnBoth(handles, [[1, 'from-B'], [2, 'seed-2']], 'after the refused race');

			await handles.a.exec(`update T set id = 9 where id = 1`);
			await expectStateOnBoth(handles, [[2, 'seed-2'], [9, 'from-B']], 'after the sequential retry');
		} finally {
			await handles.dispose();
		}
	});

	it('REPLACE move onto an OCCUPIED key vs a rival UPDATE of the occupant: the move is refused, the retry displaces the rival\'s row', async () => {
		// `primary key on conflict replace` is what makes REPLACE reachable for an UPDATE
		// (quereus has no `update or replace` grammar). The displacing upsert at key 2 is
		// guarded on the occupant's entry, since the move's index delta deletes the
		// occupant's entries as they were read.
		const handles = await twoHandles('tree://row-race/replace-move', 'id integer primary key on conflict replace, v text', SEED);
		try {
			const message = await stageThenRival(handles,
				`update T set id = 2 where id = 1`,
				`update T set v = 'from-B' where id = 2`);
			expect(message, 'the occupant changed under the displacing move').to.match(concurrentModificationOf(2));
			await expectStateOnBoth(handles, [[1, 'seed-1'], [2, 'from-B']], 'after the refused race');

			await handles.a.exec(`update T set id = 2 where id = 1`);
			await expectStateOnBoth(handles, [[2, 'seed-1']], 'after the sequential retry');
		} finally {
			await handles.dispose();
		}
	});

	it('secondary-UNIQUE eviction vs a rival UPDATE of the evicted row: the evicting insert is refused, the retry finds no collision', async () => {
		// `v unique on conflict replace`: A's insert of a duplicate value evicts row 1, staging
		// a main-table delete guarded on row 1's entry plus index deletes computed from it.
		// No declared index here: the constraint is enforced by a tree each handle synthesizes
		// at open, and a handle that opens AFTER a declared index covers the column synthesizes
		// none while the other keeps maintaining its own — a separate, pre-existing divergence
		// (see backlog `bug-unique-enforcement-tree-set-differs-across-handles`) that would
		// show up in the closing check as the first handle's tree going stale.
		const handles = await twoHandles('tree://row-race/unique-evict',
			'id integer primary key, v text unique on conflict replace', SEED, null);
		try {
			const message = await stageThenRival(handles,
				`insert into T (id, v) values (3, 'seed-1')`,
				`update T set v = 'moved-B' where id = 1`);
			expect(message, 'the evicted row changed under the eviction').to.match(concurrentModificationOf(1));
			await expectStateOnBoth(handles, [[1, 'moved-B'], [2, 'seed-2']], 'after the refused race');

			// Sequentially the value is free: nothing to evict, three rows.
			await handles.a.exec(`insert into T (id, v) values (3, 'seed-1')`);
			await expectStateOnBoth(handles, [[1, 'moved-B'], [2, 'seed-2'], [3, 'seed-1']], 'after the sequential retry');
		} finally {
			await handles.dispose();
		}
	});

	it('under a UNIQUE index, the refused loser\'s value stays insertable: no permanently orphaned entry poisons the constraint', async () => {
		// The observed shape: with a unique index on v, a racing update pair used to leave
		// the loser's old entry behind, after which `insert … 'tok-x'` was refused forever on
		// both nodes although no row held tok-x. Here B stages first and A commits first, so
		// B is the loser and 'tok-y' is the value that must stay usable.
		const handles = await twoHandles('tree://row-race/unique-index', PLAIN,
			[[1, 'tok-a'], [2, 'tok-b']], 'create unique index T_by_v on T(v)');
		try {
			await handles.b.exec('begin');
			await handles.b.exec(`update T set v = 'tok-y' where id = 1`);
			await handles.a.exec(`update T set v = 'tok-x' where id = 1`);
			const message = await captureThrowMessage(() => handles.b.exec('commit'));
			expect(message).to.match(concurrentModificationOf(1));
			await expectStateOnBoth(handles, [[1, 'tok-x'], [2, 'tok-b']], 'after the refused race');

			// The loser's value is free on the loser's own handle …
			await handles.b.exec(`insert into T (id, v) values (3, 'tok-y')`);
			await expectStateOnBoth(handles, [[1, 'tok-x'], [2, 'tok-b'], [3, 'tok-y']], 'after B reuses the loser\'s value');
			// … and on the winner's, once B's row no longer holds it.
			await handles.a.exec(`delete from T where id = 3`);
			await handles.a.exec(`insert into T (id, v) values (4, 'tok-y')`);
			await expectStateOnBoth(handles, [[1, 'tok-x'], [2, 'tok-b'], [4, 'tok-y']], 'after A reuses the loser\'s value');
		} finally {
			await handles.dispose();
		}
	});

	describe('the refusal names the refused row by its LOGICAL primary key, whatever the key type', () => {
		// `decodePrimaryKey` renders each framed key part under its column's affinity, so a
		// client can match the message to their SQL: strings quoted, numbers bare, a blob by
		// its length, composite keys in declaration order.
		const keyShapes: readonly { name: string; columns: string; keyColumns: string; key: string; where: string; rendered: string }[] = [
			{
				name: 'TEXT', columns: 'id text primary key, v text',
				keyColumns: 'id', key: `'k-1'`, where: `id = 'k-1'`, rendered: '("k-1")',
			},
			{
				name: 'BLOB', columns: 'id blob primary key, v text',
				keyColumns: 'id', key: `x'0102'`, where: `id = x'0102'`, rendered: '(<blob 2 bytes>)',
			},
			{
				name: 'composite (integer, text)', columns: 'a integer, b text, v text, primary key (a, b)',
				keyColumns: 'a, b', key: `1, 'x'`, where: `a = 1 and b = 'x'`, rendered: '(1, "x")',
			},
		];
		for (const shape of keyShapes) {
			it(`${shape.name} key: the loser's message names the row as ${shape.rendered}`, async () => {
				const { db: a, plugin: pluginA } = createDb(dir);
				const { db: b, plugin: pluginB } = createDb(dir);
				try {
					const uri = `tree://row-race/key-${shape.name.replace(/[^a-z]+/g, '-')}`;
					for (const db of [a, b]) {
						await db.exec(`create table T (${shape.columns}) using optimystic('${uri}')`);
					}
					await a.exec(`insert into T (${shape.keyColumns}, v) values (${shape.key}, 'seed')`);
					expect((await queryAll(b, 'select v from T')).map(row => row.v), 'B must see the seed row').to.deep.equal(['seed']);

					await a.exec('begin');
					await a.exec(`update T set v = 'from-A' where ${shape.where}`);
					await b.exec(`update T set v = 'from-B' where ${shape.where}`);
					const message = await captureThrowMessage(() => a.exec('commit'));
					expect(message).to.include(
						`concurrent modification: another writer changed or removed the row in T at primary key ${shape.rendered}`);
					for (const db of [a, b]) {
						expect((await queryAll(db, 'select v from T')).map(row => row.v), "the rival's row survives").to.deep.equal(['from-B']);
					}
				} finally {
					a.close();
					b.close();
					await pluginA.dispose();
					await pluginB.dispose();
				}
			});
		}
	});

	describe('within-transaction chains with no rival commit and leave a clean index', () => {
		// A later statement's guard expects the earlier statement's STAGED entry, which is
		// what `collection.get` returns inside the transaction and what replay, re-running
		// the actions in order, has put there. Each chain would refuse ITSELF if the guard
		// were checked against committed state instead.
		const chains: readonly { name: string; statements: readonly string[]; rows: TableRows }[] = [
			{
				name: 'update; update',
				statements: [`update T set v = 'c1' where id = 1`, `update T set v = 'c2' where id = 1`],
				rows: [[1, 'c2'], [2, 'seed-2']],
			},
			{
				name: 'insert; update; delete',
				statements: [
					`insert into T (id, v) values (5, 'new')`,
					`update T set v = 'new-2' where id = 5`,
					`delete from T where id = 5`,
				],
				rows: SEED,
			},
			{
				name: 'update (pk move); update',
				statements: [`update T set id = 7 where id = 1`, `update T set v = 'moved' where id = 7`],
				rows: [[2, 'seed-2'], [7, 'moved']],
			},
		];
		for (const chain of chains) {
			it(`begin; ${chain.name}; commit`, async () => {
				const handles = await twoHandles(`tree://row-race/chain-${chain.name.replace(/[^a-z]+/g, '-')}`, PLAIN, SEED);
				try {
					await handles.a.exec('begin');
					for (const statement of chain.statements) await handles.a.exec(statement);
					await handles.a.exec('commit');
					await expectStateOnBoth(handles, chain.rows, 'after the chain commits');
				} finally {
					await handles.dispose();
				}
			});
		}
	});

	it('SESSION mode, two-table transaction: a rival UPDATE of the same row fails the WHOLE transaction with the concurrent-modification message', async () => {
		const uriT = 'tree://row-race/session-t';
		const uriU = 'tree://row-race/session-u';
		const { db: a, plugin: pluginA } = createDb(dir);
		const { db: b, plugin: pluginB } = createDb(dir);
		let disposeEngine: (() => void) | undefined;
		try {
			for (const db of [a, b]) {
				await db.exec(`create table T (${PLAIN}) using optimystic('${uriT}')`);
				await db.exec('create index T_by_v on T(v)');
			}
			await a.exec(`create table U (id integer primary key, v text) using optimystic('${uriU}')`);
			await a.exec(`insert into T (id, v) values (1, 'seed-1')`);
			await expectRows(b, [[1, 'seed-1']], 'B must see the seed row');

			// Wire handle A for session (coordinator) mode; handle B stays legacy (the rival's
			// mode is irrelevant to the refusal). The commit is atomic across trees and the
			// refusal escapes the coordinator's stale re-drive, which retries only stale loss.
			const transactor = await pluginA.collectionFactory.getOrCreateTransactor({
				collectionUri: 'tree://unused', transactor: 'local', keyNetwork: 'test',
				libp2pOptions: {}, cache: false, encoding: 'json',
				rawStorageFactory: () => new FileRawStorage(dir),
			});
			const coordinator = new TransactionCoordinator(transactor, pluginA.txnBridge.getCollectionRegistry());
			const engine = new QuereusEngine(a, coordinator);
			await engine.getSchemaHash();
			pluginA.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
			disposeEngine = () => engine.dispose();

			await a.exec('begin');
			await a.exec(`update T set v = 'from-A' where id = 1`);
			await a.exec(`insert into U (id, v) values (1, 'clean')`);
			await b.exec(`update T set v = 'from-B' where id = 1`);

			const refusal = await captureThrown(() => a.exec('commit'));
			expect(refusal.message, 'the session-mode refusal carries the mapped concurrent-modification message').to.match(concurrentModificationOf(1));
			expectConcurrentModificationRefusal(refusal, 'the session-mode refusal');

			for (const db of [a, b]) {
				await expectRows(db, [[1, 'from-B']], 'the rival\'s row survives');
				await expectIndexAgreesWithScan(db, 'T', 'v');
			}
			const inU = await queryAll(a, 'select count(*) as c from U');
			expect(Number(inU[0]!.c), 'the sibling table\'s insert did not land').to.equal(0);
		} finally {
			disposeEngine?.();
			a.close();
			b.close();
			await pluginA.dispose();
			await pluginB.dispose();
		}
	});
});
