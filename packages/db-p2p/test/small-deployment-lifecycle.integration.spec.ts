import { expect } from 'chai';
import type { PrivateKey } from '@libp2p/interface';
import type { BlockId } from '@optimystic/db-core';
import { NetworkTransactor, Tree } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { RepoClient } from '../src/repo/client.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

// The growth path every real deployment takes, end to end, over real TCP:
//
//   one machine writes alone → restarts → a second machine joins as a backup and must end up
//   holding the first machine's data locally → both write → one is away for a while → both restart.
//
// Each step is covered somewhere else in isolation (solo restart in `real-libp2p.integration.spec.ts`,
// a pair present from the start in `two-node-convergence.integration.spec.ts`, cohort growth with
// in-process streams in `cohort-growth-heals-single-holder.spec.ts`); past defects lived at the joins
// between them. This spec runs them as one sequence.
//
// Configuration is exactly what `docs/optimystic.md` § Deployment Sizes recommends for two machines —
// default `clusterSize`, `clusterPolicy: { repairCorroborationClusterSize: 2 }` — and nothing else,
// deliberately NOT the `clusterSize: 2` shortcut the other two-node specs use.
//
// Phases are separate `it`s over shared state so the reporter names the phase that broke. A phase
// whose predecessor failed fails immediately with that predecessor's name rather than running over
// broken state (and rather than skipping, which would read as green).
//
// Restarts use a fresh port each time. A restarted node's peer store is empty, so it cannot find its
// partner by peer id; it dials the partner's current address instead, the way a host application
// that enrolled the backup would. The surviving node learns the new address through identify.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 like the other real-socket specs:
//   yarn workspace @optimystic/db-p2p test:integration

const NETWORK_NAME = 'small-deployment-lifecycle-it';
const PROTOCOL_PREFIX = `/optimystic/${NETWORK_NAME}`;
const TREE_ID = 'small-deployment-lifecycle-rows';

interface Row {
	key: number;
	value: string;
}

const keyOf = (row: Row) => row.key;

/** One machine: a stable identity and durable storage that outlive any single node process. */
interface Machine {
	readonly name: 'A' | 'B';
	readonly privateKey: PrivateKey;
	readonly storage: MemoryRawStorage;
	node?: OptimysticNode;
}

const running = (machine: Machine): OptimysticNode => {
	if (!machine.node) throw new Error(`machine ${machine.name} is not running`);
	return machine.node;
};

const transactorFor = (node: OptimysticNode): NetworkTransactor => new NetworkTransactor({
	timeoutMs: 30_000,
	abortOrCancelTimeoutMs: 10_000,
	dialTimeoutMs: 3_000,
	keyNetwork: node.keyNetwork,
	getRepo: (peerId) => peerId.equals(node.peerId)
		? node.coordinatedRepo
		: RepoClient.create(peerId, node.keyNetwork, PROTOCOL_PREFIX)
});

async function startMachine(machine: Machine, partners: Machine[] = []): Promise<OptimysticNode> {
	const node = await createLibp2pNode({
		port: 0,
		networkName: NETWORK_NAME,
		bootstrapNodes: partners.map(partner => pickLocalTcpMultiaddr(running(partner))),
		privateKey: machine.privateKey,
		storage: machine.storage,
		clusterPolicy: { repairCorroborationClusterSize: 2 }
	});
	machine.node = node;
	return node;
}

async function stopMachine(machine: Machine): Promise<void> {
	const node = machine.node;
	machine.node = undefined;
	await node?.stop();
}

let probeCounter = 0;

/** Both nodes connected to each other, and each assembling a two-member cohort. A fresh probe key per
 *  call so no per-key cohort cache can answer from before the latest restart. */
async function waitForPair(a: Machine, b: Machine): Promise<void> {
	const nodeA = running(a);
	const nodeB = running(b);
	await waitFor(
		() => nodeA.getPeers().some(p => p.equals(nodeB.peerId)) && nodeB.getPeers().some(p => p.equals(nodeA.peerId)),
		{ timeoutMs: 30_000, intervalMs: 250, description: 'A and B connected to each other' }
	);
	const probe = new TextEncoder().encode(`small-deployment-probe-${probeCounter++}`);
	await waitFor(async () => {
		for (const node of [nodeA, nodeB]) {
			if (Object.keys(await node.keyNetwork.findCluster(probe)).length !== 2) return false;
		}
		return true;
	}, { timeoutMs: 40_000, intervalMs: 500, description: 'A and B each assemble the same two-member cohort' });
}

