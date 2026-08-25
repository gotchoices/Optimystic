/**
 * Self-test for `expectIndexAgreesWithScan` — the oracle every two-node index-convergence
 * spec closes on, including the 144-case interleaving sweep.
 *
 * Those specs are worth reading only if their oracle can go red, and a green run proves
 * nothing about that on its own. The sweep's negative control was a scratch file that was
 * run once and deleted, and it tripped only the ROUTING arm (`indexScans > 0`) — the
 * row-set comparison, which is the arm that would actually catch "the index missed a
 * committed row", was never shown to fail at all. This pins both arms permanently, so a
 * later refactor of the helper cannot quietly turn every caller into a no-op.
 *
 * Single-node and in-memory (`default_transactor: 'test'`) — the helper under test knows
 * nothing about meshes, so exercising it does not need one.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { OptimysticVirtualTable } from '../dist/index.js';
import { expectIndexAgreesWithScan } from './query-helpers.js';

type Plugin = ReturnType<typeof register>;

/**
 * Run `body` and return the error it threw, failing if it resolved instead. Named for what
 * it asserts, because `try { await x(); expect.fail() } catch {}` swallows the `expect.fail`.
 */
async function captureFailure(body: () => Promise<void>, why: string): Promise<Error> {
	let caught: Error | undefined;
	try {
		await body();
	} catch (error) {
		caught = error as Error;
	}
	expect(caught, why).to.not.equal(undefined);
	return caught!;
}

/**
 * Make every index-routed seek yield one fewer entry than the tree holds, simulating an
 * index that does not account for every committed row — the defect class the oracle exists
 * to catch. Returns the undo, which must run even on failure or it leaks onto every later
 * spec sharing this prototype.
 */
function dropOneEntryPerIndexScan(): () => void {
	const proto = OptimysticVirtualTable.prototype as any;
	const original = proto.executeIndexScan;
	proto.executeIndexScan = async function* (this: any, ...args: any[]) {
		let first = true;
		for await (const row of original.apply(this, args)) {
			if (first) { first = false; continue; }
			yield row;
		}
	};
	return () => { proto.executeIndexScan = original; };
}

describe('expectIndexAgreesWithScan (the two-node convergence oracle)', () => {
	let db: Database;
	let plugin: Plugin;

	beforeEach(async () => {
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
		await db.exec(`
			create table Usage (Id integer primary key, Token text, Note text)
			using optimystic('tree://oracle-self-test/Usage')
		`);
		await db.exec(`create index usage_by_token on Usage(Token)`);
		// Two rows share a token so a dropped entry changes a row SET rather than emptying it —
		// an oracle that only noticed empty results would still pass the under-reporting case.
		await db.exec(`insert into Usage (Id, Token, Note) values (1, 'tok-a', 'first')`);
		await db.exec(`insert into Usage (Id, Token, Note) values (2, 'tok-a', 'second')`);
		await db.exec(`insert into Usage (Id, Token, Note) values (3, 'tok-b', 'third')`);
	});

	afterEach(() => db.close());

	it('passes on a table whose index accounts for every row', async () => {
		await expectIndexAgreesWithScan(db, 'Usage', 'Token');
	});

	it('fails when an index-routed seek under-reports a value the scan still holds', async () => {
		const undo = dropOneEntryPerIndexScan();
		try {
			const error = await captureFailure(
				() => expectIndexAgreesWithScan(db, 'Usage', 'Token'),
				'an index missing a committed row must not pass the oracle',
			);
			expect(error.message, 'and must fail on the row-set comparison, not the routing probe')
				.to.contain('the index-routed row set must equal');
		} finally {
			undo();
		}
	});

	it('fails when the predicate falls back to a full scan instead of routing into an index', async () => {
		// `Note` carries no declared index, so the equality predicate cannot be pushed into a
		// seek. The row sets still agree, so only the routing arm can catch this.
		const error = await captureFailure(
			() => expectIndexAgreesWithScan(db, 'Usage', 'Note'),
			'a full-scan fallback must not satisfy the oracle vacuously',
		);
		expect(error.message, 'and must name the routing requirement')
			.to.contain('must be answered through a secondary index seek');
	});

	it('reports a column that does not exist rather than passing on an empty group set', async () => {
		const error = await captureFailure(
			() => expectIndexAgreesWithScan(db, 'Usage', 'Missing'),
			'a typo in the column name must not read as agreement',
		);
		expect(error.message).to.contain(`has no column 'Missing'`);
	});
});
