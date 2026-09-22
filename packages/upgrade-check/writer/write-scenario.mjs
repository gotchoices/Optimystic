/**
 * Writes the upgrade-check scenario with whichever `@optimystic/*` build `node_modules` resolves.
 *
 * `scripts/write-fixture.mjs` copies this file into a scratch directory holding a PUBLISHED build
 * and runs it there, so every bare import below is that published build, never the working tree.
 * It is plain JavaScript for the same reason: nothing in the scratch directory can compile
 * TypeScript. Keep it to API every fixture version has — the oldest is 1.0.0-beta.3.
 *
 *   node write-scenario.mjs <fs|leveldb> <data directory> <manifest path>
 *
 * What it leaves behind, and why each piece is there, is the table in `readme.md`. In short: one
 * solo node over the named storage backend; a SQL table with a unique column and a declared index,
 * enough rows to split its B-tree, and an update and a delete over them; a diary long enough that
 * its log spans two chain blocks; and one more diary append whose pend landed and whose commit never
 * did — the node is stopped with that write in flight. The manifest records what a reader must find.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { Database } from '@quereus/quereus';
import register from '@optimystic/quereus-plugin-optimystic/plugin';
import { Diary, NetworkTransactor } from '@optimystic/db-core';
import { createLibp2pNode, RepoClient } from '@optimystic/db-p2p';
import { FileKVStore, FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { LevelDBKVStore, LevelDBRawStorage } from '@optimystic/db-p2p-storage-rn';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { openClassicLevel } from './classic-level.mjs';

const NETWORK_NAME = 'upgrade-check';
const TABLE = 'users';
const DIARY_ID = 'upgrade-check/diary';
/** Recorded in the manifest: a reader re-runs it where a documented upgrade step says to re-declare. */
const TABLE_DDL = [
	`create table ${TABLE} (id integer primary key, email text unique, name text) using optimystic('tree://upgrade-check/${TABLE}')`,
	`create index ${TABLE}_name on ${TABLE} (name)`,
];
/** Above `NodeCapacity` (64) in `db-core/src/btree/btree.ts`, so the table's tree has a branch node. */
const INITIAL_ROWS = 80;
/** Above `EntriesPerBlock` (32) in `db-core/src/chain/chain.ts`, so the diary's log spans two blocks. */
const DIARY_ENTRIES = 35;

/**
 * The storage a deployment runs on, opened under the data directory. `layout` goes into the manifest
 * and is how the reader finds the same files; `close` releases what the node does not own.
 */
const BACKENDS = {
	// The filesystem backend `reference-peer` runs on.
	fs: async dir => {
		const layout = { backend: 'fs', blocks: 'blocks', kv: 'kv' };
		mkdirSync(join(dir, layout.blocks), { recursive: true });
		mkdirSync(join(dir, layout.kv), { recursive: true });
		return {
			layout,
			storage: () => new FileRawStorage(join(dir, layout.blocks)),
			kvStore: new FileKVStore(join(dir, layout.kv)),
			close: async () => { },
		};
	},
	// The LevelDB backend a React Native app runs on: one database for blocks and key-value records.
	leveldb: async dir => {
		const layout = { backend: 'leveldb', path: 'leveldb' };
		const db = await openClassicLevel(join(dir, layout.path));
		return {
			layout,
			storage: () => new LevelDBRawStorage(db),
			kvStore: new LevelDBKVStore(db),
			close: () => db.close(),
		};
	},
};

const [backendName, dataDir, manifestPath] = process.argv.slice(2);
const openBackend = BACKENDS[backendName];
if (!openBackend || !dataDir || !manifestPath) {
	console.error(`usage: node write-scenario.mjs <${Object.keys(BACKENDS).join('|')}> <data directory> <manifest path>`);
	process.exit(2);
}

const backend = await openBackend(dataDir);
const privateKey = await generateKeyPair('Ed25519');
const node = await startNode(backend, privateKey);
const transactor = nodeTransactor(node);

const { db, plugin } = openDatabase(node, transactor);
await writeTable(db);
const rows = await readRows(db);
db.close();
await plugin.dispose?.();

const diary = await Diary.createOrOpen(transactor, DIARY_ID);
for (let n = 1; n <= DIARY_ENTRIES; n++) {
	await diary.append(diaryEntry(n));
}
const entries = await readDiary(diary);

const inFlightEntry = diaryEntry(DIARY_ENTRIES + 1);
const inFlightCommit = await pendWithoutCommitting(transactor, inFlightEntry);
await node.stop();
await backend.close();

