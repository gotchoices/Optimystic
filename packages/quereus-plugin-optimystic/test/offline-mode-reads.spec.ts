/**
 * Live reads in offline mode (docs/offline-sync.md §Reads in offline mode): while the mode is entered,
 * a live read of a `'queue'` table whose refresh cannot reach the cohort is served from this
 * machine's own view — the committed blocks it holds plus every queued transaction — and says so in
 * `readsServedLocally`; outside the mode, or for a `'network'` table, the read fails as it always has,
 * and a block this machine does not hold fails the read in either case.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`). The mesh's own failure switches cut a
 * node off from cluster rounds but leave it reading its own replica, so unreachability is driven
 * through node A's transactor instead: wrapped, and registered under the key the factory resolves
 * (`shared:test`), its `get` answers every block `unavailable: 'cohort-unreachable'` while
 * {@link Isolation.armed} is set — what a refresh meets on a node that cannot reach its cohort. A
 * reachability gate registered on A's factory stands in for stage 6's.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import { BlockUnavailableError } from '@optimystic/db-core';
import type { BlockGets, GetBlockResults, ITransactor } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import type { QueuedTransactionStatus } from '../dist/index.js';
import { countTreeEntries, createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';
import { captureThrown, expectLookupsAgreeWithScan, queryAll } from './query-helpers.js';

const NOTES_URI = 'tree://offline-reads/notes';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;
const createNotesIndex = 'create index NotesBody on Notes (body)';

/** Node A's registration: the drain's re-check timer shortened so a reconnect is noticed quickly. */
const offlineConfig = { offline: { recheck: { baseMs: 20, maxMs: 100 } } } as unknown as Record<string, SqlValue>;

/** Node A's transactor, wrapped so its reads can be made to meet an unreachable cohort, and counted. */
class Isolation {
	/** While set, every block `get` answers `unavailable: 'cohort-unreachable'`. */
	armed = false;
	/** Every `get` the wrapped transactor received. */
	gets = 0;

