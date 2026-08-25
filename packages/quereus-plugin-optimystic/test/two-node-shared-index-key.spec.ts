/**
 * Two nodes writing rows that share ONE secondary-index value.
 *
 * Why this file exists, and what it is NOT. `fix/two-nodes-writing-one-index-key-was-never-tested`
 * claimed the two-node sweep had never had both machines write the same indexed value —
 * that every case gave the two machines disjoint index keys, so no index entry ever had to
 * hold two writers' contributions. That claim is wrong: the sweep's `token` dimension already
 * crosses `same-token`, and 72 of its 144 orderings put both machines on `tok-seed`. They pass.
 *
 * Two things the sweep genuinely does NOT do, and this file does:
 *
 *   1. Its `same-token` cases always write into an index value a committed SEED row already
 *      established, so the shared group is grown, never CREATED by two machines at once. Here
 *      the shared value is brand new — in the base cases the index tree starts completely
 *      empty — so both machines create the group from nothing.
 *   2. Nothing anywhere crosses two machines with a UNIQUE index, or with an index tree big
 *      enough to span more than one block (the tree's default fan-out is 64 and every
 *      two-node case so far writes three rows). Both are listed as untested in
 *      `debt-index-sweep-misses-update-delete-and-orphans`.
 *
 * On the mechanism the fix ticket proposed — an index entry overwritten last-writer-wins
 * rather than merged — see `index-manager.ts insertIndexEntries`: an index tree key is
 * `frame(indexColumns) ‖ frame(primaryKey)`, for unique and non-unique indexes alike. Two rows
 * sharing an indexed value therefore occupy two DISTINCT tree keys, and a seek range-scans the
 * framed `frame(indexColumns)` prefix. There is no shared slot whose contents could be lost.
 * What two same-value writers do share is the tree BLOCK those adjacent keys land in, which is
 * the merge these cases actually exercise.
 *
 * Harness mirrors two-node-secondary-index-convergence.spec.ts: one in-process mock mesh, one
 * Database per node, each bound to its own node's transactor.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';
import { KeyRange, NodeCapacity } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '@optimystic/db-p2p/testing';
import register from '../dist/plugin.js';
import { expectIndexAgreesWithScan, queryAll } from './query-helpers.js';

type Plugin = ReturnType<typeof register>;
type Node = { db: Database; plugin: Plugin };

const TABLE_URI = 'tree://default/FormationUsage';
const INDEX_NAME = 'formation_usage_by_token';
const INDEX_URI = `${TABLE_URI}/index/${INDEX_NAME}`;

/**
 * Column names follow the downstream schema this came from: the primary key is a
 * per-redemption nonce, so two machines redeeming the same invite concurrently write
 * DISTINCT primary keys and the SAME `Token`. That is the shape under test.
 */
const createTableSql = `
	create table FormationUsage (
		UsageStampId integer primary key,
		Token text
	) using optimystic('${TABLE_URI}')
`;
const createIndexSql = `create index ${INDEX_NAME} on FormationUsage(Token)`;
const createUniqueIndexSql = `create unique index ${INDEX_NAME} on FormationUsage(Token)`;

/** The one indexed value every writer in the base cases lands on. */
const SHARED_TOKEN = 'tok-shared';

/** Per-writer primary keys, so a failure names which machine's row went missing. */
const STAMP_ID = { A: 100, B: 200, C: 300 } as const;
type Which = keyof typeof STAMP_ID;

const insertSql = (stampId: number, token: string) =>
	`insert into FormationUsage (UsageStampId, Token) values (${stampId}, '${token}')`;

/**
 * The orders two machines' writes can reach consensus in. `staged-both` opens both
 * transactions and stages both mutations before either commits, so neither machine's flush
 * can have seen the other's — the closest this harness gets to genuine concurrency.
 */
const WRITE_ORDERS = ['a-then-b', 'b-then-a', 'staged-both'] as const;
type WriteOrder = (typeof WRITE_ORDERS)[number];

