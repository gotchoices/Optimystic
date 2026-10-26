/**
 * Offline mode on a two-machine group with one member away (docs/offline-sync.md §When to submit: the
 * reachability gate): a transaction made in the mode on the machine left alone is queued, not
 * committed alone; a live read there serves it from that machine's own view; and it is sent the moment
 * the partner returns, woken by the gate rather than found by the re-check timer.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`). Node A's gate is the node's real one,
 * `KeyNetworkCohortReachability` from `@optimystic/db-p2p`, over A's own view of the mesh's key network,
 * registered on A's factory under the transactor's key before any table exists — where a node built by
 * `createLibp2pNode` has its `node.cohortReachability` registered by the factory itself. Its events come
 * from an `EventTarget` the spec dispatches on, standing in for the libp2p node's. "B away" is
 * {@link PartnerAway}: each node's view of the cohort holds only itself and names the other as absent,
 * and every request to B fails. The deterministic counterpart of phase 5 of
 * `packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts`, for writes made in the mode.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import type { IRepo } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { KeyNetworkCohortReachability } from '@optimystic/db-p2p';
import type { Mesh, MeshNode } from '@optimystic/db-p2p/testing';
import type { QueuedTransactionStatus } from '../dist/index.js';
import { countTreeEntries, createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';
import { queryAll } from './query-helpers.js';

type FailedStatus = Extract<QueuedTransactionStatus, { kind: 'failed' }>;

const NOTES_URI = 'tree://offline-two-machine/notes';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;

/**
 * Cuts node B off, and brings it back: while away, each node's own key-network view holds only itself
 * and names the other as a cohort member it could not place (`failures.partitionSides`), cluster rounds
 * to B fail (`failures.failingPeers`), and every repo request sent to B throws, as a dropped connection
 * does. Every write request any transactor sends is counted, so a case can say nothing was sent.
 */
class PartnerAway {
	sends = 0;
	private away: string | undefined;

	readonly wrap = (repo: IRepo, node: MeshNode): IRepo => {
		const reach = <T>(call: () => Promise<T>): Promise<T> => this.away === node.peerId.toString()
			? Promise.reject(new Error(`${node.peerId.toString()} is away`))
			: call();
		const send = <T>(call: () => Promise<T>): Promise<T> => {
			this.sends++;
			return reach(call);
		};
		const pendMany = repo.pendMany?.bind(repo);
		const commitMany = repo.commitMany?.bind(repo);
		return {
			get: (blockGets, options) => reach(() => repo.get(blockGets, options)),
			pend: (request, options) => send(() => repo.pend(request, options)),
			cancel: (actionRef, options) => reach(() => repo.cancel(actionRef, options)),
			commit: (request, options) => send(() => repo.commit(request, options)),
			...(pendMany ? { pendMany: (...args: Parameters<typeof pendMany>) => send(() => pendMany(...args)) } : {}),
			...(commitMany ? { commitMany: (...args: Parameters<typeof commitMany>) => send(() => commitMany(...args)) } : {}),
		};
	};

	leave(mesh: Mesh): void {
		const [a, b] = mesh.nodes.map(node => node.peerId.toString());
		mesh.failures.partitionSides = [new Set([a!]), new Set([b!])];
		mesh.failures.failingPeers = new Set([b!]);
		this.away = b;
	}

	return(mesh: Mesh): void {
		mesh.failures.partitionSides = undefined;
		mesh.failures.failingPeers = undefined;
		this.away = undefined;
	}
}

