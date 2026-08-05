/**
 * Standing regression cover for the `readCommittedSnapshot` declaration, using the
 * engine-shipped conformance harness (`runCommittedReadConformance` +
 * `installCommitStall` from @quereus/quereus 4.8).
 *
 * KNOWN BLIND SPOT (upstream documents it too): `installCommitStall` parks at the
 * ENTRY of this plugin's registered `VirtualTableConnection.commit` — BEFORE the
 * publish window (the legacy tree-by-tree sweep, or the session coordinator's
 * fold) begins. A tear INSIDE the publish window is invisible here. The real
 * cover for that is committed-read-stall.spec.ts, whose gated transactor parks
 * mid-publish. Do not delete that spec in favour of this one.
 *
 * `observedCommitOverlap` is asserted TRUE and the test fails otherwise: a pass
 * without a provable overlap only checks that each read returned one whole state,
 * which is not the property this plugin declares.
 */
import { expect } from 'chai';
import {
	Database,
	installCommitStall,
	runCommittedReadConformance,
	settleMacrotasks,
} from '@quereus/quereus';
import type { CommittedReadConformanceResult } from '@quereus/quereus';
import { TransactionCoordinator } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { QuereusEngine } from '../dist/index.js';

type Plugin = ReturnType<typeof register>;

function createDb(): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, {
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
	return { db, plugin };
}

async function enableSessionMode(db: Database, plugin: Plugin): Promise<() => void> {
	const transactor = await plugin.collectionFactory.getOrCreateTransactor({
		collectionUri: 'tree://unused',
		transactor: 'test',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json',
	});
	const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
	const engine = new QuereusEngine(db, coordinator);
	await engine.getSchemaHash();
	plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
	return () => engine.dispose();
}

function assertConformant(result: CommittedReadConformanceResult): void {
	// A pass WITHOUT a provable overlap proves nothing about the stall guarantee.
	expect(result.observedCommitOverlap, 'writer must have been provably parked during the reads').to.equal(true);
	expect(result.fullScanRows, 'full scan returns exactly the seeded snapshot').to.be.greaterThan(0);
	if (result.indexDrivenSkippedReason !== undefined) {
		// Recorded, not hidden: the harness refuses to fake index coverage.
		// eslint-disable-next-line no-console
		console.log(`  (index-driven leg skipped: ${result.indexDrivenSkippedReason})`);
	} else {
		expect(result.indexDrivenRows, 'index-driven path agrees with the full scan').to.equal(result.fullScanRows);
	}
}

describe('runCommittedReadConformance (engine harness, commit stalled at connection entry)', function () {
	this.timeout(30_000);

	it('passes in LEGACY commit mode with a provable commit overlap', async () => {
		const { db } = createDb();
		try {
			// Install BEFORE the table exists: the stall wraps connections as they are
			// REGISTERED, and this plugin registers its writer connection during create.
			const stall = installCommitStall(db);
			await db.exec(`create table conf (id integer primary key, v text) using optimystic('tree://conf/legacy')`);
			const result = await runCommittedReadConformance({
				db,
				table: 'conf',
				keyColumn: 'id',
				valueColumn: 'v',
				stallCommit: () => stall.asStallCommit(),
			});
			assertConformant(result);
		} finally {
			db.close();
		}
	});

	it('passes in SESSION (coordinator) commit mode with a provable commit overlap', async () => {
		const { db, plugin } = createDb();
		let dispose: (() => void) | undefined;
		try {
			// Install BEFORE the table exists — see the legacy test above.
			const stall = installCommitStall(db);
			await db.exec(`create table conf (id integer primary key, v text) using optimystic('tree://conf/session')`);
			dispose = await enableSessionMode(db, plugin);
			const result = await runCommittedReadConformance({
				db,
				table: 'conf',
				keyColumn: 'id',
				valueColumn: 'v',
				stallCommit: () => stall.asStallCommit(),
			});
			assertConformant(result);
		} finally {
			dispose?.();
			db.close();
		}
	});
});

describe('Database.close() with a concurrent committed read in flight', function () {
	this.timeout(30_000);

	it('close() does not hang: the read either completes or aborts, and close resolves', async () => {
		const { db } = createDb();
		await db.exec(`create table closer (id integer primary key, v text) using optimystic('tree://conf/closer')`);
		const values: string[] = [];
		for (let id = 1; id <= 60; id++) values.push(`(${id}, 'v${id}')`);
		await db.exec(`insert into closer (id, v) values ${values.join(', ')}`);

		// Start a mutex-free committed read and pull ONE row, leaving the
		// ConcurrentReadScope live.
		const iter = db.eval('select id, v from closer', undefined, { readConcurrency: 'committed' })[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.done).to.equal(false);

		// Close while the scope is live. close() awaits the scope's teardown, and the
		// scope's abort signal reaches the scan at the next row boundary.
		const closing = db.close();
		let closed = false;
		void closing.then(() => { closed = true; });

		// Drain the iterator: rows until the abort lands (or clean completion — a
		// fast scan may finish before the signal is observed). Either way the
		// generator's finally must run scope.end() so close() can resolve.
		try {
			for (let r = await iter.next(); !r.done; r = await iter.next()) {
				// draining
			}
		} catch {
			// The abort arm: swallowed deliberately — see below.
		}

		await closing;
		expect(closed).to.equal(true);
		// Not asserted which arm ran (abort vs completed) — both are legal; what is
		// illegal is close() hanging, which the await above (under the suite timeout,
		// plus the bounded settle below) rules out.
		await settleMacrotasks(10);
	});
});
