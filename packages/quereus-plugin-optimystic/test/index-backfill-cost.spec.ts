/**
 * `backfillIndexTrees` must not pay for a scan it has nothing to scan
 * (ticket `index-backfill-scans-an-empty-collection`), and must still populate
 * every index it is supposed to.
 *
 * The expensive parts of a backfill are not the row walk — they are the two
 * cache-bypassing refreshes wrapped around it: `collection.update()` before the
 * scan, and `Tree.sync()` (which is `updateAndSync()`) once per target tree
 * after it. On a table with no rows both are pure cost: the walk stages nothing,
 * so the flush commits nothing.
 *
 * The counters below wrap the raw storage the local transactor is handed, so an
 * "operation" here is exactly one `IRawStorage` call — the unit the ticket
 * measures, and the unit that multiplies by per-operation latency on a phone.
 *
 * The cost figures asserted here are ceilings with slack, not exact counts: they
 * exist to catch a regression that reintroduces a whole log walk, not to pin the
 * storage layer's internal call pattern.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { expectIndexAgreesWithScan, queryAll } from './query-helpers.js';

type Plugin = ReturnType<typeof register>;

/** Every `IRawStorage` call, counted by method name. */
class CountingRawStorage extends MemoryRawStorage {
	public counts = new Map<string, number>();

	private bump(name: string): void {
		this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
	}

	reset(): void {
		this.counts.clear();
	}

	total(): number {
		let sum = 0;
		for (const n of this.counts.values()) sum += n;
		return sum;
	}

	describe(): string {
		return [...this.counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ');
	}

	override async getMetadata(...args: Parameters<MemoryRawStorage['getMetadata']>) {
		this.bump('getMetadata');
		return super.getMetadata(...args);
	}

	override async saveMetadata(...args: Parameters<MemoryRawStorage['saveMetadata']>) {
		this.bump('saveMetadata');
		return super.saveMetadata(...args);
	}

	override async getRevision(...args: Parameters<MemoryRawStorage['getRevision']>) {
		this.bump('getRevision');
		return super.getRevision(...args);
	}

	override async saveRevision(...args: Parameters<MemoryRawStorage['saveRevision']>) {
		this.bump('saveRevision');
		return super.saveRevision(...args);
	}

	override listRevisions(...args: Parameters<MemoryRawStorage['listRevisions']>) {
		this.bump('listRevisions');
		return super.listRevisions(...args);
	}

	override async getPendingTransaction(...args: Parameters<MemoryRawStorage['getPendingTransaction']>) {
		this.bump('getPendingTransaction');
		return super.getPendingTransaction(...args);
	}

	override async savePendingTransaction(...args: Parameters<MemoryRawStorage['savePendingTransaction']>) {
		this.bump('savePendingTransaction');
		return super.savePendingTransaction(...args);
	}

	override async deletePendingTransaction(...args: Parameters<MemoryRawStorage['deletePendingTransaction']>) {
		this.bump('deletePendingTransaction');
		return super.deletePendingTransaction(...args);
	}

	override listPendingTransactions(...args: Parameters<MemoryRawStorage['listPendingTransactions']>) {
		this.bump('listPendingTransactions');
		return super.listPendingTransactions(...args);
	}

	override async getTransaction(...args: Parameters<MemoryRawStorage['getTransaction']>) {
		this.bump('getTransaction');
		return super.getTransaction(...args);
	}

	override async saveTransaction(...args: Parameters<MemoryRawStorage['saveTransaction']>) {
		this.bump('saveTransaction');
		return super.saveTransaction(...args);
	}

	override async getMaterializedBlock(...args: Parameters<MemoryRawStorage['getMaterializedBlock']>) {
		this.bump('getMaterializedBlock');
		return super.getMaterializedBlock(...args);
	}

	override async saveMaterializedBlock(...args: Parameters<MemoryRawStorage['saveMaterializedBlock']>) {
		this.bump('saveMaterializedBlock');
		return super.saveMaterializedBlock(...args);
	}

	override async promotePendingTransaction(...args: Parameters<MemoryRawStorage['promotePendingTransaction']>) {
		this.bump('promotePendingTransaction');
		return super.promotePendingTransaction(...args);
	}
}

/** A `local`-style transactor over the supplied raw storage, shared by every
 * Database in a test so trees opened by either side see the other's writes (same
 * harness as index-maintenance-invariant.spec.ts). */
function buildSharedLocalTransactor(storage: MemoryRawStorage): ITransactor {
	const repo = new StorageRepo((blockId) => new BlockStorage(blockId, storage));
	return {
		async get(blockGets) { return await repo.get(blockGets); },
		async getStatus(_trxRefs) { throw new Error('getStatus not implemented in test transactor'); },
		async pend(request) { return await repo.pend(request); },
		async commit(request) { return await repo.commit(request); },
		async cancel(trxRef) { return await repo.cancel(trxRef); },
	} as ITransactor;
}

function newSession(transactor: ITransactor): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	});
	plugin.collectionFactory.registerTransactor('local:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

const localOptions = (collectionUri: string) => ({
	collectionUri,
	transactor: 'local',
	keyNetwork: 'test',
	libp2pOptions: {},
	cache: false,
	encoding: 'json' as const,
});

/** Committed entries in the tree at `collectionUri`, read through a FRESH tree on
 * the shared transactor so the count reflects what persisted rather than some
 * vtab's in-flight tracker. */
async function countTreeEntries(plugin: Plugin, collectionUri: string): Promise<number> {
	const tree = await plugin.collectionFactory.createOrGetCollection(localOptions(collectionUri));
	await tree.update();
	let n = 0;
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (tree.isValid(treePath)) n++;
	}
	return n;
}