function createNode(transactor: ITransactor): Node {
	const db = new Database();
	const config = {
		default_transactor: 'shared',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	// The factory keys its transactor cache on `${transactor}:${keyNetwork}`, so this makes
	// every collection this Database opens ride THIS mesh node's stack.
	plugin.collectionFactory.registerTransactor('shared:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

/**
 * Count committed entries at `collectionUri` through a FRESH Tree on this node's transactor —
 * what consensus persisted, not what a vtab staged. This is the assertion that would catch a
 * lost write whose absence the query path happened to paper over.
 */
async function readTree(plugin: Plugin, collectionUri: string): Promise<{
	/** Committed entries in the tree. */
	entries: number;
	/**
	 * True once the btree has at least one branch level — i.e. the entries no longer fit in a
	 * single leaf block and the tree has actually SPLIT. Read off `Path.branches`, so it is an
	 * observation rather than an inference from the fan-out constant.
	 */
	split: boolean;
}> {
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
async function countTreeEntries(plugin: Plugin, collectionUri: string): Promise<number> {
	return (await readTree(plugin, collectionUri)).entries;
}

/** Run the two machines' inserts in `order`, all of them landing on `token`. */
async function runSharedKeyWrites(
	order: WriteOrder,
	nodes: Record<'A' | 'B', Node>,
	token: string,
): Promise<void> {
	const sql = { A: insertSql(STAMP_ID.A, token), B: insertSql(STAMP_ID.B, token) };

	if (order === 'staged-both') {
		await nodes.A.db.exec('begin');
		await nodes.A.db.exec(sql.A);
		await nodes.B.db.exec('begin');
		await nodes.B.db.exec(sql.B);
		await nodes.A.db.exec('commit');
		await nodes.B.db.exec('commit');
		return;
	}

	for (const which of order === 'b-then-a' ? (['B', 'A'] as const) : (['A', 'B'] as const)) {
		await nodes[which].db.exec(sql[which]);
	}
}

/**
 * Every node must see exactly `expected` (UsageStampId, Token) pairs by full scan, and its
 * index-routed seek must agree with that scan for every value present.
 *
 * The scan half is not the defect under test — it is what keeps the index/scan comparison
 * from passing vacuously, since a node whose scan is missing a row has an index legitimately
 * missing it too.
 */
async function expectAllNodesConverged(
	nodes: Partial<Record<Which, Node>>,
	expected: { UsageStampId: number; Token: string }[],
): Promise<void> {
	for (const [which, node] of Object.entries(nodes) as [Which, Node][]) {
		const rows = await queryAll(
			node.db,
			`select UsageStampId, Token from FormationUsage order by UsageStampId`,
		);
		expect(
			rows.map(r => ({ UsageStampId: Number(r.UsageStampId), Token: String(r.Token) })),
			`node ${which}'s full scan must hold every committed row before its index can be compared to it`,
		).to.deep.equal(expected);
		await expectIndexAgreesWithScan(node.db, 'FormationUsage', 'Token');
	}
}

describe('Two nodes writing one shared secondary-index value', function () {
	this.timeout(120_000);

	let mesh: Mesh;
	let transactors: Map<string, ITransactor>;

	const startMesh = async (size: number): Promise<void> => {
		mesh = await createMesh(size, {
			responsibilityK: size,
			clusterSize: size,
			superMajorityThreshold: 0.67,
		});
		transactors = buildNetworkTransactors(mesh);
	};

	const transactorFor = (index: number): ITransactor => {
		const peerId = mesh.nodes[index]!.peerId.toString();
		const t = transactors.get(peerId);
		if (!t) throw new Error(`No transactor for peer ${peerId}`);
		return t;
	};

	/** A declares table + index, B re-declares both. No row exists yet, so the shared index
	 * value the writes are about to create is genuinely new and the index tree starts empty. */
	async function openTwoNodesOnEmptyIndex(indexSql = createIndexSql): Promise<Record<'A' | 'B', Node>> {
		await startMesh(2);
		const nodes = { A: createNode(transactorFor(0)), B: createNode(transactorFor(1)) };
		await nodes.A.db.exec(createTableSql);
		await nodes.A.db.exec(indexSql);
		await nodes.B.db.exec(createTableSql);
		await nodes.B.db.exec(indexSql);
		return nodes;
	}

	for (const order of WRITE_ORDERS) {
		it(`both rows survive when two nodes create the same index value from nothing (write=${order})`, async () => {
			const nodes = await openTwoNodesOnEmptyIndex();

			await runSharedKeyWrites(order, nodes, SHARED_TOKEN);

			await expectAllNodesConverged(nodes, [
				{ UsageStampId: STAMP_ID.A, Token: SHARED_TOKEN },
				{ UsageStampId: STAMP_ID.B, Token: SHARED_TOKEN },
			]);

			// Both writers' rows occupy DISTINCT index tree keys (`frame(Token) ‖ frame(pk)`),
			// so the committed tree must hold one entry per row from either node's viewpoint.
			// A merge that dropped one writer's block contribution shows up here as 1.
			for (const which of ['A', 'B'] as const) {
				const tree = await readTree(nodes[which].plugin, INDEX_URI);
				expect(
					tree.entries,
					`committed index entries seen from node ${which}`,
				).to.equal(2);
				// Negative control for the multi-block case at the bottom of this file: two
				// entries must report NOT split, or `split` is a constant and the assertion
				// there proves nothing.
				expect(
					tree.split,
					`a two-entry index tree must still be a single block (fan-out is ${NodeCapacity})`,
				).to.equal(false);
			}
		});
	}

	/*
	 * Three writers, not two. If a shared index value can lose contributions, the count that
	 * survives says WHICH failure it is: 1 surviving row is last-writer-wins over the whole
	 * group, 2 is a pairwise merge that drops one arm. Two writers cannot tell those apart.
	 */
	it('all three rows survive when three nodes create the same index value from nothing', async () => {
		await startMesh(3);
		const nodes: Record<Which, Node> = {
			A: createNode(transactorFor(0)),
			B: createNode(transactorFor(1)),
			C: createNode(transactorFor(2)),
		};
		for (const which of ['A', 'B', 'C'] as const) {
			await nodes[which].db.exec(createTableSql);
			await nodes[which].db.exec(createIndexSql);
		}

		// All three stage before any commits, so no writer's flush has seen another's.
		for (const which of ['A', 'B', 'C'] as const) {
			await nodes[which].db.exec('begin');
			await nodes[which].db.exec(insertSql(STAMP_ID[which], SHARED_TOKEN));
		}
		for (const which of ['A', 'B', 'C'] as const) {
			await nodes[which].db.exec('commit');
		}

		await expectAllNodesConverged(nodes, [
			{ UsageStampId: STAMP_ID.A, Token: SHARED_TOKEN },
			{ UsageStampId: STAMP_ID.B, Token: SHARED_TOKEN },
			{ UsageStampId: STAMP_ID.C, Token: SHARED_TOKEN },
		]);

		for (const which of ['A', 'B', 'C'] as const) {
			expect(
				await countTreeEntries(nodes[which].plugin, INDEX_URI),
				`committed index entries seen from node ${which}`,
			).to.equal(3);
		}
	});

	/*
	 * A UNIQUE index across two nodes. The downstream stack's other failing signature names a
	 * `_uniq_1` index collection and nothing covered a unique index across machines.
	 *
	 * The values here are DISTINCT on purpose. Two machines writing the SAME value into a
	 * unique index is a different question — uniqueness is enforced by reading the tree before
	 * the write (`optimystic-module.ts resolveSecondaryUniqueDecision`), so neither machine can
	 * see the other's uncommitted row and both admit; that is a known consequence of
	 * check-then-write without consensus-level constraint arbitration, not the convergence
	 * defect under test. What IS under test is that a unique index maintained by two machines
	 * still ends up holding both of their entries.
	 */
	it('a UNIQUE index maintained by two nodes holds both nodes\' entries', async () => {
		const nodes = await openTwoNodesOnEmptyIndex(createUniqueIndexSql);

		await nodes.A.db.exec('begin');
		await nodes.A.db.exec(insertSql(STAMP_ID.A, 'tok-a'));
		await nodes.B.db.exec('begin');
		await nodes.B.db.exec(insertSql(STAMP_ID.B, 'tok-b'));
		await nodes.A.db.exec('commit');
		await nodes.B.db.exec('commit');

		await expectAllNodesConverged(nodes, [
			{ UsageStampId: STAMP_ID.A, Token: 'tok-a' },
			{ UsageStampId: STAMP_ID.B, Token: 'tok-b' },
		]);

		for (const which of ['A', 'B'] as const) {
			expect(
				await countTreeEntries(nodes[which].plugin, INDEX_URI),
				`committed unique-index entries seen from node ${which}`,
			).to.equal(2);
		}
	});

	/*
	 * An index tree big enough to span more than one block. Every two-node case before this one
	 * writes three rows, so the whole index has always fitted in a single block and no case has
	 * ever merged two writers against a SPLIT tree. The preload size is derived from the btree's
	 * own fan-out constant rather than hard-coded, so raising `NodeCapacity` cannot silently turn
	 * this case back into a single-block one — and the case asserts the split it needs, so a
	 * change that stopped it splitting fails loudly instead of passing vacuously.
	 */
	const PRELOAD_ROWS = NodeCapacity + 16;

	it(`both rows survive when the index tree spans several blocks (${PRELOAD_ROWS} preloaded rows)`, async () => {
		await startMesh(2);
		const nodes = { A: createNode(transactorFor(0)), B: createNode(transactorFor(1)) };

		await nodes.A.db.exec(createTableSql);
		await nodes.A.db.exec(createIndexSql);

		// Preloaded tokens are zero-padded so they sort lexicographically, and the shared token
		// the two writers use sorts INTO the middle of them rather than off either end — so the
		// concurrent inserts land in an interior block rather than an edge one.
		const preloadToken = (i: number) => `tok-${String(i).padStart(3, '0')}`;
		await nodes.A.db.exec('begin');
		for (let i = 0; i < PRELOAD_ROWS; i++) {
			await nodes.A.db.exec(insertSql(1000 + i, preloadToken(i)));
		}
		await nodes.A.db.exec('commit');

		await nodes.B.db.exec(createTableSql);
		await nodes.B.db.exec(createIndexSql);

		// Suffixing the midpoint's token sorts the shared value immediately AFTER it and before
		// its successor — interior to the preloaded range, not off either end, whatever
		// PRELOAD_ROWS works out to.
		const midToken = `${preloadToken(PRELOAD_ROWS >> 1)}-shared`;
		await runSharedKeyWrites('staged-both', nodes, midToken);

		const expected = [
			...Array.from({ length: PRELOAD_ROWS }, (_, i) => ({
				UsageStampId: 1000 + i,
				Token: preloadToken(i),
			})),
			{ UsageStampId: STAMP_ID.A, Token: midToken },
			{ UsageStampId: STAMP_ID.B, Token: midToken },
		].sort((l, r) => l.UsageStampId - r.UsageStampId);

		await expectAllNodesConverged(nodes, expected);

		for (const which of ['A', 'B'] as const) {
			const tree = await readTree(nodes[which].plugin, INDEX_URI);
			expect(
				tree.entries,
				`committed index entries seen from node ${which}`,
			).to.equal(PRELOAD_ROWS + 2);
			expect(
				tree.split,
				`node ${which}'s index tree must actually span more than one block, or this case ` +
				`tests nothing the single-block cases above do not (fan-out is ${NodeCapacity})`,
			).to.equal(true);
		}
	});
});
