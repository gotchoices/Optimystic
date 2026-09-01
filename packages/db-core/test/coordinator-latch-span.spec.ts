/**
 * The commit-time collection latch SPAN, on the corners `coordinator-latch-interleaving.spec.ts`
 * does not reach: the `execute` code path, more than one collection, and the failure path.
 *
 * **What the span is.** A commit writes to one or more {@link Collection} instances. While it is
 * in flight, nothing else in this process may refresh those instances: a `Collection.update()`
 * landing mid-commit used to leave the collection's local revision counter permanently one ahead
 * of what storage recorded, after which every later read silently served stale data (the sibling
 * spec drives that corruption directly). So both write paths —
 * `TransactionCoordinator.commitOnce` and `TransactionCoordinator.execute` — take each
 * participating collection's instance latch (`Collection.acquireLatch()`) and hold it across the
 * WHOLE commit: log append, the pend/commit round trips, and the local fold afterwards.
 *
 * `execute` has two ordering constraints `commitOnce` does not. The latch is non-reentrant, so
 * `execute` must acquire AFTER `applyActions` (applying an action calls `Collection.act`, which
 * takes that very latch) and must DE-DUPLICATE its collection list before locking (the action list
 * can name one collection twice, and taking one instance's latch twice self-deadlocks). Both cases
 * below are load-bearing precisely because a regression there does not fail an assertion — it
 * hangs, and the mocha timeout is the detector.
 *
 * **The acquisition-order case is the load-bearing proof of the sort.** Both paths sort
 * participants by collection id before acquiring, so two commits over overlapping participant sets
 * cannot take latches in opposite orders and deadlock. `Collection.acquireLatch` is a public
 * instance method, so a test can shadow it with an instance property that records the id and
 * delegates — and only the SPAN acquisitions are recorded, because `act`/`update`/`sync` call
 * `Latches.acquire` directly rather than through `acquireLatch`. Each order case feeds its path
 * the participants in the OPPOSITE order and asserts the sorted one comes back; delete either
 * `.sort(...)` in `coordinator.ts` and the assertion fails.
 *
 * **Why there is no `execute`-path version of the concurrent-deadlock case, and why that is fine.**
 * A real cross-order deadlock is unreachable through `execute`: it latches exactly the collections
 * `applyActions` just wrote, and `applyActions` already serialized on those same per-instance
 * latches, so a second `execute` over an overlapping set cannot even reach its span while the first
 * holds one. The sort is defence-in-depth there, and the order case is what pins it. A later reader
 * who tries to build the "obvious" concurrent-`execute` deadlock needs to know it cannot exist
 * rather than concluding the test is flaky.
 *
 * Every case runs against raw {@link Collection}s with a trivial `set` handler that inserts one
 * fresh block per action — the span is a Collection-level property and a `Tree` only adds nodes to
 * it.
 */

import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	ActionsEngine,
	Collection,
	CoordinatorStaleLossError,
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
	type IBlock,
	type ITransactor,
	type Transaction,
} from '../src/index.js';
import { FlakyCommitTransactor, GatedCommitTransactor, TestTransactor } from '../src/testing/test-transactor.js';
import { drainMacrotasks, releaseRefresh } from '../src/testing/refresh-probe.js';

type SpecAction = { value: string };

/** Two collection ids whose SORTED order is `a` then `b` — the order every span must acquire in,
 *  whatever order its participants arrive in. */
const collectionA = 'span-a';
const collectionB = 'span-b';

/** Each action inserts one fresh block, so a landed action leaves a durable trace and a lost one
 *  leaves none. Same shape as the sibling interleaving spec. */
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

const setAction = (value: string): Action<SpecAction> => ({ type: 'set', data: { value } });

/** One `set` per named collection, in the order given — the order a path sees its participants in
 *  before it sorts them. */
const actionsFor = (...collectionIds: string[]): CollectionActions[] =>
	collectionIds.map(collectionId => ({ collectionId, actions: [setAction(collectionId)] }));

/**
 * Build a transaction over `actions` WITHOUT applying them.
 *
 * `execute` applies the actions itself (the engine is a pure translator), so pre-applying here —
 * as the sibling spec's `stageOne` does, correctly, for the `commitOnce` path — would double-stage.
 * The `commitOnce` cases below call `coordinator.applyActions` explicitly instead.
 */
