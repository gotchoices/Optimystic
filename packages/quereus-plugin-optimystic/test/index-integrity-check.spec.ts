/**
 * `verifyIndexes`, the two-way index-versus-table check, against discrepancies made on purpose.
 *
 * Every discrepancy here is synthetic. The real producers of missing and orphaned index entries
 * are defects due to be fixed (ticket refuse-concurrent-row-change-loser covers the concurrent
 * ones), and a check's self-test must not depend on a bug surviving. So each case breaks one
 * IndexManager staging method for one statement (`withIndexStagingPatched`), which leaves exactly
 * the entry that method would have written or removed, or stages a malformed entry into the
 * index tree directly.
 *
 * Single-node and in-memory (`default_transactor: 'test'`): the check reads one node's trees.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { encodeKeyTuple, uniqueEnforcementTreeName } from '../dist/index.js';
import type { IndexIntegrityReport } from '../dist/index.js';
import { liveIndexManager, stageNothing, withIndexStagingPatched } from './index-staging-patch.js';

type Plugin = ReturnType<typeof register>;

/** The fields these assertions name an orphan by: why it is there, its decoded value and key. */
function orphans(report: IndexIntegrityReport) {
	return report.orphaned.map(orphan => ({
		reason: orphan.reason,
		value: orphan.indexPayloads,
		pk: orphan.primaryKeyPayloads,
	}));
}

function missing(report: IndexIntegrityReport) {
	return report.missing.map(entry => ({
		value: entry.indexPayloads,
		pk: entry.primaryKeyPayloads,
		row: entry.row,
	}));
}

function expectClean(reports: IndexIntegrityReport[]): void {
	for (const report of reports) {
		expect(report.missing, `${report.index}: no missing entries`).to.deep.equal([]);
		expect(report.orphaned, `${report.index}: no orphaned entries`).to.deep.equal([]);
	}
}

/** Run `body` and return the error it threw, failing if it resolved instead. */
async function captureFailure(body: () => Promise<unknown>, why: string): Promise<Error> {
	let caught: Error | undefined;
	try {
		await body();
	} catch (error) {
		caught = error as Error;
	}
	expect(caught, why).to.not.equal(undefined);
	return caught!;
}

/** The serialized index payload of a number (see serializeIndexValue). */
const numberPayload = (value: number): string => value.toExponential(15);