writeFileSync(manifestPath, JSON.stringify({
	networkName: NETWORK_NAME,
	peerKey: Buffer.from(privateKeyToProtobuf(privateKey)).toString('base64'),
	storage: backend.layout,
	table: { name: TABLE, ddl: TABLE_DDL, rows },
	diary: { id: DIARY_ID, entries, inFlight: { entry: inFlightEntry, commit: inFlightCommit } },
}, null, '\t') + '\n');
console.log(`wrote ${rows.length} rows, ${entries.length} diary entries and one in-flight append`);
// A pend whose commit never returns leaves a promise nothing will settle; exit rather than wait.
process.exit(0);

async function startNode({ storage, kvStore }, key) {
	return await createLibp2pNode({
		port: 0,
		networkName: NETWORK_NAME,
		bootstrapNodes: [],
		fretProfile: 'edge',
		clusterSize: 1,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		arachnode: { enableRingZulu: true },
		storage,
		// Builds before 1.0.0 have no `kvStore` option and ignore it.
		kvStore,
		privateKey: key,
	});
}

function nodeTransactor(node) {
	const protocolPrefix = `/optimystic/${NETWORK_NAME}`;
	return new NetworkTransactor({
		timeoutMs: 30_000,
		abortOrCancelTimeoutMs: 5_000,
		keyNetwork: node.keyNetwork,
		getRepo: peerId => peerId.toString() === node.peerId.toString()
			? node.coordinatedRepo
			: RepoClient.create(peerId, node.keyNetwork, protocolPrefix),
		localPeerId: node.peerId,
	});
}

function openDatabase(node, transactor) {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'network',
		default_key_network: 'libp2p',
		default_network_name: NETWORK_NAME,
	});
	plugin.collectionFactory.registerLibp2pNode(NETWORK_NAME, node, node.coordinatedRepo);
	plugin.collectionFactory.registerTransactor('network:libp2p', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

async function writeTable(db) {
	for (const statement of TABLE_DDL) {
		await db.exec(statement);
	}
	const values = [];
	for (let id = 1; id <= INITIAL_ROWS; id++) {
		values.push(`(${id}, 'user${id}@example.org', 'name${id % 7}')`);
	}
	await db.exec(`insert into ${TABLE} (id, email, name) values ${values.join(', ')}`);
	await db.exec(`insert into ${TABLE} (id, email, name) values (${INITIAL_ROWS + 1}, 'late@example.org', 'late')`);
	// Moves a value in the unique index and one in the declared index, then removes a row from both.
	await db.exec(`update ${TABLE} set email = 'moved@example.org' where id = 1`);
	await db.exec(`update ${TABLE} set name = 'renamed' where id = 2`);
	await db.exec(`delete from ${TABLE} where id = 3`);
}

/** `writeTable` inserts `INITIAL_ROWS` plus one and deletes one, so `INITIAL_ROWS` remain. */
async function readRows(db) {
	const rows = [];
	for await (const row of db.eval(`select id, email, name from ${TABLE} order by id`)) {
		rows.push({ id: Number(row.id), email: row.email, name: row.name });
	}
	if (rows.length !== INITIAL_ROWS) {
		throw new Error(`the writer read back ${rows.length} rows, expected ${INITIAL_ROWS}`);
	}
	return rows;
}

function diaryEntry(n) {
	return { n, text: `entry ${n}` };
}

async function readDiary(diary) {
	const entries = [];
	for await (const entry of diary.select()) {
		entries.push(entry);
	}
	if (entries.length !== DIARY_ENTRIES) {
		throw new Error(`the writer read back ${entries.length} diary entries, expected ${DIARY_ENTRIES}`);
	}
	return entries;
}

/**
 * Append `entry` through a transactor that forwards the pend and never sends the commit, and resolve
 * with the commit request once it is built — the shape a node is left in when it is stopped between
 * a write's two rounds. The append's own promise is abandoned; nothing will ever settle it.
 */
async function pendWithoutCommitting(transactor, entry) {
	let deliverCommit;
	const commitBuilt = new Promise(resolve => { deliverCommit = resolve; });
	const stalled = {
		get: blockGets => transactor.get(blockGets),
		getStatus: refs => transactor.getStatus(refs),
		pend: request => transactor.pend(request),
		commit: request => {
			deliverCommit(request);
			return new Promise(() => { });
		},
		cancel: ref => transactor.cancel(ref),
	};
	const diary = await Diary.open(stalled, DIARY_ID);
	if (!diary) {
		throw new Error(`diary ${DIARY_ID} did not open for the in-flight append`);
	}
	void diary.append(entry);
	return await commitBuilt;
}