async function buildTransaction(actions: CollectionActions[]): Promise<Transaction> {
	const statements = createActionsStatements(actions);
	const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
	return {
		stamp, statements, reads: [],
		id: await createTransactionId(stamp.id, statements, []),
	};
}

/** Open two fresh collections, `span-a` and `span-b`, over one transactor. */
async function openPair(transactor: ITransactor): Promise<[Collection<SpecAction>, Collection<SpecAction>]> {
	return [
		await Collection.createOrOpen<SpecAction>(transactor, collectionA, init()),
		await Collection.createOrOpen<SpecAction>(transactor, collectionB, init()),
	];
}

/**
 * Shadow each collection's `acquireLatch` with an instance property that records the collection id
 * and delegates, and return the array the ids land in.
 *
 * Records ONLY the span acquisitions: `act`, `update` and `sync` take the same mutex through
 * `Latches.acquire(this.latchId)` directly, never through this method, so the recorded sequence is
 * exactly the commit path's own acquisition order.
 *
 * The spy must not perturb what it measures — it delegates to the BOUND original and returns its
 * promise unchanged. Awaiting before delegating would change the very queue-registration order
 * this exists to observe (`Latches.acquire` claims its queue position synchronously).
 */
function spyAcquisitionOrder(collections: Collection<SpecAction>[]): string[] {
	const order: string[] = [];
	for (const collection of collections) {
		const original = collection.acquireLatch.bind(collection);
		(collection as unknown as { acquireLatch: () => Promise<() => void> }).acquireLatch = () => {
			order.push(collection.id);
			return original();
		};
	}
	return order;
}

/** Short, bounded backoff: where a case retries at all, the retry is incidental to what it asserts,
 *  not its subject. */
const retryOptions = { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 2, deadlineMs: 2000 };

