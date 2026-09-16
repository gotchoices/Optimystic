import { expect } from 'chai';
import { isFullyDurable } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';
import {
	attemptWrite, committedBlocks, createMachine, describeWriteAttempt, expectReadable, rowsFor, running,
	sequentialPhases, startMachine, stopMachine, waitForPair, waitUntilHeldLocally, writeRows,
	type Machine, type Row
} from './util/two-machine-lifecycle.js';

// The growth path every real deployment takes, end to end, over real TCP:
//
//   one machine writes alone → restarts → a second machine joins as a backup and must end up
//   holding the first machine's data locally → both write → one is away for a while → both restart.
//
// Each step is covered somewhere else in isolation (solo restart in `real-libp2p.integration.spec.ts`,
// a pair present from the start in `two-node-convergence.integration.spec.ts`, cohort growth with
// in-process streams in `cohort-growth-heals-single-holder.spec.ts`); past defects lived at the joins
// between them. This spec runs them as one sequence. `two-phones-over-relay.integration.spec.ts` runs
// the same lifecycle with every byte between the machines crossing a circuit relay.
//
// Configuration is exactly what `docs/optimystic.md` § Deployment Sizes recommends for two machines,
// fixed by `startMachine` in `test/util/two-machine-lifecycle.ts`.
//
// Phases are separate `it`s over shared state (`sequentialPhases`) so the reporter names the phase that
// broke.
//
// Restarts use a fresh port each time. A restarted node's peer store is empty, so it cannot find its
// partner by peer id; it dials the partner's current address instead, the way a host application that
// enrolled the backup would. The surviving node learns the new address through identify.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 like the other real-socket specs:
//   yarn workspace @optimystic/db-p2p test:integration

const NETWORK_NAME = 'small-deployment-lifecycle-it';
const TREE_ID = 'small-deployment-lifecycle-rows';

/** Start `machine` on a fresh TCP port, dialing each of `partners` at its current address. */
async function startOnTcp(machine: Machine, partners: Machine[] = []): Promise<OptimysticNode> {
	return await startMachine(machine, {
		port: 0,
		bootstrapNodes: partners.map(partner => pickLocalTcpMultiaddr(running(partner)))
	});
}

