import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import type { Libp2p } from 'libp2p';
import type { PrivateKey } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import {
	createLibp2pNode,
	Libp2pKeyPeerNetwork,
	MemoryRawStorage,
	RepoClient,
} from '@optimystic/db-p2p';
import {
	NetworkTransactor,
	type IRepo,
	type ITransactor,
	type PeerId as DbPeerId,
} from '@optimystic/db-core';
import register from '../dist/plugin.js';

// Plugin-layer first-launch smoke test over real libp2p (Phase 5 of ticket-7).
// Exercises the intersection that the fast suites and ticket-4's integration lane
// leave uncovered: plain `CREATE TABLE ... USING optimystic(...)` + `INSERT` + cold
// restart + `SELECT` against a real `NetworkTransactor` wired to a real libp2p node.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 so default `npm test` stays fast. Run via:
//   OPTIMYSTIC_INTEGRATION=1 npm test --workspace @optimystic/quereus-plugin-optimystic
// Windows (PowerShell):
//   $env:OPTIMYSTIC_INTEGRATION=1; npm test --workspace @optimystic/quereus-plugin-optimystic

const NETWORK_NAME = 'plugin-first-launch-canary';
const COLLECTION_URI = 'tree://canary-smoke/canary';

type Row = Record<string, SqlValue>;

async function collectRows(iter: AsyncIterable<Row>): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
}

interface NodeWiring {
	node: Libp2p;
	transactor: ITransactor;
}

async function spawnNode(
	trackedNodes: Libp2p[],
	overrides: { storage?: MemoryRawStorage; privateKey?: PrivateKey } = {}
): Promise<NodeWiring> {
	const node = await createLibp2pNode({
		port: 0,
		networkName: NETWORK_NAME,
		bootstrapNodes: [],
		fretProfile: 'edge',
		clusterSize: 1,
		clusterPolicy: {
			allowDownsize: true,
			sizeTolerance: 1.0,
		},
		arachnode: { enableRingZulu: true },
		...overrides,
	});
	trackedNodes.push(node);

	const coordinatedRepo = (node as any).coordinatedRepo as IRepo;
	if (!coordinatedRepo) throw new Error('coordinatedRepo not created by createLibp2pNode');

	const keyNetwork = new Libp2pKeyPeerNetwork(node);
	const protocolPrefix = `/optimystic/${NETWORK_NAME}`;

	const getRepo = (peerId: DbPeerId): IRepo => {
		if ((peerId as any).toString() === node.peerId.toString()) return coordinatedRepo;
		return RepoClient.create(peerId as any, keyNetwork, protocolPrefix);
	};

	const transactor = new NetworkTransactor({
		timeoutMs: 10_000,
		abortOrCancelTimeoutMs: 5_000,
		keyNetwork: keyNetwork as any,
		getRepo,
	});

	return { node, transactor };
}

function registerPluginAgainst(db: Database, transactor: ITransactor) {
	// Leave `default_transactor` unset so it defaults to 'network'; we inject the
	// real NetworkTransactor under that cache key before any DDL runs.
	const plugin = register(db, {
		default_key_network: 'libp2p',
		enable_cache: false,
	});
	plugin.collectionFactory.registerTransactor('network:libp2p', transactor);

	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return plugin;
}

describe('Plugin first-launch over real libp2p', function () {
	// Real libp2p boot + arachnode/ring-zulu init dominates the budget; individual
	// DDL/INSERT/SELECT operations are sub-second.
	this.timeout(30_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let nodes: Libp2p[] = [];

	afterEach(async () => {
		const toStop = nodes;
		nodes = [];
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('happy path: CREATE TABLE, INSERT, SELECT round-trip', async function () {
		this.timeout(15_000);
		const { transactor } = await spawnNode(nodes);
		const db = new Database();
		registerPluginAgainst(db, transactor);

		await db.exec(`
			CREATE TABLE canary (
				id INTEGER PRIMARY KEY,
				value TEXT NOT NULL
			) USING optimystic('${COLLECTION_URI}')
		`);
		await db.exec(`INSERT INTO canary (id, value) VALUES (1, 'first')`);

		const rows = await collectRows(db.eval('SELECT value FROM canary WHERE id = 1'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]!.value).to.equal('first');
	});

	it('cold-restart over shared storage preserves rows', async function () {
		this.timeout(25_000);
		const storage = new MemoryRawStorage();
		const privateKey = await generateKeyPair('Ed25519');

		// Session 1: boot node A, create table + insert row, stop node A.
		const { node: nodeA, transactor: transactorA } = await spawnNode(nodes, {
			storage,
			privateKey,
		});
		const dbA = new Database();
		registerPluginAgainst(dbA, transactorA);

		await dbA.exec(`
			CREATE TABLE canary (
				id INTEGER PRIMARY KEY,
				value TEXT NOT NULL
			) USING optimystic('${COLLECTION_URI}')
		`);
		await dbA.exec(`INSERT INTO canary (id, value) VALUES (1, 'first')`);

		await nodeA.stop();
		nodes = nodes.filter(n => n !== nodeA);

		// Session 2: boot node B over the SAME storage + identity, fresh Database.
		const { transactor: transactorB } = await spawnNode(nodes, {
			storage,
			privateKey,
		});
		const dbB = new Database();
		registerPluginAgainst(dbB, transactorB);

		// Re-declare the virtual table against the restarted node. The plugin loads
		// the persisted schema from the schema tree rather than storing a new one.
		await dbB.exec(`
			CREATE TABLE canary (
				id INTEGER PRIMARY KEY,
				value TEXT NOT NULL
			) USING optimystic('${COLLECTION_URI}')
		`);

		const rows = await collectRows(dbB.eval('SELECT value FROM canary WHERE id = 1'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]!.value).to.equal('first');
	});

	it('two sequential DDLs in one session', async function () {
		this.timeout(20_000);
		const { transactor } = await spawnNode(nodes);
		const db = new Database();
		registerPluginAgainst(db, transactor);

		await db.exec(`
			CREATE TABLE canary_a (
				id INTEGER PRIMARY KEY,
				value TEXT NOT NULL
			) USING optimystic('tree://canary-smoke/canary_a')
		`);
		await db.exec(`INSERT INTO canary_a (id, value) VALUES (1, 'a1')`);

		await db.exec(`
			CREATE TABLE canary_b (
				id INTEGER PRIMARY KEY,
				value TEXT NOT NULL
			) USING optimystic('tree://canary-smoke/canary_b')
		`);
		await db.exec(`INSERT INTO canary_b (id, value) VALUES (2, 'b1')`);

		const rowsA = await collectRows(db.eval('SELECT value FROM canary_a WHERE id = 1'));
		const rowsB = await collectRows(db.eval('SELECT value FROM canary_b WHERE id = 2'));
		expect(rowsA[0]!.value).to.equal('a1');
		expect(rowsB[0]!.value).to.equal('b1');
	});
});
