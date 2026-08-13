/**
 * The declared-vs-maintained index-set invariant (ticket
 * `index-maintenance-must-track-the-declared-index-set`).
 *
 * Every Optimystic table carries two independent notions of "which secondary
 * indexes exist": Quereus's catalog (`TableSchema.indexes` — what the planner
 * offers, and therefore what routes a `where Token = ?` into an index seek) and
 * the vtab's `IndexManager` (what INSERT/UPDATE/DELETE actually stage into).
 * When the maintenance set is missing an index the planner still has, writes
 * silently skip the index tree while reads keep being routed into it — empty
 * results forever, no error anywhere.
 *
 * The one site that knowingly produced that divergence was `addIndex`'s
 * already-persisted early return: a vtab whose IndexManager was built from a
 * persisted schema WITHOUT the index (another writer added it since) took the
 * early return and stayed permanently index-less for maintenance. This suite
 * pins both arms of the fix:
 *
 *   Arm 1 — the early-return branch reconciles the IndexManager with the
 *   persisted index set (tree open + registered, descriptor folded in, bridge
 *   registration), so a re-declared CREATE INDEX always ends up maintained.
 *
 *   Arm 2 — a query planned onto an index the table does NOT maintain fails at
 *   plan selection with an error naming the table and the index, instead of
 *   silently answering from a stale tree.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;
type Plugin = ReturnType<typeof register>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

/** Build a `local`-style transactor over the supplied raw storage, shared by
 * every Database in a test so Trees opened by either side see the other's
 * writes (same pattern as catalog-hydration.spec.ts). */
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

function registerWithSharedTransactor(db: Database, transactor: ITransactor): Plugin {
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
	return plugin;
}

/** Options that resolve to the registered shared `local:test` transactor. */
const localOptions = (collectionUri: string) => ({
	collectionUri,
	transactor: 'local',
	keyNetwork: 'test',
	libp2pOptions: {},
	cache: false,
	encoding: 'json' as const,
});

/** Count committed entries in the tree at `collectionUri` via a FRESH Tree on
 * the shared transactor — so the count reflects what actually persisted, not a
 * vtab's in-flight tracker (the countTreeEntries pattern from
 * session-mode-commit.spec.ts). */
async function countTreeEntries(plugin: Plugin, collectionUri: string): Promise<number> {
	const tree = await plugin.collectionFactory.createOrGetCollection(localOptions(collectionUri));
	await tree.update();
	let n = 0;
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (tree.isValid(treePath)) n++;
	}
	return n;
}

