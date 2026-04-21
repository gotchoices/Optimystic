/**
 * Sanity checks for the `'mesh-test'` factory path in CollectionFactory.
 * Production wiring (StorageRepo → CoordinatorRepo → NetworkTransactor) on a
 * 1-node mock mesh — if DDL/DML hangs under this factory, fail fast.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
};

describe('mesh-test transactor factory path', function () {
	// Explicit short timeout: the mock mesh has no real I/O, so anything
	// approaching 5s means a hang in the Tree/Collection ↔ CoordinatorRepo
	// interaction and we want to fail visibly.
	this.timeout(5000);

	let db: Database;

	beforeEach(async () => {
		db = new Database();
		const plugin = register(db, {
			default_transactor: 'mesh-test',
			default_key_network: 'test',
			enable_cache: false,
		});
		for (const vtable of plugin.vtables) {
			db.registerModule(vtable.name, vtable.module, vtable.auxData);
		}
		for (const func of plugin.functions) {
			db.registerFunction(func.schema);
		}
	});

	it('CREATE TABLE + INSERT + SELECT round-trip through the mesh-test factory', async () => {
		await db.exec(`
			CREATE TABLE widgets (
				id INTEGER PRIMARY KEY,
				label TEXT NOT NULL
			) USING optimystic('tree://mesh-test/widgets')
		`);

		await db.exec(`INSERT INTO widgets (id, label) VALUES (1, 'alpha')`);
		await db.exec(`INSERT INTO widgets (id, label) VALUES (2, 'beta')`);

		const rows = await collectRows(db.eval('SELECT * FROM widgets ORDER BY id'));
		expect(rows).to.have.lengthOf(2);
		expect(rows[0]).to.deep.include({ id: 1, label: 'alpha' });
		expect(rows[1]).to.deep.include({ id: 2, label: 'beta' });
	});
});