	wrap(inner: ITransactor): ITransactor {
		return new Proxy(inner, {
			get: (target, property) => {
				if (property === 'get') return (blockGets: BlockGets) => this.get(target, blockGets);
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	private async get(inner: ITransactor, blockGets: BlockGets): Promise<GetBlockResults> {
		this.gets++;
		if (!this.armed) return inner.get(blockGets);
		return Object.fromEntries(blockGets.blockIds.map(id => [id, { state: {}, unavailable: 'cohort-unreachable' as const }]));
	}
}

interface TwoNodes {
	a: MeshDbNode;
	b: MeshDbNode;
	isolation: Isolation;
	/** Every status node A's plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
}

/** Both nodes with `Notes` and its index declared; node A has read both through a full scan and the index. */
async function twoNodes(): Promise<TwoNodes> {
	const { transactorFor } = await startMockMesh(2);
	const isolation = new Isolation();
	const a = createMeshDbNode(transactorFor(0), offlineConfig);
	a.plugin.collectionFactory.registerTransactor('shared:test', isolation.wrap(transactorFor(0)));
	const b = createMeshDbNode(transactorFor(1));
	const statuses: QueuedTransactionStatus[] = [];
	a.plugin.offline.onStatus(status => { statuses.push(status); });
	for (const node of [a, b]) {
		await node.db.exec(createNotes);
		await node.db.exec(createNotesIndex);
	}
	await a.db.exec(`insert into Notes (id, body) values (1, 'seed')`);
	await queryAll(a.db, 'select * from Notes');
	await queryAll(a.db, `select id from Notes where body = 'seed'`);
	return { a, b, isolation, statuses };
}

const notesOf = (node: MeshDbNode): Promise<Record<string, unknown>[]> => queryAll(node.db, 'select id, body from Notes order by id');

/** The `BlockUnavailableError` somewhere along `error`'s `cause` chain, if there is one. */
function unavailableIn(error: unknown): BlockUnavailableError | undefined {
	for (let cause = error; cause instanceof Error; cause = cause.cause) {
		if (cause instanceof BlockUnavailableError) return cause;
	}
	return undefined;
}

describe('Offline mode: live reads while the cohort cannot be reached', function () {
	this.timeout(60_000);

	it("a 'queue' table's live read serves the committed rows this machine holds and its queued transactions, through the index and a full scan alike, until a refresh reaches the cohort again", async () => {
		const { a, b, isolation, statuses } = await twoNodes();
		a.plugin.offline.enter();
		isolation.armed = true;
		await a.db.exec(`insert into Notes (id, body) values (2, 'queued')`);
		expect(statuses[0]?.kind, 'queued on A').to.equal('queued');

		expect(await notesOf(a)).to.deep.equal([{ id: 1, body: 'seed' }, { id: 2, body: 'queued' }]);
		await expectLookupsAgreeWithScan(a.db, 'Notes', 'body');
		expect(a.plugin.offline.queueState().readsServedLocally).to.equal(true);
		expect(await countTreeEntries(b.plugin, NOTES_URI), 'the queued row is on A only').to.equal(1);

		isolation.armed = false;
		await a.plugin.offline.whenDrained();
		expect(await notesOf(a)).to.deep.equal([{ id: 1, body: 'seed' }, { id: 2, body: 'queued' }]);
		expect(a.plugin.offline.queueState().readsServedLocally, 'the refresh reached the cohort').to.equal(false);
		expect(await notesOf(b)).to.deep.equal([{ id: 1, body: 'seed' }, { id: 2, body: 'queued' }]);
	});

	it("outside offline mode, and for a 'network' table inside it, the live read fails with the unreachable block", async () => {
		const { a, isolation } = await twoNodes();
		await a.db.exec(`create table Revocation (id integer primary key, peer text) using optimystic('tree://offline-reads/revocation') with tags ("optimystic.offline" = 'network')`);
		await a.db.exec(`insert into Revocation (id, peer) values (1, 'p1')`);
		await queryAll(a.db, 'select * from Revocation');
		isolation.armed = true;

		const outside = await captureThrown(() => notesOf(a));
		expect(unavailableIn(outside)?.reason, `mode not entered: ${outside.message}`).to.equal('cohort-unreachable');

		a.plugin.offline.enter();
		const network = await captureThrown(() => queryAll(a.db, 'select * from Revocation'));
		expect(unavailableIn(network)?.reason, `'network' table: ${network.message}`).to.equal('cohort-unreachable');
		expect(a.plugin.offline.queueState().readsServedLocally).to.equal(false);
	});

	it('while the reachability gate says the cohort is unreachable, a live read asks the network nothing, and the queue waits on the same gate', async () => {
		const { a, b, isolation, statuses } = await twoNodes();
		let reachable = false;
		a.plugin.collectionFactory.registerCohortReachability('shared:test', { reachable: () => Promise.resolve(reachable) });
		a.plugin.offline.enter();
		await a.db.exec(`insert into Notes (id, body) values (2, 'queued')`);
		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.waitingFor === 'cohort'), { description: 'the entry to wait on the gate' });

		const before = isolation.gets;
		expect(await notesOf(a)).to.deep.equal([{ id: 1, body: 'seed' }, { id: 2, body: 'queued' }]);
		expect(isolation.gets - before, 'no read reached the transactor').to.equal(0);
		expect(a.plugin.offline.queueState().readsServedLocally).to.equal(true);
		expect(statuses.some(s => s.kind === 'submitting'), 'nothing was sent').to.equal(false);

		reachable = true;
		await a.plugin.offline.whenDrained();
		expect(await countTreeEntries(b.plugin, NOTES_URI)).to.equal(2);
	});

	it('a table this machine has never read still fails the read in offline mode: the mode does not make data appear', async () => {
		const { a, b, isolation } = await twoNodes();
		await b.db.exec(`create table Elsewhere (id integer primary key) using optimystic('tree://offline-reads/elsewhere')`);
		await b.db.exec('insert into Elsewhere (id) values (1)');
		await a.plugin.hydrate(a.db);
		a.plugin.offline.enter();
		isolation.armed = true;

		const refusal = await captureThrown(() => queryAll(a.db, 'select * from Elsewhere'));
		expect(unavailableIn(refusal)?.reason, refusal.message).to.equal('cohort-unreachable');
	});

	it("a write's uniqueness probe degrades the same way: an offline insert into a table with a unique column is queued while the cohort cannot be reached", async () => {
		const { a, b, isolation, statuses } = await twoNodes();
		const createTags = `create table Tags (id integer primary key, name text unique) using optimystic('tree://offline-reads/tags')`;
		await a.db.exec(createTags);
		await b.db.exec(createTags);
		await a.db.exec(`insert into Tags (id, name) values (1, 'one')`);
		a.plugin.offline.enter();
		isolation.armed = true;

		await a.db.exec(`insert into Tags (id, name) values (2, 'two')`);
		expect(statuses.map(s => s.kind)[0], 'locally acknowledged').to.equal('queued');

		isolation.armed = false;
		await a.plugin.offline.whenDrained();
		expect(await queryAll(b.db, 'select id, name from Tags order by id')).to.deep.equal([{ id: 1, name: 'one' }, { id: 2, name: 'two' }]);
	});
});