/** Write each row as its own action through the machine's NetworkTransactor; throws if any is refused. */
async function writeRows(machine: Machine, rows: Row[]): Promise<void> {
	const tree = await Tree.createOrOpen<number, Row>(transactorFor(running(machine)), TREE_ID, keyOf);
	for (const row of rows) {
		await tree.replace([[row.key, row]]);
	}
}

/** A freshly opened tree's view of `keys` — a new transactor and tree, so no staged or cached state
 *  from an earlier write on the same machine can answer. */
async function readRows(machine: Machine, keys: number[]): Promise<Map<number, Row | undefined>> {
	const tree = await Tree.open<number, Row>(transactorFor(running(machine)), TREE_ID, keyOf);
	expect(tree, `${machine.name} opens the collection`).to.not.equal(undefined);
	const seen = new Map<number, Row | undefined>();
	for (const key of keys) seen.set(key, await tree!.get(key));
	return seen;
}

async function expectReadable(machine: Machine, rows: Iterable<Row>, label: string): Promise<void> {
	const expected = [...rows];
	const seen = await readRows(machine, expected.map(keyOf));
	const wrong = expected.filter(row => seen.get(row.key)?.value !== row.value);
	expect(wrong.map(row => ({ key: row.key, expected: row.value, read: seen.get(row.key)?.value ?? null })),
		`${label}: rows ${machine.name} could not read back`).to.deep.equal([]);
}

const rowsFor = (prefix: string, keys: number[]): Row[] => keys.map(key => ({ key, value: `${prefix}-${key}` }));

/** Every block `machine` holds a committed revision of, from its own storage only. */
async function committedBlocks(machine: Machine): Promise<Map<BlockId, number>> {
	const { storageRepo } = running(machine);
	if (!machine.storage.listBlockIds) throw new Error('MemoryRawStorage no longer enumerates block ids; the locality check needs it');
	const held = new Map<BlockId, number>();
	for await (const blockId of machine.storage.listBlockIds()) {
		const rev = (await storageRepo.get({ blockIds: [blockId] }))[blockId]?.state.latest?.rev;
		if (rev !== undefined) held.set(blockId, rev);
	}
	return held;
}

/** Which of `expected` `holder` lacks locally at (at least) the expected revision. */
async function missingLocally(holder: Machine, expected: Map<BlockId, number>): Promise<string[]> {
	const { storageRepo } = running(holder);
	const missing: string[] = [];
	for (const [blockId, rev] of expected) {
		const entry = (await storageRepo.get({ blockIds: [blockId] }))[blockId];
		const heldRev = entry?.state.latest?.rev;
		if (!entry?.block || heldRev === undefined || heldRev < rev) {
			missing.push(`${blockId}@${rev} (holds ${heldRev ?? 'nothing'})`);
		}
	}
	return missing;
}

