/**
 * Shared machinery for the specs that take a two-machine deployment through its lifecycle:
 * `small-deployment-lifecycle.integration.spec.ts` over direct TCP, and
 * `two-phones-over-relay.integration.spec.ts` through a circuit relay.
 *
 * A {@link Machine} is what outlives a node process — a stable identity key and durable storage — so a
 * spec stops a machine's node and starts a new one over the same machine, the way a restarted app would.
 *
 * Every node {@link startMachine} builds runs the configuration `docs/optimystic.md` § Deployment Sizes
 * recommends for two machines: default `clusterSize`, `clusterPolicy: { repairCorroborationClusterSize: 2 }`,
 * and nothing else. A spec chooses only how its machines reach each other ({@link NetworkShape}), never the
 * cluster configuration — deliberately NOT the `clusterSize: 2` shortcut other two-node specs take.
 */
import { expect } from 'chai';
import type { PrivateKey } from '@libp2p/interface';
import type { BlockId, WriteDurability } from '@optimystic/db-core';
import { NetworkTransactor, Tree, mergeDurability, routingKeyForBlock } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { createLibp2pNode, type NodeOptions } from '../../src/libp2p-node.js';
import type { OptimysticNode } from '../../src/optimystic-node.js';
import { MemoryRawStorage } from '../../src/storage/memory-storage.js';
import { MemoryKVStore } from '../../src/storage/memory-kv-store.js';
import type { IUnderReplicationLedger } from '../../src/repo/i-under-replication-ledger.js';
import { RepoClient } from '../../src/repo/client.js';

/** One row of the collection the lifecycle phases write and read back. */
export interface Row {
	key: number;
	value: string;
}

export const keyOf = (row: Row): number => row.key;

/** Rows at `keys`, each valued `<prefix>-<key>` so a wrong read names the write it came from. */
export const rowsFor = (prefix: string, keys: number[]): Row[] => keys.map(key => ({ key, value: `${prefix}-${key}` }));

/** One machine: a stable identity and durable storage that outlive any single node process. */
export interface Machine {
	readonly name: string;
	readonly networkName: string;
	readonly privateKey: PrivateKey;
	readonly storage: MemoryRawStorage;
	/** The node-local key-value store — today the under-replication ledger — which, like `storage`,
	 *  must outlive a node process for a restart to mean anything. */
	readonly kvStore: MemoryKVStore;
	node?: OptimysticNode;
}

export async function createMachine(name: string, networkName: string): Promise<Machine> {
	return { name, networkName, privateKey: await generateKeyPair('Ed25519'), storage: new MemoryRawStorage(), kvStore: new MemoryKVStore() };
}

export function running(machine: Machine): OptimysticNode {
	if (!machine.node) throw new Error(`machine ${machine.name} is not running`);
	return machine.node;
}

/** How a spec's machines reach each other. The cluster configuration is not part of it — see the module header. */
export type NetworkShape = Omit<NodeOptions, 'networkName' | 'privateKey' | 'storage' | 'kvStore' | 'clusterSize' | 'clusterPolicy'>;

export async function startMachine(machine: Machine, shape: NetworkShape): Promise<OptimysticNode> {
	const node = await createLibp2pNode({
		...shape,
		networkName: machine.networkName,
		privateKey: machine.privateKey,
		storage: machine.storage,
		kvStore: machine.kvStore,
		clusterPolicy: { repairCorroborationClusterSize: 2 }
	});
	machine.node = node;
	return node;
}

/** The running node's under-replication ledger: which blocks it acknowledged before every partner held them. */
export function ledgerOf(machine: Machine): IUnderReplicationLedger {
	const ledger = (running(machine) as unknown as { underReplicationLedger?: IUnderReplicationLedger }).underReplicationLedger;
	if (!ledger) throw new Error(`machine ${machine.name} exposes no under-replication ledger`);
	return ledger;
}

export async function stopMachine(machine: Machine): Promise<void> {
	const node = machine.node;
	machine.node = undefined;
	await node?.stop();
}

