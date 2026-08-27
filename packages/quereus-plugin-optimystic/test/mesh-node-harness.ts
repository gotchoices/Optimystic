/**
 * The shared harness every in-process multi-node spec builds on: one mock mesh, one
 * `Database` per mesh node bound to that node's own transactor, and a committed-state
 * reader that goes around the vtabs entirely.
 *
 * These three pieces had been copy-pasted verbatim into four specs
 * (`two-node-secondary-index-convergence`, `two-node-index-interleaving-sweep`,
 * `two-node-multi-collection-commit`, `two-node-shared-index-key`). They are the seam
 * where a spec stops being about its own subject and starts being about how the mesh is
 * wired, so a drift between copies — a different `clusterSize`, a transactor registered
 * under the wrong key — would make two specs silently test different topologies while
 * reading identically. One definition removes that possibility.
 */

import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '@optimystic/db-p2p/testing';
import register from '../dist/plugin.js';

export type Plugin = ReturnType<typeof register>;

/** One mesh node's SQL surface: its own `Database` plus the plugin instance bound to it. */
export type MeshDbNode = { db: Database; plugin: Plugin };

/** A running mock mesh, plus the lookup from node index to that node's transactor. */
export interface MockMesh {
	mesh: Mesh;
	/** The transactor for `mesh.nodes[index]`. Throws rather than returning undefined. */
	transactorFor(index: number): ITransactor;
}

/**
 * Start an in-process mesh of `size` nodes, every node responsible for every key so no
 * case turns on which node happens to own a hash.
 *
 * Nothing tears the mesh down: it is plain in-process objects over `MemoryRawStorage`
 * with no sockets or timers, so it is collected once the spec drops its reference.
 * NOTE: accepted tradeoff — the Databases built on it are likewise left open, which is
 * per-case garbage that grows with the case count; revisit (closing each node in an
 * `afterEach`) if a spec ever slows down or runs the heap up.
 *
 * NOTE: membership admission gate is ARMED here (not opted out) — no `assumedClusterSize`
 * is passed, so it resolves to `minAbsoluteClusterSize` (2) and the gate's fallback floor
 * is `max(2, ceil(0.75*2)) = 2`. On the pend path every member derives the full
 * self-including mesh confidently (kEst = size, floor `max(2, ceil(0.75*size))`, declared
 * = size, symmetric difference 0 -> admit). On the commit/cancel path there is no
 * coordinating block id yet (tracked by fix ticket
 * `commit-and-cancel-records-omit-the-coordinating-block`), so it falls back to floor 2,
 * which any cohort of 2+ clears. `size: 1` never reaches the gate (solo short-circuit in
 * `CoordinatorRepo`). Specs here don't need to re-derive this arithmetic.
 */
export async function startMockMesh(size: number): Promise<MockMesh> {
	const mesh = await createMesh(size, {
		responsibilityK: size,
		clusterSize: size,
		superMajorityThreshold: 0.67,
	});
	const transactors = buildNetworkTransactors(mesh);
	return {
		mesh,
		transactorFor(index: number): ITransactor {
			const peerId = mesh.nodes[index]!.peerId.toString();
			const transactor = transactors.get(peerId);
			if (!transactor) throw new Error(`No transactor for peer ${peerId}`);
			return transactor;
		},
	};
}

/**
 * Build a `Database` whose every collection rides `transactor`'s stack.
 *
 * The factory keys its transactor cache on `${transactor}:${keyNetwork}`, so registering
 * under `shared:test` is what binds this Database to THIS mesh node rather than to a
 * default one — get that key wrong and the spec silently runs both nodes on one stack.
 */
export function createMeshDbNode(transactor: ITransactor): MeshDbNode {
	const db = new Database();
	const config = {
		default_transactor: 'shared',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	plugin.collectionFactory.registerTransactor('shared:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

/** What a fresh read of a committed tree can observe about it. */
export interface TreeShape {
	/** Committed entries in the tree. */
	entries: number;
	/**
	 * True once the btree has at least one branch level — i.e. the entries no longer fit
	 * in a single leaf block and the tree has actually SPLIT. Read off `Path.branches`, so
	 * it is an observation rather than an inference from the fan-out constant.
	 */
	split: boolean;
}

/**
 * Read `collectionUri` through a FRESH Tree on this node's transactor — what consensus
 * persisted, not what a vtab staged. This is the assertion that would catch a lost write
 * whose absence the query path happened to paper over.
 *
 * Passing no transaction state is what makes it fresh: the factory's collection cache is
 * transaction-scoped, so a cache-less call always opens a new Tree.
 */
export async function readTree(plugin: Plugin, collectionUri: string): Promise<TreeShape> {
	const tree = await plugin.collectionFactory.createOrGetCollection({
		collectionUri,
		transactor: 'shared',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
	});
	await tree.update();
	let entries = 0;
	let split = false;
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (!tree.isValid(treePath)) continue;
		entries++;
		if (treePath.branches.length > 0) split = true;
	}
	return { entries, split };
}

/** Committed entry count at `collectionUri`, seen from this node. */
export async function countTreeEntries(plugin: Plugin, collectionUri: string): Promise<number> {
	return (await readTree(plugin, collectionUri)).entries;
}
