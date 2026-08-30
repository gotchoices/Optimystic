/**
 * Drives a collection refresh into the MIDDLE of an in-flight coordinator commit.
 *
 * `TransactionCoordinator.commitOnce` holds each participating collection's instance latch
 * across its whole span — log append, pend, commit, and the local fold — and threads the
 * revision captured at the log append through pend, commit, and `recordCommitted`. These two
 * cases park the commit at the two points where a concurrent `Collection.update()` used to be
 * able to slip in, release a refresh at the parked instant, and assert that it cannot corrupt
 * local state:
 *
 *  - **Case 1** parks between the DURABLE commit and `recordCommitted`. Without the latch the
 *    refresh adopts the just-committed revision (carrying this transaction's own action id, read
 *    straight out of the log), and `recordCommitted` — which used to recompute `getNextRev()`
 *    rather than repeat the number the pend named — then appends the SAME action again one
 *    revision higher. The collection's local revision counter ends up permanently one ahead of
 *    storage, and every later refresh reports `collection:context-not-lowered` and closes
 *    nothing.
 *  - **Case 2** parks the PEND, lets a rival durably take the revision, and releases a refresh.
 *    Without the latch the refresh runs `replayActions()`, whose `tracker.reset()` REPLACES the
 *    transforms object; the coordinator captured that object by reference at the log append, so
 *    what it then hands the network is a stale-stable copy of what the collection believed it had
 *    staged.
 *
 * Both cases run against a single raw {@link Collection} — a trivial `set` handler that inserts
 * one fresh block per action, so every landed action leaves a durable trace — rather than a
 * `Tree`: the interleaving is a Collection-level property and a tree only adds nodes to it.
 *
 * `await`ing the released refresh's promise after the gate opens is itself the latch
 * non-reentrancy assertion — a coordinator that re-entered a latched Collection method inside its
 * own held span, or a retry that called `update()` without first releasing, would hang here and
 * the mocha timeout would catch it.
 */

import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	Collection,
	TransactionCoordinator,
	createActionsStatements,
	createTransactionId,
	createTransactionStamp,
	type Action,
	type ActionHandler,
	type BlockId,
	type BlockStore,
	type CollectionActions,
	type CollectionInitOptions,
	type CommitRequest,
	type CommitResult,
	type IBlock,
	type ITransactor,
	type PendRequest,
	type PendResult,
	type Transaction,
	type Transforms,
} from '../src/index.js';
import { DelegatingTransactor, TestTransactor } from '../src/testing/test-transactor.js';

type SpecAction = { value: string };

const collectionId = 'interleaving';

/** Each action inserts one fresh block, so a landed action leaves a durable trace and a lost one
 *  leaves none. Same shape as the filterConflict cases in transaction.spec.ts. */
const handlers: Record<string, ActionHandler<SpecAction>> = {
	set: async (_action, store) => {
		store.insert({ header: store.createBlockHeader('TEST', store.generateId()) });
	},
};

const init = (): CollectionInitOptions<SpecAction> => ({
	modules: handlers,
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => ({
		header: store.createBlockHeader('TEST', id),
	}),
});

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}

/** Yield the event loop through the MACROTASK queue `turns` times, so a refresh that is free to
 *  proceed gets every chance to run its (await-heavy) course before the gate opens. A microtask
 *  drain would not be enough: `update()` awaits real transactor reads.
 *
 *  NOTE: the turn count is what gives {@link releaseRefresh}'s `blocked()` assertions their teeth
 *  — an unlatched `Collection.update()` has to be able to run to COMPLETION within these turns,
 *  or "still pending" stops distinguishing "blocked on the latch" from "merely slow". Ten is a
 *  ~10x margin today: with the coordinator's latch reverted locally, both cases' refreshes
 *  completed on macrotask turn 1 against `TestTransactor`. If `update()` ever grows a deeper await
 *  chain — or these cases move onto a transactor with real I/O — raise this rather than letting
 *  the assertion quietly weaken into a tautology. */
async function drainMacrotasks(turns = 10): Promise<void> {
	for (let i = 0; i < turns; i++) {
		await new Promise(r => setTimeout(r, 0));
	}
}

/** Start a refresh and report — via the returned `blocked()` — whether it is STILL pending.
 *
 *  The final-state assertions in both cases would also pass if the refresh had simply run to
 *  completion harmlessly, so on its own neither case proves the latch is what protected them.
 *  This does: checked after {@link drainMacrotasks} but before the gate opens, a still-pending
 *  refresh is a refresh queued behind the coordinator's held latch. */
function releaseRefresh(collection: Collection<SpecAction>): { settle: () => Promise<void>; blocked: () => boolean } {
	let done = false;
	let failure: unknown;
	// Both handlers attach SYNCHRONOUSLY, and the rethrowing promise is built only when the caller
	// asks for it. The refresh sits unawaited across drainMacrotasks below, so a rejection reaching
	// the end of a turn with no handler would be a fatal unhandled rejection — killing the process
	// instead of failing the case. Captured here, rethrown at `settle()`.
	const captured = collection.update().then(
		() => { done = true; },
		(e: unknown) => { done = true; failure = e; },
	);
	return {
		settle: () => captured.then(() => { if (failure !== undefined) throw failure; }),
		blocked: () => !done,
	};
}

