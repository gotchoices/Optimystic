// The cost of one small transaction online and in offline mode, at the plugin layer, in the shape of
// GitHub issue #53: one row plus three child rows, one secondary index. Prints ms per transaction by
// batch of 25, with structuredClone's share. Not a spec: it asserts nothing, and is run by hand after
// `yarn build`, one mode per process so JIT warm-up does not favour the later modes.
//
//   MODE=online node test/offline-commit-cost.bench.mjs
//
// MODE: online; offline (back to back, the drain runs alongside); wait (each sent before the next);
// gated (the reachability gate stays closed, so nothing is sent and the queue only grows); drain (gated
// while N transactions queue, then the gate opens: the drain's own cost, with nothing else running).
// N: transactions (200). NODE=1: a real solo libp2p node behind a NetworkTransactor, as the report ran,
// instead of the in-process test transactor. JOURNAL=file: a FileKVStore journal instead of memory.
// FLUSH_MS: with the memory journal, each journal flush waits this long, standing in for a slower disk.
// STORAGE=file: with NODE=1, the node stores blocks in a FileRawStorage rather than in memory.
// Needs packages/db-p2p-storage-fs built as well, whichever options are used: it is imported up front.
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@quereus/quereus';
import { Collection, NetworkTransactor } from '@optimystic/db-core';
import { createLibp2pNode } from '@optimystic/db-p2p';
import { FileKVStore, FileRawStorage } from '../../db-p2p-storage-fs/dist/src/index.js';
import register from '../dist/plugin.js';

class MemoryKV {
	map = new Map();
	async get(key) { return this.map.get(key); }
	async set(key, value) { this.map.set(key, value); }
	async delete(key) { this.map.delete(key); }
	async list(prefix) { return [...this.map.keys()].filter(key => key.startsWith(prefix)); }
	async flush() { if (FLUSH_MS > 0) await new Promise(resolve => setTimeout(resolve, FLUSH_MS)); }
}

const MODE = process.env.MODE ?? 'offline';
const N = Number(process.env.N ?? 200);
const BATCH = 25;
const FLUSH_MS = Number(process.env.FLUSH_MS ?? 0);

const realClone = globalThis.structuredClone;
let clones = 0;
let cloneMs = 0;
globalThis.structuredClone = (value, options) => {
	clones++;
	const start = performance.now();
	const copy = realClone(value, options);
	cloneMs += performance.now() - start;
	return copy;
};

/** `transactor`, with the count and time of its reads added to `reads`. */
const reads = { n: 0, blocks: 0, ms: 0 };
function timed(transactor) {
	const inner = transactor.get.bind(transactor);
	transactor.get = async (blockGets) => {
		const start = performance.now();
		try { return await inner(blockGets); } finally {
			reads.n++;
			reads.blocks += blockGets.blockIds.length;
			reads.ms += performance.now() - start;
		}
	};
	return transactor;
}

async function soloNode() {
	const node = await createLibp2pNode({
		port: 0, networkName: 'bench', bootstrapNodes: [], fretProfile: 'edge', clusterSize: 1,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 }, arachnode: { enableRingZulu: true },
		...(process.env.STORAGE === 'file' ? { storage: () => new FileRawStorage(mkdtempSync(join(tmpdir(), 'oc-store-'))) } : {}),
	});
	const transactor = new NetworkTransactor({
		timeoutMs: 10_000, abortOrCancelTimeoutMs: 5_000, keyNetwork: node.keyNetwork, getRepo: () => node.coordinatedRepo,
	});
	return { node, transactor: timed(transactor) };
}

const useNode = process.env.NODE === '1';
const wiring = useNode ? await soloNode() : undefined;
const journal = process.env.JOURNAL === 'file' ? new FileKVStore(mkdtempSync(join(tmpdir(), 'oc-'))) : new MemoryKV();
const offlineConfig = MODE === 'online' ? {} : { offline: { journal, recheck: { baseMs: 20, maxMs: 100 } } };
const transactorKey = useNode ? 'network:libp2p' : 'test:test';

const db = new Database();
const plugin = register(db, {
	...(useNode ? { default_key_network: 'libp2p' } : { default_transactor: 'test', default_key_network: 'test' }),
	enable_cache: false,
	...offlineConfig,
});
if (wiring) plugin.collectionFactory.registerTransactor(transactorKey, wiring.transactor);
for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
for (const func of plugin.functions) db.registerFunction(func.schema);

