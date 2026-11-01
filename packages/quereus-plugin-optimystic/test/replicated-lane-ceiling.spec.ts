/**
 * The ceiling a validating member computes for a transaction's statements AS REPLICATED
 * (`QuereusEngine.laneCeiling` over `replicatedCeilingOf`; docs/transactions.md §What a member
 * verifies). A member never sees the statement the writer ran: it sees Quereus's rebuild of each
 * row's write, and a rebuilt UPDATE assigns every column, the key included. So every case captures
 * the real rebuild through the bridge (as the session would record it) rather than hand-writing one,
 * and checks the property the member's rule exists to keep — a writer whose lane is `convergent` is
 * never answered `serializable` — beside the answer itself.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	HlcClock,
	createTransactionId,
	createTransactionStamp,
	type Lane,
	type Transaction,
	type TransactionCoordinator
} from '@optimystic/db-core';
import { QuereusEngine, QUEREUS_ENGINE_ID, createQuereusStatement } from '../dist/index.js';
import register from '../dist/plugin.js';
import { laneOf } from '../src/optimystic-adapter/lane.js';

const REPLAY = `with tags ("optimystic.profile" = 'replay-permitted')`;
const LWW = `with tags ("optimystic.merge" = 'last-writer-wins')`;

describe('lane: the ceiling a member computes from replicated statements', () => {
	let db: Database;
	let plugin: ReturnType<typeof register>;
	let engine: QuereusEngine;
	const hlc = new HlcClock({ nodeId: 'test' }).now();

	before(async () => {
		db = new Database();
		plugin = register(db, { default_transactor: 'test', default_key_network: 'test', enable_cache: false });
		for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
		for (const func of plugin.functions) db.registerFunction(func.schema);
		await db.exec(`
			create table notes (Id text primary key, Title text ${LWW}, Owner text null) using optimystic('tree://test/notes') ${REPLAY};
			create table plain (Id text primary key, Title text) using optimystic('tree://test/plain') ${REPLAY};
			create table accounts (Id text primary key, Email text unique, body text ${LWW}) using optimystic('tree://test/accounts') ${REPLAY};
			create table ledger (Id text primary key, Title text ${LWW}) using optimystic('tree://test/ledger');
			insert into notes (Id, Title, Owner) values ('k', 'a', 'x');
			insert into plain (Id, Title) values ('k', 'a');
		`);
		// The engine reads only the catalog; the coordinator it is built with is never touched here.
		engine = new QuereusEngine(db, {} as TransactionCoordinator);
	});

	after(async () => {
		engine.dispose();
		await db.close();
	});

	/** `sql` run in a transaction that is then rolled back, as the member receives it: the bridge's
	 * rebuilt statements, claiming `convergent`. */
	async function replicated(sql: string): Promise<Transaction> {
		await db.exec('begin');
		await db.exec(sql);
		const statements = plugin.txnBridge.getStatements().map(statement => createQuereusStatement(statement));
		await db.exec('rollback');
		expect(statements, `the rebuild of ${sql}`).to.not.be.empty;
		const stamp = await createTransactionStamp('writer', Date.now(), 'schema', QUEREUS_ENGINE_ID);
		return { stamp, statements, reads: [], hlc, lane: 'convergent', id: await createTransactionId(stamp.id, statements, [], hlc, 'convergent') };
	}

	/** The lane the writer's own statement takes. */
	async function writerLane(sql: string): Promise<Lane> {
		const prepared = db.prepare(sql);
		try {
			const write = prepared.getWriteScope().writes[0]!;
			return laneOf(write, db.schemaManager.findTable(write.table.table, write.table.schema)!);
		} finally {
			await prepared.finalize();
		}
	}

	const cases: ReadonlyArray<{ readonly name: string; readonly sql: string; readonly ceiling: Lane }> = [
		{ name: 'a StampId()-keyed insert', sql: `insert into notes (Id, Title, Owner) values (StampId(), 'a', null)`, ceiling: 'convergent' },
		{ name: 'a same-key update of a merge-tagged column, though its rebuild assigns the key and an untagged column', sql: `update notes set Title = 'b' where Id = 'k'`, ceiling: 'convergent' },
		{ name: 'an update of a table that declares a merge on no column outside its key', sql: `update plain set Title = 'b' where Id = 'k'`, ceiling: 'serializable' },
		{ name: 'a delete', sql: `delete from notes where Id = 'k'`, ceiling: 'serializable' },
		{ name: 'an insert into a table with a UNIQUE column', sql: `insert into accounts (Id, Email, body) values (StampId(), 'a@x', 'b')`, ceiling: 'serializable' },
		{ name: 'an insert into a table with no profile', sql: `insert into ledger (Id, Title) values (StampId(), 'a')`, ceiling: 'serializable' },
	];

	for (const { name, sql, ceiling } of cases) {
		it(name, async () => {
			const answer = await engine.laneCeiling(await replicated(sql));
			expect(answer, 'ceiling').to.equal(ceiling);
			if (await writerLane(sql) === 'convergent') expect(answer, 'an honest convergent writer is never refused').to.equal('convergent');
		});
	}
});
