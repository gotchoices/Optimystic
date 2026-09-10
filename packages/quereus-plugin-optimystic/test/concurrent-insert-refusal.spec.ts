/**
 * Concurrent same-key INSERT refusal (ticket `concurrent-insert-guard-refuses-taken-key`).
 *
 * Two writers inserting the same primary key at the same moment used to BOTH report
 * success while only one row survived — the loser's commit retry replayed its staged
 * upsert over the winner's committed row (silent last-writer-wins, with the loser's row
 * surviving). The fix carries the INSERT's intent on the staged tree entry (a
 * `TreeEntryGuard`), re-checked by the replace handler at every conflict replay, and the
 * bridge maps the resulting `TreeKeyTakenError` to the ordinary
 * `UNIQUE constraint failed: <table>.<col>` message — so the loser fails exactly like a
 * sequential duplicate INSERT and existing client classifiers need no new arm.
 *
 * These tests run two (or three) independent `Database` handles over ONE
 * `FileRawStorage` directory and one `tree://` URI — the cheap one-node repro shape the
 * fix-stage record verified fails on pre-guard builds (both fulfilled, survivor was the
 * LOSER's row). The racing test asserts the inverted outcome; the deterministic
 * staged-then-rival-commits tests pin the replay path specifically, immune to race luck,
 * in both LEGACY and SESSION (coordinator) commit modes.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { TransactionCoordinator } from '@optimystic/db-core';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import debugFactory from 'debug';
import { format } from 'node:util';
import register from '../dist/plugin.js';
import { QuereusEngine } from '../dist/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

type Plugin = ReturnType<typeof register>;

function createDb(dir: string): { db: Database; plugin: Plugin } {
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
	return { db, plugin };
}

async function selectScalar(db: Database, sql: string): Promise<SqlValue> {
	for await (const row of db.eval(sql)) {
		const values = Object.values(row as Record<string, SqlValue>);
		return values[0] as SqlValue;
	}
	throw new Error('query returned no rows');
}

const selectCount = async (db: Database, sql: string): Promise<number> => Number(await selectScalar(db, sql));

/** Assert that `fn` rejects and return the thrown error's message. */
async function captureThrowMessage(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error('expected operation to throw, but it resolved');
}

/**
 * Run `body` with EVERY optimystic debug namespace captured (db-core's included —
 * trace-helpers' captureTrace enables only the plugin's), so the racing test can
 * assert the fork guard stayed silent: a refused writer never commits, so nothing
 * may register as `collection:lineage-divergence`.
 */
async function captureAllOptimysticTrace(body: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const previousNamespaces = debugFactory.disable();
	const previousLog = debugFactory.log;
	debugFactory.log = (...args: unknown[]) => { lines.push(format(...args)); };
	debugFactory.enable('optimystic:*');
	try {
		await body();
	} finally {
		debugFactory.log = previousLog;
		debugFactory.enable(previousNamespaces);
	}
	return lines;
}

const UNIQUE_T_ID = /UNIQUE constraint failed: T\.id/;

