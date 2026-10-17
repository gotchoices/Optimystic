/**
 * What `ALTER TABLE` does to an Optimystic table, arm by arm.
 *
 * The module implements Quereus's `alterTable` hook for the arms that change only the table's
 * catalog record: a named CHECK a later schema version adds or drops (`apply schema` emits
 * `ALTER TABLE … ADD CONSTRAINT … CHECK` and `… DROP CONSTRAINT`, the pair for a changed body) has
 * to reach the record, or a restarted machine enforces the old CHECKs. Implementing the hook takes
 * every other arm off the engine's own "module has no `alterTable`" path, so the module answers
 * those too — with the refusal the engine gave before (same text, `UNSUPPORTED`), and for RENAME
 * COLUMN with the engine's schema-only rename.
 *
 * Several machines run the same upgrade, each from the catalog it hydrated, so a machine can meet a
 * record another machine already upgraded: the change is then adopted (nothing written), and if the
 * apply later fails, Quereus's undo of it stays off the record.
 *
 * Harness: fresh `Database`s over one shared `MemoryRawStorage` through the `local` transactor
 * (see `shared-local-transactor.ts`), so a second session plus `hydrate` shows what reached storage.
 */

import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
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

const TABLES = `
	create table main.p (id integer primary key);
	create table main.t (id integer primary key, a integer null, c text null, constraint pos check (a > 0), constraint one_a unique (a));
	insert into main.t (id, a, c) values (1, 5, 'x');
`;

async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (error) {
		return error;
	}
	throw new Error('expected operation to throw, but it resolved');
}