describe('coordinator commit latch span', () => {
	it('execute holds the span over every participant: refreshes on both are blocked mid-commit', async () => {
		const inner = new TestTransactor();
		const transactor = new GatedCommitTransactor(inner);
		const [a, b] = await openPair(transactor);
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionA, a], [collectionB, b]]));
		const transaction = await buildTransaction(actionsFor(collectionA, collectionB));

		// No applyActions here — execute stages the engine's returned actions itself, through
		// Collection.act, which takes the same non-reentrant latch. That is what makes this case a
		// no-self-deadlock assertion too: a span acquired BEFORE that staging would hold the latch
		// act then waits on, and execute would never reach the transactor at all.
		const executePromise = coordinator.execute(transaction, new ActionsEngine());
		// Parked with the first participant's commit already durable and the span still held.
		// Raced against `execute` itself rather than awaited bare: the park happens INSIDE the commit
		// `execute` is awaiting, so `execute` settling first means it never reached the gate. Waiting
		// on `commitParked` alone would then hang to the mocha timeout while the real rejection went
		// unhandled — fatal to the whole run, not just this case.
		await Promise.race([transactor.commitParked, executePromise]);

		const refreshA = releaseRefresh(a);
		const refreshB = releaseRefresh(b);
		// The gate opens in the `finally` so a FAILING assertion still lets the parked commit run to
		// completion. Without it a failure leaves the span held forever and the case reports its real
		// failure buried under a leaked latch.
		try {
			await drainMacrotasks();
			expect(refreshA.blocked(), 'the refresh on the first participant is queued behind the span')
				.to.be.true;
			expect(refreshB.blocked(), 'and so is the refresh on the second — a span that latched only '
				+ 'one participant would let this one through').to.be.true;
		} finally {
			transactor.openGate();
		}

		const result = await executePromise;
		expect(result.success, `execute completed: ${result.error ?? ''}`).to.be.true;
		// Also the no-deadlock assertion on the release side (the mocha timeout catches a hang).
		await refreshA.settle();
		await refreshB.settle();

		// Neither refresh forked a local revision counter: a fresh handle over the same storage
		// lands on the same (revision, lineage) pair as the committing instance.
		for (const [id, collection] of [[collectionA, a], [collectionB, b]] as const) {
			const fresh = await Collection.open<SpecAction>(inner, id, init());
			expect(fresh, `${id} is durable in storage`).to.not.be.undefined;
			expect(collection.committedRevision(), `${id} recorded a revision`).to.be.a('number');
			expect(fresh!.committedRevision(), `${id}: local record and storage agree on the revision`)
				.to.equal(collection.committedRevision());
			expect(fresh!.committedActionId(), `${id}: and on the lineage`).to.equal(transaction.id);
			// Revision + lineage agreement alone would still pass if the span had appended the entry
			// twice at one revision, so read the log back: one entry, carrying this collection's
			// own action. Same assertion shape as the sibling interleaving spec's.
			const logged: string[] = [];
			for await (const action of fresh!.selectLog()) logged.push(action.data.value);
			expect(logged, `${id}: one log entry, once`).to.deep.equal([id]);
		}
	});

	it('execute takes exactly one span latch for a collection its actions name twice', async () => {
		const inner = new TestTransactor();
		const a = await Collection.createOrOpen<SpecAction>(inner, collectionA, init());
		const coordinator = new TransactionCoordinator(inner, new Map([[collectionA, a]]));
		const transaction = await buildTransaction([
			{ collectionId: collectionA, actions: [setAction('first')] },
			{ collectionId: collectionA, actions: [setAction('second')] },
		]);
		const order = spyAcquisitionOrder([a]);

		// The OUTCOME is deliberately unasserted. This transaction commits correctly and durably and
		// then throws out of execute's post-commit fold, which iterates result.actions rather than
		// the distinct participant set and so folds the one collection twice — a separate, currently
		// dormant defect tracked as `debt-execute-duplicate-collection-actions-double-record`. What
		// escapes today is `Collection span-a: action <id> was pended at rev N but the collection now
		// expects rev N+1 — the collection was refreshed mid-commit`, from the second fold.
		// Asserting the outcome either way would make this case fail when that defect is fixed; what
		// it is here to prove — one latch, and a durable landing — holds under both behaviours.
		// Reaching this line AT ALL is the assertion that matters most: an undeduped span would take
		// this instance's non-reentrant latch twice and hang until the mocha timeout.
		await coordinator.execute(transaction, new ActionsEngine()).catch(() => undefined);

		expect(order, 'the span deduped its participant list before acquiring')
			.to.deep.equal([collectionA]);
		expect(inner.getCommittedActions().has(transaction.id), 'and the transaction reached storage')
			.to.be.true;
		// This coordinator and collection are now poisoned (durably committed, then thrown out of
		// mid-fold) — nothing else may be asserted through them.
	});

	it('execute acquires span latches in sorted collection-id order', async () => {
		const inner = new TestTransactor();
		const [a, b] = await openPair(inner);
		const coordinator = new TransactionCoordinator(inner, new Map([[collectionA, a], [collectionB, b]]));
		// Actions ordered b-then-a: `allCollectionIds` follows result.actions, so without the sort
		// the span would acquire in this order.
		const transaction = await buildTransaction(actionsFor(collectionB, collectionA));
		const order = spyAcquisitionOrder([a, b]);

		const result = await coordinator.execute(transaction, new ActionsEngine());

		expect(result.success, `execute completed: ${result.error ?? ''}`).to.be.true;
		expect(order, 'sorted, not the order the actions arrived in')
			.to.deep.equal([collectionA, collectionB]);
	});

	it('commitOnce acquires span latches in sorted collection-id order', async () => {
		const inner = new TestTransactor();
		const [a, b] = await openPair(inner);
		// Collection map built in insertion order b, a — commitOnce derives its participants by
		// iterating this map, so this is the order the acquisition falls back to without the sort.
		const coordinator = new TransactionCoordinator(inner, new Map([[collectionB, b], [collectionA, a]]));
		const actions = actionsFor(collectionB, collectionA);
		const transaction = await buildTransaction(actions);
		await coordinator.applyActions(actions, transaction.stamp.id);
		const order = spyAcquisitionOrder([a, b]);

		await coordinator.commit(transaction);

		expect(order, 'sorted, not the coordinator map order')
			.to.deep.equal([collectionA, collectionB]);
	});

	it('two concurrent commits over overlapping collections both complete', async () => {
		const inner = new TestTransactor();
		const [a, b] = await openPair(inner);
		// TWO coordinators over the SAME instances are required: the latch is per-instance, so
		// separate Collection instances would never contend, and one coordinator would hand both
		// commits the same participant order. Opposite map orders are what a missing sort turns into
		// opposite acquisition orders.
		const first = new TransactionCoordinator(inner, new Map([[collectionA, a], [collectionB, b]]));
		const second = new TransactionCoordinator(inner, new Map([[collectionB, b], [collectionA, a]]));

		const firstActions = actionsFor(collectionA, collectionB);
		const firstTransaction = await buildTransaction(firstActions);
		await first.applyActions(firstActions, firstTransaction.stamp.id);
		const secondActions = [
			{ collectionId: collectionB, actions: [setAction('second-b')] },
			{ collectionId: collectionA, actions: [setAction('second-a')] },
		];
		const secondTransaction = await buildTransaction(secondActions);
		await second.applyActions(secondActions, secondTransaction.stamp.id);

		// Externally hold BOTH latches, so each commit pins at its FIRST span acquisition rather
		// than racing through. `Latches.acquire` registers its queue position synchronously and is
		// FIFO, so starting one commit, draining, then starting the other makes the queue state
		// deterministic: with the sort both queue on `a`; without it they queue head-to-head.
		const releaseA = await a.acquireLatch();
		const releaseB = await b.acquireLatch();

		const firstCommit = first.commit(firstTransaction, retryOptions);
		await drainMacrotasks();
		const secondCommit = second.commit(secondTransaction, retryOptions);
		await drainMacrotasks();
		// Both promises sit unawaited across the drains above. A rejection reaching the end of a turn
		// with no handler attached is a FATAL unhandled rejection — it kills the whole mocha run
		// instead of failing this case (the same hazard `releaseRefresh` guards against). These
		// no-op catches attach a handler without swallowing anything: the `Promise.all` below is
		// still on the originals, so a real rejection is still reported there.
		firstCommit.catch(() => undefined);
		secondCommit.catch(() => undefined);

		// Released BEFORE the assertion below, and exactly once, so a failing assertion cannot leave
		// the collections latched for the rest of the file.
		releaseA();
		releaseB();

		// With the sort both commits want `a` first, serialize, and both resolve. Without it, the
		// first holds `a` and wants `b` while the second holds `b` and wants `a`: the mocha timeout
		// is the deadlock detector.
		await Promise.all([firstCommit, secondCommit]);

		// SCOPE, so a later reader does not over-read this case: the two coordinators share the two
		// Collection INSTANCES (they have to — the latch is per-instance), and therefore share their
		// staged state. Verified by instrumenting `getPendingActions`: the first commit takes BOTH
		// stamps' staged actions into its log entry, and the second, arriving after that fold reset
		// the trackers, appends an EMPTY entry. So both commits really do run their whole span —
		// append, pend, commit, fold, at revisions 1 and 2 — but only the first carries work. This
		// case is about the acquisition order not deadlocking, not about two bodies of work landing
		// independently; the durability of a multi-collection commit is asserted by the first case in
		// this file.
		expect(a.committedRevision(), 'both commits folded through span-a').to.equal(2);
		expect(b.committedRevision(), 'and through span-b').to.equal(2);
	});

	it('execute releases the span when the commit fails inside it', async () => {
		const inner = new TestTransactor();
		// Every commit fails, so coordinateTransaction fails and execute returns a failure result
		// from INSIDE the locked block — the early-return escape the `finally` has to cover.
		const transactor = new FlakyCommitTransactor(inner, Infinity);
		const [a, b] = await openPair(transactor);
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionA, a], [collectionB, b]]));
		const transaction = await buildTransaction(actionsFor(collectionA, collectionB));

		const result = await coordinator.execute(transaction, new ActionsEngine());

		expect(result.success, 'the commit failed inside the span').to.be.false;
		// A leaked latch is silent: these simply never return, and the mocha timeout is the detector.
		await a.update();
		await b.update();
	});

	it('commitOnce releases the span when the commit rejects out of it', async () => {
		const inner = new TestTransactor();
		const transactor = new FlakyCommitTransactor(inner, Infinity);
		const [a, b] = await openPair(transactor);
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionA, a], [collectionB, b]]));
		const actions = actionsFor(collectionA, collectionB);
		const transaction = await buildTransaction(actions);
		await coordinator.applyActions(actions, transaction.stamp.id);

		let thrown: unknown;
		try {
			await coordinator.commit(transaction, retryOptions);
		} catch (error) {
			thrown = error;
		}

		expect(thrown, 'the retry budget ran out on a clean stale loss')
			.to.be.instanceOf(CoordinatorStaleLossError);
		// As above: a latch leaked on the throwing path shows up as a refresh that never returns.
		await a.update();
		await b.update();
	});
});
