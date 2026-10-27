/**
 * The rules by which a statement's write description (Quereus's `TableWrite`, docs/offline-sync.md
 * §Judging each guard and §Unchecked decisions) is turned into facts: which of the elements a row's
 * write stages carry a value no other writer can produce (`freshElementsOf`), and which decisions the
 * statement made against other rows (`uncheckedOf`). Pure, over prepared statements alone: a plain
 * `Database`, memory tables, and the plugin's `StampId()` registered as it is in production (flagged
 * fresh). Nothing is executed and no network is touched; each case hands `Statement.getWriteScope()`'s
 * one write site to the rule under test.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlParameters, TableWrite } from '@quereus/quereus';
import register from '../dist/plugin.js';
import {
	foldWriteFacts, freshElementsOf, insertAcceptsEqualRow, rewriteAcceptsEqualRow, uncheckedOf, type StagedRowOf, type UncheckedRead,
} from '../src/optimystic-adapter/write-description.js';

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

describe('write-description: the guard variant a described statement admits', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Declared spellings differ from the lowercased names the description carries, on purpose.
		await db.exec(`
			create table t (Id text primary key, Email text unique, body text, n integer) using memory;
			create table c (A text, B text, body text, primary key (A, B)) using memory;
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

	const insertT = (suffix: string): string => `insert ${suffix.startsWith('or ') ? suffix : ''}into t (Id, Email, body, n) values ('k', 'a@x', 'a', 1)${suffix.startsWith('or ') ? '' : ` ${suffix}`}`;

	it('an insert admits absentOrEqual when its disposition says a present row is not an error: or ignore, or replace, on conflict do nothing, and on conflict (the key) do nothing', () => {
		for (const sql of [insertT('or ignore '), insertT('or replace '), insertT('on conflict do nothing'), insertT('on conflict (Id) do nothing')]) {
			expect(insertAcceptsEqualRow(describedWrite(sql), ['Id']), sql).to.equal(true);
		}
	});

	it('a do nothing clause on a composite key matches the key columns as a set, whatever their order and case', () => {
		const write = describedWrite(`insert into c (A, B, body) values ('x', 'y', 'z') on conflict (b, a) do nothing`);
		expect(insertAcceptsEqualRow(write, ['A', 'B'])).to.equal(true);
	});

	it('a plain insert, a do nothing clause on another unique column, and a do update clause keep absent; so does no description', () => {
		for (const sql of [insertT(''), insertT('on conflict (Email) do nothing'), insertT(`on conflict (Id) do update set body = 'b'`)]) {
			expect(insertAcceptsEqualRow(describedWrite(sql), ['Id']), sql).to.equal(false);
		}
		expect(insertAcceptsEqualRow(undefined, ['Id'])).to.equal(false);
	});

	it('a same-key update admits unchangedOrEqual when self-independent: a parameter or a literal, not a value read from the row', () => {
		expect(rewriteAcceptsEqualRow(describedWrite(`update t set body = :p where Id = 'k'`), 'update')).to.equal(true);
		expect(rewriteAcceptsEqualRow(describedWrite(`update t set n = 1 where Id = 'k'`), 'update')).to.equal(true);
		expect(rewriteAcceptsEqualRow(describedWrite(`update t set n = n + 1 where Id = 'k'`), 'update')).to.equal(false);
	});

	it('an insert or replace is a self-independent rewrite on its insert arm; the DO UPDATE arm, handed the INSERT\'s description, and a cascade child write keep unchanged', () => {
		expect(rewriteAcceptsEqualRow(describedWrite(insertT('or replace ')), 'insert')).to.equal(true);
		const upsert = describedWrite(insertT(`on conflict (Id) do update set body = 'b'`));
		expect(upsert.operation).to.equal('insert');
		expect(rewriteAcceptsEqualRow(upsert, 'update')).to.equal(false);
		expect(rewriteAcceptsEqualRow(undefined, 'update')).to.equal(false);
	});
});

/** A decision on `table` in `main`, with no pinned rows. */
const on = (table: string, kind: UncheckedRead['kind'], scope: 'group' | 'global'): UncheckedRead =>
	({ table: { schema: 'main', table }, kind, scope, rows: [] });