await db.exec("create table entry (id text primary key, ts text, note text) using optimystic('tree://bench/entry')");
await db.exec('create index entry_ts on entry (ts)');
await db.exec("create table entry_item (entry_id text, item text, primary key (entry_id, item)) using optimystic('tree://bench/entry_item')");

let committed = 0;
let gateClosed = true;
let onCommitted = () => {};
if (MODE !== 'online') {
	plugin.offline.onStatus(status => { if (status.kind === 'committed') { committed++; onCommitted(); } });
	if (MODE === 'gated' || MODE === 'drain') plugin.collectionFactory.registerCohortReachability(transactorKey, { reachable: async () => !gateClosed });
	plugin.offline.enter();
}

const started = performance.now();
const batches = [];
let mark = { at: started, clones, cloneMs, reads: { ...reads } };
const closeBatch = i => {
	const now = performance.now();
	batches.push({
		ms: (now - mark.at) / BATCH,
		clones: (clones - mark.clones) / BATCH,
		cloneMs: (cloneMs - mark.cloneMs) / BATCH,
		depth: MODE === 'online' ? 0 : i - committed,
		reads: (reads.n - mark.reads.n) / BATCH,
		blocks: (reads.blocks - mark.reads.blocks) / BATCH,
		readMs: (reads.ms - mark.reads.ms) / BATCH,
	});
	mark = { at: now, clones, cloneMs, reads: { ...reads } };
};

for (let i = 0; i < N; i++) {
	if (i && i % BATCH === 0) closeBatch(i);
	const id = randomUUID();
	await db.exec('begin');
	await db.exec('insert into entry (id, ts, note) values (?, ?, ?)', [id, new Date(Date.now() + i).toISOString(), 'n']);
	for (const item of ['a', 'b', 'c']) await db.exec('insert into entry_item (entry_id, item) values (?, ?)', [id, item]);
	await db.exec('commit');
	if (MODE === 'wait' && committed < i + 1) await new Promise(resolve => { onCommitted = resolve; });
}
closeBatch(N);
const acknowledged = performance.now() - started;
if (MODE === 'drain') {
	// Replay's share of the drain, the private method wrapped: time inside it, summed over collections.
	const proto = Collection.prototype;
	const replay = proto.replayActions;
	let replayMs = 0;
	proto.replayActions = async function (...args) {
		const start = performance.now();
		try { return await replay.apply(this, args); } finally { replayMs += performance.now() - start; }
	};
	const cloneStart = clones;
	const drainStart = performance.now();
	gateClosed = false;
	plugin.offline.wake?.();
	while (committed < N) await new Promise(resolve => setTimeout(resolve, 5));
	const drainMs = performance.now() - drainStart;
	console.log(`  drain alone: ${(drainMs / N).toFixed(1)} ms/entry, ${(replayMs / N).toFixed(1)} ms/entry in replay, ${Math.round((clones - cloneStart) / N)} clones/entry`);
}
if (MODE === 'offline') while (committed < N) await new Promise(resolve => setTimeout(resolve, 5));
const sent = performance.now() - started;

const line = pick => batches.map(pick).join(' ');
console.log(`${MODE}${useNode ? ' node' : ''}${process.env.JOURNAL === 'file' ? ' file-journal' : ''}, N=${N}`);
console.log(`  ms/txn        ${line(b => b.ms.toFixed(1))}`);
console.log(`  clone ms/txn  ${line(b => b.cloneMs.toFixed(1))}`);
console.log(`  clones/txn    ${line(b => Math.round(b.clones))}`);
console.log(`  queue depth   ${line(b => b.depth)}`);
if (useNode) {
	console.log(`  reads/txn     ${line(b => b.reads.toFixed(1))}`);
	console.log(`  blocks read   ${line(b => b.blocks.toFixed(1))}`);
	console.log(`  read ms/txn   ${line(b => b.readMs.toFixed(1))}`);
}
console.log(`  commits returned ${(acknowledged / N).toFixed(1)} ms each; all sent ${(sent / N).toFixed(1)} ms each`);
process.exit(0);