/** Every action recorded in a collection's committed log, oldest first. One entry per landed
 *  transaction, so the length is the no-duplicate-log-entry assertion. */
async function logActions<T>(collection: Collection<T>): Promise<Action<T>[]> {
	const out: Action<T>[] = [];
	for await (const action of collection.selectLog()) out.push(action);
	return out;
}

/** Stage one `set` action into `coordinator`'s single collection and return the transaction that
 *  will commit it. Mirrors makeConflictSetup in transaction.spec.ts, minus the rival wiring. */
async function stageOne(coordinator: TransactionCoordinator, value: string): Promise<Transaction> {
	const actions: CollectionActions[] = [
		{ collectionId, actions: [{ type: 'set', data: { value } }] },
	];
	const statements = createActionsStatements(actions);
	const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
	const transaction: Transaction = {
		stamp, statements, reads: [],
		id: await createTransactionId(stamp.id, statements, []),
	};
	await coordinator.applyActions(actions, stamp.id);
	return transaction;
}

/**
 * Parks the commit AFTER the inner transactor has made it durable and BEFORE the result gets back
 * to the coordinator — precisely the window in which storage already holds the new revision but
 * `recordCommitted` has not run.
 *
 * Everything else delegates, so the pend/commit round trip is otherwise the real one.
 */
class GatedCommitTransactor extends DelegatingTransactor {
	/** The `rev` carried on each pend request seen, in call order. */
	readonly pendRevs: (number | undefined)[] = [];
	/** The `rev` carried on each commit request seen, in call order. */
	readonly commitRevs: number[] = [];
	/** Resolves once a commit has landed durably in the inner transactor and is parked. */
	readonly commitParked: Promise<void>;
	private readonly parked = deferred();
	private readonly gate = deferred();
	private parkedOnce = false;

	constructor(inner: TestTransactor) {
		super(inner);
		this.commitParked = this.parked.promise;
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		this.pendRevs.push(request.rev);
		return this.inner.pend(request);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		this.commitRevs.push(request.rev);
		const result = await this.inner.commit(request);	// durable FIRST
		if (!this.parkedOnce) {
			this.parkedOnce = true;
			this.parked.resolve();
			await this.gate.promise;
		}
		return result;
	}

	openGate(): void { this.gate.resolve(); }
}

/**
 * Parks the FIRST pend BEFORE it reaches the inner transactor, so a rival can durably take the
 * revision while the coordinator is already committed to a set of transforms it captured at the
 * log append.
 *
 * Snapshots the pair `(what was handed to the network, what the collection's tracker held)` at
 * DELEGATION time — after the gate — for every pend, so a refresh that swapped the tracker's
 * transforms object out from under the coordinator shows up as a divergent pair.
 */
class GatedPendTransactor extends DelegatingTransactor {
	/** One entry per delegated pend, in call order. */
	readonly snapshots: { pended: Transforms; staged: Transforms }[] = [];
	/** Resolves once a pend is parked and has NOT yet reached the inner transactor. */
	readonly pendParked: Promise<void>;
	/** The collection under test. Assigned after construction — the collection is built over this
	 *  wrapper, so it cannot be a constructor argument. */
	collection?: Collection<SpecAction>;
	private readonly parked = deferred();
	private readonly gate = deferred();
	private parkedOnce = false;

	constructor(inner: TestTransactor) {
		super(inner);
		this.pendParked = this.parked.promise;
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		if (!this.parkedOnce) {
			this.parkedOnce = true;
			this.parked.resolve();
			await this.gate.promise;
		}
		this.snapshots.push({
			pended: structuredClone(request.transforms),
			staged: structuredClone(this.collection!.tracker.transforms),
		});
		return this.inner.pend(request);
	}

	openGate(): void { this.gate.resolve(); }
}

/** A SECOND Collection over the same id, committing 'rival' through the single-collection sync
 *  path against the UNWRAPPED transactor — so its own pend/commit never re-enter the gate, and
 *  the instance-scoped latch it takes is not the one the coordinator is holding. */
async function rivalWrite(unwrapped: ITransactor): Promise<void> {
	const rival = await Collection.createOrOpen<SpecAction>(unwrapped, collectionId, init());
	await rival.act({ type: 'set', data: { value: 'rival' } });
	await rival.updateAndSync();
}

