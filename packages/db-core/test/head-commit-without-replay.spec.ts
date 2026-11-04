/**
 * A committed head segment leaves the staged view without a replay (ticket
 * `a-committed-head-leaves-the-staged-view-without-a-replay`, GitHub #53): the head's attempt is
 * built from what its actions staged into the live tracker (`SealedSegment.delta`), and once it
 * commits, the blocks it touched are re-folded from the remaining segments' deltas instead of every
 * segment being staged again (`Collection.subtractCommittedHead`). The new path has to behave
 * exactly like the one it replaces, so this is a property check over a generated workload: a tree
 * of small leaves, so forty keys split and merge nodes, written by several queued entries with rows
 * also staged into the open segment while a head is on the network. After every head commit the
 * live view must read as a fresh handle reads after staging what remains over the committed state,
 * every attempt must declare each updated block's base as the revision storage holds, and the
 * committed tree at the end must be the sequential result. The second case lands a rival commit
 * mid-drain, which forces the one replay that still happens — a refresh adopting another writer's
 * revision — and checks the heads after it are subtracted from the deltas that replay recorded.
 */

import { expect } from 'chai';
import {
	Tree,
	HlcClock,
	KeyRange,
	type CommitRequest,
	type CommitResult,
	type HeadCommitOptions,
	type InFlightAttempt,
	type ITransactor,
	type PendRequest,
	type PendResult,
	type TreeReadView,
	type TreeReplaceAction,
} from '../src/index.js';
import { DelegatingTransactor, TestTransactor } from '../src/testing/test-transactor.js';
import { captureCollectionLog } from './capture-log.js';

interface Entry {
	key: number;
	value: number;
}

const USERS = 'users';
/** Leaves of four entries, so the forty keys below make a tree whose nodes split and merge. */
const CAPACITY = 4;
const KEYS = 40;
const byKey = (e: Entry) => e.key;
const clock = new HlcClock({ nodeId: 'test' });

type Replace = TreeReplaceAction<number, Entry>;
/** The entries by key: what the tree holds after a sequence of replaces. */
type Model = Map<number, Entry>;

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}

/** mulberry32: a small seeded generator, so a failure replays. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One to three elements over distinct keys: a delete of a key the model holds about a third of
 * the time, an upsert carrying `step` otherwise. */
function generateReplace(rand: () => number, model: Model, step: number): Replace {
	const count = 1 + Math.floor(rand() * 3);
	const keys = new Set<number>();
	while (keys.size < count) keys.add(Math.floor(rand() * KEYS));
	return [...keys].map((key, index): Replace[number] =>
		model.has(key) && rand() < 0.35 ? [key] : [key, { key, value: step * 10 + index }]);
}

function applyToModel(model: Model, replace: Replace): void {
	for (const [key, entry] of replace) {
		if (entry === undefined) model.delete(key);
		else model.set(key, entry);
	}
}

function modelEntries(model: Model): Entry[] {
	return [...model.values()].sort((a, b) => a.key - b.key);
}

async function allEntries(view: TreeReadView<number, Entry>): Promise<Entry[]> {
	return view.entriesIn(new KeyRange<number>());
}

function openTree(transactor: ITransactor): Promise<Tree<number, Entry>> {
	return Tree.createOrOpen<number, Entry>(transactor, USERS, byKey, undefined, CAPACITY);
}

/** What a fresh handle over the committed state reads after staging `replaces` in order — the
 * view the live tree must match after each head commit. */
async function freshlyStaged(inner: TestTransactor, replaces: readonly Replace[]): Promise<Entry[]> {
	const fresh = await openTree(inner);
	for (const replace of replaces) await fresh.stage(replace);
	return allEntries(fresh);
}

/** Twelve seeded keys committed through a handle of their own, so the handle under test opens over
 * a committed collection. */
async function seeded(rand: () => number): Promise<{ inner: TestTransactor; seed: Replace }> {
	const inner = new TestTransactor();
	const seed: Replace = [];
	while (seed.length < 12) {
		const key = Math.floor(rand() * KEYS);
		if (!seed.some(([k]) => k === key)) seed.push([key, { key, value: key }]);
	}
	await (await openTree(inner)).replace(seed);
	return { inner, seed };
}

type QueuedEntry = { id: string; replaces: Replace[] };

/** Stage `count` entries of `perEntry` replaces each into `tree`, sealing each under its id, and
 * apply them to `model`. */
