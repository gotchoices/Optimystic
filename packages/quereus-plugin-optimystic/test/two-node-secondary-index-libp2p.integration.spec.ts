/**
 * Two-node secondary-index convergence over REAL libp2p — the plugin-layer shape the
 * mock-mesh specs cannot express.
 *
 * `two-node-secondary-index-convergence.spec.ts` runs the same SQL over the in-process
 * mock mesh and passes; the production report it exists for
 * (`fix/1-two-node-index-divergence-guard-never-fires`, and sereus's
 * `secondary-index-seek-blind-to-sibling-rows`) is still red on real transports. This
 * file is the in-repo instrument for that gap: two real libp2p nodes, each driving its
 * own Quereus Database over its own NetworkTransactor, against a table carrying a
 * secondary index.
 *
 * Cluster configuration deliberately mirrors sereus's control network rather than the
 * mock-mesh specs' `clusterSize: 2`: a replication factor much larger than the machine
 * count, with `clusterPolicy.assumedClusterSize: 2` declared so the read-repair
 * corroboration floor still relaxes (see db-p2p `cluster/cluster-policy.ts`).
 *
 * Gated on OPTIMYSTIC_INTEGRATION=1:
 *   yarn workspace @optimystic/quereus-plugin-optimystic test:integration
 */
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import type { Libp2p } from 'libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, RepoClient } from '@optimystic/db-p2p';
import {
	NetworkTransactor,
	type IRepo,
	type ITransactor,
	type PeerId as DbPeerId,
} from '@optimystic/db-core';
import register from '../dist/plugin.js';

const NETWORK_NAME = 'two-node-index-it';
const TABLE_URI = 'tree://two-node-index/FormationUsage';

type Row = Record<string, SqlValue>;
type Plugin = ReturnType<typeof register>;

const createTableSql = `
	create table FormationUsage (
		Token text,
		UsageStampId text,
		PeerKey text,
		primary key (Token, UsageStampId)
	) using optimystic('${TABLE_URI}')
`;
const createIndexSql = `create index formation_usage_by_token on FormationUsage(Token)`;

