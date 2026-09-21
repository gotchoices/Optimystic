/**
 * Ticket: a-member-that-leaves-mid-session-and-returns.
 *
 * What a phone actually does to a group: it is there, it goes to sleep while the others keep working, and it
 * comes back needing everything it missed. Every other spec above two machines only covers a member that was
 * missing from boot — nothing was missed while it was gone, so nothing has to heal when it returns. This one
 * runs the whole episode at THREE machines on the in-process mesh, with the production-shaped configuration
 * (`util/node-count-mesh.ts`: default replication factor, machine count declared only as
 * `clusterPolicy.repairCorroborationClusterSize`). Three, not two, so it asserts a documented rule: the
 * two-machine lone-survivor rule is under design (backlog/more-design/6.5-partition-healing.md) and is not
 * asserted here.
 *
 * ## How anything commits while a member is away, at three machines
 *
 * It mostly cannot. Every cluster transaction — a pend, each commit step, a cancel — needs promises from
 * `ceil(0.75 × 3)` = all three members (`transaction-node-count-sweep.spec.ts` pins the refusal). What CAN
 * complete without a member is a transaction it had already promised: the commit phase needs only a simple
 * majority (`floor(0.51 × 3) + 1` = 2) and the durability gate a strict majority (2). So C leaves in the
 * middle of A's write — after promising the write's final commit step, before voting on it — and the write is
 * acknowledged by A and B, naming C as the member that does not hold it. That is the one documented way C can
 * come back behind.
 *
 * Why the FINAL step — the one carrying the write's non-tail blocks. On this mesh one coordinator covers every
 * block, so `NetworkTransactor.commit` sends the tail and the rest as one round, and that is the only commit
 * step. Were the write split into a tail round and a sweep of the rest, C lost during the tail round would miss
 * the sweep's own promise round, leaving the sweep short of its all-three bar: the write would be acknowledged
 * torn and the pending record it abandons could not be cancelled (a cancel needs the same all-three bar) until
 * the member returns. That residual is owned by backlog `debt-unpromotable-pending-records-need-a-sweep`; it is
 * not the healing this spec is about.
 *
 * ## Two arms: how long C was away
 *
 * What brings C current depends on whether anyone still owes it the commit it missed:
 *  - **short** — C returns while the writer's scheduled commit retry (`ClusterCoordinator.scheduleCommitRetry`)
 *    is still running, and that retry delivers the commit before C does anything at all;
 *  - **long** — the writer restarts while C is away, taking the retry with it (the mesh wires no transaction
 *    state store, so the restarted writer recovers no retry; a phone asleep for longer than the retry schedule
 *    ends the same way), so C returns owed nothing and its own reads must bring it current. C missed the
 *    write's only commit step, so it lacks the write's log tail as well as its data blocks, and until its
 *    read-repair window lapses its reads serve its own older copy of the tail without asking anyone. A long
 *    absence outlasts that window too (10 s by default), and this arm waits it out.
 *    What does it then, observed under full debug logging: C's first read of the tail consults the cohort,
 *    A and B corroborate the newer revision, and C restores it (`cluster-tx:read-repair-applied`). The data
 *    blocks need no fetch: C still holds the pending records it stored when it promised the write, and a read
 *    carrying the collection context the restored tail provides promotes them in C's own storage (the
 *    read-driven promotion in `StorageRepo.get`).
 *
 * ## Phases, per arm, over one mesh (a phase whose predecessor failed fails at once, naming it)
 *
 *  1. **Whole group.** Each machine commits its own row; every machine reads every row.
 *  2. **C leaves mid-write.** Acknowledged by A and B; C's own storage lacks the write.
 *  3. **While C is away.** B's write is refused with the typed promise shortfall; A and B still read every
 *     acknowledged row.
 *  4. **C returns.** C's OWN storage comes to hold the write it missed — not merely a copy it fetched — and C
 *     reads every acknowledged row.
 *  5. **Two of three restart** (B and C) over their own storage and identity: every acknowledged row reads on
 *     all three, and a fresh write from each is read by the other two.
 *
 * A per-arm summary (how long C was away, the refusal's latency, what healed C and how fast) prints at the end.
 */

import { expect } from 'chai';
import { Tree, isFullyDurable, type ClusterRecord, type CommitRequest, type ITransactor, type WriteDurability } from '@optimystic/db-core';
import { delay, waitFor } from '@optimystic/db-core/test';
import type { Mesh, MeshNode } from '../src/testing/mesh-harness.js';
import {
	createProductionShapedMesh, setUnreachable, transactorDrivenBy,
	recording, committed, durableHolders, expectPromiseShortfall, type Attempt
} from './util/node-count-mesh.js';
import { sequentialPhases } from './util/two-machine-lifecycle.js';

const MACHINES = 3;
const TREE_ID = 'member-leaves-and-returns';