describe('write-description: the decisions a described statement made against other rows', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Foreign keys are enforced by default, so the child's constraint is listed with its parent read.
		await db.exec(`
			create table parent (id text primary key, name text) using memory;
			create table child (id text primary key, parent_id text references parent(id), body text) using memory;
			create table t (id text primary key, status text, n integer, x integer) using memory;
			create table src (id text primary key, body text) using memory;
			create table checked (id text primary key, amount integer, check (amount < (select max(n) from t))) using memory;
		`);
	});

	afterEach(async () => { await db.close(); });

	/** The one write site of `sql`, with `params` bound as the hook binds an execution's. */
	function describedWrite(sql: string, params?: SqlParameters): TableWrite {
		const stmt = db.prepare(sql);
		try {
			const { writes } = stmt.getWriteScope(params);
			expect(writes.length, 'one write site').to.equal(1);
			return writes[0]!;
		} finally {
			void stmt.finalize();
		}
	}

	it('an insert into a child table is a foreign-key decision on the parent, global, and the parent read is consumed by it', () => {
		const write = describedWrite(`insert into child (id, parent_id, body) values ('c', 'p', 'b')`);
		expect(uncheckedOf(write)).to.deep.equal([on('parent', 'foreign-key', 'global')]);
	});

	it('a delete of a parent row is a foreign-key decision on the child, global; its key selection adds nothing', () => {
		const write = describedWrite(`delete from parent where id = 'p'`);
		expect(uncheckedOf(write)).to.deep.equal([on('child', 'foreign-key', 'global')]);
	});

	it('an update choosing its rows by a non-key predicate is one row-selection decision: the target read is covered by it', () => {
		const write = describedWrite(`update t set status = 'done' where status = 'open'`);
		expect(uncheckedOf(write)).to.deep.equal([on('t', 'row-selection', 'global')]);
	});

	it('an update of a row by its key, reading its own non-key column, decides nothing: the guard covers the row', () => {
		const write = describedWrite(`update t set n = n + 1 where id = 'a'`);
		expect(uncheckedOf(write)).to.deep.equal([]);
	});

	it('a target read wider than the key selection (a subquery over the table) is a read, global', () => {
		const write = describedWrite(`update t set x = (select max(x) from t) where id = 'a'`);
		expect(uncheckedOf(write)).to.deep.equal([on('t', 'read', 'global')]);
	});

	it('an insert from a select is a read with the source\'s scope: global over the whole source, group under a group by', () => {
		expect(uncheckedOf(describedWrite(`insert into t (id, status, n, x) select id, body, 1, 2 from src`)))
			.to.deep.equal([on('src', 'read', 'global')]);
		expect(uncheckedOf(describedWrite(`insert into t (id, status, n, x) select id, body, count(*), 2 from src group by id, body`)))
			.to.deep.equal([on('src', 'read', 'group')]);
	});

	it('a read pinned by a key keeps the key and the bound values, and is widened to global while a value is an unbound parameter', () => {
		const sql = `insert into t (id, status, n, x) select id, body, 1, 2 from src where id = :source`;
		expect(uncheckedOf(describedWrite(sql, { source: 'c1' }))).to.deep.equal([
			{ table: { schema: 'main', table: 'src' }, kind: 'read', scope: 'row', rows: [{ key: ['id'], values: ['c1'] }] },
		]);
		expect(uncheckedOf(describedWrite(sql))).to.deep.equal([on('src', 'read', 'global')]);
	});

	it('a subquery pinned to a parent row keeps its own read beside the foreign key: the whole-table watch is the parent probe\'s', () => {
		const write = describedWrite(`insert into child (id, parent_id, body) values ('c', 'p', (select name from parent where id = 'p'))`);
		expect(uncheckedOf(write)).to.deep.equal([
			on('parent', 'foreign-key', 'global'),
			{ table: { schema: 'main', table: 'parent' }, kind: 'read', scope: 'row', rows: [{ key: ['id'], values: ['p'] }] },
		]);
	});

	it('a cross-row CHECK is a check decision on the written table beside the read of the table its subquery reads', () => {
		const write = describedWrite(`insert into checked (id, amount) values ('k', 1)`);
		expect(uncheckedOf(write)).to.deep.equal([on('checked', 'check', 'global'), on('t', 'read', 'global')]);
	});

	it('folding a transaction\'s records concatenates the statements\' decisions in order, deduped with their rows merged, and is complete only while every write was described', () => {
		const pinned = (value: string): UncheckedRead => ({ table: { schema: 'main', table: 'src' }, kind: 'read', scope: 'row', rows: [{ key: ['id'], values: [value] }] });
		const described = [
			{ kind: 'statement' as const, unchecked: [pinned('c1'), on('parent', 'foreign-key', 'global')] },
			{ kind: 'fresh' as const, collectionId: MAIN, key: 'K' },
			{ kind: 'statement' as const, unchecked: [pinned('c2'), pinned('c1')] },
		];
		const folded = foldWriteFacts(described);
		expect(folded.unchecked).to.deep.equal([
			{ table: { schema: 'main', table: 'src' }, kind: 'read', scope: 'row', rows: [{ key: ['id'], values: ['c1'] }, { key: ['id'], values: ['c2'] }] },
			on('parent', 'foreign-key', 'global'),
		]);
		expect(folded.complete).to.equal(true);
		expect([...folded.fresh.get(MAIN) ?? []]).to.deep.equal(['K']);
		expect(foldWriteFacts([...described, { kind: 'undescribed' }]).complete).to.equal(false);
	});
});
