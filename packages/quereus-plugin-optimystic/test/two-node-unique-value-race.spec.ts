/**
 * Two writers on two mesh nodes insert, in the same tick, different rows carrying the SAME value
 * in a UNIQUE column. Exactly one may land, and the loser must leave NOTHING behind — not its
 * table row, not its plain-index entry, not a torn store.
 *
 * Reported from the field (sereus, two real nodes, 6 of 6 rounds; GitHub issue #17 is the
 * same tear reached from a pend conflict) and reproduced here on the in-process two-node mock
 * mesh. Before the legacy multi-tree commit went through one pend-all-then-commit-all batch,
 * the loser's main-table row was committed on its own retry — a different primary key replays
 * fine — and only the unique-index tree, flushed later, refused it: the row was stored on both
 * nodes without its unique-index entry, and the writer got a `PartialCommitError`.
 *
 * The mock mesh rather than the libp2p integration harness: `startMockMesh(2)` gives each node
 * its own transactor over a real in-process cluster (pend conflicts, cancels, race resolution
 * all run), it reproduced 6 of 6 in about a second, and it runs under plain `yarn test`.
 *
 * The committed-state assertions read each tree through a FRESH Tree on the node's own
 * transactor (`countTreeEntries`) — what consensus persisted, around the vtab — because the
 * defect is precisely that the query path can look right while a tree holds an orphan.
 */
