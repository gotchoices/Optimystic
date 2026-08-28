/**
 * Regression guard for read amplification through the `local` transactor seam
 * (`CollectionFactory.createLocalTransactor` → `withReadCache`).
 *
 * Before the cache was wired, `BlockStorage` re-read block metadata on essentially every
 * operation and nothing beneath it memoized, so a create/insert/update/select workload over a
 * host-supplied backend issued 181 `getMetadata` reads against the driver (314 `fs.readFile`s
 * over `FileRawStorage`). On a host with slow disk reads that was enough to push several plugin
 * specs past their Mocha timeout.
 *
 * Counts are taken at the `RawStoreDriver` seam — BELOW the cache — because that is the only
 * place the fix is observable: the calls `BlockStorage` makes against `IRawStorage` are
 * identical cached or not. The assertions are operation counts, never wall clock (wall clock on
 * this workload varied 2.5× between runs on one host in one session).
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { KvRawStorage, MemoryStoreDriver, defaultCachePool, type RawStoreDriver } from '@optimystic/db-p2p';
import register from '../dist/plugin.js';

/** Count every driver method call by name, then delegate. Wraps the driver the plugin never sees. */
function counting(inner: RawStoreDriver): { driver: RawStoreDriver; counts: Record<string, number> } {
	const counts: Record<string, number> = {};
	const driver = new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				const name = String(prop);
				counts[name] = (counts[name] ?? 0) + 1;
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	return { driver, counts };
}

const READ_METHODS = [
	'getMetadata', 'getRevision', 'rangeRevisions', 'getPending',
	'listPendingActionIds', 'getTransaction', 'getMaterialized',
] as const;

function totalReads(counts: Record<string, number>): number {
	return READ_METHODS.reduce((sum, m) => sum + (counts[m] ?? 0), 0);
}

function createDb(driver: RawStoreDriver): { db: Database; plugin: ReturnType<typeof register> } {
	const db = new Database();
	const config = {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		// A KvRawStorage over anything but the memory driver is "host-supplied persistent
		// storage" as far as the seam is concerned, so it gets the read cache — exactly the
		// path FileRawStorage takes, without touching a disk.
		rawStorageFactory: () => new KvRawStorage(driver),
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

async function selectScalar(db: Database, sql: string): Promise<SqlValue> {
	for await (const row of db.eval(sql)) {
		const values = Object.values(row as Record<string, SqlValue>);
		return values[0] as SqlValue;
	}
	throw new Error('query returned no rows');
}

describe('local transactor read cache (read-amplification regression guard)', function () {
	this.timeout(15000);

	it('a create/insert/update/select workload stays within a bounded number of backend reads, and a reopen sees the write', async () => {
		const backing = new MemoryStoreDriver();
		const uri = 'tree://readcache/bounded';

		// --- First lifetime: the workload the timed-out specs run. ---
		const first = counting(backing);
		const { db, plugin } = createDb(first.driver);
		try {
			await db.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
			await db.exec(`insert into T (id, v) values (1, 'a')`);
			await db.exec(`update T set id = 99 where id = 1`);
			expect(await selectScalar(db, 'select v from T where id = 99')).to.equal('a');
		} finally {
			db.close();
		}

		// Measured through this seam at the time of writing: 6 getMetadata / 16 total backend
		// reads cached, against 181 getMetadata uncached (the ticket's baseline). The bounds
		// leave ~3× headroom for schema-catalog growth without letting the amplification back in.
		const meta = first.counts['getMetadata'] ?? 0;
		const reads = totalReads(first.counts);
		expect(meta, `getMetadata reached the driver ${meta} times (counts: ${JSON.stringify(first.counts)})`)
			.to.be.at.most(20);
		expect(reads, `${reads} backend reads total (counts: ${JSON.stringify(first.counts)})`)
			.to.be.at.most(60);

		// --- Dispose: the cache's shared-pool registration is released. ---
		const storesBefore = defaultCachePool().stats().stores.length;
		await plugin.dispose();
		expect(defaultCachePool().stats().stores.length, 'dispose retired the store handle').to.equal(storesBefore - 1);

		// --- Second lifetime over the SAME backing store: cold cache, post-update value observed. ---
		const second = counting(backing);
		const { db: db2, plugin: plugin2 } = createDb(second.driver);
		try {
			await plugin2.hydrate(db2);
			expect(await selectScalar(db2, 'select v from T where id = 99'), 'post-update value after reopen').to.equal('a');
			expect(await selectScalar(db2, 'select count(*) from T where id = 1'), 'old key gone after reopen').to.equal(0);
			expect(second.counts['getMetadata'] ?? 0, 'reopen read the backing store (not a stale cache)').to.be.greaterThan(0);
		} finally {
			db2.close();
			await plugin2.dispose();
		}
	});

	it('dispose is idempotent and a statement after dispose rebuilds a fresh transactor coherently', async () => {
		const backing = new MemoryStoreDriver();
		const { db, plugin } = createDb(counting(backing).driver);
		try {
			await db.exec(`create table U (id integer primary key, v text) using optimystic('tree://readcache/after-dispose')`);
			await db.exec(`insert into U (id, v) values (1, 'x')`);
			await plugin.dispose();
			await plugin.dispose();
			// The factory rebuilds the transactor (fresh cold cache) rather than serving a disposed one.
			expect(await selectScalar(db, 'select v from U where id = 1')).to.equal('x');
		} finally {
			db.close();
			await plugin.dispose();
		}
	});
});
