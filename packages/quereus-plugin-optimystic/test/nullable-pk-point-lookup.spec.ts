/**
 * Regression test for a NULL seek arg reaching the primary-key point lookup.
 *
 * Since Quereus 4.14 (`feat-relax-declared-primary-key-not-null`), PRIMARY KEY no
 * longer implies NOT NULL, so `x integer null primary key` accepts a NULL-keyed row.
 * Key equality is NULL-self-equal — that row is a real identity and a second all-NULL
 * key is a duplicate — but SQL comparison stays three-valued, so `where x = <NULL>`
 * must match nothing.
 *
 * The engine folds only a *literal* `= null` to an empty result at plan time; a
 * dynamic value (parameter, correlated binding) is left to a per-module runtime
 * guard. `getBestAccessPlan` reports the PK equality filters as handled, so the
 * `_primary_` seek carries no residual FILTER — before the guard in
 * `executePointLookup`, `where x = :p` with `:p` bound to NULL returned the
 * NULL-keyed row.
 *
 * Pinned upstream by quereus `test/logic/43.3-nullable-primary-key.sqllogic`.
 *
 * Runs against the `local` transactor backed by `FileRawStorage` so it exercises the
 * real seek path with no mocking.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

function createDb(dir: string): Database {
	const db = new Database();
	const config = {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => new FileRawStorage(dir),
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return db;
}

async function selectRows(
	db: Database,
	sql: string,
	params?: Record<string, SqlValue>,
): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of (params ? db.eval(sql, params) : db.eval(sql))) {
		rows.push(row as Record<string, SqlValue>);
	}
	return rows;
}

describe('nullable primary key: NULL never satisfies a point-lookup equality', function () {
	this.timeout(15000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-nullable-pk-lookup', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('stores a NULL-keyed row and reaches it only through IS NULL', async () => {
		const db = createDb(dir);
		try {
			await db.exec(
				`create table NullKey (x integer null primary key, val text null)
					using optimystic('tree://test/nullkey')`,
			);
			await db.exec(`insert into NullKey values (null, 'first')`);
			await db.exec(`insert into NullKey values (1, 'one'), (2, 'two')`);

			// The NULL-keyed row is stored and scannable.
			expect(await selectRows(db, 'select x, val from NullKey order by x')).to.deep.equal([
				{ x: null, val: 'first' },
				{ x: 1, val: 'one' },
				{ x: 2, val: 'two' },
			]);

			// `is null` is the only predicate that reaches it.
			expect(await selectRows(db, `select val from NullKey where x is null`)).to.deep.equal([
				{ val: 'first' },
			]);

			// Literal `= null` — folded to an empty result by the planner.
			expect(await selectRows(db, `select val from NullKey where x = null`)).to.deep.equal([]);

			// Dynamic `= :p` bound to NULL — the module's own guard. Pre-fix this
			// returned [{ val: 'first' }] because the seek key encodes NULL and the
			// PK plan carries no residual FILTER.
			expect(
				await selectRows(db, `select val from NullKey where x = :p`, { p: null }),
			).to.deep.equal([]);

			// Non-NULL point lookups are unaffected.
			expect(
				await selectRows(db, `select val from NullKey where x = :p`, { p: 1 }),
			).to.deep.equal([{ val: 'one' }]);
		} finally {
			db.close();
		}
	});

	it('drops a composite-PK seek whose key has a NULL component', async () => {
		const db = createDb(dir);
		try {
			await db.exec(
				`create table NullPart (a text null, b text null, note text null,
					primary key (a, b))
					using optimystic('tree://test/nullpart')`,
			);
			await db.exec(`insert into NullPart values ('A', null, 'a-null'), ('A', 'B', 'a-b')`);

			expect(
				await selectRows(db, `select note from NullPart where a = 'A' and b = :p`, { p: null }),
			).to.deep.equal([]);

			// The row itself is still reachable, and the all-non-NULL seek still works.
			expect(
				await selectRows(db, `select note from NullPart where a = 'A' and b is null`),
			).to.deep.equal([{ note: 'a-null' }]);
			expect(
				await selectRows(db, `select note from NullPart where a = 'A' and b = 'B'`),
			).to.deep.equal([{ note: 'a-b' }]);
		} finally {
			db.close();
		}
	});
});
