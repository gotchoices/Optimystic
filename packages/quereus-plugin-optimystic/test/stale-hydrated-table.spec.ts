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
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { buildSharedLocalTransactor } from './shared-local-transactor.js';
import { captureThrowMessage, queryAll } from './query-helpers.js';

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

/** `store`, with `refuse(n)` making its next `n` commits fail. */
function refusingCommits(store: ITransactor): { transactor: ITransactor; refuse(times: number): void } {
	let refusals = 0;
	return {
		transactor: {
			get: request => store.get(request),
			getStatus: request => store.getStatus(request),
			pend: request => store.pend(request),
			cancel: request => store.cancel(request),
			commit: request => refusals-- > 0 ? Promise.reject(new Error('injected refusal')) : store.commit(request),
		} as ITransactor,
		refuse(times) { refusals = times; },
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
		// `b`'s own maintenance keys on the column too, against `b`'s row layout.
		await b.db.exec(`insert into main.t (id, c, d) values (2, 'y', 'q')`);
		expect(await queryAll(b.db, `select id from main.t where c = 'y'`)).to.deep.equal([{ id: 2 }]);
		const third = await hydratedSession(store);
		expect(await queryAll(third.db, `select id from main.t where c = 'y'`)).to.deep.equal([{ id: 2 }]);
		for (const report of await third.plugin.verifyIndexes(third.db, 't')) {
			expect(report.missing, `${report.index}: no missing entries`).to.deep.equal([]);
			expect(report.orphaned, `${report.index}: no orphaned entries`).to.deep.equal([]);
		}
	});

	it('refuses an index on a column the other machine dropped, and leaves the record alone', async () => {
		const { store, a, b } = await twoMachines('');
		await a.db.exec('alter table main.t drop column c');

		expect(await captureThrowMessage(() => b.db.exec('create index t_c on main.t (c)'))).to.include(`'c'`);

		const record = await saved(store);
		expect(record.columns).to.deep.equal(['id', 'a', 'd']);
		expect(record.indexes).to.deep.equal({});
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
				await b.db.exec(`insert into t (id, a) values (2, 6)`);
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

		it('writes the record a data-destroying apply still owes on the first touch of a table with no instance', async () => {
			const store = buildSharedLocalTransactor(new MemoryRawStorage());
			const a = await openSession(store);
			await a.db.exec(`declare schema main { table t { ${TABLE} } table u { id integer primary key } } apply schema main;`);
			const refusing = refusingCommits(store);
			const b = await hydratedSession(refusing.transactor);

			// Declaring only `t` plans `drop table u`, which stops Quereus unwinding anything, and the
			// tag change on `t` happens with no instance of `t` in this session.
			refusing.refuse(1);
			const apply = `declare schema main { table t { ${TABLE} } with tags (version = 2) } apply schema main;`;
			expect(await captureThrowMessage(() => b.db.exec(apply))).to.include('injected refusal');
			refusing.refuse(0);
			expect((await saved(store)).tags, 'the refused commit carried the tag').to.equal(undefined);

			expect(await queryAll(b.db, 'select id from t')).to.deep.equal([]);
			expect((await saved(store)).tags).to.deep.equal({ version: 2 });
		});
	});
});
