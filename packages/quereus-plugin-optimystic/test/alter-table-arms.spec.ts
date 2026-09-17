/**
 * What `ALTER TABLE` does to an Optimystic table, arm by arm.
 *
 * The module implements Quereus's `alterTable` hook for one reason: a named CHECK added by a
 * later schema version (`apply schema` emits `ALTER TABLE … ADD CONSTRAINT … CHECK`) has to reach
 * the table's catalog record, or a restarted machine stops enforcing it. Implementing the hook
 * takes every other arm off the engine's own "module has no `alterTable`" path, so the module
 * answers those too — with the refusal the engine gave before (same text, `UNSUPPORTED`), and
 * for RENAME COLUMN with the engine's schema-only rename. Nothing here may change what an arm
 * that is not ADD CHECK did before.
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
	create table main.t (id integer primary key, a integer null, c text null, constraint pos check (a > 0));
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
		{ arm: 'DROP CONSTRAINT', sql: 'alter table main.t drop constraint pos', message: `Module for table 't' does not support ALTER TABLE DROP CONSTRAINT` },
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

	it('ADD CHECK on a hydrated table no statement has touched yet persists it, and the table then works', async () => {
		// The first thing this session does to the table is the ALTER: no cached instance exists,
		// so the module resolves the table the way CREATE INDEX does before it can write.
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const writer = await openSession(store);
		await writer.db.exec(TABLES);

		const second = await openSession(store);
		await second.plugin.hydrate(second.db);
		await second.db.exec('alter table main.t add constraint small check (a < 100)');

		// Checked before `second` touches the table again: a later first touch would re-persist
		// the engine's shape on its own, which is not the ALTER saving it.
		const third = await openSession(store);
		await third.plugin.hydrate(third.db);
		expect(third.db.schemaManager.findTable('t', 'main')!.checkConstraints.map(check => check.name)).to.have.members(['pos', 'small']);

		await second.db.exec('insert into main.t (id, a) values (2, 50)');
		expect(await captureThrowMessage(() => second.db.exec('insert into main.t (id, a) values (3, 500)'))).to.include('small');
		expect(await queryAll(second.db, 'select id, a from main.t order by id')).to.deep.equal([{ id: 1, a: 5 }, { id: 2, a: 50 }]);
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
});