/**
 * The writer's commit-retry schedule, written out from the defaults `CoordinatorRepo` hands
 * `ClusterCoordinator` (`commitBroadcastRetryInitialMs` 250, backoff factor 2, `commitBroadcastRetryMaxAttempts`
 * 5): one delivery attempt this long after each previous one, starting from the missed broadcast. Written out
 * rather than read back so a change to a default fails the short arm's premise here, by name.
 */
const COMMIT_RETRY_INTERVALS_MS = [250, 500, 1_000, 2_000, 4_000];
const COMMIT_RETRY_SCHEDULE_MS = COMMIT_RETRY_INTERVALS_MS.reduce((total, interval) => total + interval, 0);
/** Slack on top of the schedule for the retry's own delivery and apply. */
const RETRY_DELIVERY_SLACK_MS = 1_000;
/**
 * How long a coordinator serves its own copy of a block before a read consults the cohort again — the
 * `readRepairWindowMs` default `CoordinatorRepo` applies. Written out for the same reason as the retry
 * schedule: the long arm's premise is an absence longer than this.
 */
const READ_REPAIR_WINDOW_MS = 10_000;
/** Slack past the window, so no read in the long arm's phase 4 lands at its edge. */
const READ_REPAIR_WINDOW_SLACK_MS = 250;

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;

interface AbsenceArm {
	readonly name: 'short' | 'long';
	readonly title: string;
	/** Restart the writer while C is away, so the commit retry it owed C is lost. */
	readonly writerRestartsWhileAway: boolean;
}

const ARMS: readonly AbsenceArm[] = [
	{ name: 'short', title: 'a short absence: C returns while the writer still owes it the commit', writerRestartsWhileAway: false },
	{ name: 'long', title: 'a long absence: the writer restarts while C is away, so C returns owed nothing', writerRestartsWhileAway: true }
];

interface ArmReport {
	arm: string;
	awayMs?: number;
	refusal?: string;
	heal?: string;
	runtimeMs?: number;
}

function renderReport(reports: readonly ArmReport[]): string {
	const header = ['arm', 'C away for', 'B\'s write while C away', 'what brought C current', 'runtime'];
	const body = reports.map(r => [r.arm, r.awayMs === undefined ? 'not run' : `${r.awayMs}ms`, r.refusal ?? 'not run', r.heal ?? 'not run', r.runtimeMs === undefined ? 'incomplete' : `${r.runtimeMs}ms`]);
	const widths = header.map((h, i) => Math.max(h.length, ...body.map(line => line[i]!.length)));
	const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i]!)).join(' | ');
	return ['', 'A member that leaves mid-session and returns (three machines):', line(header), widths.map(w => '-'.repeat(w)).join('-|-'), ...body.map(line), ''].join('\n');
}