describe('Concurrent same-key INSERT refusal (two handles, one FileRawStorage dir)', function () {
	this.timeout(30000);

	let dir: string;
	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-concurrent-insert', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** Two handles over one dir, both declaring table T over `uri`. Dispose BOTH plugins
	 * (per-dir read cache lease) and close both dbs via the returned disposer. */
	async function twoHandles(uri: string): Promise<{
		a: Database; b: Database; pluginA: Plugin; pluginB: Plugin; dispose: () => Promise<void>;
	}> {
		const { db: a, plugin: pluginA } = createDb(dir);
		const { db: b, plugin: pluginB } = createDb(dir);
		await a.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
		await b.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
		return {
			a, b, pluginA, pluginB,
			dispose: async () => {
				a.close();
				b.close();
				await pluginA.dispose();
				await pluginB.dispose();
			},
		};
	}

	it('same key, same tick: exactly one fulfils, the loser gets the UNIQUE message, one row (the winner\'s) on both handles', async () => {
		const uri = 'tree://race/same-key';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			let results: PromiseSettledResult<unknown>[] = [];
			const lines = await captureAllOptimysticTrace(async () => {
				results = await Promise.allSettled([
					a.exec(`insert into T (id, v) values (1, 'from-A')`),
					b.exec(`insert into T (id, v) values (1, 'from-B')`),
				]);
			});

			const fulfilledIndexes = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
			const outcomes = results
				.map(r => (r.status === 'fulfilled' ? 'fulfilled' : `rejected: ${String((r as PromiseRejectedResult).reason)}`))
				.join(' | ');
			expect(fulfilledIndexes.length, `exactly one writer wins (${outcomes})`).to.equal(1);
			const rejection = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
			const message = rejection.reason instanceof Error ? rejection.reason.message : String(rejection.reason);
			expect(message, 'the loser sees the ordinary duplicate-key refusal').to.match(UNIQUE_T_ID);

			// Both handles agree: one row, and it is the WINNER's (pre-fix the loser's
			// replay displaced the winner, so the survivor was the loser's row).
			const winnerValue = fulfilledIndexes[0] === 0 ? 'from-A' : 'from-B';
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
				expect(await selectScalar(db, 'select v from T where id = 1')).to.equal(winnerValue);
			}

			// Fork-guard silence: a refused writer never commits, so nothing may have
			// registered as lineage divergence during the race.
			const divergence = lines.filter(line => line.includes('lineage-divergence'));
			expect(divergence, `no lineage divergence may be reported: ${divergence.join('\n')}`).to.deep.equal([]);
		} finally {
			await handles.dispose();
		}
	});

	it('different keys, same tick: both fulfil and both rows survive on both handles (discriminator)', async () => {
		const uri = 'tree://race/two-keys';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			const results = await Promise.allSettled([
				a.exec(`insert into T (id, v) values (1, 'from-A')`),
				b.exec(`insert into T (id, v) values (2, 'from-B')`),
			]);
			expect(results.map(r => r.status), 'no false refusal on disjoint keys').to.deep.equal(['fulfilled', 'fulfilled']);
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(2);
			}
		} finally {
			await handles.dispose();
		}
	});

	it('three writers, one key: exactly one fulfils and every loser gets the UNIQUE message', async () => {
		const uri = 'tree://race/three-writers';
		const handles = await twoHandles(uri);
		const { db: c, plugin: pluginC } = createDb(dir);
		try {
			await c.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
			const results = await Promise.allSettled([
				handles.a.exec(`insert into T (id, v) values (1, 'from-A')`),
				handles.b.exec(`insert into T (id, v) values (1, 'from-B')`),
				c.exec(`insert into T (id, v) values (1, 'from-C')`),
			]);
			const fulfilled = results.filter(r => r.status === 'fulfilled');
			const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
			expect(fulfilled.length, `exactly one of three wins (statuses: ${results.map(r => r.status).join(', ')})`).to.equal(1);
			expect(rejected.length).to.equal(2);
			for (const r of rejected) {
				const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
				expect(message, 'each loser is refused as a duplicate key').to.match(UNIQUE_T_ID);
			}
			expect(await selectCount(handles.a, 'select count(*) as c from T')).to.equal(1);
		} finally {
			c.close();
			await pluginC.dispose();
			await handles.dispose();
		}
	});

	it('DETERMINISTIC replay path (legacy): a staged insert whose key a rival then commits is refused at commit', async () => {
		const uri = 'tree://race/staged-then-rival';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			// A stages the insert first (probe sees a clear key), THEN the rival commits the
			// same key, THEN A commits — so the refusal can only come from the commit-time
			// conflict replay, never from the pre-stage probe. No race luck involved.
			await a.exec('begin');
			await a.exec(`insert into T (id, v) values (1, 'from-A')`);
			await b.exec(`insert into T (id, v) values (1, 'from-B')`);

			const message = await captureThrowMessage(() => a.exec('commit'));
			expect(message, 'the loser\'s COMMIT carries the ordinary duplicate-key message').to.match(UNIQUE_T_ID);

			// The winner's row survives on both handles; the loser's transaction rolled back.
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
				expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('from-B');
			}
		} finally {
			await handles.dispose();
		}
	});

	it('INSERT OR IGNORE staged before a rival commits the key: commit succeeds and keeps the rival\'s row', async () => {
		const uri = 'tree://race/ignore';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			await a.exec('begin');
			await a.exec(`insert or ignore into T (id, v) values (1, 'from-A')`);
			await b.exec(`insert into T (id, v) values (1, 'from-B')`);
			// The keepExisting guard skips the entry at replay — the same outcome a
			// sequential INSERT OR IGNORE gets, with no error and no overwrite.
			await a.exec('commit');
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
				expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('from-B');
			}
		} finally {
			await handles.dispose();
		}
	});

	it('INSERT OR REPLACE staged before a rival commits the key: commit succeeds and overwrites (declared semantics)', async () => {
		const uri = 'tree://race/replace';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			await a.exec('begin');
			await a.exec(`insert or replace into T (id, v) values (1, 'from-A')`);
			await b.exec(`insert into T (id, v) values (1, 'from-B')`);
			// OR REPLACE stages unguarded: displacing whatever occupies the key is exactly
			// what the statement declared, concurrently or not.
			await a.exec('commit');
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
				expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('from-A');
			}
		} finally {
			await handles.dispose();
		}
	});

	it('a key the winner deleted is legitimately reusable by the other handle', async () => {
		const uri = 'tree://race/delete-reinsert';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			await a.exec(`insert into T (id, v) values (1, 'original')`);
			await a.exec(`delete from T where id = 1`);
			// The guard checks the adopted committed state, not key history — the re-insert
			// must not be refused. (The stale-view replay variant of this shape is pinned
			// deterministically at the db-core level in tree-guard.spec.ts.)
			await b.exec(`insert into T (id, v) values (1, 'reborn')`);
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
				expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('reborn');
			}
		} finally {
			await handles.dispose();
		}
	});

	it('SESSION mode, two-table transaction: one colliding insert fails the WHOLE transaction with the UNIQUE message', async () => {
		const uriT = 'tree://race/session-t';
		const uriU = 'tree://race/session-u';
		const { db: a, plugin: pluginA } = createDb(dir);
		const { db: b, plugin: pluginB } = createDb(dir);
		let disposeEngine: (() => void) | undefined;
		try {
			await a.exec(`create table T (id integer primary key, v text) using optimystic('${uriT}')`);
			await a.exec(`create table U (id integer primary key, v text) using optimystic('${uriU}')`);
			await b.exec(`create table T (id integer primary key, v text) using optimystic('${uriT}')`);

			// Wire handle A for session (coordinator/consensus) mode over the same storage;
			// handle B stays legacy — the rival's mode is irrelevant to the refusal.
			const transactor = await pluginA.collectionFactory.getOrCreateTransactor({
				collectionUri: 'tree://unused', transactor: 'local', keyNetwork: 'test',
				libp2pOptions: {}, cache: false, encoding: 'json',
				rawStorageFactory: () => new FileRawStorage(dir),
			});
			const coordinator = new TransactionCoordinator(transactor, pluginA.txnBridge.getCollectionRegistry());
			const engine = new QuereusEngine(a, coordinator);
			await engine.getSchemaHash();
			pluginA.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
			disposeEngine = () => engine.dispose();

			// A stages a two-table transaction; the rival then takes T's key; A's commit must
			// fail ATOMICALLY — the clean U insert must not land either.
			await a.exec('begin');
			await a.exec(`insert into T (id, v) values (1, 'from-A')`);
			await a.exec(`insert into U (id, v) values (1, 'clean')`);
			await b.exec(`insert into T (id, v) values (1, 'from-B')`);

			const message = await captureThrowMessage(() => a.exec('commit'));
			expect(message, 'the session-mode refusal carries the mapped UNIQUE message').to.match(UNIQUE_T_ID);

			expect(await selectCount(a, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(a, 'select v from T where id = 1'), 'the rival\'s row survives').to.equal('from-B');
			expect(await selectCount(a, 'select count(*) as c from U'), 'the sibling table\'s insert did not land').to.equal(0);
			expect(await selectCount(b, 'select count(*) as c from T')).to.equal(1);
		} finally {
			disposeEngine?.();
			a.close();
			b.close();
			await pluginA.dispose();
			await pluginB.dispose();
		}
	});
});
