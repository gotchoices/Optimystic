/**
 * The rule by which a statement's write description (Quereus's `TableWrite`) and its table's declared
 * profile and merges decide the lane the statement's write takes (docs/transactions.md §Which lane a
 * transaction takes): `laneOf`, the writer's answer, and `laneCeilingOf`, the part of it every
 * machine with the same schema hash computes alike. Pure, over prepared statements alone: a plain
 * `Database`, memory tables, and the plugin's `StampId()` registered as it is in production (flagged
 * fresh). Nothing is executed and no network is touched; each case hands `Statement.getWriteScope()`'s
 * one write site and the table's schema to the rule under test. One row per branch of the rule.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { TableSchema, TableWrite } from '@quereus/quereus';
import type { Lane } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { laneCeilingOf, laneOf, transactionLaneOf } from '../src/optimystic-adapter/lane.js';
import type { WriteFact } from '../src/optimystic-adapter/write-description.js';

const REPLAY = `with tags ("optimystic.profile" = 'replay-permitted')`;
const LWW = `with tags ("optimystic.merge" = 'last-writer-wins')`;

describe('lane: which lane a described statement takes', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		const plugin = register(db, { default_transactor: 'test', default_key_network: 'test', enable_cache: false });
		for (const func of plugin.functions) db.registerFunction(func.schema);
		// Declared spellings differ from the lowercased names the description carries, on purpose.
		await db.exec(`
			create table t (Id text primary key, Title text ${LWW}, n integer ${LWW}, name text, body text) using memory ${REPLAY};
			create table u (Id text primary key, Email text unique, body text ${LWW}) using memory ${REPLAY};
			create table parent (id text primary key) using memory ${REPLAY};
			create table child (id text primary key, parent_id text references parent(id)) using memory ${REPLAY};
			create table k (Id text primary key with tags ("optimystic.fresh" = true), body text) using memory ${REPLAY};
			create table blob (hash text primary key, body text) using memory with tags ("optimystic.profile" = 'replay-permitted', "optimystic.content_key" = true);
			create table s (Id text primary key, Title text ${LWW}) using memory;
		`);
	});

	afterEach(async () => { await db.close(); });

	/** The one write site of `sql`, as the vtab receives it on `UpdateArgs.writeScope`, and its table. */
	function described(sql: string): { write: TableWrite; table: TableSchema } {
		const stmt = db.prepare(sql);
		try {
			const { writes } = stmt.getWriteScope();
			expect(writes.length, 'one write site').to.equal(1);
			const write = writes[0]!;
			const table = db.schemaManager.findTable(write.table.table, write.table.schema);
			expect(table, `schema of ${write.table.table}`).to.not.equal(undefined);
			return { write, table: table! };
		} finally {
			void stmt.finalize();
		}
	}

	const insertT = (key: string): string => `insert into t (Id, Title, n, name, body) values (${key}, 'a', 1, 'x', 'b')`;

	/** Each row: the statement, the lane the writer takes, and the ceiling a member can compute (the lane when omitted). */
	const cases: ReadonlyArray<{ readonly name: string; readonly sql: string; readonly lane: Lane; readonly ceiling?: Lane }> = [
		{ name: 'a StampId()-keyed insert into a replay-permitted table', sql: insertT('StampId()'), lane: 'convergent' },
		{ name: 'the same insert into a table with a UNIQUE column: the constraint is decided against other rows', sql: `insert into u (Id, Email, body) values (StampId(), 'a@x', 'b')`, lane: 'serializable' },
		{ name: 'an insert into a child table: its foreign key is decided against the parent', sql: `insert into child (id, parent_id) values (StampId(), 'p')`, lane: 'serializable' },
		{ name: 'an insert whose key is a parameter can collide: serializable to the writer, convergent at the ceiling', sql: insertT(':id'), lane: 'serializable', ceiling: 'convergent' },
		{ name: 'the same once the key column is tagged optimystic.fresh', sql: `insert into k (Id, body) values (:id, 'b')`, lane: 'convergent' },
		{ name: 'a literal-keyed insert into a content-keyed table: the same content is the same row', sql: `insert into blob (hash, body) values ('h', 'b')`, lane: 'convergent' },
		{ name: 'a same-key update of a merge-tagged column', sql: `update t set Title = :v where Id = :id`, lane: 'convergent' },
		{ name: 'a same-key update of an untagged column: no merge is declared for it', sql: `update t set name = :v where Id = :id`, lane: 'serializable' },
		{ name: 'an increment of a merge-tagged column reads the row: serializable to the writer, convergent at the ceiling', sql: `update t set n = n + 1 where Id = :id`, lane: 'serializable', ceiling: 'convergent' },
		{ name: 'an update that assigns a key column moves the row', sql: `update t set Id = :new where Id = :id`, lane: 'serializable' },
		{ name: 'an update choosing its rows by a non-key predicate reads other writers\' state', sql: `update t set Title = :v where name = :n`, lane: 'serializable' },
		{ name: 'an update choosing its row by a UNIQUE key: which row the value names is other writers\' state to change', sql: `update u set body = :v where Email = :e`, lane: 'serializable' },
		{ name: 'a delete: no tombstone merge is declared', sql: `delete from t where Id = :id`, lane: 'serializable' },
		{ name: 'a StampId()-keyed insert into a table with no profile tag: strong is the ceiling', sql: `insert into s (Id, Title) values (StampId(), 'a')`, lane: 'serializable' },
	];

	for (const { name, sql, lane, ceiling } of cases) {
		it(name, () => {
			const { write, table } = described(sql);
			expect(laneOf(write, table), 'lane').to.equal(lane);
			expect(laneCeilingOf(write, table), 'ceiling').to.equal(ceiling ?? lane);
		});
	}

	it('a transaction takes the stricter lane over its described statements, and serializable when a write went undescribed', () => {
		const convergent = described(insertT('StampId()'));
		const strong = described(`insert into s (Id, Title) values (StampId(), 'a')`);
		const lane = (statement: { write: TableWrite; table: TableSchema }): WriteFact => ({ kind: 'lane', lane: laneOf(statement.write, statement.table) });
		expect(transactionLaneOf([lane(convergent)]), 'one convergent statement').to.equal('convergent');
		expect(transactionLaneOf([lane(convergent), lane(strong)]), 'a strong table beside a replay-permitted one').to.equal('serializable');
		expect(transactionLaneOf([lane(convergent), { kind: 'undescribed' }]), 'a cascade child write beside it').to.equal('serializable');
		expect(transactionLaneOf([]), 'nothing described').to.equal('serializable');
	});
});
