/**
 * An invented collection meets the network's (docs/offline-sync.md §Invented collections): a handle
 * that found no committed header and staged one of its own (`Collection.createOrOpen`'s create
 * branch) seals a segment, and meanwhile another handle over the same id creates the collection for
 * real. The head commit must land the segment in THAT collection, never commit the invented header
 * over it — two headers under one id would be two collections, the joiner fork.
 *
 * Nothing here adds a probe: both drivers open their cycle with a refresh (`Collection.commitHead`,
 * `TransactionCoordinator.commitEntry`), and that refresh (`Collection.updateInternal`) re-reads the
 * header with no remembered tail. Found, it adopts the committed log and replays the sealed segments
 * over it from an empty baseline; authoritatively absent, the entry commits the invented header as a
 * first write does; unavailable, the refresh throws `BlockUnavailableError` and the entry waits.
 *
 * Every case runs over `Tree` on one `TestTransactor`, the rival committing through a handle of its
 * own (`commitRivalTreeWrite`); the one double answers the header as unavailable while told to.
 */

import { expect } from 'chai';
import {
	OfflineQueue,
	TransactionCoordinator,
	Tree,
	type BlockGets,
	type CollectionId,
	type EntryStatus,
	type GetBlockResults,
	type HeadCommitOptions,
	type ITransactor,
} from '../src/index.js';
import { DelegatingTransactor, TestTransactor, commitRivalTreeWrite, waitFor } from '../src/testing/index.js';

interface Entry {
	key: number;
	name: string;
}

const USERS = 'users';
const BY_NAME = 'users/index/name';
const byKey = (e: Entry) => e.key;
const entry = (key: number, name: string): Entry => ({ key, name });
const QUEUED_AT = 1_700_000_000_000;

const headOptions = (actionId: string): HeadCommitOptions =>
	({ actionId, timestamp: QUEUED_AT, maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 });

async function openTree(transactor: ITransactor, id: CollectionId): Promise<Tree<number, Entry>> {
	return Tree.createOrOpen<number, Entry>(transactor, id, byKey);
}

/** Stage `rows` as one action and seal it under `entryId`. */
async function sealAs(tree: Tree<number, Entry>, entryId: string, rows: Entry[]): Promise<void> {
	await tree.stage(rows.map(row => [row.key, row]));
	expect(tree.getCollection().sealPending(entryId), `${entryId} seals a non-empty open segment`).to.be.true;
}

/** The keys each committed log entry of `id` replaced, in log order, read through a fresh handle —
 * durable storage, not the handle under test's view. One walk of one chain, so a second log under
 * the id would show as entries missing from it. */
async function committedKeys(inner: TestTransactor, id: CollectionId): Promise<number[][]> {
	const fresh = await Tree.open<number, Entry>(inner, id, byKey);
	expect(fresh, `${id} has a committed header`).to.not.equal(undefined);
	const keys: number[][] = [];
	for await (const action of fresh!.getCollection().selectLog()) {
		keys.push(action.data.map(([key]) => key));
	}
	return keys;
}

/** The rows a handle reads for `keys`, refreshed first. */
async function rowsSeenBy(tree: Tree<number, Entry>, keys: number[]): Promise<(string | undefined)[]> {
	await tree.update();
	return Promise.all(keys.map(async key => (await tree.get(key))?.name));
}

/** Answers every read of collection header `headerId` as a coordinator that reached none of its
 * cohort does, while {@link unavailable} is set; every other read, and every write, delegates. */
class HeaderUnavailable extends DelegatingTransactor {
	unavailable = false;

	constructor(inner: TestTransactor, private readonly headerId: CollectionId) {
		super(inner);
	}

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		const results = await this.inner.get(gets);
		if (this.unavailable && gets.blockIds.includes(this.headerId)) {
			return { ...results, [this.headerId]: { state: {}, unavailable: 'cohort-unreachable' } };
		}
		return results;
	}
}

