/**
 * Ticket: transaction-sweep-across-node-counts.
 *
 * ONE transaction scenario, run unchanged at one, two, three, four and five machines, with only the
 * expectations the documentation makes size-dependent changing between sizes. Every other transaction
 * spec fixes its node count and builds its own cohort configuration, so a defect that bites at exactly
 * one size has no sibling assertion at the size next to it to contrast with; this file is that contrast.
 *
 * Per size, in order, over one mesh (a phase whose predecessor failed fails at once, naming it):
 *
 *  1. **Every node writes, every node reads.** Each node commits its own row into one shared Tree — as
 *     the COORDINATOR of that write (see `transactorDrivenBy`) — and then every node reads every row.
 *     At one machine this is the solo short-circuit, which is the point of running it in the same loop.
 *  2. **Two nodes race the same row.** One of them wins the contested revision; every attempt that lost
 *     is answered with a returned conflict, never a throw of some other kind.
 *  3. **One member unreachable.** A write is acknowledged exactly where the reachable members can still
 *     meet every bar the documentation states, and refused where they cannot — with the refusal's shape
 *     pinned, and an acknowledgement checked against the members' own storage, not just its return value.
 *  4. **Acknowledged implies durable.** Every row that was ever acknowledged reads back, with its last
 *     acknowledged value, from every node that is still reachable.
 *
 * The configuration is the production-shaped one (`util/node-count-mesh.ts`): default replication factor,
 * the machine count declared only as `clusterPolicy.repairCorroborationClusterSize` — never the
 * `clusterSize: N` shortcut.
 *
 * A per-size table (bars, the expected and observed one-away outcome, the race, runtime) is printed at the
 * end so CI output shows the shape, not only pass/fail.
 */

import { expect } from 'chai';
import {
	Tree, SyncRetryExhaustedError, isConflictFailure, isFullyDurable,
	type ITransactor, type StaleFailure, type WriteDurability, type ActionId
} from '@optimystic/db-core';
import { resolveMeshPolicy, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';
import {
	createProductionShapedMesh, productionShapedMeshOptions, cohortOf, setUnreachable, transactorDrivenBy,
	recording, committed, durableHolders, expectPromiseShortfall, type Attempt
} from './util/node-count-mesh.js';
import { sequentialPhases } from './util/two-machine-lifecycle.js';

const SIZES = [1, 2, 3, 4, 5] as const;

// ── The documented arithmetic ────────────────────────────────────────────────────────────────────────
//
// packages/db-p2p/docs/cluster.md: the promise phase needs a super-majority, `ceil(0.75 × n)` approving
// promises ("Phase 1: Promise Collection"); the commit phase needs a simple majority, ">50%" ("Phase 2: Commit
// Execution"), which `ClusterCoordinator` computes as `floor(0.51 × n) + 1`. docs/correctness.md / `CoordinatorRepo.commit`: the
// writer is acknowledged only when durable holders, the coordinator included, are a strict majority of the
// cohort. A cohort of one runs none of it (the solo short-circuit).
//
// The fractions are written out rather than imported so that a change to a default fails HERE, next to the
// documentation it would contradict — the first phase cross-checks them against what the mesh resolves.

const DOCUMENTED_PROMISE_FRACTION = 0.75;
const DOCUMENTED_COMMIT_FRACTION = 0.51;

const promiseBar = (n: number): number => Math.ceil(n * DOCUMENTED_PROMISE_FRACTION);
const commitBar = (n: number): number => Math.floor(n * DOCUMENTED_COMMIT_FRACTION) + 1;
const durableBar = (n: number): number => Math.floor(n / 2) + 1;

/** Whether a write is acknowledged with exactly one of `n` cohort members unreachable: the `n − 1` that
 *  remain must clear every bar above. */
const acknowledgedWithOneAway = (n: number): boolean => {
	const reachable = n - 1;
	return reachable >= promiseBar(n) && reachable >= commitBar(n) && reachable >= durableBar(n);
};

/** The same answer written out by hand, as the size table in ticket `6.5-docs-one-durability-bar-one-size-floor`
 *  states it (the docs do not yet carry it in one place — that ticket gives them one): two needs both, three
 *  needs all three, four tolerates one, five needs four and tolerates one. Compared against the arithmetic so a
 *  slip in either shows up as a disagreement rather than as a quietly wrong expectation.
 *
 *  At every one of these sizes it is the PROMISE bar that binds: whenever the reachable members clear it they
 *  also clear the commit and durability bars. So the refusal this sweep meets is always the promise-phase
 *  shortfall, never the durability gate's `COMMIT_NOT_DURABLE_REASON` refusal — that one needs a member that
 *  promised and then failed to store, and `commit-durability-quorum.spec.ts` pins it at a two-member cohort. */
const DOCUMENTED_ONE_AWAY: Record<number, 'acknowledged' | 'refused'> = { 2: 'refused', 3: 'refused', 4: 'acknowledged', 5: 'acknowledged' };

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;
const TREE_ID = 'node-count-sweep';

/** A fresh Tree handle through `transactor` — no staged or cached state from an earlier handle answers. */
async function readRow(transactor: ITransactor, key: string): Promise<string | undefined> {
	const tree = await Tree.open<string, Row>(transactor, TREE_ID, keyOf);
	expect(tree, 'the shared tree opens').to.not.equal(undefined);
	return (await tree!.get(key))?.value;
}

const peerLabel = (mesh: Mesh, node: MeshNode): string => `node ${mesh.nodes.indexOf(node)}`;

// ── The per-size report ──────────────────────────────────────────────────────────────────────────────

interface SweepRow {
	size: number;
	promiseBar: string;
	expectedOneAway: string;
	observedOneAway: string;
	race: string;
	runtimeMs?: number;
}

function renderTable(rows: readonly SweepRow[]): string {
	const header = ['size', 'promise bar', 'expected, one member away', 'observed, one member away', 'two writers racing one row', 'runtime'];
	const body = rows.map(r => [String(r.size), r.promiseBar, r.expectedOneAway, r.observedOneAway, r.race, r.runtimeMs === undefined ? 'incomplete' : `${r.runtimeMs}ms`]);
	const widths = header.map((h, i) => Math.max(h.length, ...body.map(line => line[i]!.length)));
	const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i]!)).join(' | ');
	return ['', 'Transaction sweep across node counts:', line(header), widths.map(w => '-'.repeat(w)).join('-|-'), ...body.map(line), ''].join('\n');
}