async function queueEntries(tree: Tree<number, Entry>, rand: () => number, model: Model, count: number, perEntry: number, step: { n: number }): Promise<QueuedEntry[]> {
	const entries: QueuedEntry[] = [];
	for (let e = 0; e < count; e++) {
		const replaces: Replace[] = [];
		for (let k = 0; k < perEntry; k++) {
			const replace = generateReplace(rand, model, step.n++);
			await tree.stage(replace);
			applyToModel(model, replace);
			replaces.push(replace);
		}
		const id = `E${e}`;
		expect(tree.getCollection().sealPending(id)).to.be.true;
		entries.push({ id, replaces });
	}
	return entries;
}

/** The head commit's identity as the queue would supply it, with a write-ahead hook that checks
 * the attempt's declared bases against storage: for every block the attempt updates, the revision
 * it declares its operations were computed against is the revision the inner transactor holds for
 * the block, so the pin a subtraction rebases and the one a replay takes agree with storage. */
function headOptions(inner: TestTransactor, actionId: string, declared: { bases: number }): HeadCommitOptions {
	return {
		actionId, timestamp: Date.now(), hlc: clock.now(), lane: 'serializable', maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5,
		recordAttempt: async (attempt: InFlightAttempt) => {
			const bases = attempt.baseRevs ?? {};
			const ids = Object.keys(bases);
			if (ids.length === 0) return;
			const held = await inner.get({ blockIds: ids });
			for (const id of ids) {
				expect(held[id]?.state.latest?.rev, `attempt ${actionId} declares the base of ${id} as the revision storage holds`).to.equal(bases[id]);
			}
			declared.bases += ids.length;
		},
	};
}

/** Parks EVERY commit after the inner transactor has made it durable, until `openGate()`, so a row
 * can be staged into the open segment while each head's attempt is on the network. */
class ParksEachCommit extends DelegatingTransactor {
	private parked = deferred();
	private gate = deferred();

	constructor(inner: TestTransactor) {
		super(inner);
	}

	/** Resolves once the commit in flight is durable and parked. Read it after the previous
	 * `openGate()`, which replaces it. */
	get commitParked(): Promise<void> { return this.parked.promise; }

	override async commit(request: CommitRequest): Promise<CommitResult> {
		const result = await this.inner.commit(request);
		const gate = this.gate.promise;
		this.parked.resolve();
		await gate;
		return result;
	}

	openGate(): void {
		const gate = this.gate;
		this.parked = deferred();
		this.gate = deferred();
		gate.resolve();
	}
}

/** Parks the `parkAt`-th pend before it reaches the inner transactor, until `openGate()`: the
 * attempt is built, nothing of it is in storage, and a rival can land first. */
class ParksOnePend extends DelegatingTransactor {
	private pends = 0;
	private readonly parked = deferred();
	private readonly gate = deferred();

	constructor(inner: TestTransactor, private readonly parkAt: number) {
		super(inner);
	}

	get pendParked(): Promise<void> { return this.parked.promise; }

	override async pend(request: PendRequest): Promise<PendResult> {
		if (++this.pends === this.parkAt) {
			this.parked.resolve();
			await this.gate.promise;
		}
		return this.inner.pend(request);
	}

	openGate(): void { this.gate.resolve(); }
}

const subtracted = (lines: string[]) => lines.filter(line => line.includes('collection:committed-head-subtracted'));
const replayed = (lines: string[]) => lines.filter(line => line.includes('collection:committed-head-replayed'));