import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import { CoordinatorPartialCommitError } from '@optimystic/db-core';
import { PartialCommitError, uniqueEnforcementTreeName } from '../dist/index.js';
import { countTreeEntries, createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';

const ROUNDS = 6;

/** The two table shapes the field report tore under: a unique column alone, and a unique column
 * beside a plain index (a third tree in the same commit, flushed before the unique one). */
const SHAPES = ['unique-only', 'with-plain-index'] as const;
type Shape = typeof SHAPES[number];

type Nodes = [MeshDbNode, MeshDbNode];

/** Every tree one insert into `T` dirties, by collection URI, for `countTreeEntries`. */
function treesOf(uri: string, shape: Shape): string[] {
	const trees = [uri, `${uri}/index/${uniqueEnforcementTreeName(['v'])}`];
	if (shape === 'with-plain-index') trees.push(`${uri}/index/T_g`);
	return trees;
}

async function selectRows(node: MeshDbNode): Promise<{ id: number; v: string }[]> {
	const rows: { id: number; v: string }[] = [];
	for await (const row of node.db.eval('select id, v from T order by id')) {
		const r = row as Record<string, SqlValue>;
		rows.push({ id: Number(r.id), v: String(r.v) });
	}
	return rows;
}

/** Two fresh nodes on a fresh two-node mesh, both declaring `T` over `uri` in `shape`. */
async function twoNodes(uri: string, shape: Shape): Promise<Nodes> {
	const { transactorFor } = await startMockMesh(2);
	const nodes: Nodes = [createMeshDbNode(transactorFor(0)), createMeshDbNode(transactorFor(1))];
	const ddl = `create table T (id integer primary key, g text not null, v text not null unique) using optimystic('${uri}')`;
	for (const node of nodes) {
		await node.db.exec(ddl);
		if (shape === 'with-plain-index') await node.db.exec('create index T_g on T (g)');
	}
	return nodes;
}

/** Whether any error in a rejection's cause chain is a partial-commit signal of either kind
 * (the legacy per-tree tear, or the coordinator's commit-phase residual). */
function isPartialCommit(reason: unknown): boolean {
	for (let cursor: unknown = reason; cursor instanceof Error; cursor = cursor.cause) {
		if (cursor instanceof PartialCommitError || cursor instanceof CoordinatorPartialCommitError) return true;
	}
	return false;
}

interface RaceOutcome {
	/** Index into the nodes tuple of the writer whose insert fulfilled. */
	winner: 0 | 1;
	/** The loser's rejection message. */
	message: string;
	partial: boolean;
	/** Both settlements rendered, for assertion messages. */
	outcomes: string;
}

/** Run one insert per node in the same tick; exactly one must fulfil. */
async function race([a, b]: Nodes, insertA: string, insertB: string): Promise<RaceOutcome> {
	const results = await Promise.allSettled([a.db.exec(insertA), b.db.exec(insertB)]);
	const outcomes = results
		.map(r => (r.status === 'fulfilled' ? 'fulfilled' : `rejected: ${String(r.reason)}`))
		.join(' | ');
	const fulfilled = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
	expect(fulfilled, `exactly one writer wins (${outcomes})`).to.have.length(1);
	const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
	const reason: unknown = rejected.reason;
	return {
		winner: fulfilled[0] as 0 | 1,
		message: reason instanceof Error ? reason.message : String(reason),
		partial: isPartialCommit(reason),
		outcomes,
	};
}

/** The loser's rejection is the ordinary constraint refusal of a clean rollback. */
function expectCleanRefusal(outcome: RaceOutcome, pattern: RegExp, label: string): void {
	expect(outcome.message, `${label}: the loser is refused with the constraint message (${outcome.outcomes})`).to.match(pattern);
	expect(outcome.partial, `${label}: the refusal is a clean rollback, not a torn commit (${outcome.outcomes})`).to.equal(false);
	expect(outcome.message.toLowerCase(), `${label}: no partial-commit text (${outcome.outcomes})`).to.not.contain('not atomic');
}

/** Every node reads exactly the winner's row, and every tree the insert touches holds exactly
 * one committed entry — the loser left nothing in any of them. */
async function expectOnlyTheWinner(nodes: Nodes, uri: string, shape: Shape, winnerRow: { id: number; v: string }, label: string): Promise<void> {
	for (const [i, node] of nodes.entries()) {
		expect(await selectRows(node), `${label}: node ${i} reads only the winner's row`).to.deep.equal([winnerRow]);
		for (const tree of treesOf(uri, shape)) {
			expect(await countTreeEntries(node.plugin, tree), `${label}: node ${i} sees exactly one entry in ${tree}`).to.equal(1);
		}
	}
}

describe('Two-node same-instant race on a UNIQUE value (legacy commit)', function () {
	this.timeout(120_000);

	for (const shape of SHAPES) {
		it(`${shape}: the loser is refused with the UNIQUE message and NOTHING of its write is stored`, async () => {
			for (let round = 0; round < ROUNDS; round++) {
				const label = `${shape} round ${round}`;
				const uri = `tree://race/${shape}-${round}`;
				const nodes = await twoNodes(uri, shape);
				// Different primary keys, one shared unique value.
				const outcome = await race(
					nodes,
					`insert into T (id, g, v) values (1, 'g', 'x')`,
					`insert into T (id, g, v) values (2, 'g', 'x')`,
				);
				expectCleanRefusal(outcome, /UNIQUE constraint failed: T\.v/, label);
				await expectOnlyTheWinner(nodes, uri, shape, { id: outcome.winner + 1, v: 'x' }, label);
			}
		});
	}

	it('mirror race — same primary key, different unique values: the loser is refused on the key and leaves no orphan index entry', async () => {
		// The mirror of the value race. Flushing the unique-index trees FIRST would have closed
		// the value race but opened this one: both writers' index entries would land and the
		// main table would then refuse one of them, leaving a unique value that no row carries
		// but that refuses every later insert of it. One pended batch closes both.
		const shape = 'with-plain-index';
		for (let round = 0; round < ROUNDS; round++) {
			const label = `mirror round ${round}`;
			const uri = `tree://race/same-pk-${round}`;
			const nodes = await twoNodes(uri, shape);
			const values = ['x', 'y'] as const;
			const outcome = await race(
				nodes,
				`insert into T (id, g, v) values (1, 'g', '${values[0]}')`,
				`insert into T (id, g, v) values (1, 'g', '${values[1]}')`,
			);
			expectCleanRefusal(outcome, /UNIQUE constraint failed: T\.id/, label);
			await expectOnlyTheWinner(nodes, uri, shape, { id: 1, v: values[outcome.winner] }, label);

			// The refused value is reusable under a fresh key, from the loser's own node: no
			// orphan unique-index entry stands in its way.
			const loser = nodes[1 - outcome.winner]!;
			const refusedValue = values[1 - outcome.winner]!;
			await loser.db.exec(`insert into T (id, g, v) values (2, 'g', '${refusedValue}')`);
			for (const [i, node] of nodes.entries()) {
				expect((await selectRows(node)).map(r => r.id), `${label}: node ${i} reads both rows after reusing the refused value`)
					.to.deep.equal([1, 2]);
			}
		}
	});
});