/** A transactor over `node`: its own coordinated repo for itself, a protocol client for every other peer. */
export function transactorFor(node: OptimysticNode, networkName: string): NetworkTransactor {
	return new NetworkTransactor({
		timeoutMs: 30_000,
		abortOrCancelTimeoutMs: 10_000,
		dialTimeoutMs: 3_000,
		keyNetwork: node.keyNetwork,
		getRepo: (peerId) => peerId.equals(node.peerId)
			? node.coordinatedRepo
			: RepoClient.create(peerId, node.keyNetwork, `/optimystic/${networkName}`),
		localPeerId: node.peerId
	});
}

let probeCounter = 0;

/** Both nodes connected to each other, and each assembling a two-member cohort. A fresh probe key per
 *  call so no per-key cohort cache can answer from before the latest restart. */
export async function waitForPair(a: Machine, b: Machine): Promise<void> {
	const nodeA = running(a);
	const nodeB = running(b);
	await waitFor(
		() => nodeA.getPeers().some(p => p.equals(nodeB.peerId)) && nodeB.getPeers().some(p => p.equals(nodeA.peerId)),
		{ timeoutMs: 30_000, intervalMs: 250, description: `${a.name} and ${b.name} connected to each other` }
	);
	const probe = routingKeyForBlock(`${a.networkName}-probe-${probeCounter++}`);
	await waitFor(async () => {
		for (const node of [nodeA, nodeB]) {
			if (Object.keys(await node.keyNetwork.findCluster(probe)).length !== 2) return false;
		}
		return true;
	}, { timeoutMs: 40_000, intervalMs: 500, description: `${a.name} and ${b.name} each assemble the same two-member cohort` });
}

/** Write each row as its own action through the machine's NetworkTransactor; throws if any is refused.
 *
 *  @returns who holds the rows: the WEAKEST of the per-row reports (`mergeDurability`), because a caller
 *  asking about a batch is asking whether ALL of it is held — one row that reached only the writer makes
 *  the batch only-on-the-writer. `undefined` only when no row wrote anything (an empty `rows`). */
export async function writeRows(machine: Machine, treeId: string, rows: Row[]): Promise<WriteDurability | undefined> {
	const tree = await Tree.createOrOpen<number, Row>(transactorFor(running(machine), machine.networkName), treeId, keyOf);
	const reports: WriteDurability[] = [];
	for (const row of rows) {
		const durability = await tree.replace([[row.key, row]]);
		if (durability) reports.push(durability);
	}
	return reports.length === 0 ? undefined : mergeDurability(reports);
}

/** A freshly opened tree's view of `keys` — a new transactor and tree, so no staged or cached state
 *  from an earlier write on the same machine can answer. */
export async function readRows(machine: Machine, treeId: string, keys: number[]): Promise<Map<number, Row | undefined>> {
	const tree = await Tree.open<number, Row>(transactorFor(running(machine), machine.networkName), treeId, keyOf);
	expect(tree, `${machine.name} opens the collection`).to.not.equal(undefined);
	const seen = new Map<number, Row | undefined>();
	for (const key of keys) seen.set(key, await tree!.get(key));
	return seen;
}

export async function expectReadable(machine: Machine, treeId: string, rows: Iterable<Row>, label: string): Promise<void> {
	const expected = [...rows];
	const seen = await readRows(machine, treeId, expected.map(keyOf));
	const wrong = expected.filter(row => seen.get(row.key)?.value !== row.value);
	expect(wrong.map(row => ({ key: row.key, expected: row.value, read: seen.get(row.key)?.value ?? null })),
		`${label}: rows ${machine.name} could not read back`).to.deep.equal([]);
}

/** What became of a write attempted while the writer's partner was away. */
export interface WriteAttempt {
	/** Absent when the write was acknowledged. */
	readonly refusal?: Error;
	/** Who holds the write, for an ACKNOWLEDGED attempt — the answer `Tree.replace` now returns. Absent
	 *  on a refusal (nothing was written), and absent for an acknowledged attempt that wrote nothing at
	 *  all (an empty `rows`). A lone survivor's write reads `local` here, which is how a caller tells it
	 *  from one the whole group holds. */
	readonly durability?: WriteDurability;
	readonly elapsedMs: number;
}

/** Write `rows`, returning a refusal as the outcome rather than throwing it — for phases that observe admission
 *  instead of asserting it. */