describe('Small deployment lifecycle over real libp2p (solo → backup → away → restart)', function () {
	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let a: Machine;
	let b: Machine;
	/** Every row whose write was acknowledged, by key — the durability ledger every later phase checks. */
	const acknowledged = new Map<number, Row>();
	let failedPhase: string | undefined;

	before(async function () {
		a = { name: 'A', privateKey: await generateKeyPair('Ed25519'), storage: new MemoryRawStorage() };
		b = { name: 'B', privateKey: await generateKeyPair('Ed25519'), storage: new MemoryRawStorage() };
	});

	beforeEach(function () {
		if (failedPhase) throw new Error(`not run: an earlier phase failed ("${failedPhase}")`);
	});

	afterEach(function () {
		if (this.currentTest?.state === 'failed' && !failedPhase) failedPhase = this.currentTest.title;
	});

	after(async function () {
		await Promise.allSettled([a, b].filter(Boolean).map(stopMachine));
	});

	const acknowledge = (rows: Row[]) => { for (const row of rows) acknowledged.set(row.key, row); };

	it('phase 1 — solo: A writes alone and reads its rows back', async function () {
		this.timeout(30_000);
		await startMachine(a);

		const rows = rowsFor('solo', [1, 2, 3]);
		await writeRows(a, rows);
		acknowledge(rows);

		await expectReadable(a, rows, 'solo');
	});

	it('phase 2 — solo restart: A comes back over its storage, reads everything, writes again', async function () {
		this.timeout(30_000);
		await stopMachine(a);
		await startMachine(a);

		await expectReadable(a, acknowledged.values(), 'after solo restart');

		const rows = rowsFor('solo-restarted', [4]);
		await writeRows(a, rows);
		acknowledge(rows);
		await expectReadable(a, rows, 'solo write after restart');
	});

	it('phase 3 — add a backup: B joins, holds A\'s blocks locally, and serves every row with A stopped', async function () {
		this.timeout(120_000);
		const founderBlocks = await committedBlocks(a);
		expect(founderBlocks.size, 'A holds committed blocks to replicate').to.be.greaterThan(0);

		await startMachine(b, [a]);
		await waitForPair(a, b);

		let missing: string[] = [];
		try {
			await waitFor(async () => (missing = await missingLocally(b, founderBlocks)).length === 0,
				{ timeoutMs: 90_000, intervalMs: 500, description: 'B holds every block A wrote alone' });
		} catch (err) {
			throw new Error(`${(err as Error).message}; B never held locally: ${missing.join(', ')}`);
		}

		await stopMachine(a);
		await expectReadable(b, acknowledged.values(), 'B with A stopped');
	});

	it('phase 4 — both write: A restarts, each writes, each reads the other\'s rows', async function () {
		this.timeout(60_000);
		await startMachine(a, [b]);
		await waitForPair(a, b);

		const fromA = rowsFor('both-A', [10, 11]);
		await writeRows(a, fromA);
		acknowledge(fromA);

		const fromB = rowsFor('both-B', [20, 21]);
		await writeRows(b, fromB);
		acknowledge(fromB);

		await expectReadable(a, fromB, 'A reads B\'s rows');
		await expectReadable(b, fromA, 'B reads A\'s rows');
	});

	it('phase 5 — one away: B stops, A writes, B returns; every acknowledged row is on both', async function () {
		this.timeout(120_000);
		const nodeA = running(a);
		const bPeerId = running(b).peerId;
		await stopMachine(b);
		await waitFor(() => !nodeA.getPeers().some(p => p.equals(bPeerId)),
			{ timeoutMs: 10_000, intervalMs: 100, description: 'A notices B is gone' });

		const whileAway: Row = { key: 30, value: 'B-away-30' };
		const startedAt = Date.now();
		let refusal: Error | undefined;
		try {
			await writeRows(a, [whileAway]);
			acknowledge([whileAway]);
		} catch (err) {
			refusal = err as Error;
		}
		const elapsedMs = Date.now() - startedAt;

		await startMachine(b, [a]);
		await waitForPair(a, b);

		await expectReadable(a, acknowledged.values(), 'A after B returned');
		await expectReadable(b, acknowledged.values(), 'B after its restart');

		// Observed, not asserted: whether a lone survivor of a two-machine group should accept writes is
		// under design (tickets/backlog/more-design/6.5-partition-healing.md). This phase pins durability of
		// what was acknowledged; the admission outcome — and, when refused, whether the refused row surfaces
		// anyway — is reported so a change in either shows up in the run output.
		let outcome = `ACKNOWLEDGED after ${elapsedMs}ms`;
		if (refusal) {
			const onA = (await readRows(a, [whileAway.key])).get(whileAway.key)?.value ?? 'absent';
			const onB = (await readRows(b, [whileAway.key])).get(whileAway.key)?.value ?? 'absent';
			outcome = `REFUSED after ${elapsedMs}ms (${refusal.name}: ${refusal.message}); once B returned the refused row read as ${onA} on A, ${onB} on B`;
		}
		console.log(`      phase 5 observed: A's write with B away was ${outcome}`);
	});

	it('phase 6 — both restart: every acknowledged row on each, and a new write from each crosses', async function () {
		this.timeout(90_000);
		await Promise.all([stopMachine(a), stopMachine(b)]);
		await startMachine(a);
		await startMachine(b, [a]);
		await waitForPair(a, b);

		await expectReadable(a, acknowledged.values(), 'A after both restarted');
		await expectReadable(b, acknowledged.values(), 'B after both restarted');

		const fromA = rowsFor('final-A', [40]);
		await writeRows(a, fromA);
		acknowledge(fromA);
		const fromB = rowsFor('final-B', [50]);
		await writeRows(b, fromB);
		acknowledge(fromB);

		await expectReadable(b, fromA, 'B reads A\'s final row');
		await expectReadable(a, fromB, 'A reads B\'s final row');
	});
});