interface Group {
	mesh: Mesh;
	partner: PartnerAway;
	a: MeshDbNode;
	b: MeshDbNode;
	/** What A's gate hears its connection events from. */
	events: EventTarget;
	gate: KeyNetworkCohortReachability;
	/** Every status node A's plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
}

/** Both nodes with `Notes` declared and one row committed while both are present; node A registered
 * with `offline`, its gate registered before the table was created, and the table read once. */
async function twoMachines(offline: Record<string, unknown>): Promise<Group> {
	const partner = new PartnerAway();
	const { mesh, transactorFor } = await startMockMesh(2, { wrapRepo: partner.wrap });
	const a = createMeshDbNode(transactorFor(0), { offline } as unknown as Record<string, SqlValue>);
	const events = new EventTarget();
	const gate = new KeyNetworkCohortReachability({
		keyNetwork: mesh.nodes[0]!.keyNetwork,
		selfId: mesh.nodes[0]!.peerId.toString(),
		events,
		wakeDebounceMs: 10,
	});
	a.plugin.collectionFactory.registerCohortReachability('shared:test', gate);
	const b = createMeshDbNode(transactorFor(1));
	const statuses: QueuedTransactionStatus[] = [];
	a.plugin.offline.onStatus(status => { statuses.push(status); });
	for (const node of [a, b]) await node.db.exec(createNotes);
	await a.db.exec(`insert into Notes (id, body) values (1, 'both present')`);
	await notesOf(a);
	return { mesh, partner, a, b, events, gate, statuses };
}

const notesOf = (node: MeshDbNode): Promise<Record<string, unknown>[]> => queryAll(node.db, 'select id, body from Notes order by id');

/** The kinds of `statuses`, each run of one kind collapsed to one. */
const kindRuns = (statuses: readonly QueuedTransactionStatus[]): string[] =>
	statuses.map(status => status.kind).filter((kind, index, kinds) => kind !== kinds[index - 1]);

describe('Offline mode: a two-machine group with one member away', function () {
	this.timeout(60_000);

	it('a write on the machine left alone is queued and sent nowhere, a live read there serves it, and it drains as soon as the partner returns', async () => {
		// A re-check no sooner than 30 s (60 s less at most half of jitter): only the gate's wake can
		// explain a drain within the few seconds this case waits.
		const { mesh, partner, a, b, events, gate, statuses } = await twoMachines({ recheck: { baseMs: 60_000, maxMs: 60_000 } });
		try {
			a.plugin.offline.enter();
			partner.leave(mesh);
			const sendsBefore = partner.sends;

			await a.db.exec(`insert into Notes (id, body) values (2, 'B away')`);
			await waitFor(() => statuses.some(status => status.kind === 'queued' && status.waitingFor === 'cohort'),
				{ description: 'the entry to wait for its cohort' });
			expect(await notesOf(a), 'a live read on A serves the queued row').to.deep.equal([{ id: 1, body: 'both present' }, { id: 2, body: 'B away' }]);
			expect(a.plugin.offline.queueState().readsServedLocally).to.equal(true);
			expect(partner.sends - sendsBefore, 'nothing sent: not committed on A alone, nor on B').to.equal(0);

			partner.return(mesh);
			events.dispatchEvent(new Event('peer:identify'));
			await waitFor(() => statuses.some(status => status.kind === 'committed'), { description: 'the drain to commit on the wake', timeoutMs: 10_000 });

			expect(kindRuns(statuses)).to.deep.equal(['queued', 'submitting', 'committed']);
			expect(statuses.filter(status => status.kind === 'submitting'), 'submitted once').to.have.length(1);
			expect(new Set(statuses.map(status => status.transactionId)).size, 'one transaction throughout').to.equal(1);
			expect(await notesOf(b)).to.deep.equal([{ id: 1, body: 'both present' }, { id: 2, body: 'B away' }]);
		} finally {
			gate.stop();
		}
	});

	it('an entry that outlives expireAfterMs while the partner is away fails as expired, never sent', async () => {
		const { mesh, partner, a, b, gate, statuses } = await twoMachines({ expireAfterMs: 300, recheck: { baseMs: 50, maxMs: 100 } });
		try {
			a.plugin.offline.enter();
			partner.leave(mesh);
			const sendsBefore = partner.sends;

			await a.db.exec(`insert into Notes (id, body) values (2, 'expires')`);
			await waitFor(() => statuses.some(status => status.kind === 'failed'), { description: 'the entry to expire' });

			const failed = statuses.find((status): status is FailedStatus => status.kind === 'failed')!;
			expect(failed.reason).to.equal('expired');
			expect(failed.changedTables).to.deep.equal(['main.Notes']);
			expect(statuses.some(status => status.kind === 'submitting'), 'never submitted').to.equal(false);
			expect(partner.sends - sendsBefore, 'nothing sent').to.equal(0);
			expect(await notesOf(a), 'its row has left A\'s view').to.deep.equal([{ id: 1, body: 'both present' }]);

			partner.return(mesh);
			expect(await countTreeEntries(b.plugin, NOTES_URI), 'B never received it').to.equal(1);
		} finally {
			gate.stop();
		}
	});
});