describe('coordinator commit / collection refresh interleaving', () => {
	it('a refresh released between the durable commit and recordCommitted cannot fork the revision', async () => {
		const inner = new TestTransactor();
		const transactor = new GatedCommitTransactor(inner);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionId, collection]]));
		const transaction = await stageOne(coordinator, 'local');

		const commitPromise = coordinator.commit(transaction);
		// Storage now holds the new revision; the coordinator has not yet run recordCommitted.
		await transactor.commitParked;

		// Release a refresh into exactly that window and give it every chance to interleave.
		const refresh = releaseRefresh(collection);
		// The gate opens in the `finally` so a FAILING assertion still lets the parked commit run to
		// completion. Without it a failure leaves `commitPromise` pending forever and the
		// collection's latch held, so the case reports its real failure buried under leaked state.
		try {
			await drainMacrotasks();
			expect(refresh.blocked(), 'the refresh is queued behind the commit span, not running inside it')
				.to.be.true;
		} finally {
			transactor.openGate();
		}
		await commitPromise;
		await refresh.settle();	// also the no-deadlock assertion (the mocha timeout catches a hang)

		expect(transactor.pendRevs, 'exactly one pend, one revision').to.have.lengthOf(1);
		const pendedRev = transactor.pendRevs[0];
		expect(pendedRev, 'the pend named a revision').to.be.a('number');
		expect(transactor.commitRevs, 'the commit repeated the pended revision').to.deep.equal([pendedRev]);

		// The whole point: the collection recorded the revision storage assigned this action, not
		// one a mid-flight refresh pushed it past.
		expect(collection.committedRevision(), 'records exactly the revision it pended at')
			.to.equal(pendedRev);
		expect(collection.committedActionId(), "under this transaction's own action id")
			.to.equal(transaction.id);

		// Local record and storage agree — a fresh handle over the same storage lands on the same
		// (revision, action) pair. A forked local counter shows up here as a one-revision gap.
		const fresh = await Collection.open<SpecAction>(inner, collectionId, init());
		expect(fresh, 'the collection is durable in storage').to.not.be.undefined;
		expect(fresh!.committedRevision(), 'local record and storage agree on the revision')
			.to.equal(collection.committedRevision());
		expect(fresh!.committedActionId(), 'and on the lineage').to.equal(transaction.id);

		expect((await logActions(collection)).map(a => a.data.value), 'one log entry, once')
			.to.deep.equal(['local']);
	});

	it('a refresh released against a parked pend cannot desync the transforms on the wire', async () => {
		const inner = new TestTransactor();
		const transactor = new GatedPendTransactor(inner);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());
		transactor.collection = collection;
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionId, collection]]));
		const transaction = await stageOne(coordinator, 'local');

		// Short, bounded backoff: the retry below is the point of the case, not its latency.
		const retryOptions = { maxAttempts: 4, baseBackoffMs: 1, maxBackoffMs: 5, deadlineMs: 4000 };
		const commitPromise = coordinator.commit(transaction, retryOptions);
		await transactor.pendParked;

		// A rival durably takes the revision the parked pend is about to ask for.
		await rivalWrite(inner);

		// Release a refresh on the LOSER's instance while its own pend is still parked.
		const refresh = releaseRefresh(collection);
		try {	// gate opens even on a failing assertion — see case 1
			await drainMacrotasks();
			expect(refresh.blocked(), 'the refresh is queued behind the commit span, not replaying inside it')
				.to.be.true;
		} finally {
			transactor.openGate();
		}
		await commitPromise;
		await refresh.settle();	// no-deadlock assertion, as in case 1

		// Attempt 1 loses the revision to the rival; the retry re-reads and attempt 2 wins.
		expect(transactor.snapshots.length, 'the parked pend and at least one retry delegated')
			.to.be.greaterThan(1);
		transactor.snapshots.forEach(({ pended, staged }, i) => {
			expect(pended, `pend #${i + 1} sent exactly what the collection believed it had staged`)
				.to.deep.equal(staged);
		});

		// Both writers are durable, once each — the retry did not re-append the loser's entry.
		// NOTE: the ORDER here is a TestTransactor property (the rival commits to completion before
		// the parked pend is released), not a guarantee of the code under test. What this case is
		// actually asserting is the multiset — one entry per writer, no duplicate from the retry. If
		// a transactor change ever makes commit ordering non-deterministic, compare sorted values
		// rather than relaxing this into a length check, which would stop catching a duplicate.
		expect((await logActions(collection)).map(a => a.data.value), 'both writes landed, once each')
			.to.deep.equal(['rival', 'local']);
		const fresh = await Collection.open<SpecAction>(inner, collectionId, init());
		expect(fresh, 'the collection is durable in storage').to.not.be.undefined;
		expect((await logActions(fresh!)).map(a => a.data.value), 'and storage agrees')
			.to.deep.equal(['rival', 'local']);
		expect(inner.getCommittedActions().has(transaction.id), "the loser's action committed")
			.to.be.true;

		// Same (revision, lineage) agreement case 1 asserts, but reached through the RETRY: the
		// retry loop's blanket collection.update() runs outside the latch, between attempts, so
		// this is where a rev captured on attempt 1 and recorded after attempt 2 would show up.
		// Explicitly a number, so the equality below cannot pass with both sides `undefined`.
		expect(collection.committedRevision(), 'the winning attempt recorded a revision').to.be.a('number');
		expect(collection.committedRevision(), 'local record and storage agree on the revision')
			.to.equal(fresh!.committedRevision());
		expect(collection.committedActionId(), "under the winning attempt's own action id")
			.to.equal(transaction.id);
		expect(fresh!.committedActionId(), 'and storage attributes that revision to it')
			.to.equal(transaction.id);
	});
});
