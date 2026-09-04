/**
 * Repro harness for GH issue #8 / the on-device follow-up: cold `APPLY SCHEMA` through the
 * COORDINATED commit path (solo libp2p node, cohort-of-1) â€” the path cadre-core 0.12 exposed
 * when it dropped `StrandConfig.mode: 'bootstrap'`.
 *
 * Counts at two seams:
 *   - RawStoreDriver (BELOW the read cache) â€” what actually hits the backend. On RN each of
 *     these is a native bridge round-trip.
 *   - ITransactor.commit/pend/get â€” how many coordinated commits one apply issues.
 *
 *   node test/repro-issue8.mjs                  # 9 tables + 13 indexes (the device schema)
 *   TABLES=54 INDEXES=13 CAP_MS=300000 node test/repro-issue8.mjs
 *   TRANSACTOR=local node test/repro-issue8.mjs # A/B against the local transactor
 */
import { Database } from '@quereus/quereus';
import { createLibp2pNode, KvRawStorage, MemoryStoreDriver, RepoClient, defaultCachePool } from '@optimystic/db-p2p';
import { NetworkTransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';

const TABLES = Number(process.env.TABLES ?? 9);
const INDEXES = Number(process.env.INDEXES ?? 13);
const CAP_MS = Number(process.env.CAP_MS ?? 120_000);
const MODE = process.env.TRANSACTOR ?? 'network';
// Emulates a slow backend: RN's LevelDB goes over the native bridge, and the emulator's
// virtual disk makes each call cost milliseconds rather than microseconds.
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);
// Squeeze the transactor's own deadline to test the "slow storage trips the timeout, the
// timeout retries, the retry is slow" hypothesis for the device's non-terminating apply.
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10_000);
// Node defaults to a 32 MB shared read-cache budget; React Native gets 8 MB
// (platformDefaultBytes). Squeeze it to see what a device-sized budget does to this workload.
const CACHE_BYTES = Number(process.env.CACHE_BYTES ?? 0);
const NETWORK_NAME = 'issue8-repro';

const READ_METHODS = ['getMetadata', 'getRevision', 'rangeRevisions', 'getPending', 'listPendingActionIds', 'getTransaction', 'getMaterialized', 'getProof'];
const WRITE_METHODS = ['putMetadata', 'putRevision', 'putPending', 'deletePending', 'putTransaction', 'putProof', 'putMaterialized', 'deleteMaterialized', 'promote'];

function counting(inner) {
	const counts = {};
	const driver = new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			return (...args) => {
				counts[String(prop)] = (counts[String(prop)] ?? 0) + 1;
				const result = value.apply(target, args);
				if (LATENCY_MS <= 0) return result;
				// rangeRevisions/listPendingActionIds return async iterables, not promises.
				if (result && typeof result.then === 'function') {
					return new Promise((resolve) => setTimeout(resolve, LATENCY_MS)).then(() => result);
				}
				return result;
			};
		},
	});
	return { driver, counts };
}

function countingTransactor(inner, counts) {
	return new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			return (...args) => {
				counts[String(prop)] = (counts[String(prop)] ?? 0) + 1;
				return value.apply(target, args);
			};
		},
	});
}

/** Count AND time each call - the key-network seam is where a real device pays DHT/timeout cost. */
function countingTimed(inner, counts, ms) {
	return new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			return (...args) => {
				const name = String(prop);
				counts[name] = (counts[name] ?? 0) + 1;
				const t0 = performance.now();
				const result = value.apply(target, args);
				if (result && typeof result.then === 'function') {
					return result.finally(() => { ms[name] = (ms[name] ?? 0) + (performance.now() - t0); });
				}
				ms[name] = (ms[name] ?? 0) + (performance.now() - t0);
				return result;
			};
		},
	});
}

const sum = (counts, keys) => keys.reduce((s, k) => s + (counts[k] ?? 0), 0);

function buildSchema(tables, indexes) {
	const parts = [];
	for (let i = 0; i < tables; i++) {
		parts.push(`\n  table T${i} (\n    Id text,\n    Name text,\n    Amount integer,\n    primary key (Id)\n  );`);
	}
	for (let i = 0; i < indexes; i++) {
		parts.push(`\n  index T${i % tables}ByName${i} on T${i % tables} (Name);`);
	}
	return parts.join('');
}

