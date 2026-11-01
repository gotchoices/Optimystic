/**
 * A SQL commit's log entry carries the lane the plugin classified the transaction with
 * (docs/transactions.md §Which lane a transaction takes): the one contract between `laneOf` (pinned
 * per statement by lane.spec.ts) and the carriers (pinned in db-core) that neither covers — the bridge's
 * fold and its hand-off to the commit route. The route is the per-tree sweep every single-table write
 * takes in legacy mode; the other three routes are the same `openLane` value typed into a `lane` field.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { Collection, Log, laneOf } from '@optimystic/db-core';
import type { BlockStore, IBlock, ITransactor, Lane } from '@optimystic/db-core';
import register from '../dist/plugin.js';

describe('lane on the entry: a SQL commit carries the lane the plugin classified', () => {
	let db: Database;
	let transactor: ITransactor;

	beforeEach(async () => {
		db = new Database();
		const plugin = register(db, { default_transactor: 'test', default_key_network: 'test', enable_cache: false });
		for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
		for (const func of plugin.functions) db.registerFunction(func.schema);
		transactor = await plugin.collectionFactory.getOrCreateTransactor({
			collectionUri: 'tree://unused', transactor: 'test', keyNetwork: 'test', libp2pOptions: {}, cache: false, encoding: 'json',
		});
		await db.exec(`
			create table Merged (Id text primary key, Title text with tags ("optimystic.merge" = 'last-writer-wins'))
				using optimystic('tree://lane/merged') with tags ("optimystic.profile" = 'replay-permitted');
			create table Plain (Id text primary key, Title text) using optimystic('tree://lane/plain');
		`);
	});

	afterEach(async () => { await db.close(); });

	/** The lane of the newest action entry in the collection `id`'s log, read as a reader must (`laneOf`),
	 * through a fresh handle so nothing the vtab holds is in the way. */
	async function lastEntryLane(id: string): Promise<Lane> {
		const reader = await Collection.open<unknown>(transactor, id, {
			modules: {},
			createHeaderBlock: (headerId: string, store: BlockStore<IBlock>) => ({ header: store.createBlockHeader('TEST', headerId) }),
		});
		const log = await Log.open<unknown>(reader!.tracker, id);
		let last;
		for await (const entry of log!.select()) last = entry;
		expect(last?.action, 'an action entry').to.not.equal(undefined);
		return laneOf(last!.action!);
	}

	it('is convergent for a fresh-keyed insert into a replay-permitted table, serializable for the same insert into a strong one', async () => {
		// `StampId()` answers null until the bridge's transaction has begun, which an autocommit
		// statement does at its first vtab touch, after the value is evaluated: begin explicitly.
		await db.exec(`begin; insert into Merged (Id, Title) values (StampId(), 'a'); commit;`);
		expect(await lastEntryLane('lane/merged')).to.equal('convergent');
		await db.exec(`begin; insert into Plain (Id, Title) values (StampId(), 'a'); commit;`);
		expect(await lastEntryLane('lane/plain')).to.equal('serializable');
	});

	it('is serializable when one transaction writes both tables', async () => {
		await db.exec(`
			begin;
			insert into Merged (Id, Title) values (StampId(), 'b');
			insert into Plain (Id, Title) values (StampId(), 'b');
			commit;
		`);
		expect(await lastEntryLane('lane/merged')).to.equal('serializable');
	});
});