describe('Index maintenance must track the declared index set', function () {
	this.timeout(30_000);

	it('a CREATE INDEX for an index another writer already persisted ends up maintained (early-return reconcile)', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);
		const dbA = new Database();
		const pluginA = registerWithSharedTransactor(dbA, shared);
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);

		const uri = 'tree://invariant/formation_usage';
		const ddl = `create table formation_usage (id integer primary key, token text) using optimystic('${uri}')`;

		// A declares the table (persisted schema has NO indexes yet) and writes a
		// row — initializing A's vtab, whose IndexManager is built from that
		// index-less schema.
		await dbA.exec(ddl);
		await dbA.exec(`insert into formation_usage (id, token) values (1, 'tok-a')`);

		// B joins the same storage and declares the index: it lands in the
		// persisted schema and is populated from the existing row.
		await dbB.exec(ddl);
		await dbB.exec(`create index formation_usage_by_token on formation_usage(token)`);
		expect(
			await countTreeEntries(pluginB, `${uri}/index/formation_usage_by_token`),
			'B populated the index from the pre-existing row',
		).to.equal(1);

		// Refresh A's schema cache from the catalog tree (hydrate's listTables walk
		// reseeds it), so A's CREATE INDEX below sees the index as already
		// persisted — the early-return branch under test.
		await pluginA.hydrate(dbA);

		// A re-declares the index. Before the fix this early-returned without
		// touching A's IndexManager: A kept writing past the index while A's
		// planner kept routing seeks into it.
		await dbA.exec(`create index formation_usage_by_token on formation_usage(token)`);

		// A subsequent INSERT on A must stage into the index tree.
		await dbA.exec(`insert into formation_usage (id, token) values (2, 'tok-b')`);
		expect(
			await countTreeEntries(pluginA, `${uri}/index/formation_usage_by_token`),
			'index entry count after the divergent-then-reconciled writer inserts',
		).to.equal(2);

		// A's own index seek finds the row it just wrote…
		const onA = await collectRows(dbA.eval(`select id from formation_usage where token = 'tok-b'`));
		expect(onA.map(r => r.id), "A's index seek").to.deep.equal([2]);

		// …and the sibling's index seek converges on the same row.
		const onB = await collectRows(dbB.eval(`select id from formation_usage where token = 'tok-b'`));
		expect(onB.map(r => r.id), "B's index seek").to.deep.equal([2]);
	});

	it('a fresh session re-declaring persisted DDL keeps the index maintained (warm early-return stays cheap and correct)', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);
		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);

		const uri = 'tree://invariant/warm_redeclare';
		const ddl = `create table warm_redeclare (id integer primary key, token text) using optimystic('${uri}')`;
		await dbA.exec(ddl);
		await dbA.exec(`create index warm_redeclare_by_token on warm_redeclare(token)`);
		await dbA.exec(`insert into warm_redeclare (id, token) values (1, 'tok-a')`);

		// A fresh Database replays the same DDL against existing storage — the
		// common warm boot. Its vtab initializes from the persisted schema (which
		// carries the index), and the CREATE INDEX takes the early return.
		const dbC = new Database();
		const pluginC = registerWithSharedTransactor(dbC, shared);
		await dbC.exec(ddl);
		await dbC.exec(`create index warm_redeclare_by_token on warm_redeclare(token)`);

		await dbC.exec(`insert into warm_redeclare (id, token) values (2, 'tok-b')`);
		expect(
			await countTreeEntries(pluginC, `${uri}/index/warm_redeclare_by_token`),
			'index entries after the re-declaring session inserts',
		).to.equal(2);

		const onC = await collectRows(dbC.eval(`select id from warm_redeclare where token = 'tok-b'`));
		expect(onC.map(r => r.id)).to.deep.equal([2]);
		const onA = await collectRows(dbA.eval(`select id from warm_redeclare where token = 'tok-b'`));
		expect(onA.map(r => r.id)).to.deep.equal([2]);
	});

	it('a query planned onto an unmaintained index fails loudly, naming table and index', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);

		const uri = 'tree://invariant/guarded';
		await db.exec(`create table guarded (id integer primary key, token text) using optimystic('${uri}')`);
		await db.exec(`create index guarded_by_token on guarded(token)`);
		await db.exec(`insert into guarded (id, token) values (1, 'tok-a')`);

		// Sanity: the maintained index serves the seek.
		const before = await collectRows(db.eval(`select id from guarded where token = 'tok-a'`));
		expect(before.map(r => r.id)).to.deep.equal([1]);

		// Construct the divergent state directly: strip the index from the vtab's
		// IndexManager (its tree stays open and registered) while Quereus's
		// catalog — and therefore the planner — still carries it. This is the
		// "tree exists but nothing maintains it" shape no public path should be
		// able to produce anymore; the guard is what keeps it loud if one ever does.
		const optimysticModule = plugin.vtables.find(v => v.name === 'optimystic')!.module as unknown as {
			tables: Map<string, {
				indexManager?: { setSchema(schema: unknown): void };
				schemaManager: { getSchema(name: string): Promise<unknown> };
			}>;
		};
		const vtab = optimysticModule.tables.get('main.guarded');
		expect(vtab, 'vtab registered under main.guarded').to.not.equal(undefined);
		const stored = await vtab!.schemaManager.getSchema('guarded') as { indexes: unknown[] };
		expect(stored.indexes, 'persisted schema carries the index').to.have.lengthOf(1);
		vtab!.indexManager!.setSchema({ ...stored, indexes: [] });

		// The seek must now fail with an error naming table and index — NOT
		// return rows from the frozen tree (which still holds tok-a and would
		// answer plausibly today and wrongly after the next write).
		let failure: unknown;
		try {
			await collectRows(db.eval(`select id from guarded where token = 'tok-a'`));
		} catch (error) {
			failure = error;
		}
		expect(failure, 'index seek on an unmaintained index must throw').to.be.instanceOf(Error);
		const message = (failure as Error).message;
		expect(message).to.contain(`does not maintain index 'guarded_by_token'`);
		expect(message).to.contain(`'guarded'`);

		// Plans that do not route through the index still answer.
		const scanned = await collectRows(db.eval(`select id from guarded`));
		expect(scanned.map(r => r.id), 'full scan is unaffected').to.deep.equal([1]);
		const byPk = await collectRows(db.eval(`select id from guarded where id = 1`));
		expect(byPk.map(r => r.id), 'primary-key seek is unaffected').to.deep.equal([1]);
	});
});