async function main() {
	if (CACHE_BYTES > 0) defaultCachePool().setBudget({ maxBytes: CACHE_BYTES });
	const { driver, counts } = counting(new MemoryStoreDriver());
	const txCounts = {};
	const knCounts = {};
	const knMs = {};
	let node;

	if (MODE === 'network') {
		node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: true },
			// KvRawStorage over a non-memory driver == "host-supplied persistent storage",
			// so the node attaches its read cache - the same wrap RN's LevelDBRawStorage gets.
			storage: () => new KvRawStorage(driver),
		});
	}

	const db = new Database();
	const pluginConfig =
		MODE === 'network'
			? { default_key_network: 'libp2p', enable_cache: false }
			: { default_transactor: 'local', default_key_network: 'test', enable_cache: false, rawStorageFactory: () => new KvRawStorage(driver) };
	const p = register(db, pluginConfig);

	if (MODE === 'network') {
		const keyNetwork = countingTimed(node.keyNetwork, knCounts, knMs);
		const coordinatedRepo = node.coordinatedRepo;
		const protocolPrefix = `/optimystic/${NETWORK_NAME}`;
		const getRepo = (peerId) =>
			peerId.toString() === node.peerId.toString()
				? coordinatedRepo
				: RepoClient.create(peerId, keyNetwork, protocolPrefix);
		const real = new NetworkTransactor({ timeoutMs: TIMEOUT_MS, abortOrCancelTimeoutMs: Math.max(1, TIMEOUT_MS / 2), keyNetwork, getRepo });
		p.collectionFactory.registerTransactor('network:libp2p', countingTransactor(real, txCounts));
	}

	for (const vtable of p.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of p.functions) db.registerFunction(func.schema);

	const objects = TABLES + INDEXES;
	const sql = `declare schema main {${buildSchema(TABLES, INDEXES)}\n}\napply schema main;`;
	console.log(`transactor=${MODE} tables=${TABLES} indexes=${INDEXES} objects=${objects} cap=${CAP_MS}ms`);

	await db.exec("PRAGMA default_vtab_module='optimystic'");

	const started = Date.now();
	let last = { reads: 0, writes: 0, commits: 0, t: started };
	const ticker = setInterval(() => {
		const now = Date.now();
		const reads = sum(counts, READ_METHODS);
		const writes = sum(counts, WRITE_METHODS);
		const commits = txCounts.commit ?? 0;
		const dt = (now - last.t) / 1000;
		console.log(
			`  t=${((now - started) / 1000).toFixed(1)}s reads=${reads} (+${((reads - last.reads) / dt).toFixed(0)}/s) ` +
			`writes=${writes} (+${((writes - last.writes) / dt).toFixed(0)}/s) commits=${commits} (+${((commits - last.commits) / dt).toFixed(1)}/s)`
		);
		last = { reads, writes, commits, t: now };
	}, 2000);

	let timedOut = false;
	const cap = new Promise((_, reject) =>
		setTimeout(() => { timedOut = true; reject(new Error(`CAP: apply did not complete in ${CAP_MS}ms`)); }, CAP_MS).unref()
	);

	let error;
	try {
		await Promise.race([(async () => { for await (const _ of db.eval(sql)) { /* drain */ } })(), cap]);
	} catch (e) {
		error = e;
	}
	clearInterval(ticker);
	const elapsed = Date.now() - started;

	const reads = sum(counts, READ_METHODS);
	const writes = sum(counts, WRITE_METHODS);
	console.log(`\n=== ${timedOut ? 'DID NOT COMPLETE' : error ? 'ERROR' : 'completed'} in ${(elapsed / 1000).toFixed(2)}s ===`);
	if (error && !timedOut) console.log(`error: ${error.message}`);
	console.log(`driver calls: ${reads + writes} (reads ${reads}, writes ${writes}) = ${((reads + writes) / objects).toFixed(1)}/object`);
	for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`);
	if (MODE === 'network') {
		console.log(`transactor calls:`);
		for (const [k, v] of Object.entries(txCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`);
		console.log(`  commits/object: ${((txCounts.commit ?? 0) / objects).toFixed(1)}`);
		console.log(`key-network calls:`);
		for (const [k, v] of Object.entries(knCounts).sort((a, b) => b[1] - a[1])) {
			console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}  ${(knMs[k] ?? 0).toFixed(1)}ms total  ${((knMs[k] ?? 0) / v).toFixed(2)}ms/call`);
		}
	}

	try {
		const stats = defaultCachePool().stats?.();
		if (stats) console.log(`cache pool: ${JSON.stringify(stats)}`);
	} catch { /* ignore */ }

	try { await db.close?.(); } catch { /* ignore */ }
	try { await node?.stop(); } catch { /* ignore */ }
	process.exit(timedOut ? 2 : error ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
