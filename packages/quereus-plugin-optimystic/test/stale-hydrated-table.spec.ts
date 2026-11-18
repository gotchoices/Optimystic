/**
 * A machine that hydrated before another machine changed a table must not write its older copy of
 * the table's description back over the catalog record.
 *
 * Hydrate copies each record into the engine's catalog, and a table instance built from that entry
 * looks declared. It is not: only a `create table`, or a table a failed `apply schema` left without
 * its record, owes the catalog a description. Everything else leaves the record alone.
 *
 * Harness: sessions over one shared `MemoryRawStorage` through the `local` transactor, so a session
 * that only hydrates shows what reached storage.
 */

import { expect } from 'chai';
import { ConstraintError, Database, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { StaleTableDescriptionError } from '../dist/index.js';
import { buildSharedLocalTransactor, countingTransactor, refusingCommits } from './shared-local-transactor.js';
import { captureThrown, captureThrowMessage, countIndexScans, queryAll } from './query-helpers.js';

type PluginHandle = ReturnType<typeof register>;

async function openSession(store: ITransactor): Promise<{ db: Database; plugin: PluginHandle }> {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>);
	plugin.collectionFactory.registerTransactor('local:test', store);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	await db.exec(`pragma default_vtab_module = 'optimystic'`);
	return { db, plugin };
}

async function hydratedSession(store: ITransactor): Promise<{ db: Database; plugin: PluginHandle }> {
	const session = await openSession(store);
	await session.plugin.hydrate(session.db);
	return session;
}

/** Assert that `refusal` is the commit-time refusal of a write made under a description another machine replaced or dropped. */
function expectStaleDescription(refusal: Error, why: string): void {
	const detail = `${refusal.name} (code=${(refusal as { code?: unknown }).code}): ${refusal.message}`;
	expect(refusal, `${why}: expected StaleTableDescriptionError, got ${detail}`).to.be.instanceOf(StaleTableDescriptionError);
	expect((refusal as StaleTableDescriptionError).code, `${why}: ${detail}`).to.equal(StatusCode.SCHEMA);
}

/** Every index of `t` agrees with its rows, as a session that only hydrates finds them. */
async function expectIndexesComplete(store: ITransactor, table = 't'): Promise<void> {
	const third = await hydratedSession(store);
	for (const report of await third.plugin.verifyIndexes(third.db, table)) {
		expect(report.missing, `${report.index}: no missing entries`).to.deep.equal([]);
		expect(report.orphaned, `${report.index}: no orphaned entries`).to.deep.equal([]);
	}
}

/** The table as a session that only hydrates finds it in the record. */
async function saved(store: ITransactor, table = 't'): Promise<{
	columns: string[];
	checks: (string | undefined)[];
	indexes: Record<string, string[]>;
	tags: unknown;
}> {
	const { db } = await hydratedSession(store);
	const schema = db.schemaManager.findTable(table, 'main')!;
	return {
		columns: schema.columns.map(col => col.name),
		checks: schema.checkConstraints.map(check => check.name),
		indexes: Object.fromEntries((schema.indexes ?? []).map(idx => [idx.name, idx.columns.map(col => schema.columns[col.index]!.name)])),
		tags: schema.tags,
	};
}