describe('Small deployment lifecycle over real libp2p (solo → backup → away → restart)', function () {
	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let a: Machine;
	let b: Machine;
	/** Every row whose write was acknowledged, by key — the durability ledger every later phase checks. */
	const acknowledged = new Map<number, Row>();
	const acknowledge = (rows: Row[]) => { for (const row of rows) acknowledged.set(row.key, row); };

	sequentialPhases();

	before(async function () {
		a = await createMachine('A', NETWORK_NAME);
		b = await createMachine('B', NETWORK_NAME);
	});

	after(async function () {
		await Promise.allSettled([a, b].filter(Boolean).map(stopMachine));
	});

	it('phase 1 — solo: A writes alone and reads its rows back', async function () {
		this.timeout(30_000);
		await startOnTcp(a);

		const rows = rowsFor('solo', [1, 2, 3]);
		await writeRows(a, TREE_ID, rows);
		acknowledge(rows);

		await expectReadable(a, TREE_ID, rows, 'solo');
	});

	it('phase 2 — solo restart: A comes back over its storage, reads everything, writes again', async function () {
		this.timeout(30_000);
		await stopMachine(a);
		await startOnTcp(a);

		await expectReadable(a, TREE_ID, acknowledged.values(), 'after solo restart');

		const rows = rowsFor('solo-restarted', [4]);
		await writeRows(a, TREE_ID, rows);
		acknowledge(rows);
		await expectReadable(a, TREE_ID, rows, 'solo write after restart');
	});

	it('phase 3 — add a backup: B joins, holds A\'s blocks locally, and serves every row with A stopped', async function () {
		this.timeout(120_000);
		const founderBlocks = await committedBlocks(a);
		expect(founderBlocks.size, 'A holds committed blocks to replicate').to.be.greaterThan(0);

		await startOnTcp(b, [a]);
		await waitForPair(a, b);
		await waitUntilHeldLocally(b, founderBlocks, 'B holds every block A wrote alone', 90_000);

		await stopMachine(a);
		await expectReadable(b, TREE_ID, acknowledged.values(), 'B with A stopped');
	});

	it('phase 4 — both write: A restarts, each writes, each reads the other\'s rows', async function () {
		this.timeout(60_000);
		await startOnTcp(a, [b]);
		await waitForPair(a, b);

		const fromA = rowsFor('both-A', [10, 11]);
		await writeRows(a, TREE_ID, fromA);
		acknowledge(fromA);

		const fromB = rowsFor('both-B', [20, 21]);
		await writeRows(b, TREE_ID, fromB);
		acknowledge(fromB);

		await expectReadable(a, TREE_ID, fromB, 'A reads B\'s rows');
		await expectReadable(b, TREE_ID, fromA, 'B reads A\'s rows');
	});

	it('phase 5 — one away: B stops, A writes, B returns; every acknowledged row is on both', async function () {
		this.timeout(120_000);
		const nodeA = running(a);
		const bPeerId = running(b).peerId;
		await stopMachine(b);
		await waitFor(() => !nodeA.getPeers().some(p => p.equals(bPeerId)),
			{ timeoutMs: 10_000, intervalMs: 100, description: 'A notices B is gone' });

		const whileAway: Row = { key: 30, value: 'B-away-30' };
		const attempt = await attemptWrite(a, TREE_ID, [whileAway]);
		if (!attempt.refusal) {
			acknowledge([whileAway]);
			// Conditional on purpose. Whether a lone survivor should accept at all is still under design
			// (see the note below), so this asserts nothing about ADMISSION — only that when the write IS
			// admitted, what comes back says truthfully that A alone holds it. That is the whole point of
			// the durability class: an app showing this row must show it as pending, not as saved.
			const { durability } = attempt;
			if (!durability) throw new Error('an acknowledged write must report who holds it, but none came back');
			expect(durability.quorum, 'a write A accepted with B away is held by A alone').to.equal('local');
			expect(isFullyDurable(durability), 'a solo write is not fully durable').to.equal(false);
		}

		await startOnTcp(b, [a]);
		await waitForPair(a, b);

		await expectReadable(a, TREE_ID, acknowledged.values(), 'A after B returned');
		await expectReadable(b, TREE_ID, acknowledged.values(), 'B after its restart');

		// Observed, not asserted: whether a lone survivor of a two-machine group should accept writes is
		// under design (tickets/backlog/more-design/6.5-partition-healing.md). This phase pins durability of
		// what was acknowledged; the admission outcome — and, when refused, whether the refused row surfaces
		// anyway — is reported so a change in either shows up in the run output.
		console.log(`      phase 5 observed: A's write with B away was ${await describeWriteAttempt(attempt, whileAway, TREE_ID, [a, b])}`);
	});

	it('phase 6 — both restart: every acknowledged row on each, and a new write from each crosses', async function () {
		this.timeout(90_000);
		await Promise.all([stopMachine(a), stopMachine(b)]);
		await startOnTcp(a);
		await startOnTcp(b, [a]);
		await waitForPair(a, b);

		await expectReadable(a, TREE_ID, acknowledged.values(), 'A after both restarted');
		await expectReadable(b, TREE_ID, acknowledged.values(), 'B after both restarted');

		const fromA = rowsFor('final-A', [40]);
		await writeRows(a, TREE_ID, fromA);
		acknowledge(fromA);
		const fromB = rowsFor('final-B', [50]);
		await writeRows(b, TREE_ID, fromB);
		acknowledge(fromB);

		await expectReadable(b, TREE_ID, fromA, 'B reads A\'s final row');
		await expectReadable(a, TREE_ID, fromB, 'A reads B\'s final row');
	});
});