describe('A member that leaves mid-session and returns (three machines)', function () {
	this.timeout(30_000);

	const reports: ArmReport[] = [];
	after(() => {
		console.log(renderReport(reports));
	});

	for (const arm of ARMS) {
		describe(arm.title, function () {
			sequentialPhases();

			let mesh: Mesh;
			let a: MeshNode;
			let b: MeshNode;
			let c: MeshNode;
			let startedAt: number;
			/** Every pend and commit issued in this arm, across every driver. */
			const attempts: Attempt[] = [];
			/** The last acknowledged value of every row. */
			const acknowledged = new Map<string, string>();
			/** The commit C missed by leaving mid-write — what phase 4 waits for C's own storage to hold. */
			let missed: Attempt;
			/** When C became unreachable. */
			let leftAt: number;
			const report: ArmReport = { arm: arm.name };
			reports.push(report);

			const label = (node: MeshNode): string => 'ABC'[mesh.nodes.indexOf(node)]!;
			/** A fresh recording transactor that `node` coordinates — no coordinator cache or pending-action state
			 *  carries between uses. */
			const driven = (node: MeshNode, into: Attempt[] = attempts): ITransactor => recording(transactorDrivenBy(mesh, node), into);
			const holdersOf = async (commit: Attempt): Promise<string[]> => (await durableHolders(mesh.nodes, commit)).map(label);

			async function write(writer: MeshNode, key: string, value: string, into: Attempt[] = attempts): Promise<WriteDurability | undefined> {
				const tree = await Tree.createOrOpen<string, Row>(driven(writer, into), TREE_ID, keyOf);
				return await tree.replace([[key, { key, value }]]);
			}

			/** What `reader` reads at `key` through a freshly opened tree. */
			async function read(reader: MeshNode, key: string): Promise<string | undefined> {
				const tree = await Tree.open<string, Row>(driven(reader, []), TREE_ID, keyOf);
				expect(tree, `${label(reader)} opens the shared tree`).to.not.equal(undefined);
				return (await tree!.get(key))?.value;
			}

			async function expectReadable(readers: readonly MeshNode[], rows: Iterable<[string, string]>, when: string): Promise<void> {
				const expected = [...rows];
				const wrong: string[] = [];
				for (const reader of readers) {
					for (const [key, value] of expected) {
						const seen = await read(reader, key);
						if (seen !== value) wrong.push(`${label(reader)} read ${key} as ${seen ?? 'absent'}, expected ${value}`);
					}
				}
				expect(wrong, `${when}: rows that did not read back`).to.deep.equal([]);
			}

			before(async () => {
				startedAt = Date.now();
				mesh = await createProductionShapedMesh(MACHINES);
				[a, b, c] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
			});

			it('phase 1 — whole group: each machine commits its own row, and every machine reads every row', async () => {
				for (const writer of mesh.nodes) {
					const key = `row-${label(writer)}`;
					const value = `written-by-${label(writer)}`;
					const durability = await write(writer, key, value);
					expect(durability, `${label(writer)}'s write reports who holds it`).to.not.equal(undefined);
					expect(isFullyDurable(durability!), `${label(writer)}'s write, with every member reachable: ${JSON.stringify(durability)}`).to.equal(true);
					acknowledged.set(key, value);
				}
				for (const commit of committed(attempts)) {
					expect(await holdersOf(commit), `every machine's own storage holds action ${commit.actionId}`).to.deep.equal(['A', 'B', 'C']);
				}
				await expectReadable(mesh.nodes, acknowledged, 'whole group');
			});

			it('phase 2 — C leaves mid-write: it promises A\'s final commit step, drops before voting on it, and A and B acknowledge the write', async () => {
				const cId = c.peerId.toString();
				let leftDuring: ClusterRecord | undefined;
				mesh.failures.onClusterDelivery = (target, record) => {
					if (leftDuring !== undefined || target !== cId) return;
					const commit = (record.message.operations[0] as { commit?: CommitRequest }).commit;
					// The write's final commit step — the one carrying its non-tail blocks, here together with the
					// tail — on the delivery that would carry C's commit vote: C has promised it, and has not voted
					// to commit it.
					const isFinalStep = commit !== undefined && commit.blockIds.some(id => id !== commit.tailId);
					if (isFinalStep && record.promises[cId] !== undefined && record.commits[cId] === undefined) {
						leftDuring = record;
						leftAt = Date.now();
						setUnreachable(mesh, [c]);
					}
				};

				const phaseAttempts: Attempt[] = [];
				const key = 'written-as-C-left';
				const value = 'acknowledged-by-A-and-B';
				let durability: WriteDurability | undefined;
				try {
					durability = await write(a, key, value, phaseAttempts);
				} finally {
					mesh.failures.onClusterDelivery = undefined;
					attempts.push(...phaseAttempts);
				}

				expect(leftDuring, 'C left at the intended step — the write\'s commit carried blocks beyond its tail, and C promised it').to.not.equal(undefined);
				// Acknowledged, and truthful about it: two of the three hold it, and the one that does not is named.
				expect(durability, 'the write is acknowledged').to.not.equal(undefined);
				const { quorum, confirmed, cohort, unconfirmed, torn } = durability!;
				expect({ quorum, confirmed, cohort, unconfirmed, torn: torn ?? [] }, JSON.stringify(durability))
					.to.deep.equal({ quorum: 'majority', confirmed: 2, cohort: MACHINES, unconfirmed: [cId], torn: [] });
				acknowledged.set(key, value);

				// ...and storage agrees: A and B hold every block of the commit, C does not.
				const commits = committed(phaseAttempts);
				expect(commits.length, 'the write committed once').to.equal(1);
				missed = commits[0]!;
				expect(await holdersOf(missed), `whose own storage holds action ${missed.actionId}`).to.deep.equal(['A', 'B']);
			});

			it(`phase 3 — while C is away${arm.writerRestartsWhileAway ? ' (and A restarts)' : ''}: B's write is refused, every member must promise, and A and B still read every acknowledged row`, async () => {
				if (arm.writerRestartsWhileAway) {
					// A owed C the commit it missed; the retry that would have delivered it goes with the old process.
					mesh.restart(a);
				}

				const phaseAttempts: Attempt[] = [];
				const key = 'refused-while-C-away';
				const startedWrite = Date.now();
				let refusal: unknown;
				let durability: WriteDurability | undefined;
				try {
					durability = await write(b, key, 'never-acknowledged', phaseAttempts);
				} catch (err) {
					refusal = err;
				} finally {
					attempts.push(...phaseAttempts);
				}
				// NOTE: almost all of this latency is the transactor's cancel loop — a cancel needs the same
				// all-three bar the write missed (arm of backlog `debt-unpromotable-pending-records-need-a-sweep`).
				// Reported, not asserted.
				const refusalMs = Date.now() - startedWrite;

				expect(refusal, `with C away B's write must be refused (it returned ${JSON.stringify(durability)})`).to.not.equal(undefined);
				const shortfall = expectPromiseShortfall(refusal);
				expect(shortfall, 'the numbers an application would branch on').to.deep.equal({ approvals: 2, peers: MACHINES, needed: MACHINES, rejections: 0 });
				expect(committed(phaseAttempts), 'a refused write commits nothing').to.deep.equal([]);
				report.refusal = `refused (${shortfall.approvals}/${shortfall.peers} promises) in ${refusalMs}ms`;

				await expectReadable([a, b], acknowledged, 'A and B with C away');
				for (const reader of [a, b]) {
					expect(await read(reader, key), `${label(reader)} does not read the refused row`).to.equal(undefined);
				}
				expect(await holdersOf(missed), 'nothing reaches C while it is away').to.deep.equal(['A', 'B']);
			});

			if (arm.writerRestartsWhileAway) {
				it('phase 4 — C returns owed nothing, after longer than one read-repair window: its own reads bring its storage current, and it reads every acknowledged row', async () => {
					// A long absence outlasts C's read-repair window as well as the writer's retry schedule. C's
					// last consult of any block happened before it left, so waiting from `leftAt` suffices.
					await delay(Math.max(0, leftAt + READ_REPAIR_WINDOW_MS + READ_REPAIR_WINDOW_SLACK_MS - Date.now()));
					setUnreachable(mesh, []);
					report.awayMs = Date.now() - leftAt;
					// The arm's premise: there is something to heal, and nobody is about to deliver it.
					expect(await holdersOf(missed), 'C is still behind when it returns').to.deep.equal(['A', 'B']);

					// Reading is all C does: no repair call, no write. See the module header for what these reads trigger.
					const startedReads = Date.now();
					await expectReadable([c], acknowledged, 'C on its return');
					const readsMs = Date.now() - startedReads;
					// Not merely served: C's OWN storage holds the write now.
					expect(await holdersOf(missed), `whose own storage holds action ${missed.actionId} after C's reads`).to.deep.equal(['A', 'B', 'C']);
					report.heal = `its own reads, past its read-repair window (${acknowledged.size} rows in ${readsMs}ms)`;
				});
			} else {
				it('phase 4 — C returns: the writer\'s scheduled commit retry brings C\'s own storage current before C reads anything, and C reads every acknowledged row', async () => {
					const awayMs = Date.now() - leftAt;
					report.awayMs = awayMs;
					expect(awayMs, `the arm's premise: C returns inside the writer's ${COMMIT_RETRY_SCHEDULE_MS}ms commit-retry schedule`).to.be.below(COMMIT_RETRY_SCHEDULE_MS);
					setUnreachable(mesh, []);

					const returnedAt = Date.now();
					// C issues nothing here — no read, no write — so the only thing that can bring its storage current
					// is a delivery someone else makes: the writer's retry of the commit C missed.
					await waitFor(async () => (await holdersOf(missed)).includes('C'), {
						timeoutMs: COMMIT_RETRY_SCHEDULE_MS - awayMs + RETRY_DELIVERY_SLACK_MS,
						intervalMs: 25,
						description: `C's own storage holds action ${missed.actionId}, delivered by A's scheduled commit retry (ClusterCoordinator.scheduleCommitRetry) before its schedule runs out`
					});
					report.heal = `A's commit retry, ${Date.now() - returnedAt}ms after C returned`;

					await expectReadable([c], acknowledged, 'C after the retry reached it');
				});
			}

			it('phase 5 — B and C restart over their own storage: every acknowledged row reads on all three, and a fresh write from each is read by the other two', async () => {
				mesh.restart(b);
				mesh.restart(c);

				await expectReadable(mesh.nodes, acknowledged, 'after B and C restarted');

				for (const writer of mesh.nodes) {
					const key = `after-restart-by-${label(writer)}`;
					const value = `written-by-${label(writer)}-after-restart`;
					const durability = await write(writer, key, value);
					expect(durability, `${label(writer)}'s fresh write reports who holds it`).to.not.equal(undefined);
					expect(isFullyDurable(durability!), `${label(writer)}'s fresh write, with every member back: ${JSON.stringify(durability)}`).to.equal(true);
					acknowledged.set(key, value);
					await expectReadable(mesh.nodes.filter(node => node !== writer), [[key, value]], `${label(writer)}'s fresh write`);
				}

				// Nothing acknowledged in this arm is missing from any machine's own storage.
				for (const commit of committed(attempts)) {
					expect(await holdersOf(commit), `whose own storage holds action ${commit.actionId}`).to.deep.equal(['A', 'B', 'C']);
				}
				report.runtimeMs = Date.now() - startedAt;
			});
		});
	}
});
