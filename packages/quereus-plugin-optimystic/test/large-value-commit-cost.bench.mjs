// The cost of committing large values, at the plugin layer, in the shape of GitHub issue #63: a
// two-node in-process mock mesh (memory storage), node 0 writing transactions of N rows of VALUE_KB
// random bytes each into `BlobChunk (Hash text primary key, Bytes blob not null)`, the bytes bound as
// parameters. Prints, per transaction, the time spent staging (`begin` and the inserts) and committing,
// their medians and maxima, milliseconds per MB of raw value data, and the expansion factor: the bytes
// node 0's pends encode to (`jsonEncodedBytes` of every pend request its transactor sends) over the raw
// value bytes. Not a spec: it asserts nothing, and is run by hand after `yarn build`.
//
//   MODE=legacy node test/large-value-commit-cost.bench.mjs
//
// MODE: legacy (each tree synced on its own, the default) or session (a TransactionCoordinator commits,
// wired as two-node-write-request-count.spec.ts wires it). N: values per transaction (8). VALUE_KB: size
// of each value in KiB (256). REPS: measured transactions (20), after one unmeasured warm-up transaction.
//
// To see where the time goes, profile one run from the repository root and open the .cpuprofile in a
// profiler (Chrome DevTools' Performance panel, or speedscope), then delete the directory:
//
//   node --cpu-prof --cpu-prof-dir=tickets/.logs/large-value-commit packages/quereus-plugin-optimystic/test/large-value-commit-cost.bench.mjs
import { randomBytes } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { TransactionCoordinator, jsonEncodedBytes } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors } from '@optimystic/db-p2p/testing';
import { QuereusEngine } from '../dist/index.js';
import register from '../dist/plugin.js';

const MODE = process.env.MODE ?? 'legacy';
const N = Number(process.env.N ?? 8);
const VALUE_KB = Number(process.env.VALUE_KB ?? 256);
const REPS = Number(process.env.REPS ?? 20);
if (MODE !== 'legacy' && MODE !== 'session') throw new Error(`MODE must be legacy or session, not ${MODE}`);

const MB = 1024 * 1024;
const valueBytes = VALUE_KB * 1024;
const rawBytesPerTxn = N * valueBytes;

/** Node 0's transactor, with the encoded size of every pend it sends added to `pended`. A batched
 * `pendMany` that answers `undefined` sent nothing: its caller falls back to one `pend` per collection. */
let pended = 0;
function measured(transactor) {
	const pend = transactor.pend.bind(transactor);
	transactor.pend = async request => {
		pended += jsonEncodedBytes(request);
		return pend(request);
	};
	if (transactor.pendMany) {
		const pendMany = transactor.pendMany.bind(transactor);
		transactor.pendMany = async requests => {
			const result = await pendMany(requests);
			if (result !== undefined) pended += requests.reduce((sum, request) => sum + jsonEncodedBytes(request), 0);
			return result;
		};
	}
	return transactor;
}

/** A `Database` over node 0's transactor, as `mesh-node-harness.ts` builds one for a two-node mesh, holding
 * the `BlobChunk` table. Session mode is wired after the table exists, since the engine's schema hash has to
 * be warmed outside any statement. */
async function writerNode() {
	const mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2, superMajorityThreshold: 0.67 });
	const transactor = buildNetworkTransactors(mesh).get(mesh.nodes[0].peerId.toString());
	measured(transactor);
	const db = new Database();
	const plugin = register(db, { default_transactor: 'shared', default_key_network: 'test', enable_cache: false });
	plugin.collectionFactory.registerTransactor('shared:test', transactor);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	await db.exec("create table BlobChunk (Hash text primary key, Bytes blob not null) using optimystic('tree://bench/blob-chunk')");
	if (MODE === 'session') {
		const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
		const engine = new QuereusEngine(db, coordinator);
		await engine.getSchemaHash();
		plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
	}
	return db;
}

/** The `TransactionTooLargeError` in `error`'s cause chain, if there is one. */
function tooLarge(error) {
	for (let cause = error; cause; cause = cause.cause) {
		if (cause.name === 'TransactionTooLargeError') return cause;
	}
	return undefined;
}

/** One transaction of `N` fresh values: how long staging and the commit took, and what its pends encoded
 * to. A transaction whose pend is over the size limit (a tree node division can copy rows already stored
 * into the pend beside the new ones) is reported refused, with the size it was refused at. */
async function oneTransaction(db) {
	const pendedBefore = pended;
	const start = performance.now();
	await db.exec('begin');
	for (let i = 0; i < N; i++) {
		await db.exec('insert into BlobChunk (Hash, Bytes) values (?, ?)', [randomBytes(16).toString('hex'), new Uint8Array(randomBytes(valueBytes))]);
	}
	const staged = performance.now();
	try {
		await db.exec('commit');
	} catch (error) {
		const refusal = tooLarge(error);
		if (!refusal) throw error;
		return { refusedBytes: refusal.bytes };
	}
	const committed = performance.now();
	return { stagingMs: staged - start, commitMs: committed - staged, pendBytes: pended - pendedBefore };
}

const median = values => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const db = await writerNode();
await oneTransaction(db);

const attempts = [];
for (let rep = 0; rep < REPS; rep++) attempts.push(await oneTransaction(db));
const runs = attempts.filter(run => run.refusedBytes === undefined);
const refused = attempts.filter(run => run.refusedBytes !== undefined);

const rawMB = rawBytesPerTxn / MB;
console.log(`${MODE}, ${N} values of ${VALUE_KB} KiB per transaction (${rawMB.toFixed(2)} MB), ${runs.length} of ${REPS} transactions committed`);
if (refused.length > 0) console.log(`  refused as too large at ${refused.map(run => (run.refusedBytes / MB).toFixed(2)).join(' ')} MB`);
if (runs.length > 0) {
	console.log(`  staging ms   ${runs.map(run => run.stagingMs.toFixed(0)).join(' ')}`);
	console.log(`  commit ms    ${runs.map(run => run.commitMs.toFixed(0)).join(' ')}`);
	for (const [label, pick] of [['staging', run => run.stagingMs], ['commit', run => run.commitMs], ['total', run => run.stagingMs + run.commitMs]]) {
		const values = runs.map(pick);
		const mid = median(values);
		console.log(`  ${label.padEnd(8)} median ${mid.toFixed(0)} ms, max ${Math.max(...values).toFixed(0)} ms, ${(mid / rawMB).toFixed(0)} ms per MB`);
	}
	console.log(`  expansion    ${(median(runs.map(run => run.pendBytes)) / rawBytesPerTxn).toFixed(2)}x (median pend bytes over raw value bytes)`);
}
process.exit(0);