const ddlFor = (table: string, uri: string) =>
	`create table ${table} (id integer primary key, token text) using optimystic('${uri}')`;

describe('index backfill cost on a table with nothing to copy', function () {
	this.timeout(30_000);

	it('CREATE INDEX on a table with committed history but no live rows stays cheap', async () => {
		// The table's collection HAS a committed log (a row was written and removed),
		// so `collection.update()` here is a real, cache-bypassing chain walk — the
		// shape the ticket measured. It still has zero rows to copy.
		const storage = new CountingRawStorage();
		const { db } = newSession(buildSharedLocalTransactor(storage));
		const uri = 'tree://backfill-cost/emptied';

		await db.exec(ddlFor('emptied', uri));
		await db.exec(`insert into emptied (id, token) values (1, 'tok-a')`);
		await db.exec(`delete from emptied where id = 1`);
		expect(await queryAll(db, `select id from emptied`), 'precondition: no live rows').to.deep.equal([]);

		storage.reset();
		await db.exec(`create index emptied_by_token on emptied(token)`);
		const ops = storage.total();

		// eslint-disable-next-line no-console
		console.log(`\n    CREATE INDEX, committed-but-empty table: ${ops} ops (${storage.describe()})`);

		// Measured 255 with the skip, 301 without it (the rest is the statement's own
		// catalog write and the index tree's first commit, which the skip does not
		// touch). A reintroduced refresh-and-scan of the main collection blows through
		// this ceiling.
		expect(ops, 'an empty table must not pay a main-collection refresh + scan').to.be.lessThan(280);
	});

	it('re-attaching to an empty table skips both the refresh and the per-tree flush', async () => {
		// Two connections. B builds the index; A is detached from it and holds no rows,
		// so when A re-declares, its backfill has nothing to copy AND its freshly opened
		// index tree has nothing staged — both the `collection.update()` and the
		// `tree.sync()` are pure cost.
		const storage = new CountingRawStorage();
		const shared = buildSharedLocalTransactor(storage);
		const uri = 'tree://backfill-cost/reattach-empty';
		const ddl = ddlFor('reattach_empty', uri);

		const a = newSession(shared);
		await a.db.exec(ddl);
		// Give A's collection a committed log without leaving a live row behind.
		await a.db.exec(`insert into reattach_empty (id, token) values (1, 'tok-a')`);
		await a.db.exec(`delete from reattach_empty where id = 1`);

		const b = newSession(shared);
		await b.db.exec(ddl);
		await b.db.exec(`create index reattach_empty_by_token on reattach_empty(token)`);

		// Reseed A's schema cache so its CREATE INDEX takes the already-persisted
		// branch and reconciles (attaching the index it never had).
		await a.plugin.hydrate(a.db);

		storage.reset();
		await a.db.exec(`create index reattach_empty_by_token on reattach_empty(token)`);
		const ops = storage.total();

		// eslint-disable-next-line no-console
		console.log(`    re-attach on empty table:                ${ops} ops (${storage.describe()})`);

		// Measured 98 with the skip, 184 without — the largest of the three, because
		// here BOTH refreshes are wasted (the main collection's and the already-committed
		// index tree's).
		expect(ops, 're-attach with nothing to copy must not walk two logs').to.be.lessThan(140);
	});

	it('CREATE INDEX on a populated table still pays for — and performs — the full scan', async () => {
		// The control the ticket asks for: the build path over real rows must be
		// unchanged, in both cost and effect.
		const storage = new CountingRawStorage();
		const { db, plugin } = newSession(buildSharedLocalTransactor(storage));
		const uri = 'tree://backfill-cost/populated';

		await db.exec(ddlFor('populated', uri));
		for (let i = 0; i < 20; i++) {
			await db.exec(`insert into populated (id, token) values (${i}, 'tok-${i % 4}')`);
		}

		storage.reset();
		await db.exec(`create index populated_by_token on populated(token)`);
		const ops = storage.total();

		// eslint-disable-next-line no-console
		console.log(`    CREATE INDEX, 20-row table:              ${ops} ops (${storage.describe()})\n`);

		expect(
			await countTreeEntries(plugin, `${uri}/index/populated_by_token`),
			'every existing row must be in the new index',
		).to.equal(20);
		await expectIndexAgreesWithScan(db, 'populated', 'token');
		// Unchanged by the skip (measured 301 either way); asserted loosely so the
		// number itself is not the contract.
		expect(ops, 'the populated build path is not made cheaper — or dearer — by the skip')
			.to.be.greaterThan(150);
	});
});