describe('ALTER TABLE on an Optimystic table', function () {
	this.timeout(20_000);

	/** Every arm the module refuses, with the text Quereus gave for it before the module had an `alterTable` hook. */
	const REFUSED: { arm: string; sql: string; message: string }[] = [
		{ arm: 'ADD COLUMN', sql: 'alter table main.t add column b integer null', message: `Module for table 't' does not support ALTER TABLE ADD COLUMN` },
		{ arm: 'DROP COLUMN', sql: 'alter table main.t drop column c', message: `Module for table 't' does not support ALTER TABLE DROP COLUMN` },
		{ arm: 'DROP CONSTRAINT of a UNIQUE', sql: 'alter table main.t drop constraint one_a', message: `Module for table 't' does not support ALTER TABLE DROP CONSTRAINT` },
		{ arm: 'RENAME CONSTRAINT', sql: 'alter table main.t rename constraint pos to positive', message: `Module for table 't' does not support ALTER TABLE RENAME CONSTRAINT` },
		{ arm: 'ALTER COLUMN', sql: 'alter table main.t alter column a set default 1', message: `Module for table 't' does not support ALTER COLUMN` },
		{ arm: 'ADD CONSTRAINT UNIQUE', sql: 'alter table main.t add constraint uc unique (c)', message: `Module for table 't' does not support ADD CONSTRAINT` },
		{ arm: 'ADD CONSTRAINT FOREIGN KEY', sql: 'alter table main.t add constraint fk foreign key (a) references p (id)', message: `Module for table 't' does not support ADD CONSTRAINT` },
		{
			arm: 'ALTER PRIMARY KEY',
			sql: 'alter table main.t alter primary key (id desc)',
			message: `Module 'optimystic' does not support ALTER PRIMARY KEY on table 't': it cannot re-key in place`,
		},
	];

	for (const { arm, sql, message } of REFUSED) {
		it(`refuses ${arm} as UNSUPPORTED, with the text it always had, and changes nothing`, async () => {
			const { db } = await openSession(buildSharedLocalTransactor(new MemoryRawStorage()));
			await db.exec(TABLES);
			const before = db.schemaManager.findTable('t', 'main');

			const error = await thrownBy(() => db.exec(sql));
			expect(error).to.be.instanceOf(QuereusError);
			expect((error as QuereusError).message).to.include(message);
			expect((error as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);

			expect(db.schemaManager.findTable('t', 'main'), 'the catalog entry is untouched').to.equal(before);
			expect(await queryAll(db, 'select id, a, c from main.t')).to.deep.equal([{ id: 1, a: 5, c: 'x' }]);
		});
	}

	it('refuses ADD COLUMN of a NOT NULL column with no default over rows, reporting the missing default first', async () => {
		// Precedence changed with the hook: Quereus runs this arm's NOT NULL check (one row read)
		// only for a module that has `alterTable`, and it now answers before the module's refusal.
		// Still refused, still nothing changed.
		const { db } = await openSession(buildSharedLocalTransactor(new MemoryRawStorage()));
		await db.exec(TABLES);
		const before = db.schemaManager.findTable('t', 'main');

		expect(await captureThrowMessage(() => db.exec('alter table main.t add column b integer not null')))
			.to.include(`NOT NULL constraint failed for column 'b'`);
		expect(db.schemaManager.findTable('t', 'main')).to.equal(before);
		expect(await captureThrowMessage(() => db.exec('alter table main.t add column b integer not null default 0')))
			.to.include(`Module for table 't' does not support ALTER TABLE ADD COLUMN`);
	});

	it('RENAME COLUMN still renames for the session, schema-only, and still is not saved', async () => {
		// Unchanged from the engine's schema-only fallback — including that a restart undoes it
		// (tickets/backlog/bug-optimystic-rename-column-lost-on-restart). This pins today's
		// behaviour so the hook changes nothing; that ticket owns changing it.
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db } = await openSession(store);
		await db.exec(TABLES);

		await db.exec('alter table main.t rename column c to cc');
		expect(db.schemaManager.findTable('t', 'main')!.columns.map(col => col.name)).to.deep.equal(['id', 'a', 'cc']);
		expect(await queryAll(db, 'select id, cc from main.t')).to.deep.equal([{ id: 1, cc: 'x' }]);

		const restarted = await openSession(store);
		await restarted.plugin.hydrate(restarted.db);
		expect(restarted.db.schemaManager.findTable('t', 'main')!.columns.map(col => col.name)).to.deep.equal(['id', 'a', 'c']);
	});

	it('ADD CONSTRAINT CHECK is enforced at once and survives a restart that only hydrates', async () => {
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db } = await openSession(store);
		await db.exec(TABLES);

		await db.exec('alter table main.t add constraint small check (a < 100)');
		expect(await captureThrowMessage(() => db.exec('insert into main.t (id, a) values (2, 500)'))).to.include('small');
		await db.exec('insert into main.t (id, a) values (2, 50)');

		const restarted = await openSession(store);
		await restarted.plugin.hydrate(restarted.db);
		const checks = restarted.db.schemaManager.findTable('t', 'main')!.checkConstraints.map(check => check.name);
		expect(checks).to.have.members(['pos', 'small']);
		expect(await captureThrowMessage(() => restarted.db.exec('insert into main.t (id, a) values (3, 500)'))).to.include('small');
		expect(await captureThrowMessage(() => restarted.db.exec('insert into main.t (id, a) values (3, -1)'))).to.include('pos');
		await restarted.db.exec('insert into main.t (id, a) values (3, 7)');
		expect(await queryAll(restarted.db, 'select id from main.t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	it('DROP CONSTRAINT of a CHECK stops enforcing it at once and survives a restart that only hydrates', async () => {
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db } = await openSession(store);
		await db.exec(TABLES);

		await db.exec('alter table main.t drop constraint POS');
		await db.exec('insert into main.t (id, a) values (2, -1)');

		const restarted = await openSession(store);
		await restarted.plugin.hydrate(restarted.db);
		expect(restarted.db.schemaManager.findTable('t', 'main')!.checkConstraints).to.deep.equal([]);
		await restarted.db.exec('insert into main.t (id, a) values (3, -5)');
		expect(await queryAll(restarted.db, 'select id from main.t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	it('an unnamed ADD CHECK gets the name the engine mints, and keeps it across a restart', async () => {
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db } = await openSession(store);
		await db.exec(TABLES);

		await db.exec('alter table main.t add check (a <> 13)');
		const named = db.schemaManager.findTable('t', 'main')!.checkConstraints.map(check => check.name);
		expect(named).to.deep.equal(['pos', 'check_1']);

		const restarted = await openSession(store);
		await restarted.plugin.hydrate(restarted.db);
		expect(restarted.db.schemaManager.findTable('t', 'main')!.checkConstraints.map(check => check.name))
			.to.have.members(['pos', 'check_1']);
		expect(await captureThrowMessage(() => restarted.db.exec('insert into main.t (id, a) values (4, 13)'))).to.include('check_1');
	});

	it('DROP and ADD CHECK on a hydrated table no statement has touched yet are saved, and the table then works', async () => {
		// The first thing this session does to the table is the ALTER. The arms save through the
		// catalog manager the table would be built with, and build no instance: one built from this
		// session's catalog entry would compare it with the record and write it back on a mismatch.
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const writer = await openSession(store);
		await writer.db.exec(TABLES);

		const second = await openSession(store);
		await second.plugin.hydrate(second.db);
		await second.db.exec('alter table main.t drop constraint pos');
		const module = second.plugin.vtables.find(v => v.name === 'optimystic')!.module as unknown as { tables: Map<string, unknown> };
		expect(module.tables.has('main.t'), 'DROP CONSTRAINT builds no table instance').to.equal(false);
		// Quereus checks the stored rows against an added CHECK with a `select`, which does build one.
		await second.db.exec('alter table main.t add constraint small check (a < 100)');

		// Checked before `second` touches the table again: a later first touch would re-persist
		// the engine's shape on its own, which is not the ALTER saving it.
		const third = await openSession(store);
		await third.plugin.hydrate(third.db);
		expect(third.db.schemaManager.findTable('t', 'main')!.checkConstraints.map(check => check.name)).to.deep.equal(['small']);

		await second.db.exec('insert into main.t (id, a) values (2, -1)');
		expect(await captureThrowMessage(() => second.db.exec('insert into main.t (id, a) values (3, 500)'))).to.include('small');
		expect(await queryAll(second.db, 'select id, a from main.t order by id')).to.deep.equal([{ id: 1, a: 5 }, { id: 2, a: -1 }]);
	});

	it('an ADD CHECK whose name another writer already saved replaces that CHECK in the record', async () => {
		// `second` hydrated before `first` added `small`, so its engine accepts the same name
		// (compared ignoring case). Local DDL wins, as on every other schema write: one CHECK of
		// that name remains, and it is the later one.
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const first = await openSession(store);
		await first.db.exec(TABLES);
		const second = await openSession(store);
		await second.plugin.hydrate(second.db);

		await first.db.exec('alter table main.t add constraint small check (a < 100)');
		await second.db.exec('alter table main.t add constraint SMALL check (a < 10)');

		const restarted = await openSession(store);
		await restarted.plugin.hydrate(restarted.db);
		expect(restarted.db.schemaManager.findTable('t', 'main')!.checkConstraints.map(check => check.name)).to.have.members(['pos', 'SMALL']);
		expect(await captureThrowMessage(() => restarted.db.exec('insert into main.t (id, a) values (2, 50)'))).to.include('SMALL');
	});

	it('a CHECK added to a table this session already wrote through is not dropped by that table re-opening its record', async () => {
		// The live table instance compares its own schema against the record whenever it
		// (re-)initializes, and a mismatch rewrites the record from the instance's schema. If the
		// instance never learned of the CHECK, that rewrite would silently remove it again.
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db, plugin } = await openSession(store);
		await db.exec(TABLES);
		await db.exec('alter table main.t add constraint small check (a < 100)');

		const module = plugin.vtables.find(v => v.name === 'optimystic')!.module as unknown as {
			tables: Map<string, { markSchemaUnpersisted(): void }>;
		};
		module.tables.get('main.t')!.markSchemaUnpersisted();
		await db.exec('insert into main.t (id, a) values (2, 50)');

		const restarted = await openSession(store);
		await restarted.plugin.hydrate(restarted.db);
		expect(restarted.db.schemaManager.findTable('t', 'main')!.checkConstraints.map(check => check.name)).to.have.members(['pos', 'small']);
	});

	describe('inside apply schema, on one machine and on two', () => {
		const declared = (constraints: string) =>
			`declare schema main { table t { id integer primary key, a integer null, c text null${constraints} } } apply schema main;`;
		const V1 = declared(', constraint pos check (a > 0)');
		/** Declared last, so its step runs after every CHECK step; the module refuses it, and the apply fails there. */
		const FAILING = ', constraint one_c unique (c)';

		async function expectRestored(apply: () => Promise<unknown>): Promise<void> {
			const error = (await thrownBy(apply)) as Error;
			expect(error.message).to.include(`does not support ADD CONSTRAINT`);
			expect(error.message, `a verified restore rethrows the step's own error`).to.not.match(/partially migrated|could not be restored/);
		}

		/** The CHECK names a session that only hydrates finds in the record. */
		async function savedChecks(store: ITransactor): Promise<{ db: Database; names: (string | undefined)[] }> {
			const { db, plugin } = await openSession(store);
			await plugin.hydrate(db);
			return { db, names: db.schemaManager.findTable('t', 'main')!.checkConstraints.map(check => check.name) };
		}

		/** Machine `a` declared V1 and wrote a row; machine `b` hydrated that, before anything the caller does. */
		async function twoMachines(): Promise<{ store: ITransactor; a: Database; b: Database }> {
			const store = buildSharedLocalTransactor(new MemoryRawStorage());
			const a = await openSession(store);
			await a.db.exec(V1);
			await a.db.exec(`insert into t (id, a, c) values (1, 5, 'x')`);
			const b = await openSession(store);
			await b.plugin.hydrate(b.db);
			return { store, a: a.db, b: b.db };
		}

		it('a failed apply undoes its DROP CONSTRAINT of a CHECK, in the session and in the record', async () => {
			const store = buildSharedLocalTransactor(new MemoryRawStorage());
			const { db } = await openSession(store);
			await db.exec(V1);
			await db.exec(`insert into t (id, a, c) values (1, 5, 'x')`);

			await expectRestored(() => db.exec(declared(FAILING)));
			expect(await captureThrowMessage(() => db.exec('insert into t (id, a) values (2, -1)'))).to.include('pos');
			expect((await savedChecks(store)).names).to.deep.equal(['pos']);
		});

		it('a failed apply undoes its ADD CONSTRAINT … CHECK, in the session and in the record', async () => {
			const store = buildSharedLocalTransactor(new MemoryRawStorage());
			const { db } = await openSession(store);
			await db.exec(V1);
			await db.exec(`insert into t (id, a, c) values (1, 5, 'x')`);

			await expectRestored(() => db.exec(declared(`, constraint pos check (a > 0), constraint small check (a < 100)${FAILING}`)));
			await db.exec('insert into t (id, a) values (2, 500)');
			expect((await savedChecks(store)).names).to.deep.equal(['pos']);
		});

		it('two machines applying the same upgrade at once both succeed, and the record holds it once', async () => {
			const { store, a, b } = await twoMachines();
			const v2 = declared(', constraint small check (a < 100)');

			await Promise.all([a.exec(v2), b.exec(v2)]);

			const saved = await savedChecks(store);
			expect(saved.names).to.deep.equal(['small']);
			for (const [id, db] of [[2, a], [3, b], [4, saved.db]] as const) {
				await db.exec(`insert into t (id, a) values (${id}, -1)`);
				expect(await captureThrowMessage(() => db.exec(`insert into t (id, a) values (${id + 10}, 500)`))).to.include('small');
			}
		});

		it('a second machine adopts a DROP already saved, and its failed apply leaves that DROP in the record', async () => {
			const { store, a, b } = await twoMachines();
			await a.exec(declared(''));

			// `b` still holds `pos`. Its DROP finds the record without it and writes nothing; the
			// undo of that DROP re-adds `pos` to `b`'s own catalog only.
			await expectRestored(() => b.exec(declared(FAILING)));
			expect((await savedChecks(store)).names).to.deep.equal([]);
			expect(await captureThrowMessage(() => b.exec('insert into t (id, a) values (2, -1)'))).to.include('pos');
		});

		it('a second machine adopts both halves of a changed CHECK body, and its failed apply leaves the new body in the record', async () => {
			const { store, a, b } = await twoMachines();
			// `b` reads first, so its table instance exists before the upgrade. One built mid-apply —
			// by Quereus's check of the stored rows against the re-added CHECK — would write `b`'s older
			// description over the record on its first initialize
			// (tickets/backlog/bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record).
			expect(await queryAll(b, 'select id from t')).to.deep.equal([{ id: 1 }]);
			const changed = `, constraint pos check (a >= 0)`;
			await a.exec(declared(changed));

			// The differ emits `drop constraint pos` then `add constraint pos check (a >= 0)`; both find
			// the record already changed, and the unwind undoes the add, then the drop, on `b` alone.
			await expectRestored(() => b.exec(declared(`${changed}${FAILING}`)));
			const saved = await savedChecks(store);
			expect(saved.names).to.deep.equal(['pos']);
			await saved.db.exec('insert into t (id, a) values (2, 0)');
			expect(await captureThrowMessage(() => b.exec('insert into t (id, a) values (3, 0)'))).to.include('pos');
		});
	});
});