export async function attemptWrite(machine: Machine, treeId: string, rows: Row[]): Promise<WriteAttempt> {
	const startedAt = Date.now();
	try {
		const durability = await writeRows(machine, treeId, rows);
		return { ...(durability === undefined ? {} : { durability }), elapsedMs: Date.now() - startedAt };
	} catch (err) {
		return { refusal: err as Error, elapsedMs: Date.now() - startedAt };
	}
}

/** One line for the run output describing `attempt`; for a refusal, also what each of `readers` reads at the refused row now. */
export async function describeWriteAttempt(attempt: WriteAttempt, row: Row, treeId: string, readers: Machine[]): Promise<string> {
	if (!attempt.refusal) return `ACKNOWLEDGED (${attempt.durability?.quorum ?? 'no durability reported'}) after ${attempt.elapsedMs}ms`;
	const reads: string[] = [];
	for (const reader of readers) {
		const value = (await readRows(reader, treeId, [row.key])).get(row.key)?.value ?? 'absent';
		reads.push(`${value} on ${reader.name}`);
	}
	return `REFUSED after ${attempt.elapsedMs}ms (${attempt.refusal.name}: ${attempt.refusal.message}); `
		+ `once the partner returned, the refused row read as ${reads.join(', ')}`;
}

/** Every block `machine` holds a committed revision of, from its own storage only. */
export async function committedBlocks(machine: Machine): Promise<Map<BlockId, number>> {
	const { storageRepo } = running(machine);
	if (!machine.storage.listBlockIds) throw new Error('MemoryRawStorage no longer enumerates block ids; the locality check needs it');
	const held = new Map<BlockId, number>();
	for await (const blockId of machine.storage.listBlockIds()) {
		const rev = (await storageRepo.get({ blockIds: [blockId] }))[blockId]?.state.latest?.rev;
		if (rev !== undefined) held.set(blockId, rev);
	}
	return held;
}

/** The blocks `machine` now holds at a revision `before` did not — what a write since then touched. */
export async function blocksChangedSince(machine: Machine, before: Map<BlockId, number>): Promise<Map<BlockId, number>> {
	const changed = new Map<BlockId, number>();
	for (const [blockId, rev] of await committedBlocks(machine)) {
		if (before.get(blockId) !== rev) changed.set(blockId, rev);
	}
	return changed;
}

/** Wait until `machine`'s ledger no longer lists any of `blockIds`; on timeout, name the ones it still owes. */
export async function waitUntilLedgerClear(machine: Machine, blockIds: Iterable<BlockId>, description: string, timeoutMs: number): Promise<void> {
	const expected = [...blockIds];
	let owed: BlockId[] = [];
	try {
		await waitFor(async () => {
			const listed = new Set((await ledgerOf(machine).list()).map(entry => entry.blockId));
			owed = expected.filter(blockId => listed.has(blockId));
			return owed.length === 0;
		}, { timeoutMs, intervalMs: 500, description });
	} catch (err) {
		throw new Error(`${(err as Error).message}; ${machine.name}'s ledger still owes: ${owed.join(', ')}`);
	}
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

/** Wait until `holder`'s own storage holds every block in `expected`; on timeout, name the blocks it still lacks. */
export async function waitUntilHeldLocally(holder: Machine, expected: Map<BlockId, number>, description: string, timeoutMs: number): Promise<void> {
	let missing: string[] = [];
	try {
		await waitFor(async () => (missing = await missingLocally(holder, expected)).length === 0,
			{ timeoutMs, intervalMs: 500, description });
	} catch (err) {
		throw new Error(`${(err as Error).message}; ${holder.name} never held locally: ${missing.join(', ')}`);
	}
}

/**
 * Makes a suite's `it`s one ordered sequence over shared state. A phase whose predecessor failed fails at once,
 * naming that predecessor, rather than running over broken state — and rather than skipping, which would read as
 * green. Call from inside the `describe`.
 */
export function sequentialPhases(): void {
	let failedPhase: string | undefined;
	beforeEach(function () {
		if (failedPhase) throw new Error(`not run: an earlier phase failed ("${failedPhase}")`);
	});
	afterEach(function () {
		if (this.currentTest?.state === 'failed' && !failedPhase) failedPhase = this.currentTest.title;
	});
}