describe('verifyIndexes (two-way index-versus-table check)', () => {
	let db: Database;
	let plugin: Plugin;

	beforeEach(() => {
		db = new Database();
		plugin = register(db, {
			default_transactor: 'test',
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

	/** Usage: rows 1 and 2 share tok-a, so an orphan under it has a live sibling entry beside
	 *  it; row 4's token is NULL. */
	async function createUsage(): Promise<void> {
		await db.exec(`create table Usage (Id integer primary key, Token text null, Note text) using optimystic('tree://integrity/Usage')`);
		await db.exec(`create index usage_by_token on Usage(Token)`);
		await db.exec(`insert into Usage (Id, Token, Note) values (1, 'tok-a', 'first')`);
		await db.exec(`insert into Usage (Id, Token, Note) values (2, 'tok-a', 'second')`);
		await db.exec(`insert into Usage (Id, Token, Note) values (3, 'tok-b', 'third')`);
		await db.exec(`insert into Usage (Id, Token, Note) values (4, null, 'fourth')`);
	}

	async function usageReport(): Promise<IndexIntegrityReport> {
		const reports = await plugin.verifyIndexes(db, 'Usage');
		expect(reports.map(report => report.index)).to.deep.equal(['usage_by_token']);
		return reports[0]!;
	}

	async function createAccount(): Promise<void> {
		// `unique` with no declared index: the table synthesizes a tree to enforce it.
		await db.exec(`create table Account (Id integer primary key, Email text null unique) using optimystic('tree://integrity/Account')`);
	}

	it('reports a clean table with shared values, a NULL and a numeric column as clean', async () => {
		await db.exec(`create table Item (Id integer primary key, Token text null, Score integer null) using optimystic('tree://integrity/Item')`);
		await db.exec(`create index item_by_token on Item(Token)`);
		await db.exec(`create index item_by_score on Item(Score)`);
		await db.exec(`insert into Item (Id, Token, Score) values (1, 'tok-a', 5)`);
		await db.exec(`insert into Item (Id, Token, Score) values (2, 'tok-a', 5)`);
		await db.exec(`insert into Item (Id, Token, Score) values (3, null, null)`);
		// Bound as a BigInt: the insert keys its entry off the raw 7n, while the check keys off the
		// decoded row's 7. serializeIndexValue must make those one key.
		await db.exec(`insert into Item (Id, Token, Score) values (?, ?, ?)`, [4, 'tok-b', 7n]);

		const reports = await plugin.verifyIndexes(db, 'Item');
		expect(reports.map(report => [report.index, report.kind])).to.have.deep.members([
			['item_by_token', 'declared'],
			['item_by_score', 'declared'],
		]);
		expectClean(reports);
		for (const report of reports) {
			expect(report.table.toLowerCase()).to.equal('item');
			expect([report.rowCount, report.entryCount], `${report.index}: one entry per row`).to.deep.equal([4, 4]);
		}
	});

	it('reports a row whose index entry was never staged as missing', async () => {
		await createUsage();
		await withIndexStagingPatched(plugin, 'Usage', 'insertIndexEntries', stageNothing, () =>
			db.exec(`insert into Usage (Id, Token, Note) values (5, 'tok-c', 'fifth')`));

		const report = await usageReport();
		expect(missing(report)).to.deep.equal([{ value: ['tok-c'], pk: ['5'], row: [5, 'tok-c', 'fifth'] }]);
		expect(report.orphaned).to.deep.equal([]);
		expect([report.rowCount, report.entryCount]).to.deep.equal([5, 4]);
	});

	it('reports an entry left behind by a delete as a no-row orphan, without disturbing its sibling', async () => {
		await createUsage();
		await withIndexStagingPatched(plugin, 'Usage', 'deleteIndexEntries', stageNothing, () =>
			db.exec(`delete from Usage where Id = 1`));

		const report = await usageReport();
		// Row 2's tok-a entry shares the orphan's value prefix and is neither reported nor masks it.
		expect(orphans(report)).to.deep.equal([{ reason: 'no-row', value: ['tok-a'], pk: ['1'] }]);
		expect(report.missing).to.deep.equal([]);
		expect([report.rowCount, report.entryCount]).to.deep.equal([3, 4]);
	});

	it('reports an update that moved the value without its entry as a stale-value orphan plus a missing entry', async () => {
		await createUsage();
		await withIndexStagingPatched(plugin, 'Usage', 'updateIndexEntries', stageNothing, () =>
			db.exec(`update Usage set Token = 'tok-z' where Id = 3`));

		const report = await usageReport();
		expect(orphans(report)).to.deep.equal([{ reason: 'stale-value', value: ['tok-b'], pk: ['3'] }]);
		expect(report.orphaned[0]!.currentRow).to.deep.equal([3, 'tok-z', 'third']);
		expect(missing(report)).to.deep.equal([{ value: ['tok-z'], pk: ['3'], row: [3, 'tok-z', 'third'] }]);
	});

	it('reports every entry of a table emptied by deletes, including the NULL value\'s', async () => {
		await createUsage();
		await withIndexStagingPatched(plugin, 'Usage', 'deleteIndexEntries', stageNothing, () =>
			db.exec(`delete from Usage`));

		const report = await usageReport();
		expect([report.rowCount, report.entryCount]).to.deep.equal([0, 4]);
		// Ascending tree-key order: the NULL tag sorts before any present value.
		expect(orphans(report)).to.deep.equal([
			{ reason: 'no-row', value: [null], pk: ['4'] },
			{ reason: 'no-row', value: ['tok-a'], pk: ['1'] },
			{ reason: 'no-row', value: ['tok-a'], pk: ['2'] },
			{ reason: 'no-row', value: ['tok-b'], pk: ['3'] },
		]);
		expect(report.missing).to.deep.equal([]);
	});

	it('splits a composite index over a composite primary key at the index\'s width', async () => {
		await db.exec(`create table Pair (A text, B integer, C text, D integer null, primary key (A, B)) using optimystic('tree://integrity/Pair')`);
		await db.exec(`create index pair_by_cd on Pair(C, D)`);
		await db.exec(`insert into Pair (A, B, C, D) values ('a', 1, 'c', 10)`);
		await db.exec(`insert into Pair (A, B, C, D) values ('a', 2, 'c', 10)`);
		await db.exec(`insert into Pair (A, B, C, D) values ('b', 1, 'x', null)`);
		expectClean(await plugin.verifyIndexes(db, 'Pair'));

		await withIndexStagingPatched(plugin, 'Pair', 'deleteIndexEntries', stageNothing, () =>
			db.exec(`delete from Pair where A = 'a' and B = 2`));

		const [report] = await plugin.verifyIndexes(db, 'Pair');
		expect(orphans(report!)).to.deep.equal([
			{ reason: 'no-row', value: ['c', numberPayload(10)], pk: ['a', '2'] },
		]);
		expect(report!.missing).to.deep.equal([]);
	});

	it('checks the tree enforcing a unique column with no declared index like any other', async () => {
		await createAccount();
		await db.exec(`insert into Account (Id, Email) values (1, 'a@example.com')`);
		await db.exec(`insert into Account (Id, Email) values (2, 'b@example.com')`);
		await db.exec(`insert into Account (Id, Email) values (3, null)`);

		const clean = await plugin.verifyIndexes(db, 'Account');
		expect(clean.map(report => [report.index, report.kind])).to.deep.equal([
			[uniqueEnforcementTreeName(['Email']), 'unique-enforcement'],
		]);
		expectClean(clean);

		await withIndexStagingPatched(plugin, 'Account', 'deleteIndexEntries', stageNothing, () =>
			db.exec(`delete from Account where Id = 2`));

		const [report] = await plugin.verifyIndexes(db, 'Account');
		expect(orphans(report!)).to.deep.equal([{ reason: 'no-row', value: ['b@example.com'], pk: ['2'] }]);
		expect(report!.missing).to.deep.equal([]);
	});

	it('treats a NULL-bearing row\'s entry in a unique-enforcement tree as optional, and only that', async () => {
		await createAccount();
		await db.exec(`insert into Account (Id, Email) values (1, 'a@example.com')`);
		await withIndexStagingPatched(plugin, 'Account', 'insertIndexEntries', stageNothing, async () => {
			// Exempt from the constraint: the tree's populate for an older build's rows stages
			// nothing for this row, so a tree without its entry is correct...
			await db.exec(`insert into Account (Id, Email) values (2, null)`);
			// ...but a present value's entry is still required.
			await db.exec(`insert into Account (Id, Email) values (3, 'c@example.com')`);
		});

		const [report] = await plugin.verifyIndexes(db, 'Account');
		expect([report!.rowCount, report!.entryCount]).to.deep.equal([3, 1]);
		expect(missing(report!)).to.deep.equal([{ value: ['c@example.com'], pk: ['3'], row: [3, 'c@example.com'] }]);
		expect(report!.orphaned).to.deep.equal([]);
	});

	/** Write one entry straight into `index`'s tree. No write path produces a malformed entry. */
	async function stageRawEntry(table: string, index: string, treeKey: string, storedPrimaryKey: string): Promise<void> {
		const tree = liveIndexManager(plugin, table).getIndexTree(index);
		expect(tree, `the ${index} tree`).to.not.equal(undefined);
		await tree!.stage([[treeKey, [treeKey, storedPrimaryKey]]]);
		await tree!.sync();
	}

	it('reports an entry whose stored primary key is not the one its tree key encodes as malformed', async () => {
		await createUsage();
		// It sits at tok-q‖1 but resolves to row 2.
		const treeKey = encodeKeyTuple(['tok-q']) + encodeKeyTuple(['1']);
		const storedPrimaryKey = encodeKeyTuple(['2']);
		await stageRawEntry('Usage', 'usage_by_token', treeKey, storedPrimaryKey);

		const report = await usageReport();
		expect(orphans(report)).to.deep.equal([{ reason: 'malformed', value: ['tok-q'], pk: ['1'] }]);
		expect(report.orphaned[0]!.primaryKey).to.equal(storedPrimaryKey);
		expect(report.missing).to.deep.equal([]);
	});

	it('reports a malformed entry at a row\'s own tree key once, as malformed and not also missing', async () => {
		await createUsage();
		// Overwrite row 3's entry in place: still at tok-b‖3, now resolving to row 1.
		const treeKey = encodeKeyTuple(['tok-b']) + encodeKeyTuple(['3']);
		await stageRawEntry('Usage', 'usage_by_token', treeKey, encodeKeyTuple(['1']));

		const report = await usageReport();
		expect(orphans(report)).to.deep.equal([{ reason: 'malformed', value: ['tok-b'], pk: ['3'] }]);
		expect(report.missing).to.deep.equal([]);
		expect([report.rowCount, report.entryCount]).to.deep.equal([4, 4]);
	});

	it('reports no indexes for a table with none, and an index over an empty table as clean', async () => {
		await db.exec(`create table Bare (Id integer primary key, Token text null) using optimystic('tree://integrity/Bare')`);
		expect(await plugin.verifyIndexes(db, 'Bare')).to.deep.equal([]);

		// Its tree has never been written, so the scan finds nothing and must not throw. The table
		// name resolves case-insensitively, as it does in SQL.
		await db.exec(`create index bare_by_token on Bare(Token)`);
		const reports = await plugin.verifyIndexes(db, 'bare');
		expect(reports.map(report => report.index)).to.deep.equal(['bare_by_token']);
		expectClean(reports);
		expect([reports[0]!.rowCount, reports[0]!.entryCount]).to.deep.equal([0, 0]);
	});

	it('includes an open transaction\'s staged writes, and is clean before and after a rollback', async () => {
		await createUsage();
		await db.exec('begin');
		await db.exec(`insert into Usage (Id, Token, Note) values (5, 'tok-c', 'staged')`);
		const staged = await usageReport();
		expectClean([staged]);
		expect([staged.rowCount, staged.entryCount]).to.deep.equal([5, 5]);

		await db.exec('rollback');
		const rolledBack = await usageReport();
		expectClean([rolledBack]);
		expect([rolledBack.rowCount, rolledBack.entryCount]).to.deep.equal([4, 4]);
	});

	it('throws for a table it does not know, rather than reporting nothing', async () => {
		const error = await captureFailure(
			() => plugin.verifyIndexes(db, 'Nowhere'),
			'an unknown table must not read as a table with no discrepancies',
		);
		expect(error.message).to.contain(`'Nowhere' not found`);
	});

	it('throws for a table another module owns', async () => {
		await db.exec(`create table Scratch (Id integer primary key, Token text) using memory`);
		const error = await captureFailure(
			() => plugin.verifyIndexes(db, 'Scratch'),
			'a memory table must not be adopted as an Optimystic one',
		);
		expect(error.message).to.contain('not an Optimystic table');
	});
});