describe('An invented collection adopts the one another handle created', function () {
	this.timeout(20_000);

	it('a head commit lands its sealed row in the collection the rival created: one header, one log holding both entries, and the handle now holds a committed revision', async () => {
		const inner = new TestTransactor();
		const joiner = await openTree(inner, USERS);
		expect(joiner.getCollection().committedRevision(), 'invented: nothing committed').to.equal(undefined);
		await sealAs(joiner, 'E1', [entry(1, 'joiner')]);

		const founder = await openTree(inner, USERS);
		await founder.replace([[2, entry(2, 'founder')]]);

		await joiner.getCollection().commitHead('E1', headOptions('A1'));

		expect(await committedKeys(inner, USERS), 'the founder\'s entry, then the joiner\'s, in the one log').to.deep.equal([[2], [1]]);
		expect(await rowsSeenBy(founder, [1, 2]), 'the founder\'s handle reads both rows').to.deep.equal(['joiner', 'founder']);
		expect(await rowsSeenBy(joiner, [1, 2]), 'and so does the joiner\'s').to.deep.equal(['joiner', 'founder']);
		expect(joiner.getCollection().committedRevision(), 'the joiner adopted the committed log').to.equal(2);
		expect(joiner.getCollection().sealedEntries(), 'nothing left sealed').to.deep.equal([]);
		expect(joiner.hasUnsyncedChanges(), 'nothing left to sync').to.be.false;
	});

	it('an entry over a main collection and an index tree invented beside it commits through the coordinator into the index the rival created', async () => {
		const inner = new TestTransactor();
		await commitRivalTreeWrite<number, Entry>(inner, USERS, byKey, [[5, entry(5, 'seed')]]);
		const users = await openTree(inner, USERS);
		const byName = await openTree(inner, BY_NAME);
		expect(byName.getCollection().committedRevision(), 'the index tree is invented').to.equal(undefined);
		await sealAs(users, 'E1', [entry(1, 'joiner')]);
		await sealAs(byName, 'E1', [entry(1, 'joiner')]);

		await commitRivalTreeWrite<number, Entry>(inner, USERS, byKey, [[2, entry(2, 'founder')]]);
		await commitRivalTreeWrite<number, Entry>(inner, BY_NAME, byKey, [[2, entry(2, 'founder')]]);

		const coordinator = new TransactionCoordinator(inner,
			new Map([users, byName].map(tree => [tree.getCollection().id, tree.getCollection()])),
			{ pendValidation: 'none' });
		await coordinator.commitEntry({ entryId: 'E1', actionId: 'A1', timestamp: QUEUED_AT, collectionIds: [USERS, BY_NAME] });

		expect(await committedKeys(inner, BY_NAME), 'the index tree\'s one log: the founder\'s entry, then the joiner\'s').to.deep.equal([[2], [1]]);
		expect(await committedKeys(inner, USERS), 'and the main collection\'s').to.deep.equal([[5], [2], [1]]);
		const founderIndex = await openTree(inner, BY_NAME);
		expect(await rowsSeenBy(founderIndex, [1, 2]), 'a fresh handle on the index reads both entries').to.deep.equal(['joiner', 'founder']);
		expect(byName.getCollection().committedRevision(), 'the joiner\'s index tree adopted the committed log').to.equal(2);
	});

	it('while the header cannot be read the entry waits for the cohort with nothing committed, and once it reads absent the entry commits the invented header', async () => {
		const inner = new TestTransactor();
		const transactor = new HeaderUnavailable(inner, USERS);
		const statuses: EntryStatus[] = [];
		const queue = new OfflineQueue({ recheck: { baseMs: 5, maxMs: 20 }, submit: { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 } });
		queue.onStatus(status => statuses.push(status));
		const joiner = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey, undefined, undefined, {
			onSealedRefused: queue.onSealedRefused,
		});
		transactor.unavailable = true;
		await joiner.stage([[1, entry(1, 'joiner')]]);
		queue.enqueue([joiner.getCollection()], { id: 'E1' });

		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.entryId === 'E1' && s.waitingFor === 'cohort'),
			{ description: 'E1 queued waiting for the cohort' });
		expect(await Tree.open<number, Entry>(inner, USERS, byKey), 'no header was committed on an unanswered probe').to.equal(undefined);
		expect(queue.entries().map(e => e.id), 'still listed').to.deep.equal(['E1']);
		expect(statuses.some(s => s.kind === 'failed'), 'never failed').to.be.false;

		transactor.unavailable = false;
		await queue.whenDrained();
		expect(statuses.filter(s => s.entryId === 'E1').at(-1)?.kind, 'E1 committed').to.equal('committed');
		expect(await committedKeys(inner, USERS), 'the joiner\'s entry is the collection\'s first').to.deep.equal([[1]]);
		await queue.dispose();
	});
});
