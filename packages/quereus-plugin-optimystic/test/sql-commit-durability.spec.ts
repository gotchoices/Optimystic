/**
 * A SQL commit hands the application its durability: `onCommitDurability` on the object the
 * plugin's `register` returns is called once per commit that wrote something, on each of the
 * bridge's three commit routes — the per-tree sweep (one staged tree: the common single-table
 * write), the batched legacy commit (several staged trees: a table and its index), and session
 * mode — and not at all for a commit that wrote nothing.
 *
 * The in-memory `test` transactor decides the quorum class, so these assert presence and
 * shape, not a class.
 */
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { TransactionCoordinator } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { QuereusEngine, type SqlCommitDurability } from '../dist/index.js';

type Plugin = ReturnType<typeof register>;

function createDb(): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
	});
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

/** Collect every report the plugin delivers. */
function collectReports(plugin: Plugin): SqlCommitDurability[] {
	const reports: SqlCommitDurability[] = [];
	plugin.onCommitDurability(report => { reports.push(report); });
	return reports;
}

/** Wire session mode over the bridge's live registry, the way a host does (see session-mode-commit.spec.ts). */
async function enableSessionMode(db: Database, plugin: Plugin): Promise<() => void> {
	const transactor = await plugin.collectionFactory.getOrCreateTransactor({
		collectionUri: 'tree://unused',
		transactor: 'test',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json',
	});
	const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
	const engine = new QuereusEngine(db, coordinator);
	await engine.getSchemaHash();
	plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
	return () => engine.dispose();
}

describe('A SQL commit reports its durability', function () {
	this.timeout(20_000);

	it('a single-table insert (the per-tree sweep) reports its collection under its table and its StampId', async () => {
		const { db, plugin } = createDb();
		try {
			await db.exec(`create table Single (id integer primary key, name text) using optimystic('tree://sqldur/single')`);
			const reports = collectReports(plugin);

			await db.exec('begin');
			await db.exec(`insert into Single (id, name) values (1, 'a')`);
			const stamp = (await db.prepare('select StampId() as stamp_id').get()) as { stamp_id: string };
			await db.exec('commit');

			expect(reports).to.have.length(1);
			const [report] = reports;
			expect(report!.transactionId).to.equal(stamp.stamp_id);
			expect([...report!.durability.collections.keys()]).to.deep.equal(['sqldur/single']);
			expect(report!.durability.overall, 'overall').to.not.equal(undefined);
			expect([...report!.tables.keys()]).to.deep.equal(['main.Single']);
			expect(report!.tables.get('main.Single')).to.deep.equal(report!.durability.overall);
		} finally {
			db.close();
		}
	});

	it('a table with a secondary index (the batched commit) reports both collections under one table', async () => {
		const { db, plugin } = createDb();
		try {
			await db.exec(`create table Indexed (id integer primary key, cat text) using optimystic('tree://sqldur/indexed')`);
			await db.exec('create index idx_indexed_cat on Indexed (cat)');
			const reports = collectReports(plugin);

			await db.exec(`insert into Indexed (id, cat) values (1, 'a')`);

			expect(reports).to.have.length(1);
			const [report] = reports;
			expect([...report!.durability.collections.keys()].sort())
				.to.deep.equal(['sqldur/indexed', 'sqldur/indexed/index/idx_indexed_cat']);
			expect([...report!.tables.keys()]).to.deep.equal(['main.Indexed']);
			expect(report!.tables.get('main.Indexed')).to.not.equal(undefined);
		} finally {
			db.close();
		}
	});

	it('a session-mode commit reports the coordinator\'s durability', async () => {
		const { db, plugin } = createDb();
		let dispose: (() => void) | undefined;
		try {
			await db.exec(`create table Sess (id integer primary key, name text) using optimystic('tree://sqldur/session')`);
			dispose = await enableSessionMode(db, plugin);
			const reports = collectReports(plugin);

			await db.exec(`insert into Sess (id, name) values (1, 'a')`);

			expect(reports).to.have.length(1);
			expect([...reports[0]!.durability.collections.keys()]).to.deep.equal(['sqldur/session']);
			expect([...reports[0]!.tables.keys()]).to.deep.equal(['main.Sess']);
		} finally {
			dispose?.();
			db.close();
		}
	});

	it('a select in its own autocommit reports nothing', async () => {
		const { db, plugin } = createDb();
		try {
			await db.exec(`create table Quiet (id integer primary key, name text) using optimystic('tree://sqldur/quiet')`);
			await db.exec(`insert into Quiet (id, name) values (1, 'a')`);
			const reports = collectReports(plugin);

			for await (const _row of db.eval('select * from Quiet')) { /* drain */ }

			expect(reports).to.have.length(0);
		} finally {
			db.close();
		}
	});

	it('a table declared over a dropped table\'s URI reports under its own name only', async () => {
		const { db, plugin } = createDb();
		try {
			await db.exec(`create table Before (id integer primary key, name text) using optimystic('tree://sqldur/reused')`);
			await db.exec(`insert into Before (id, name) values (1, 'a')`);
			await db.exec('drop table Before');
			await db.exec(`create table After (id integer primary key, name text) using optimystic('tree://sqldur/reused')`);
			const reports = collectReports(plugin);

			await db.exec(`insert into After (id, name) values (2, 'b')`);

			expect(reports).to.have.length(1);
			expect([...reports[0]!.tables.keys()]).to.deep.equal(['main.After']);
		} finally {
			db.close();
		}
	});

	it('a listener that throws neither fails the commit nor stops the next listener', async () => {
		const { db, plugin } = createDb();
		try {
			await db.exec(`create table Loud (id integer primary key, name text) using optimystic('tree://sqldur/loud')`);
			plugin.onCommitDurability(() => { throw new Error('listener fault'); });
			const reports = collectReports(plugin);

			await db.exec(`insert into Loud (id, name) values (1, 'a')`);

			expect(reports).to.have.length(1);
			const rows: unknown[] = [];
			for await (const row of db.eval('select * from Loud')) rows.push(row);
			expect(rows).to.have.length(1);
		} finally {
			db.close();
		}
	});
});