describe('index backfill correctness around the empty-table skip', function () {
	this.timeout(30_000);

	it('an index built on an empty table indexes every row written afterwards', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db, plugin } = newSession(shared);
		const uri = 'tree://backfill-skip/later-rows';

		await db.exec(ddlFor('later_rows', uri));
		await db.exec(`create index later_rows_by_token on later_rows(token)`);
		await db.exec(`insert into later_rows (id, token) values (1, 'tok-a')`);
		await db.exec(`insert into later_rows (id, token) values (2, 'tok-b')`);

		expect(
			await countTreeEntries(plugin, `${uri}/index/later_rows_by_token`),
			'rows written after an index built on an empty table are indexed',
		).to.equal(2);
		await expectIndexAgreesWithScan(db, 'later_rows', 'token');

		// And a fresh session over the same storage reads that index, so skipping the
		// flush of an empty tree did not cost the index its durable header.
		const second = newSession(shared);
		await second.db.exec(ddlFor('later_rows', uri));
		await second.db.exec(`create index later_rows_by_token on later_rows(token)`);
		await expectIndexAgreesWithScan(second.db, 'later_rows', 'token');
		await second.db.exec(`insert into later_rows (id, token) values (3, 'tok-a')`);
		expect(
			await countTreeEntries(second.plugin, `${uri}/index/later_rows_by_token`),
			'the second session appends to the same index tree',
		).to.equal(3);
	});

	it('rows committed while detached are still backfilled when the table is not empty', async () => {
		// The bug backfill exists to fix, restated against the skip: the skip must key
		// off "this connection has no rows", never off "this connection attached late".
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		const uri = 'tree://backfill-skip/detached';
		const ddl = ddlFor('detached', uri);
		const indexUri = `${uri}/index/detached_by_token`;

		const a = newSession(shared);
		await a.db.exec(ddl);

		const b = newSession(shared);
		await b.db.exec(ddl);
		await b.db.exec(`create index detached_by_token on detached(token)`);

		// A is detached from the index and commits a row past it.
		await a.db.exec(`insert into detached (id, token) values (1, 'tok-a')`);
		expect(await countTreeEntries(a.plugin, indexUri), 'the detached write left no index entry')
			.to.equal(0);

		await a.plugin.hydrate(a.db);
		await a.db.exec(`create index detached_by_token on detached(token)`);

		expect(await countTreeEntries(a.plugin, indexUri), 'the detached row gained its entry on re-attach')
			.to.equal(1);
		await expectIndexAgreesWithScan(a.db, 'detached', 'token');
	});

	it('several indexes attaching in one reconcile share the single scan decision', async () => {
		// `attached` is a list, and one scan serves all of it — so the skip is decided
		// per scan, not per index. Here the table is NOT empty, so all of them populate.
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		const uri = 'tree://backfill-skip/multi';
		const ddl = `create table multi (id integer primary key, token text, grade text) using optimystic('${uri}')`;

		const a = newSession(shared);
		await a.db.exec(ddl);
		await a.db.exec(`insert into multi (id, token, grade) values (1, 'tok-a', 'g1')`);
		await a.db.exec(`insert into multi (id, token, grade) values (2, 'tok-b', 'g2')`);

		const b = newSession(shared);
		await b.db.exec(ddl);
		await b.db.exec(`create index multi_by_token on multi(token)`);
		await b.db.exec(`create index multi_by_grade on multi(grade)`);

		// A attaches BOTH indexes in the single reconcile its re-declare triggers.
		await a.plugin.hydrate(a.db);
		await a.db.exec(`create index multi_by_token on multi(token)`);

		expect(await countTreeEntries(a.plugin, `${uri}/index/multi_by_token`), 'token index populated')
			.to.equal(2);
		expect(await countTreeEntries(a.plugin, `${uri}/index/multi_by_grade`), 'grade index populated')
			.to.equal(2);
		// Only multi_by_token is in A's Quereus catalog (A never ran the grade DDL), so
		// only that one is routable from A; multi_by_grade is checked by entry count
		// above and read back through B, which declared it.
		await expectIndexAgreesWithScan(a.db, 'multi', 'token');
		await expectIndexAgreesWithScan(b.db, 'multi', 'grade');
	});

	it('CREATE INDEX inside a transaction populates from rows staged but not yet committed', async () => {
		// The skip reads the LIVE tree, not a committed snapshot, precisely so that
		// uncommitted inserts above a mid-transaction CREATE INDEX still count as rows
		// to copy. A committed-view check would read this table as empty and skip.
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db, plugin } = newSession(shared);
		const uri = 'tree://backfill-skip/mid-txn';

		await db.exec(ddlFor('mid_txn', uri));
		await db.exec(`
			begin;
			insert into mid_txn (id, token) values (1, 'tok-a');
			insert into mid_txn (id, token) values (2, 'tok-b');
			create index mid_txn_by_token on mid_txn(token);
			commit;
		`);

		expect(
			await countTreeEntries(plugin, `${uri}/index/mid_txn_by_token`),
			'rows staged before the mid-transaction CREATE INDEX must be indexed',
		).to.equal(2);
		await expectIndexAgreesWithScan(db, 'mid_txn', 'token');
	});
});
