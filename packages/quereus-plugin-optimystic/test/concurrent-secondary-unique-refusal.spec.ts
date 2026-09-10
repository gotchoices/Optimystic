/**
 * Concurrent same-VALUE refusal on a secondary UNIQUE column
 * (ticket `concurrent-secondary-unique-guard`, follow-up to
 * `concurrent-insert-guard-refuses-taken-key`).
 *
 * The primary-key guard refuses two concurrent inserts of the SAME key. This suite
 * covers the sibling hole: two inserts with DIFFERENT primary keys but the SAME value
 * in a UNIQUE column. Both writers' pre-stage probes read their own snapshot and find
 * the value clear, so both used to commit — leaving two rows a UNIQUE constraint says
 * cannot coexist. The exact-key guard cannot catch it: the two rows key the index tree
 * as `value ‖ pkA` and `value ‖ pkB`, DIFFERENT tree keys inside one value prefix.
 * A range guard (`absentRange`, TreeRangeTakenError) claims the whole value prefix, so
 * the losing writer's index-tree replay refuses it, and the bridge maps that to the
 * ordinary `UNIQUE constraint failed: T.v` message naming the CONSTRAINT's column, not
 * the PK.
 *
 * Two `Database` handles over ONE `FileRawStorage` directory, one `tree://` URI — the
 * same cheap one-node repro shape the PK suite uses. Legacy and session (coordinator)
 * commit modes both covered: an index-tree refusal must fail the whole transaction
 * exactly as a main-tree one does.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { TransactionCoordinator } from '@optimystic/db-core';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
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

// The constraint's COLUMN is named, not the PK — that is the whole point of mapping the
// index-tree refusal through the constraint's own message.
const UNIQUE_T_V = /UNIQUE constraint failed: T\.v/;

describe('Concurrent same-VALUE refusal on a secondary UNIQUE column (two handles, one dir)', function () {
	this.timeout(30000);

	let dir: string;
	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-concurrent-unique', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** Two handles over one dir, both declaring `T(id pk, v unique)` over `uri`. */
	async function twoHandles(uri: string): Promise<{
		a: Database; b: Database; pluginA: Plugin; pluginB: Plugin; dispose: () => Promise<void>;
	}> {
		const { db: a, plugin: pluginA } = createDb(dir);
		const { db: b, plugin: pluginB } = createDb(dir);
		const ddl = `create table T (id integer primary key, v text not null unique) using optimystic('${uri}')`;
		await a.exec(ddl);
		await b.exec(ddl);
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

	it('DETERMINISTIC replay (legacy): a staged insert whose unique VALUE a rival then commits under a DIFFERENT pk is refused', async () => {
		const uri = 'tree://uniq-race/staged-then-rival';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			// A stages id=1 v='x' (probe sees the value clear), THEN the rival commits id=2 v='x'
			// — different PK, SAME unique value — THEN A commits. The refusal can only come from
			// the index tree's commit-time conflict replay, never from A's own pre-stage probe.
			await a.exec('begin');
			await a.exec(`insert into T (id, v) values (1, 'x')`);
			await b.exec(`insert into T (id, v) values (2, 'x')`);

			const message = await captureThrowMessage(() => a.exec('commit'));
			expect(message, 'the loser is refused naming the UNIQUE COLUMN, not the PK').to.match(UNIQUE_T_V);

			// The rival's row is the durable one on both handles; A rolled back entirely.
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
				expect(await selectScalar(db, `select id from T where v = 'x'`)).to.equal(2);
			}
		} finally {
			await handles.dispose();
		}
	});

	for (const clause of ['or ignore', 'or replace'] as const) {
		it(`DETERMINISTIC replay (legacy): insert ${clause} is REFUSED, not silently admitted, when a rival takes the value first`, async () => {
			// Neither disposition can be honoured inside an index tree's replay — the rival's
			// row lives in the MAIN collection, which the replay can neither skip around
			// (IGNORE) nor evict (REPLACE) — so the guard refuses rather than letting two rows
			// share the value. Before this was guarded, both rows silently committed.
			const uri = `tree://uniq-race/${clause.replace(' ', '-')}`;
			const handles = await twoHandles(uri);
			const { a, b } = handles;
			try {
				await a.exec('begin');
				await a.exec(`insert ${clause} into T (id, v) values (1, 'x')`);
				await b.exec(`insert into T (id, v) values (2, 'x')`);

				const message = await captureThrowMessage(() => a.exec('commit'));
				expect(message, `an insert ${clause} loser is refused naming T.v`).to.match(UNIQUE_T_V);
				for (const db of [a, b]) {
					expect(await selectCount(db, 'select count(*) as c from T'), 'exactly one row holds the value').to.equal(1);
					expect(await selectScalar(db, `select id from T where v = 'x'`)).to.equal(2);
				}

				// The sequential disposition is untouched: a retry sees the rival's row and
				// honours it — IGNORE swallows, REPLACE evicts the rival.
				await a.exec(`insert ${clause} into T (id, v) values (1, 'x')`);
				expect(await selectCount(a, 'select count(*) as c from T')).to.equal(1);
				expect(await selectScalar(a, `select id from T where v = 'x'`)).to.equal(clause === 'or ignore' ? 2 : 1);
			} finally {
				await handles.dispose();
			}
		});
	}

	it('racing: same value, different pk, same tick — exactly one fulfils, the loser is refused naming the UNIQUE column', async () => {
		const uri = 'tree://uniq-race/same-value';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			const results = await Promise.allSettled([
				a.exec(`insert into T (id, v) values (1, 'x')`),
				b.exec(`insert into T (id, v) values (2, 'x')`),
			]);
			const fulfilled = results.filter(r => r.status === 'fulfilled');
			const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
			const outcomes = results
				.map(r => (r.status === 'fulfilled' ? 'fulfilled' : `rejected: ${String((r as PromiseRejectedResult).reason)}`))
				.join(' | ');
			expect(fulfilled.length, `exactly one writer wins (${outcomes})`).to.equal(1);
			const message = rejected[0]!.reason instanceof Error ? rejected[0]!.reason.message : String(rejected[0]!.reason);
			// The refusal names the UNIQUE COLUMN. In a true race the rival can commit
			// AFTER the loser's legacy pre-flight refresh but before its index-tree flush;
			// LEGACY commit is not durably atomic across trees, so that surfaces as a loud
			// PartialCommitError (`not atomic`) whose underlying failure is the mapped UNIQUE
			// message — never a silent double-commit. (The pre-flight makes the
			// rival-already-committed shape clean; the DETERMINISTIC test above pins that. The
			// residual race window is owned by backlog `feat-optimystic-legacy-commit-two-phase`.)
			expect(message, `the loser is refused naming T.v (${outcomes})`).to.match(UNIQUE_T_V);

			// The enforced invariant that holds regardless of a torn base row: the winner's
			// value is durably present in the UNIQUE index, so a fresh insert of it is refused
			// on BOTH handles. This is the guarantee the constraint exists to make.
			for (const db of [a, b]) {
				const dup = await captureThrowMessage(() => db.exec(`insert into T (id, v) values (9, 'x')`));
				expect(dup, 'the value stays enforced-present after the race').to.match(UNIQUE_T_V);
			}
		} finally {
			await handles.dispose();
		}
	});

	it('different unique values, same tick: both fulfil and both rows survive (no false refusal)', async () => {
		const uri = 'tree://uniq-race/two-values';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			const results = await Promise.allSettled([
				a.exec(`insert into T (id, v) values (1, 'x')`),
				b.exec(`insert into T (id, v) values (2, 'y')`),
			]);
			expect(results.map(r => r.status), 'disjoint unique values never refuse').to.deep.equal(['fulfilled', 'fulfilled']);
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(2);
			}
		} finally {
			await handles.dispose();
		}
	});

	it('a unique value the winner DELETED is legitimately reusable under a different pk', async () => {
		const uri = 'tree://uniq-race/delete-reinsert';
		const handles = await twoHandles(uri);
		const { a, b } = handles;
		try {
			await a.exec(`insert into T (id, v) values (1, 'x')`);
			await a.exec(`delete from T where id = 1`);
			// The guard reads the adopted committed state, not value history: the prefix is empty
			// after the delete, so the re-insert under a new pk must NOT be refused.
			await b.exec(`insert into T (id, v) values (2, 'x')`);
			for (const db of [a, b]) {
				expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
				expect(await selectScalar(db, `select id from T where v = 'x'`)).to.equal(2);
			}
		} finally {
			await handles.dispose();
		}
	});

	it('SESSION mode, two-table transaction: a concurrent same-VALUE rival fails the WHOLE transaction with the UNIQUE-column message', async () => {
		const uriT = 'tree://uniq-race/session-t';
		const uriU = 'tree://uniq-race/session-u';
		const { db: a, plugin: pluginA } = createDb(dir);
		const { db: b, plugin: pluginB } = createDb(dir);
		let disposeEngine: (() => void) | undefined;
		try {
			await a.exec(`create table T (id integer primary key, v text not null unique) using optimystic('${uriT}')`);
			await a.exec(`create table U (id integer primary key, v text) using optimystic('${uriU}')`);
			await b.exec(`create table T (id integer primary key, v text not null unique) using optimystic('${uriT}')`);

			// Wire handle A for session (coordinator) mode; handle B stays legacy (its mode is
			// irrelevant to the refusal).
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

			// A stages a two-table transaction; the rival then takes T's unique value under a
			// different pk; A's commit must fail ATOMICALLY — the clean U insert must not land.
			await a.exec('begin');
			await a.exec(`insert into T (id, v) values (1, 'x')`);
			await a.exec(`insert into U (id, v) values (1, 'clean')`);
			await b.exec(`insert into T (id, v) values (2, 'x')`);

			const message = await captureThrowMessage(() => a.exec('commit'));
			expect(message, 'the session-mode refusal carries the mapped UNIQUE-column message').to.match(UNIQUE_T_V);

			expect(await selectCount(a, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(a, `select id from T where v = 'x'`), 'the rival\'s row survives').to.equal(2);
			expect(await selectCount(a, 'select count(*) as c from U'), 'the sibling table insert did not land').to.equal(0);
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
