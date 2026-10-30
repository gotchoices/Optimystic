/**
 * A partial index (`create index … where …`) holds entries only for the rows its predicate admits
 * — SQL TRUE; FALSE and NULL both exclude — through live writes and the backfill a `CREATE INDEX`
 * runs over existing rows, and the planner never seeks one, since a seek would miss matching rows
 * outside the predicate. What the tree holds is read through `verifyIndexes`, so the maintenance
 * cases assert on the tree, not on query results.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import register from '../dist/plugin.js';
import type { IndexIntegrityReport } from '../dist/index.js';
import { queryAll, readIndexIntegrity } from './query-helpers.js';

describe('partial index maintenance', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		const plugin = register(db, {
			default_transactor: 'local',
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

	afterEach(() => db.close());

	async function createTable(): Promise<void> {
		await db.exec(`create table T (Id integer primary key, C text null, Flag integer null) using optimystic('tree://partial/T')`);
	}

	async function createFlaggedIndex(): Promise<void> {
		await db.exec(`create index ByFlagged on T (C) where Flag = 1`);
	}

	/** The report for `ByFlagged`, required clean: no missing and no orphaned entry. */
	async function flaggedReport(): Promise<IndexIntegrityReport> {
		const report = (await readIndexIntegrity(db, 'T')).find(candidate => candidate.index === 'ByFlagged');
		expect(report, 'ByFlagged is maintained').to.not.equal(undefined);
		expect(report!.missing, 'no admitted row lacks its entry').to.deep.equal([]);
		expect(report!.orphaned, 'no entry belongs to a row outside the predicate, or to no row').to.deep.equal([]);
		return report!;
	}

	it('stages an entry only for the rows the predicate admits, through insert, update and delete', async () => {
		await createTable();
		await createFlaggedIndex();
		// Row 2's predicate is FALSE and row 4's is NULL; both stay out. Row 3 is in despite its NULL value.
		await db.exec(`insert into T (Id, C, Flag) values (1, 'a', 1), (2, 'b', 0), (3, null, 1), (4, 'd', null)`);
		expect((await flaggedReport()).entryCount, 'rows 1 and 3').to.equal(2);

		await db.exec(`update T set Flag = 0 where Id = 1`);
		await db.exec(`update T set Flag = 1 where Id = 2`);
		await db.exec(`update T set C = 'e' where Id = 4`);
		expect((await flaggedReport()).entryCount, 'rows 2 and 3: row 1 moved out, row 2 in, row 4 stayed out').to.equal(2);

		await db.exec(`delete from T where Id = 2`);
		expect((await flaggedReport()).entryCount, 'row 3').to.equal(1);
	});

	it('backfills only the rows the predicate admits', async () => {
		await createTable();
		await db.exec(`insert into T (Id, C, Flag) values (1, 'a', 1), (2, 'b', 0), (3, 'c', 1), (4, 'd', null)`);
		await createFlaggedIndex();
		expect((await flaggedReport()).entryCount, 'rows 1 and 3').to.equal(2);
	});

	it('answers an equality on the indexed column with rows outside the predicate too', async () => {
		await createTable();
		await createFlaggedIndex();
		await db.exec(`insert into T (Id, C, Flag) values (1, 'a', 1), (2, 'b', 0)`);
		expect(await queryAll(db, `select Id from T where C = 'b'`)).to.deep.equal([{ Id: 2 }]);
	});
});