describe('a machine holding an older copy of a table description', function () {
	this.timeout(20_000);

	/** Machine `a` created `t` with one row; `b` hydrated that, and has not touched the table. */
	async function twoMachines(constraints = ', constraint pos check (a > 0)') {
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const a = await openSession(store);
		await a.db.exec(`create table main.t (id integer primary key, a integer null, c text null, d text null${constraints}); insert into main.t (id, a, c, d) values (1, 5, 'x', 'p');`);
		const b = await hydratedSession(store);
		return { store, a, b };
	}

	it('keeps the other machine\'s CHECK in the record when its first touch follows a refresh of its cache', async () => {
		const { store, a, b } = await twoMachines();
		await a.db.exec('alter table main.t add constraint small check (a < 100)');

		// Saving a tag reads the record fresh, so the instance's first initialize compares this
		// machine's copy with the newer record, not with the copy hydrate cached.
		await b.db.exec('alter table main.t set tags (x = 1)');
		await b.plugin.whenCatalogPersisted();
		expect(await queryAll(b.db, 'select id from main.t')).to.deep.equal([{ id: 1 }]);

		const record = await saved(store);
		expect(record.checks).to.have.members(['pos', 'small']);
		expect(record.tags).to.deep.equal({ x: 1 });
	});

	it('reads a table whose record has indexes over a column it does not know, and leaves the record alone', async () => {
		const { store, a, b } = await twoMachines();
		await a.db.exec('alter table main.t add column y text null');
		await a.db.exec('create index t_y on main.t (y)');
		await a.db.exec('create index t_partial on main.t (a) where y is not null');
		await b.db.exec('alter table main.t set tags (x = 1)');
		await b.plugin.whenCatalogPersisted();

		expect(await queryAll(b.db, 'select id, a, c, d from main.t')).to.deep.equal([{ id: 1, a: 5, c: 'x', d: 'p' }]);

		const record = await saved(store);
		expect(record.columns).to.deep.equal(['id', 'a', 'c', 'd', 'y']);
		expect(record.indexes).to.deep.equal({ t_partial: ['a'], t_y: ['y'] });
	});

	it('keeps the value of a column it does not know when its update, refused for the new column, is retried', async () => {
		const { a, b } = await twoMachines('');
		expect(await queryAll(b.db, 'select id from main.t')).to.deep.equal([{ id: 1 }]);
		await a.db.exec('alter table main.t add column y text null');
		await a.db.exec(`update main.t set y = 'kept' where id = 1`);

		const update = 'update main.t set a = 9 where id = 1';
		expectStaleDescription(await captureThrown(() => b.db.exec(update)), 'the update was planned without y');
		await b.db.exec(update);

		expect(await queryAll(a.db, 'select a, y from main.t where id = 1')).to.deep.equal([{ a: 9, y: 'kept' }]);
	});

	it('does not bring back a table the other machine dropped by creating an index on it', async () => {
		const { store, a, b } = await twoMachines();
		await a.db.exec('drop table main.t');

		expect(await captureThrowMessage(() => b.db.exec('create index t_a on main.t (a)'))).to.include('Schema not found');

		const third = await hydratedSession(store);
		expect(third.db.schemaManager.findTable('t', 'main')).to.equal(undefined);
	});

	it('does not bring back a dropped table with a catalog-only ALTER either', async () => {
		const { store, a, b } = await twoMachines();
		await a.db.exec('drop table main.t');

		expect(await captureThrowMessage(() => b.db.exec('alter table main.t drop constraint pos'))).to.include('Schema not found');

		const third = await hydratedSession(store);
		expect(third.db.schemaManager.findTable('t', 'main')).to.equal(undefined);
	});

	it('indexes the column it asked for when the other machine dropped an earlier column', async () => {
		const { store, a, b } = await twoMachines('');
		await a.db.exec('alter table main.t drop column a');

		await b.db.exec('create index t_c on main.t (c)');

		expect((await saved(store)).indexes).to.deep.equal({ t_c: ['c'] });
		// `b` still has `a`, so its insert is refused once and then written under the record's columns.
		const insert = `insert into main.t (id, c, d) values (2, 'y', 'q')`;
		expectStaleDescription(await captureThrown(() => b.db.exec(insert)), 'the insert was planned with the dropped column');
		await b.db.exec(insert);
		expect(await queryAll(b.db, `select id from main.t where c = 'y'`)).to.deep.equal([{ id: 2 }]);
		const third = await hydratedSession(store);
		expect(await queryAll(third.db, `select id from main.t where c = 'y'`)).to.deep.equal([{ id: 2 }]);
		await expectIndexesComplete(store);
	});

	it('refuses an index on a column the other machine dropped, and leaves the record alone', async () => {
		const { store, a, b } = await twoMachines('');
		await a.db.exec('alter table main.t drop column c');

		expect(await captureThrowMessage(() => b.db.exec('create index t_c on main.t (c)'))).to.include(`'c'`);

		const record = await saved(store);
		expect(record.columns).to.deep.equal(['id', 'a', 'd']);
		expect(record.indexes).to.deep.equal({});
	});

	describe('a write committed under a description the other machine replaced', () => {
		/**
		 * Machine `a` created `t` with one row; `b` hydrated that and read the table, so its instance is
		 * built. `b` reaches storage through `counted`, which counts what it sends.
		 */
		async function bothReading() {
			const store = buildSharedLocalTransactor(new MemoryRawStorage());
			const a = await openSession(store);
			await a.db.exec(`create table main.t (id integer primary key, a integer null); insert into main.t (id, a) values (1, 5);`);
			const counted = countingTransactor(store);
			const b = await hydratedSession(counted.transactor);
			expect(await queryAll(b.db, 'select id from main.t')).to.deep.equal([{ id: 1 }]);
			return { store, a, b, counts: counted.counts };
		}

		it('is refused when the other machine created an index, and its retry maintains the index', async () => {
			const { store, a, b, counts } = await bothReading();
			await a.db.exec('create index t_a on main.t (a)');
			await a.db.exec('alter table main.t set tags (x = 1)');
			await a.plugin.whenCatalogPersisted();

			const insert = 'insert into main.t (id, a) values (2, 7)';
			counts.reset();
			expectStaleDescription(await captureThrown(() => b.db.exec(insert)), 'the insert would leave its row out of t_a');
			await b.plugin.whenCatalogPersisted();
			expect({ pend: counts.pend, commit: counts.commit }, 'neither the refused write nor following the record sends anything')
				.to.deep.equal({ pend: 0, commit: 0 });
			await b.db.exec(insert);

			expect(await queryAll(a.db, 'select id from main.t where a = 7')).to.deep.equal([{ id: 2 }]);
			let found: Record<string, unknown>[] = [];
			expect(await countIndexScans(async () => { found = await queryAll(b.db, 'select id from main.t where a = 7'); }),
				'b plans through the index it now maintains').to.equal(1);
			expect(found).to.deep.equal([{ id: 2 }]);
			await expectIndexesComplete(store);
		});

		it('is refused when the other machine added a CHECK, and its retry is held to the CHECK', async () => {
			const { a, b } = await bothReading();
			await a.db.exec('alter table main.t add constraint small check (a < 100)');

			const insert = 'insert into main.t (id, a) values (2, 200)';
			expectStaleDescription(await captureThrown(() => b.db.exec(insert)), 'the insert was planned without small');
			const retry = await captureThrown(() => b.db.exec(insert));
			expect(retry, `${retry.name}: ${retry.message}`).to.be.instanceOf(ConstraintError);
			expect(retry.message).to.include('small');
			expect(await queryAll(a.db, 'select id from main.t')).to.deep.equal([{ id: 1 }]);
		});

		it('is refused when the other machine dropped the table, which this machine then no longer has', async () => {
			const { store, a, b } = await bothReading();
			await a.db.exec('drop table main.t');

			const insert = 'insert into main.t (id, a) values (2, 7)';
			expectStaleDescription(await captureThrown(() => b.db.exec(insert)), 'the insert targets a dropped table');

			const third = await hydratedSession(store);
			expect(third.db.schemaManager.findTable('t', 'main'), 'nothing brought the table back').to.equal(undefined);
			expect(await captureThrowMessage(() => b.db.exec(insert)))
				.to.equal(await captureThrowMessage(() => third.db.exec(insert)));
		});

		it('is committed when the other machine changed only the table\'s tags', async () => {
			const { store, a, b } = await bothReading();
			await a.db.exec('alter table main.t set tags (x = 1)');
			await a.plugin.whenCatalogPersisted();

			await b.db.exec('insert into main.t (id, a) values (2, 7)');

			expect(await queryAll(a.db, 'select id from main.t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
			expect((await saved(store)).tags).to.deep.equal({ x: 1 });
		});
	});

	describe('after a failed apply schema', () => {
		const TABLE = 'id integer primary key, a integer null, c text null, constraint pos check (a > 0)';
		const declared = (constraints: string) => `declare schema main { table t { ${TABLE}${constraints} } } apply schema main;`;

		/** Machine `a` declared `t` and wrote a row; `b` hydrated that behind a transactor whose commits can be refused. */
		async function behindARefusal() {
			const store = buildSharedLocalTransactor(new MemoryRawStorage());
			const a = await openSession(store);
			await a.db.exec(declared(''));
			await a.db.exec(`insert into t (id, a, c) values (1, 5, 'x')`);
			const refusing = refusingCommits(store);
			const b = await hydratedSession(refusing.transactor);
			return { store, a, b, refuse: refusing.refuse };
		}

		/** `b` declares this on top of the description it hydrated, which `small` has since overtaken. */
		const TINY = ', constraint tiny check (a < 1000)';

		/** A tag save reads the record fresh, so `b`'s next first touch compares its copy with the newer record. */
		async function refreshCache(session: { db: Database; plugin: PluginHandle }): Promise<void> {
			await session.db.exec('alter table main.t set tags (x = 1)');
			await session.plugin.whenCatalogPersisted();
		}

		for (const refusals of [1, 2]) {
			const undo = refusals === 1 ? 'landing its undo batch' : 'with its undo batch refused too';
			it(`leaves the other machine's change in the record after a refused commit, ${undo}`, async () => {
				const { store, a, b, refuse } = await behindARefusal();
				await a.db.exec('alter table main.t add constraint small check (a < 100)');

				refuse(refusals);
				expect(await captureThrowMessage(() => b.db.exec(declared(TINY)))).to.include('injected refusal');
				refuse(0);
				expect((await saved(store)).checks, 'the failed apply took nothing with it').to.have.members(['pos', 'small']);

				await refreshCache(b);
				const insert = `insert into t (id, a) values (2, 6)`;
				expectStaleDescription(await captureThrown(() => b.db.exec(insert)), 'b never took small into its engine');
				await b.db.exec(insert);
				expect((await saved(store)).checks, 'nor did the next touch').to.have.members(['pos', 'small']);
			});
		}

		it('leaves the other machine\'s change in the record when a failed step and a refused commit meet in one batch', async () => {
			const { store, a, b, refuse } = await behindARefusal();
			await a.db.exec('alter table main.t add constraint small check (a < 100)');

			// The module refuses a UNIQUE added to a table, so `tiny` lands, is unwound in the same batch,
			// and that batch's commit is refused as well.
			refuse(1);
			expect(await captureThrowMessage(() => b.db.exec(declared(`${TINY}, constraint one_c unique (c)`)))).to.include('does not support ADD CONSTRAINT');
			refuse(0);

			await refreshCache(b);
			await queryAll(b.db, 'select id from t');
			expect((await saved(store)).checks).to.have.members(['pos', 'small']);
		});

		/** `b` had a data-destroying apply refused, which left `t` owing the tag it changed, with no instance of `t` in this session. */
		async function owingAfterADataDestroyingRefusal() {
			const store = buildSharedLocalTransactor(new MemoryRawStorage());
			const a = await openSession(store);
			await a.db.exec(`declare schema main { table t { ${TABLE} } table u { id integer primary key } } apply schema main;`);
			const refusing = refusingCommits(store);
			const b = await hydratedSession(refusing.transactor);

			// Declaring only `t` plans `drop table u`, which stops Quereus unwinding anything.
			refusing.refuse(1);
			const apply = `declare schema main { table t { ${TABLE} } with tags (version = 2) } apply schema main;`;
			expect(await captureThrowMessage(() => b.db.exec(apply))).to.include('injected refusal');
			refusing.refuse(0);
			return { store, a, b };
		}

		it('writes the record a data-destroying apply still owes on the first touch of a table with no instance', async () => {
			const { store, b } = await owingAfterADataDestroyingRefusal();
			expect((await saved(store)).tags, 'the refused commit carried the tag').to.equal(undefined);

			expect(await queryAll(b.db, 'select id from t')).to.deep.equal([]);
			expect((await saved(store)).tags).to.deep.equal({ version: 2 });
		});

		it('does not owe the record again after that write, when the next apply ends', async () => {
			const { store, a, b } = await owingAfterADataDestroyingRefusal();
			await queryAll(b.db, 'select id from t');

			await a.db.exec('alter table main.t add constraint small check (a < 100)');
			await b.db.exec(`declare schema main { table t { ${TABLE} } with tags (version = 2) table v { id integer primary key } } apply schema main;`);
			await refreshCache(b);
			await queryAll(b.db, 'select id from t');

			expect((await saved(store)).checks).to.have.members(['pos', 'small']);
		});
	});
});