function pickLocalTcpMultiaddr(node: Libp2p): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
		?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr; have: ${addrs.join(', ')}`);
	return local;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

function transactorFor(node: Libp2p): ITransactor {
	const keyNetwork = (node as any).keyNetwork;
	const coordinatedRepo = (node as any).coordinatedRepo as IRepo;
	const protocolPrefix = `/optimystic/${NETWORK_NAME}`;
	return new NetworkTransactor({
		timeoutMs: 30_000,
		abortOrCancelTimeoutMs: 10_000,
		dialTimeoutMs: 3_000,
		keyNetwork,
		getRepo: (peerId: DbPeerId): IRepo => peerId.toString() === node.peerId.toString()
			? coordinatedRepo
			: RepoClient.create(peerId as any, keyNetwork, protocolPrefix),
	});
}

function createDb(transactor: ITransactor): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, { default_key_network: 'libp2p', enable_cache: false });
	plugin.collectionFactory.registerTransactor('network:libp2p', transactor);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	return { db, plugin };
}

async function collect(db: Database, sql: string): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const row of db.eval(sql)) rows.push(row as Row);
	return rows;
}

describe('Two-node secondary-index convergence over real libp2p', function () {
	this.timeout(180_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let nodes: Libp2p[] = [];

	// Mirrors sereus's control network: replication factor >> machine count, with the
	// cohort size the deployment can actually field declared explicitly.
	const clusterPolicy = { allowDownsize: true, sizeTolerance: 0.5, assumedClusterSize: 2 };

	async function spawnNode(overrides: Record<string, unknown> = {}): Promise<Libp2p> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 16,
			clusterPolicy,
			arachnode: { enableRingZulu: true },
			...overrides,
		} as any);
		nodes.push(node);
		return node;
	}

	afterEach(async () => {
		const toStop = nodes;
		nodes = [];
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	async function stabilizedPair(): Promise<[Libp2p, Libp2p]> {
		const a = await spawnNode();
		const b = await spawnNode({ bootstrapNodes: [pickLocalTcpMultiaddr(a)], fretProfile: 'core' });
		const mesh = [a, b];
		for (let i = 0; i < mesh.length; i++) {
			for (let j = 0; j < mesh.length; j++) {
				if (i === j) continue;
				try { await mesh[i]!.dial(multiaddr(pickLocalTcpMultiaddr(mesh[j]!))); } catch { /* reciprocal dial covers this */ }
			}
		}
		await waitFor(() => mesh.every(n => n.getPeers().length >= 1), 30_000, 'the 2-node mesh to connect');
		await waitFor(async () => {
			for (const n of mesh) {
				const ids = Object.keys(await (n as any).keyNetwork.findCluster(new TextEncoder().encode('two-node-index-probe')));
				if (ids.length !== 2) return false;
			}
			return true;
		}, 40_000, 'both nodes to assemble the same 2-peer cohort');
		return [a, b];
	}

	it('sequential single writer: A inserts, B index-seeks it', async function () {
		const [a, b] = await stabilizedPair();
		const { db: dbA } = createDb(transactorFor(a));
		const { db: dbB } = createDb(transactorFor(b));

		// Both nodes declare the schema BEFORE either writes — the sereus bring-up order.
		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);
		await dbB.exec(createTableSql);
		await dbB.exec(createIndexSql);

		await dbA.exec(`insert into FormationUsage (Token, UsageStampId, PeerKey) values ('tok', 'stamp-A', 'key-A')`);

		const scanB = await collect(dbB, `select UsageStampId from FormationUsage order by UsageStampId`);
		const seekB = await collect(dbB, `select UsageStampId from FormationUsage where Token = 'tok' order by UsageStampId`);
		// eslint-disable-next-line no-console
		console.log('B scan', scanB.map(r => r.UsageStampId), '| B seek', seekB.map(r => r.UsageStampId));

		expect(scanB.map(r => r.UsageStampId), "B's full scan sees A's row").to.deep.equal(['stamp-A']);
		expect(seekB.map(r => r.UsageStampId), "B's index seek sees A's row").to.deep.equal(['stamp-A']);
	});

	it('concurrent writers: both insert under the same Token, both must see both rows', async function () {
		const [a, b] = await stabilizedPair();
		const { db: dbA } = createDb(transactorFor(a));
		const { db: dbB } = createDb(transactorFor(b));

		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);
		await dbB.exec(createTableSql);
		await dbB.exec(createIndexSql);

		const outcomes = await Promise.allSettled([
			dbA.exec(`insert into FormationUsage (Token, UsageStampId, PeerKey) values ('tok', 'stamp-A', 'key-A')`),
			dbB.exec(`insert into FormationUsage (Token, UsageStampId, PeerKey) values ('tok', 'stamp-B', 'key-B')`),
		]);
		// eslint-disable-next-line no-console
		console.log('insert outcomes:', outcomes.map(o => o.status === 'rejected' ? String((o as PromiseRejectedResult).reason) : 'ok'));

		const scanA = await collect(dbA, `select UsageStampId from FormationUsage order by UsageStampId`);
		const seekA = await collect(dbA, `select UsageStampId from FormationUsage where Token = 'tok' order by UsageStampId`);
		const scanB = await collect(dbB, `select UsageStampId from FormationUsage order by UsageStampId`);
		const seekB = await collect(dbB, `select UsageStampId from FormationUsage where Token = 'tok' order by UsageStampId`);
		// eslint-disable-next-line no-console
		console.log('A scan', scanA.map(r => r.UsageStampId), '| A seek', seekA.map(r => r.UsageStampId));
		// eslint-disable-next-line no-console
		console.log('B scan', scanB.map(r => r.UsageStampId), '| B seek', seekB.map(r => r.UsageStampId));

		expect(seekA.map(r => r.UsageStampId), "A's index seek").to.deep.equal(['stamp-A', 'stamp-B']);
		expect(seekB.map(r => r.UsageStampId), "B's index seek").to.deep.equal(['stamp-A', 'stamp-B']);
	});
});
