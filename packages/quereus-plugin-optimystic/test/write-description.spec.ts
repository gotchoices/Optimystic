/**
 * The rules by which a statement's write description (Quereus's `TableWrite`, docs/offline-sync.md
 * §Judging each guard) is turned into facts about the elements a row's write stages: which carry a
 * value no other writer can produce. Pure, over prepared statements alone: a plain `Database`, memory
 * tables, and the plugin's `StampId()` registered as it is in production (flagged fresh). Nothing is
 * executed and no network is touched; each case hands `Statement.getWriteScope()`'s one write site to
 * `freshElementsOf` with a hand-built description of the staged row.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { TableWrite } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { freshElementsOf, type StagedRowOf } from '../src/optimystic-adapter/write-description.js';

const MAIN = 'app/t';
const EMAIL_INDEX = 'app/t/index/email';

/** A row keyed `K` in the main tree, with one unique entry `E` for the `email` constraint. */
const row: StagedRowOf = {
	mainCollectionId: MAIN,
	key: 'K',
	keyColumns: ['Id'],
	uniqueEntries: [{ collectionId: EMAIL_INDEX, key: 'E', columns: ['Email'] }],
};

const freshMain = { kind: 'fresh', collectionId: MAIN, key: 'K' } as const;
const freshEmail = { kind: 'fresh', collectionId: EMAIL_INDEX, key: 'E' } as const;

describe('write-description: the fresh elements of a described write', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		const plugin = register(db, { default_transactor: 'test', default_key_network: 'test', enable_cache: false });
		for (const func of plugin.functions) db.registerFunction(func.schema);
		// Declared spellings differ from the lowercased names the description carries, on purpose.
		await db.exec(`
			create table t (Id text primary key, Email text unique, body text) using memory;
			create table c (a text, b text, body text, primary key (a, b)) using memory;
		`);
	});

	afterEach(async () => { await db.close(); });

	/** The one write site of `sql`, as the vtab receives it on `UpdateArgs.writeScope`. */
	function describedWrite(sql: string): TableWrite {
		const stmt = db.prepare(sql);
		try {
			const { writes } = stmt.getWriteScope();
			expect(writes.length, 'one write site').to.equal(1);
			return writes[0]!;
		} finally {
			void stmt.finalize();
		}
	}

	it('a key from StampId() is fresh: the plugin registers it with the FRESH flag', () => {
		const write = describedWrite(`insert into t (Id, Email, body) values (StampId(), 'a@x', 'a')`);
		expect(freshElementsOf(write, 'insert', row)).to.deep.equal([freshMain]);
	});

	it('a key from hex(randomblob(16)) is fresh: a wide random source under an injective wrapper', () => {
		const write = describedWrite(`insert into t (Id, Email, body) values (hex(randomblob(16)), 'a@x', 'a')`);
		expect(freshElementsOf(write, 'insert', row)).to.deep.equal([freshMain]);
	});

	// Not pinned: `randomblob(16)` written bare to a text key. Quereus 4.21.0 labels it `fresh` on a
	// table with no blob column although the engine stores a lossy text decode of the bytes, and the
	// plugin trusts the label — blocked `quereus-labels-a-fresh-blob-written-to-text-as-fresh`.
	it('a fresh blob under a lossy wrapper (cast to text) is not fresh: the plugin trusts the label', () => {
		const write = describedWrite(`insert into t (Id, Email, body) values (cast(randomblob(16) as text), 'a@x', 'a')`);
		expect(freshElementsOf(write, 'insert', row)).to.deep.equal([]);
	});

	it('a key from a parameter is not fresh', () => {
		const write = describedWrite(`insert into t (Id, Email, body) values (:id, 'a@x', 'a')`);
		expect(freshElementsOf(write, 'insert', row)).to.deep.equal([]);
	});

	it('a composite key is fresh when any one of its columns is', () => {
		const write = describedWrite(`insert into c (a, b, body) values ('shared', StampId(), 'a')`);
		const composite: StagedRowOf = { mainCollectionId: 'app/c', key: 'K', keyColumns: ['a', 'b'], uniqueEntries: [] };
		expect(freshElementsOf(write, 'insert', composite)).to.deep.equal([{ kind: 'fresh', collectionId: 'app/c', key: 'K' }]);
	});

	it('a unique entry is fresh through one of its constraint\'s columns, independently of the key', () => {
		const write = describedWrite(`insert into t (Id, Email, body) values (:id, hex(randomblob(16)), 'a')`);
		expect(freshElementsOf(write, 'insert', row)).to.deep.equal([freshEmail]);
	});

	it('the upsert DO UPDATE arm, handed the INSERT\'s description, records nothing fresh', () => {
		const write = describedWrite(`insert into t (Id, Email, body) values (StampId(), hex(randomblob(16)), 'a') on conflict (Id) do update set body = 'b'`);
		expect(write.operation).to.equal('insert');
		expect(freshElementsOf(write, 'update', row)).to.deep.equal([]);
	});

	it('no description (an FK cascade child write) records nothing fresh', () => {
		expect(freshElementsOf(undefined, 'insert', row)).to.deep.equal([]);
	});
});