describe('Transaction sweep across node counts (one scenario at 1–5 machines)', function () {
	this.timeout(60_000);

	const report: SweepRow[] = [];
	// Taken when the suite starts RUNNING — describe bodies all execute at load time, long before any test.
	let sweepStartedAt: number;
	before(() => { sweepStartedAt = Date.now(); });
	after(() => {
		console.log(renderTable(report) + `total: ${Date.now() - sweepStartedAt}ms\n`);
	});

	it('the documented arithmetic yields the documented one-member-away table, under the policy the mesh resolves', () => {
		for (const size of SIZES) {
			const resolved = resolveMeshPolicy(productionShapedMeshOptions(size));
			expect(resolved.superMajorityThreshold, `size ${size}: the promise fraction the mesh runs`).to.equal(DOCUMENTED_PROMISE_FRACTION);
			expect(resolved.simpleMajorityThreshold, `size ${size}: the commit fraction the mesh runs`).to.equal(DOCUMENTED_COMMIT_FRACTION);
			expect(resolved.repairCorroborationClusterSize, `size ${size}: the declared machine count`).to.equal(size);
			expect(resolved.clusterSize, `size ${size}: the replication factor stays at its default, not the machine count`).to.equal(10);
		}
		const derived = Object.fromEntries(SIZES.filter(n => n > 1).map(n => [n, acknowledgedWithOneAway(n) ? 'acknowledged' : 'refused']));
		expect(derived).to.deep.equal(DOCUMENTED_ONE_AWAY);
	});

	for (const size of SIZES) {
		describe(`${size} machine${size === 1 ? '' : 's'}`, function () {
			sequentialPhases();

			let mesh: Mesh;
			let startedAt: number;
			/** Every pend/commit issued in this size's run, across every driver. */
			const attempts: Attempt[] = [];
			/** The last acknowledged value of every row — what phase 4 must read back. */
			const acknowledged = new Map<string, string>();
			const row: SweepRow = {
				size,
				promiseBar: size === 1 ? 'n/a (solo)' : `${promiseBar(size)} of ${size}`,
				expectedOneAway: size === 1 ? 'n/a' : (acknowledgedWithOneAway(size) ? 'acknowledged' : 'refused'),
				observedOneAway: 'not run',
				race: 'not run'
			};
			report.push(row);

			/** A recording transactor that `node` coordinates. A fresh transactor per use, so no coordinator
			 *  cache or pending-action state carries between phases. `routes` collects every peer it reached for. */
			const driven = (node: MeshNode, into: Attempt[] = attempts, routes?: string[]): ITransactor =>
				recording(transactorDrivenBy(mesh, node, { onRoute: peer => routes?.push(peer) }), into);

			before(async () => {
				startedAt = Date.now();
				mesh = await createProductionShapedMesh(size);
			});

			it('every node commits its own row, and every node reads every row', async () => {
				for (const [index, node] of mesh.nodes.entries()) {
					const routes: string[] = [];
					const tree = await Tree.createOrOpen<string, Row>(driven(node, attempts, routes), TREE_ID, keyOf);
					const value = `written-by-node-${index}`;
					const durability = await tree.replace([[`row-${index}`, { key: `row-${index}`, value }]]);
					// The write was coordinated by the node that made it — every read, pend and commit went to it —
					// not funnelled through whichever node proximity routing happens to prefer. Without this the
					// sweep would quietly exercise one coordinating node N times.
					expect([...new Set(routes)], `node ${index}'s write reached only node ${index}`).to.deep.equal([node.peerId.toString()]);
					expect(durability, `node ${index}'s write reports who holds it`).to.not.equal(undefined);
					if (size === 1) {
						// The solo short-circuit: no consensus ran, and the answer says so.
						expect(durability!.quorum, 'a one-machine write is a local write').to.equal('local');
						expect(durability!.cohort).to.equal(1);
					} else {
						expect(isFullyDurable(durability!), `node ${index}'s write, with every member reachable: ${JSON.stringify(durability)}`).to.equal(true);
						expect(durability!.cohort, `node ${index}'s write ran on the whole mesh`).to.equal(size);
					}
					acknowledged.set(`row-${index}`, value);
				}

				expect(committed(attempts).length, 'one committed action per node').to.equal(size);

				// Every block the scenario wrote has the whole mesh as its cohort: with the default replication
				// factor that is what these sizes mean, and the one-away arithmetic below depends on it.
				const everyNode = mesh.nodes.map(n => n.peerId.toString()).sort();
				for (const commit of committed(attempts)) {
					for (const blockId of commit.blockIds) {
						expect((await cohortOf(mesh, blockId)).sort(), `block ${blockId}'s cohort is every node`).to.deep.equal(everyNode);
					}
					expect((await durableHolders(mesh.nodes, commit)).length, `every node's own storage holds action ${commit.actionId}`).to.equal(size);
				}

				for (const [readerIndex, reader] of mesh.nodes.entries()) {
					for (const [key, value] of acknowledged) {
						expect(await readRow(driven(reader), key), `node ${readerIndex} reads ${key}`).to.equal(value);
					}
				}
			});

			if (size === 1) {
				it('two nodes racing one row — does not apply: one machine has no second node to race', () => {
					// Registered rather than silently absent, so the run shows this arm was considered at this size.
					expect(mesh.nodes.length).to.equal(1);
					row.race = 'n/a: no second writer';
				});
			} else {
				it('two nodes racing one row: one action wins the contested revision, and every lost attempt is a returned conflict', async () => {
					const [nodeA, nodeB] = [mesh.nodes[0]!, mesh.nodes[1]!];
					const raceAttempts = { a: [] as Attempt[], b: [] as Attempt[] };
					// Both handles open before either writes, so both stage against the same revision.
					const treeA = await Tree.createOrOpen<string, Row>(driven(nodeA, raceAttempts.a), TREE_ID, keyOf);
					const treeB = await Tree.createOrOpen<string, Row>(driven(nodeB, raceAttempts.b), TREE_ID, keyOf);
					const contested = 'contested';
					const values = { a: 'raced-by-node-0', b: 'raced-by-node-1' };

					const [outcomeA, outcomeB] = await Promise.allSettled([
						treeA.replace([[contested, { key: contested, value: values.a }]]),
						treeB.replace([[contested, { key: contested, value: values.b }]])
					]);
					attempts.push(...raceAttempts.a, ...raceAttempts.b);

					const all = [...raceAttempts.a, ...raceAttempts.b];
					const describeAttempts = (list: readonly Attempt[]): string => list.map(a =>
						`${a.kind}@${a.rev}:${a.thrown !== undefined ? `threw ${String((a.thrown as Error)?.message ?? a.thrown)}` : a.result!.success ? 'ok' : `refused ${(a.result as StaleFailure).reason ?? ''}`}`).join(', ');

					// They really raced: both first pends asked for the same revision.
					const firstA = raceAttempts.a.find(a => a.kind === 'pend');
					const firstB = raceAttempts.b.find(a => a.kind === 'pend');
					expect(firstA?.rev, `both writers requested a revision (${describeAttempts(all)})`).to.be.a('number');
					expect(firstB?.rev, 'the two writers raced for the same revision').to.equal(firstA!.rev);
					const contestedRev = firstA!.rev!;

					// A lost attempt is ANSWERED as a conflict — a returned StaleFailure the retry loop recognizes —
					// never thrown as some other kind of fault.
					const threw = all.filter(a => a.thrown !== undefined);
					expect(threw.map(a => `${a.kind}@${a.rev}: ${String((a.thrown as Error)?.message ?? a.thrown)}`), 'no pend or commit threw during the race').to.deep.equal([]);
					const refused = all.filter(a => a.result?.success === false);
					for (const lost of refused) {
						expect(isConflictFailure(lost.result as StaleFailure), `lost ${lost.kind}@${lost.rev} is conflict-shaped: ${JSON.stringify(lost.result)}`).to.equal(true);
					}

					// Exactly one action committed the contested revision. Deliberately NOT "one writer wins the first
					// round": both racing pends can reach pend consensus, each member's storage then keeps whichever
					// pending record reached it first, and both coordinators hear a cohort refusal
					// (`CoordinatorRepo.pendThroughCluster`, `cohortPendRefusals`) — an all-lose round that the retry
					// loop's jittered backoff separates. The guarantee is that no revision is ever won twice, and
					// that is what is asserted; how the first round went is reported in the table.
					const winnersByRev = new Map<number, Set<ActionId>>();
					for (const commit of committed(all)) {
						winnersByRev.set(commit.rev!, (winnersByRev.get(commit.rev!) ?? new Set()).add(commit.actionId));
					}
					expect(winnersByRev.get(contestedRev)?.size, `actions that committed rev ${contestedRev} (${describeAttempts(all)})`).to.equal(1);
					// ...and no LATER revision either: a loser that rebased and retried must not collide again unseen.
					const wonTwice = [...winnersByRev].filter(([, actions]) => actions.size > 1).map(([rev]) => rev);
					expect(wonTwice, `revisions committed by more than one action (${describeAttempts(all)})`).to.deep.equal([]);

					// At the application: each write either landed (the loser rebased onto the winner) or gave up with
					// the retry loop's own typed error — nothing else.
					for (const [label, outcome] of [['node 0', outcomeA], ['node 1', outcomeB]] as const) {
						if (outcome.status === 'rejected') {
							expect(outcome.reason, `${label}'s write may only give up as retry exhaustion: ${String(outcome.reason)}`).to.be.instanceOf(SyncRetryExhaustedError);
						}
					}
					const landed = [outcomeA, outcomeB].filter(o => o.status === 'fulfilled').length;
					expect(landed, 'at least one of the two writes lands').to.be.at.least(1);

					// Every node agrees on the row, and it holds the value of the write that committed LAST.
					const lastCommitRev = (list: readonly Attempt[]): number => Math.max(-1, ...committed(list).map(a => a.rev!));
					const lastWriter = lastCommitRev(raceAttempts.a) > lastCommitRev(raceAttempts.b) ? values.a : values.b;
					for (const [readerIndex, reader] of mesh.nodes.entries()) {
						expect(await readRow(driven(reader), contested), `node ${readerIndex} reads the last committed value of the contested row`).to.equal(lastWriter);
					}
					acknowledged.set(contested, lastWriter);

					// The first round, for the report: did a writer's very first pend and commit both land?
					const wonFirstRound = (list: readonly Attempt[]): boolean =>
						list[0]?.kind === 'pend' && list[0].result?.success === true && list[1]?.kind === 'commit' && list[1].result?.success === true;
					const firstRound = wonFirstRound(raceAttempts.a) ? 'node 0 won' : wonFirstRound(raceAttempts.b) ? 'node 1 won' : 'both lost';
					const contestedWinner = committed(raceAttempts.a).some(a => a.rev === contestedRev) ? 0 : 1;
					row.race = `round 1: ${firstRound}; ${refused.length} lost attempt(s), all conflicts; rev ${contestedRev} won by node ${contestedWinner}; ${landed} of 2 landed`;
				});
			}

			if (size === 1) {
				it('one member unreachable — does not apply: a cohort of one has no other member to lose', () => {
					expect(mesh.nodes.length).to.equal(1);
					row.observedOneAway = 'n/a';
				});
			} else {
				const expectAcknowledged = acknowledgedWithOneAway(size);
				it(`one member unreachable: the write is ${expectAcknowledged ? 'acknowledged' : 'refused'} (promise bar ${promiseBar(size)} of ${size}, ${size - 1} reachable)`, async () => {
					const writer = mesh.nodes[0]!;
					const away = mesh.nodes[size - 1]!;
					setUnreachable(mesh, [away]);
					// NOTE: this is the UNCHANGED-VIEW case — the key network still names `away` as a cohort member,
					// so the cohort the write runs on is the full mesh. At two machines it is therefore a
					// deterministic refusal, and says nothing about the lone-survivor question (a survivor whose
					// routing view has dropped its partner), which is under design in
					// backlog/more-design/6.5-partition-healing.md and deliberately not asserted anywhere.

					const oneAwayAttempts: Attempt[] = [];
					const tree = await Tree.createOrOpen<string, Row>(driven(writer, oneAwayAttempts), TREE_ID, keyOf);
					const key = 'while-one-away';
					const value = `written-while-${peerLabel(mesh, away)}-away`;
					const startedWrite = Date.now();
					let durability: WriteDurability | undefined;
					let refusal: unknown;
					try {
						durability = await tree.replace([[key, { key, value }]]);
					} catch (err) {
						refusal = err;
					}
					// NOTE: a refusal's elapsed time here (~1 s at two and three machines, measured 2026-09-16) is almost
					// all the transactor's cancel loop, not the refusal: a cancel is itself a cluster transaction, so with
					// the same member away it misses its own super-majority and spends all six cancel rounds
					// (`NetworkTransactor.MAX_CANCEL_ROUNDS`). Reported in the table, not asserted; tracked as an arm of
					// backlog `debt-unpromotable-pending-records-need-a-sweep`.
					const elapsedMs = Date.now() - startedWrite;
					attempts.push(...oneAwayAttempts);

					if (expectAcknowledged) {
						expect(refusal, `with ${size - 1} of ${size} reachable the write must be acknowledged: ${String((refusal as Error)?.message ?? refusal)}`).to.equal(undefined);
						// The answer names exactly the member that is away.
						expect(durability, 'an acknowledged write reports who holds it').to.not.equal(undefined);
						expect(durability!.quorum, JSON.stringify(durability)).to.equal('majority');
						expect(durability!.cohort).to.equal(size);
						expect(durability!.confirmed).to.equal(size - 1);
						expect(durability!.unconfirmed).to.deep.equal([away.peerId.toString()]);
						// ...and it is not merely a returned success: every committed action is held by a strict
						// majority of the cohort's OWN storage, and not by the member that was away.
						const commits = committed(oneAwayAttempts);
						expect(commits.length, 'the acknowledged write committed').to.be.at.least(1);
						for (const commit of commits) {
							const holders = await durableHolders(mesh.nodes, commit);
							// At least as many as the answer claimed — the reported count is storage fact, not optimism.
							expect(holders.length, `holders of action ${commit.actionId}`).to.be.at.least(Math.max(durableBar(size), durability!.confirmed));
							expect(holders, 'the unreachable member cannot hold it').to.not.include(away);
						}
						acknowledged.set(key, value);
						row.observedOneAway = `acknowledged (${durability!.confirmed} of ${durability!.cohort} hold it) in ${elapsedMs}ms`;
					} else {
						expect(refusal, `with ${size - 1} of ${size} reachable the write must be refused (it returned ${JSON.stringify(durability)})`).to.not.equal(undefined);
						// The shape an application sees — see `expectPromiseShortfall`.
						const { approvals, peers, needed, rejections } = expectPromiseShortfall(refusal);
						expect({ approvals, peers, needed, rejections }, 'the numbers an application would branch on')
							.to.deep.equal({ approvals: size - 1, peers: size, needed: promiseBar(size), rejections: 0 });
						// Nothing committed, so no reachable node reads the refused row.
						expect(committed(oneAwayAttempts).length, 'a refused write commits nothing').to.equal(0);
						for (const reader of mesh.nodes.filter(n => n !== away)) {
							expect(await readRow(driven(reader), key), `${peerLabel(mesh, reader)} does not read the refused row`).to.equal(undefined);
						}
						row.observedOneAway = `refused (${approvals}/${peers} promises, needed ${needed}) in ${elapsedMs}ms`;
					}
				});
			}

			it('every acknowledged row reads back, with its last acknowledged value, from every reachable node', async () => {
				const reachable = mesh.nodes.filter(n => !mesh.failures.failingPeers?.has(n.peerId.toString()));
				expect(acknowledged.size, 'the scenario acknowledged rows to check').to.be.at.least(size);
				const wrong: string[] = [];
				for (const reader of reachable) {
					for (const [key, value] of acknowledged) {
						const read = await readRow(driven(reader), key);
						if (read !== value) wrong.push(`${peerLabel(mesh, reader)} read ${key} as ${read ?? 'absent'}, expected ${value}`);
					}
				}
				expect(wrong).to.deep.equal([]);
				row.runtimeMs = Date.now() - startedAt;
			});
		});
	}
});
