/**
 * A delete on an Optimystic table answers with the row it removed, so the engine runs what it runs
 * after a delete on any table. `processDeleteRow` in `@quereus/quereus/src/runtime/emit/dml-executor.ts`
 * returns as soon as the module's answer has no `row`, which skips foreign-key actions, the row
 * `returning` projects, and the automatic data event. Each case runs on a memory table as well, which
 * is the behaviour being matched.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { DatabaseDataChangeEvent, SqlValue } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import { queryAll } from './query-helpers.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

type Plugin = ReturnType<typeof register>;

const BACKENDS = {
	memory: () => 'using memory',
	optimystic: (table: string) => `using optimystic('tree://delete-reports/${table}')`,
};

describe('A delete reports the row it removed', function () {
	this.timeout(60000);

	let dir: string;
	const opened: { db: Database; plugin: Plugin }[] = [];

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-delete-reports', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});
	afterEach(async () => {
		for (const { db, plugin } of opened.splice(0)) {
			db.close();
			await plugin.dispose();
		}
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function openDb(): Promise<Database> {
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
		opened.push({ db, plugin });
		await db.exec('pragma foreign_keys = true');
		return db;
	}

	/** Declares parent `P` and child `C`, whose `pid` references `P` under `action`. */
	async function declareTables(db: Database, usingClause: (table: string) => string, action: string): Promise<void> {
		await db.exec(`create table P (id integer primary key, v text) ${usingClause('p')}`);
		await db.exec(`create table C (id integer primary key, pid integer null references P(id) on delete ${action}) ${usingClause('c')}`);
	}

	async function parentWithChild(usingClause: (table: string) => string, action: string): Promise<Database> {
		const db = await openDb();
		await declareTables(db, usingClause, action);
		await db.exec(`insert into P (id, v) values (1, 'a')`);
		await db.exec('insert into C (id, pid) values (10, 1)');
		return db;
	}

	for (const [backend, usingClause] of Object.entries(BACKENDS)) {
		describe(`on ${backend}`, () => {
			it('on delete cascade removes the child', async () => {
				const db = await parentWithChild(usingClause, 'cascade');
				await db.exec('delete from P where id = 1');
				expect(await queryAll(db, 'select id from P')).to.deep.equal([]);
				expect(await queryAll(db, 'select id from C')).to.deep.equal([]);
			});

			it('on delete set null clears the reference', async () => {
				const db = await parentWithChild(usingClause, 'set null');
				await db.exec('delete from P where id = 1');
				expect(await queryAll(db, 'select id, pid from C')).to.deep.equal([{ id: 10, pid: null }]);
			});

			it('returning gives the removed row', async () => {
				const db = await parentWithChild(usingClause, 'cascade');
				expect(await queryAll(db, 'delete from P where id = 1 returning id, v')).to.deep.equal([{ id: 1, v: 'a' }]);
			});

			it('raises one data event per row removed, the child included', async () => {
				const db = await parentWithChild(usingClause, 'cascade');
				const events: DatabaseDataChangeEvent[] = [];
				const unsubscribe = db.onDataChange(event => events.push(event));
				await db.exec('delete from P where id = 1');
				unsubscribe();
				expect(events.map(e => [e.type, e.tableName, e.key]).sort()).to.deep.equal([
					['delete', 'C', [10]],
					['delete', 'P', [1]],
				]);
			});

			// The engine collects the keys its end-of-statement restrict check probes only after it has
			// seen a row in the module's answer; on an engine older than that this passes without the row.
			it('on delete restrict refuses the delete and keeps both rows', async () => {
				const db = await parentWithChild(usingClause, 'restrict');
				let refusal: unknown;
				await db.exec('delete from P where id = 1').catch((err: unknown) => { refusal = err; });
				expect(String(refusal)).to.match(/foreign key/i);
				expect(await queryAll(db, 'select id from P')).to.deep.equal([{ id: 1 }]);
				expect(await queryAll(db, 'select id, pid from C')).to.deep.equal([{ id: 10, pid: 1 }]);
			});
		});
	}

	it('racing parent deletes under on delete cascade both commit, report the row and leave nothing', async () => {
		const a = await parentWithChild(BACKENDS.optimystic, 'cascade');
		const b = await openDb();
		await declareTables(b, BACKENDS.optimystic, 'cascade');
		expect(await queryAll(b, 'select id from C')).to.deep.equal([{ id: 10 }]);

		await a.exec('begin');
		await b.exec('begin');
		const returnedA = await queryAll(a, 'delete from P where id = 1 returning id');
		const returnedB = await queryAll(b, 'delete from P where id = 1 returning id');
		await a.exec('commit');
		await b.exec('commit');

		expect(returnedA).to.deep.equal([{ id: 1 }]);
		expect(returnedB).to.deep.equal([{ id: 1 }]);
		for (const db of [a, b]) {
			expect(await queryAll(db, 'select id from P')).to.deep.equal([]);
			expect(await queryAll(db, 'select id from C')).to.deep.equal([]);
		}
	});
});