describe('A committed head leaves the staged view without a replay', function () {
	this.timeout(60000);

	it('after every head commit the live view reads as a fresh staging of what remains, each attempt declares the bases storage holds, no head is replayed out, and the committed tree is the sequential result', async () => {
		const rand = prng(7);
		const { inner, seed } = await seeded(rand);
		const model: Model = new Map();
		applyToModel(model, seed);
		const transactor = new ParksEachCommit(inner);
		const tree = await openTree(transactor);
		const collection = tree.getCollection();
		const step = { n: 1 };
		const entries = await queueEntries(tree, rand, model, 10, 3, step);
		expect(await allEntries(tree), 'the queued view before the drain').to.deep.equal(modelEntries(model));

		const declared = { bases: 0 };
		const open: Replace[] = [];
		const lines = await captureCollectionLog(async () => {
			for (const [i, entry] of entries.entries()) {
				const committing = collection.commitHead(entry.id, headOptions(inner, `A${i}`, declared));
				// Raced, so a commit that fails before it parks fails the case instead of hanging it.
				await Promise.race([transactor.commitParked, committing]);
				if (i % 2 === 0) {
					// A row staged into the open segment while the head is on the network: the
					// subtraction's re-fold ends with the open delta.
					const replace = generateReplace(rand, model, step.n++);
					await tree.stage(replace);
					applyToModel(model, replace);
					open.push(replace);
				}
				transactor.openGate();
				await committing;

				const remaining = [...entries.slice(i + 1).flatMap(e => e.replaces), ...open];
				const live = await allEntries(tree);
				expect(live, `after head ${entry.id}, the live view equals a fresh staging of what remains`).to.deep.equal(await freshlyStaged(inner, remaining));
				expect(live, `after head ${entry.id}, and the sequential result`).to.deep.equal(modelEntries(model));
				expect(collection.sealedEntries()).to.deep.equal(entries.slice(i + 1).map(e => e.id));
			}
		});

		expect(subtracted(lines), 'every head was taken out of the live tracker without a replay').to.have.length(entries.length);
		expect(replayed(lines), 'no head fell back to a replay').to.be.empty;
		expect(declared.bases, 'the attempts declared bases, which were checked').to.be.greaterThan(entries.length);

		// The open rows commit as one more entry, and then storage holds the sequential result.
		expect(collection.sealPending('EOPEN')).to.be.true;
		const finishing = collection.commitHead('EOPEN', headOptions(inner, 'AOPEN', declared));
		await Promise.race([transactor.commitParked, finishing]);
		transactor.openGate();
		await finishing;
		expect(collection.hasUnsyncedChanges()).to.be.false;
		expect(await allEntries(await openTree(inner)), 'the committed tree, read from storage').to.deep.equal(modelEntries(model));
		expect(await allEntries(tree), 'and the live view agrees').to.deep.equal(modelEntries(model));
	});

	it('a rival that lands mid-drain is adopted by a replay that records the segments again, the heads after it are still subtracted, and the committed tree is the sequential result with the rival where it landed', async () => {
		const rand = prng(11);
		const { inner, seed } = await seeded(rand);
		const model: Model = new Map();
		applyToModel(model, seed);
		// The third head's first pend is parked, so the rival lands ahead of it.
		const transactor = new ParksOnePend(inner, 3);
		const tree = await openTree(transactor);
		const collection = tree.getCollection();
		const step = { n: 1 };
		const entries = await queueEntries(tree, rand, model, 6, 3, step);
		const RIVAL_AT = 2;
		// Two keys no entry writes, and the first key the last entry writes, which that entry overrides.
		const overridden = entries[5]!.replaces[0]![0]![0];
		const rival: Replace = [[1000, { key: 1000, value: -1 }], [1001, { key: 1001, value: -2 }], [overridden, { key: overridden, value: -3 }]];

		const declared = { bases: 0 };
		const lines = await captureCollectionLog(async () => {
			for (const [i, entry] of entries.entries()) {
				const committing = collection.commitHead(entry.id, headOptions(inner, `A${i}`, declared));
				if (i === RIVAL_AT) {
					await Promise.race([transactor.pendParked, committing]);
					await (await openTree(inner)).replace(rival);
					await tree.update();	// a reader's refresh adopts the rival and replays what is staged
					expect(await allEntries(tree), 'the view after the rival was adopted, before the head commits')
						.to.deep.equal(await freshlyStaged(inner, entries.slice(i).flatMap(e => e.replaces)));
					transactor.openGate();
				}
				await committing;
				expect(await allEntries(tree), `after head ${entry.id}`).to.deep.equal(await freshlyStaged(inner, entries.slice(i + 1).flatMap(e => e.replaces)));
			}
		});

		expect(subtracted(lines), 'every head, the one rebuilt after the rival included, was subtracted').to.have.length(entries.length);
		expect(replayed(lines)).to.be.empty;
		expect(collection.committedRevision(), 'the seed, six heads and the rival').to.equal(8);

		const sequential: Model = new Map();
		applyToModel(sequential, seed);
		for (const entry of entries.slice(0, RIVAL_AT)) for (const replace of entry.replaces) applyToModel(sequential, replace);
		applyToModel(sequential, rival);
		for (const entry of entries.slice(RIVAL_AT)) for (const replace of entry.replaces) applyToModel(sequential, replace);
		expect(await allEntries(await openTree(inner)), 'the committed tree').to.deep.equal(modelEntries(sequential));
		expect(await allEntries(tree), 'and the live view').to.deep.equal(modelEntries(sequential));
	});
});
