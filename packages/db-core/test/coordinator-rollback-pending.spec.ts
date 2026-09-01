/**
 * A `Collection` stages every change in TWO places, written together by `Collection.actInternal`:
 * the tracker transforms (the in-memory picture reads see) and the pending queue (the ordered
 * action list a commit records into the collection's durable action log).
 *
 * `TransactionCoordinator.rollback` used to restore only the tracker half, so an aborted
 * transaction's actions stayed queued, and the NEXT transaction to commit on that collection wrote
 * them into its own durable log entry (commitOnceLatched builds each entry from
 * `getPendingActions()`). Reads right after such a commit still looked correct — the entry's
 * transforms come from the tracker, which WAS rolled back — which is why the transform-and-read
 * assertions in transaction.spec.ts missed it. The corruption lives in the action list, so these
 * cases assert on the pending queue and on what reaches the log append, never on transforms.
 *
 * The coordinator now enforces at most ONE open stamp at a time (locked by
 * coordinator-single-stamp.spec.ts), so the multi-stamp rollback cases that used to live here —
 * survivor replay, cross-stamp interleaved batches — are retired: the configuration they exercised
 * is refused outright at the second stamp's first applyActions.
 *
 * Rollback is driven through `coordinator.rollback(stampId)` directly; `TransactionSession.rollback`
 * is a thin delegate to exactly that call.
 */

import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	Collection,
	CoordinatorPartialCommitError,
	TransactionCoordinator,
	blockIdsForTransforms,
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
	type PendRequest,
	type PendResult,
	type Transaction,
} from '../src/index.js';
import { DelegatingTransactor, TestTransactor } from '../src/testing/test-transactor.js';

type SpecAction = { value: string };

/** Each action inserts one fresh block, so staging is observable in the tracker as well as the
 *  queue — same shape as coordinator-own-action-replay.spec.ts. */
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

/** A staged unit of work: the stamp id a rollback names, plus the transaction a commit takes. */
type Staged = { stampId: string; transaction: Transaction };

/** Stage one `set` action per entry under a FRESH stamp and return both the stamp id and the
 *  transaction that would commit it. One call models one session's `applyActions`. */
async function stage(
	coordinator: TransactionCoordinator,
	entries: { collectionId: string; value: string }[],
): Promise<Staged> {
	const actions: CollectionActions[] = entries.map(({ collectionId, value }) => ({
		collectionId,
		actions: [{ type: 'set', data: { value } }],
	}));
	const statements = createActionsStatements(actions);
	const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
	const transaction: Transaction = {
		stamp, statements, reads: [],
		id: await createTransactionId(stamp.id, statements, []),
	};
	await coordinator.applyActions(actions, stamp.id);
	return { stampId: stamp.id, transaction };
}

/** Stage another batch under the ALREADY-tracked stamp — no new snapshot is taken; models a later
 *  statement of the same session. */
async function stageMore(
	coordinator: TransactionCoordinator,
	staged: Staged,
	entries: { collectionId: string; value: string }[],
): Promise<void> {
	await coordinator.applyActions(
		entries.map(({ collectionId, value }) => ({
			collectionId,
			actions: [{ type: 'set', data: { value } }],
		})),
		staged.stampId,
	);
}

/** The `data.value` of every action queued on a collection, in queue order. Duplicates show up as
 *  repeats, which is the point: membership alone would not have caught the double-replay. */
function queuedValues(collection: Collection<SpecAction>): string[] {
	return collection.getPendingActions().map(a => a.data.value);
}

/** The general guard: after ANY rollback, no collection's pending queue may hold an action tagged
 *  with the rolled-back stamp. `applyActionsRaw` tags every action it stages as
 *  `{ ...action, transaction: stampId }`, so the tag is the ground truth for provenance — stronger
 *  than comparing values, and inherited by future rollback paths. */
function expectNoActionsFromStamp(
	collections: Map<string, Collection<SpecAction>>,
	stampId: string,
	label: string,
): void {
	for (const [collectionId, collection] of collections) {
		const leftover = collection.getPendingActions().filter(a => a.transaction === stampId);
		expect(leftover.map(a => a.data.value), `${label}: ${collectionId} still queues rolled-back actions`)
			.to.deep.equal([]);
	}
}

/** Every action recorded in a collection's committed log, oldest first. */
async function logValues(collection: Collection<SpecAction>): Promise<string[]> {
	const out: string[] = [];
	for await (const action of collection.selectLog()) out.push(action.data.value);
	return out;
}

/** Create N collections on one coordinator, all registered BEFORE any staging. The collection map
 *  is handed to the coordinator and stays live afterwards — see {@link registerLate} for the
 *  mid-transaction-registration case, which the same snapshot machinery must also cover. */
async function makeCoordinator(
	transactor: ConstructorParameters<typeof TransactionCoordinator>[0],
	collectionIds: string[],
): Promise<{ coordinator: TransactionCoordinator; collections: Map<string, Collection<SpecAction>> }> {
	const collections = new Map<string, Collection<SpecAction>>();
	for (const id of collectionIds) {
		collections.set(id, await Collection.createOrOpen<SpecAction>(transactor as any, id, init()));
	}
	const coordinator = new TransactionCoordinator(transactor, collections as Map<string, Collection<any>>);
	return { coordinator, collections };
}

/** Add a BRAND-NEW collection to the coordinator's live map AFTER the coordinator was built —
 *  the shape the Quereus adapter produces when a table is first opened partway through a
 *  transaction (`TransactionBridge.registerCollection` mutates the same map the coordinator holds).
 *  The coordinator does not own this map, so it can only notice the addition at its next
 *  `applyActions`. */
async function registerLate(
	transactor: ConstructorParameters<typeof TransactionCoordinator>[0],
	collections: Map<string, Collection<SpecAction>>,
	collectionId: string,
): Promise<Collection<SpecAction>> {
	const collection = await Collection.createOrOpen<SpecAction>(transactor as any, collectionId, init());
	collections.set(collectionId, collection);
	return collection;
}

/** The tracker's insert keys, sorted. A collection with no committed revision carries its own
 *  header/root blocks here, so "rolled back" is "back to the keys it had before staging" — not
 *  "empty". Asserting the transform half matters because the pending half alone was already being
 *  restored for eagerly-captured collections, which is how the sibling defect stayed hidden. */
function insertKeys(collection: Collection<SpecAction>): string[] {
	return Object.keys(collection.tracker.transforms.inserts ?? {}).sort();
}

/** Permanently loses the COMMIT for one collection while the other lands, producing the partial
 *  landing that makes `rollback` a deliberate no-op. Mirrors PartialLossTransactor in
 *  transaction.spec.ts (kept local rather than growing that already-oversized file). */
class PartialLossTransactor extends DelegatingTransactor {
	private readonly poison = new Set<BlockId>();
	constructor(inner: TestTransactor, private readonly poisonCollectionId: string) { super(inner); }
	override async pend(request: PendRequest): Promise<PendResult> {
		const firstInsert = Object.values(request.transforms.inserts ?? {})[0] as IBlock | undefined;
		if (firstInsert?.header.collectionId === this.poisonCollectionId) {
			for (const id of blockIdsForTransforms(request.transforms)) this.poison.add(id);
		}
		return this.inner.pend(request);
	}
	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (request.blockIds.some(id => this.poison.has(id))) {
			return { success: false, reason: `forced loss: ${this.poisonCollectionId}` };
		}
		return this.inner.commit(request);
	}
}

/** Hard-rejects the first pend (no conflict markers → not retryable), then delegates. Nothing of
 *  the failed commit is durable, and `commitOnceLatched`'s catch restores its pre-append snapshots
 *  through the same `restorePending` a rollback uses. */
class PendFailsHardOnce extends DelegatingTransactor {
	private failed = false;
	constructor(inner: TestTransactor) { super(inner); }
	override async pend(request: PendRequest): Promise<PendResult> {
		if (!this.failed) {
			this.failed = true;
			return { success: false, reason: 'injected hard pend rejection' };
		}
		return this.inner.pend(request);
	}
}

describe('TransactionCoordinator.rollback: pending queue', () => {
	it('empties the queue when the rolled-back stamp is the only one staged', async () => {
		const id = 'rb-solo';
		const { coordinator, collections } = await makeCoordinator(new TestTransactor(), [id]);
		const one = await stage(coordinator, [{ collectionId: id, value: 'one' }]);
		expect(queuedValues(collections.get(id)!), 'staged before rollback').to.deep.equal(['one']);

		await coordinator.rollback(one.stampId);

		expect(queuedValues(collections.get(id)!), 'queue is empty after rollback').to.deep.equal([]);
		expectNoActionsFromStamp(collections, one.stampId, 'solo rollback');
	});

	it('clears the rolled-back stamp from every collection it touched', async () => {
		const [one, two] = ['rb-multi-one', 'rb-multi-two'];
		const { coordinator, collections } = await makeCoordinator(new TestTransactor(), [one, two]);
		const both = await stage(coordinator, [
			{ collectionId: one, value: 'both-one' },
			{ collectionId: two, value: 'both-two' },
		]);

		await coordinator.rollback(both.stampId);

		expect(queuedValues(collections.get(one)!), 'first collection is empty').to.deep.equal([]);
		expect(queuedValues(collections.get(two)!), 'second collection is empty').to.deep.equal([]);
		expectNoActionsFromStamp(collections, both.stampId, 'multi-collection rollback');
	});

	it('does not write the rolled-back stamp into the NEXT transaction\'s durable log entry', async () => {
		const id = 'rb-then-commit';
		const inner = new TestTransactor();
		const { coordinator, collections } = await makeCoordinator(inner, [id]);
		const collection = collections.get(id)!;

		const aborted = await stage(coordinator, [{ collectionId: id, value: 'aborted' }]);
		await coordinator.rollback(aborted.stampId);

		// Observe the exact array that reaches the log append: commitOnceLatched builds each log
		// entry from getPendingActions(), so this is the clearest single symptom of the defect.
		const appended: Action<SpecAction>[][] = [];
		const realGetPending = collection.getPendingActions.bind(collection);
		(collection as { getPendingActions: () => Action<SpecAction>[] }).getPendingActions = () => {
			const actions = realGetPending();
			appended.push([...actions]);
			return actions;
		};

		const kept = await stage(coordinator, [{ collectionId: id, value: 'kept' }]);
		await coordinator.commit(kept.transaction);

		// Pre-fix, the commit's array carried BOTH actions and the durable entry recorded both.
		expect(appended.length, 'commit read the pending queue').to.be.greaterThan(0);
		for (const batch of appended) {
			expect(batch.map(a => a.data.value), 'only the committing stamp reached the log append')
				.to.deep.equal(['kept']);
			expect(batch.every(a => a.transaction !== aborted.stampId), 'nothing tagged with the aborted stamp')
				.to.equal(true);
		}
		expect(await logValues(collection), 'durable log holds only the kept action').to.deep.equal(['kept']);
		// Also proves the invented-collection case: this collection had no committed revision when
		// the rollback ran, so its header/root blocks lived in the tracker. Restoring a SNAPSHOT
		// (rather than resetting to empty) preserved them — otherwise this commit could not resolve.
	});

	it('rolls back cleanly on a collection that already has committed state', async () => {
		const id = 'rb-post-commit';
		const inner = new TestTransactor();
		const { coordinator, collections } = await makeCoordinator(inner, [id]);
		const collection = collections.get(id)!;

		// Land a first transaction, so the collection's log tail lives in storage rather than in
		// the tracker — the case a blanket reset-to-empty would handle differently from a restore.
		const first = await stage(coordinator, [{ collectionId: id, value: 'durable' }]);
		await coordinator.commit(first.transaction);
		expect(queuedValues(collection), 'a committed transaction clears its own queue').to.deep.equal([]);

		const aborted = await stage(coordinator, [{ collectionId: id, value: 'aborted' }]);
		await coordinator.rollback(aborted.stampId);

		expect(queuedValues(collection), 'queue is empty again after the second rollback').to.deep.equal([]);
		expectNoActionsFromStamp(collections, aborted.stampId, 'post-commit rollback');
		expect(await logValues(collection), 'the durable entry is untouched by the rollback')
			.to.deep.equal(['durable']);

		// The collection is still writable: a later transaction commits without dragging the
		// aborted action into its entry.
		const next = await stage(coordinator, [{ collectionId: id, value: 'next' }]);
		await coordinator.commit(next.transaction);
		expect(await logValues(collection), 'only the two kept transactions are durable')
			.to.deep.equal(['durable', 'next']);
	});

	it('stays a no-op for a stamp that never went through applyActions', async () => {
		const id = 'rb-untracked';
		const { coordinator, collections } = await makeCoordinator(new TestTransactor(), [id]);
		const collection = collections.get(id)!;
		// The Tree.stage / deferred-DML path: actions staged straight into the collection, so the
		// coordinator holds no stampData entry to undo.
		await collection.act({ type: 'set', data: { value: 'direct' }, transaction: 'untracked-stamp' });

		await coordinator.rollback('untracked-stamp');

		expect(queuedValues(collection), 'directly-staged action survives an untracked rollback')
			.to.deep.equal(['direct']);
	});

	it('stays a no-op after a partial landing dropped the stamp, leaving the winner durable', async () => {
		const [winner, loser] = ['rb-partial-win', 'rb-partial-lose'];
		const inner = new TestTransactor();
		const transactor = new PartialLossTransactor(inner, loser);
		const { coordinator, collections } = await makeCoordinator(transactor, [winner, loser]);
		const staged = await stage(coordinator, [
			{ collectionId: winner, value: 'win' },
			{ collectionId: loser, value: 'lose' },
		]);

		let err: unknown;
		try {
			await coordinator.commit(staged.transaction);
		} catch (e) { err = e; }
		expect(err, 'partial landing surfaces the partial signal').to.be.instanceOf(CoordinatorPartialCommitError);

		// commitOnceLatched deletes the stampData entry on a partial landing precisely so rollback
		// cannot rewind the collection that DID durably commit. That must stay true.
		const winnerLogBefore = await logValues(collections.get(winner)!);
		await coordinator.rollback(staged.stampId);

		expect(await logValues(collections.get(winner)!), 'the winner stayed durable across the no-op rollback')
			.to.deep.equal(winnerLogBefore);
		expect(winnerLogBefore, 'the winner really did commit').to.deep.equal(['win']);
		// Both queues were folded by the partial-commit branch (winner cleared, loser restored to
		// its pre-append snapshot); the no-op rollback must not have re-staged anything.
		expect(queuedValues(collections.get(winner)!), 'winner queue not re-populated').to.deep.equal([]);
	});

	it('still rolls the queue back cleanly after a failed commit restored its own snapshot', async () => {
		const id = 'rb-after-failed-commit';
		const inner = new TestTransactor();
		const { coordinator, collections } = await makeCoordinator(new PendFailsHardOnce(inner), [id]);
		const collection = collections.get(id)!;
		const staged = await stage(coordinator, [{ collectionId: id, value: 'doomed' }]);

		let err: unknown;
		try {
			await coordinator.commit(staged.transaction, { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 5 });
		} catch (e) { err = e; }
		expect(err, 'a hard pend rejection is not retryable').to.be.instanceOf(Error);
		// Nothing landed, so the catch restored the pre-append snapshot: the action is queued again.
		expect(queuedValues(collection), 'failed commit left the action staged').to.deep.equal(['doomed']);

		await coordinator.rollback(staged.stampId);

		expect(queuedValues(collection), 'rollback after a failed commit empties the queue').to.deep.equal([]);
		expectNoActionsFromStamp(collections, staged.stampId, 'rollback after failed commit');
	});
});

describe('TransactionCoordinator.rollback: collections registered mid-transaction', () => {
	it('empties a collection registered after the stamp started and staged into by that stamp', async () => {
		const [early, late] = ['rb-late-early', 'rb-late-new'];
		const transactor = new TestTransactor();
		const { coordinator, collections } = await makeCoordinator(transactor, [early]);

		const staged = await stage(coordinator, [{ collectionId: early, value: 'early' }]);
		// The table opens partway through the transaction: the adapter drops the new collection
		// straight into the live map the coordinator was handed. The stamp's FIRST applyActions —
		// the only capture point before this fix — is already spent.
		const lateCollection = await registerLate(transactor, collections, late);
		const baseline = insertKeys(lateCollection);

		await stageMore(coordinator, staged, [{ collectionId: late, value: 'late' }]);
		expect(queuedValues(lateCollection), 'staged before rollback').to.deep.equal(['late']);
		expect(insertKeys(lateCollection), 'staging really moved the tracker too').to.not.deep.equal(baseline);

		await coordinator.rollback(staged.stampId);

		// Pre-fix BOTH halves survived here: the queue kept 'late', so the next commit on this
		// collection wrote it into that transaction's durable log entry, still tagged with the
		// cancelled stamp.
		expect(queuedValues(lateCollection), 'the late-registered queue is empty').to.deep.equal([]);
		expect(insertKeys(lateCollection), 'the late-registered tracker holds no staged transforms')
			.to.deep.equal(baseline);
		expect(queuedValues(collections.get(early)!), 'the eagerly-captured collection is empty too')
			.to.deep.equal([]);
		expectNoActionsFromStamp(collections, staged.stampId, 'late-registration rollback');
	});

	it('does not re-capture a collection the stamp already staged into when it is re-registered', async () => {
		const id = 'rb-reregister';
		const { coordinator, collections } = await makeCoordinator(new TestTransactor(), [id]);
		const collection = collections.get(id)!;
		const staged = await stage(coordinator, [{ collectionId: id, value: 'first' }]);

		// `TransactionBridge.registerCollection` is idempotent and `reconcileMaintainedIndexes`
		// re-registers already-open index trees: the SAME instance is written back into the live
		// map after it has been staged into.
		collections.set(id, collection);
		await stageMore(coordinator, staged, [{ collectionId: id, value: 'second' }]);

		await coordinator.rollback(staged.stampId);

		// Without the has-guard the reconcile would record the DIRTY state as "before", and
		// 'first' would survive the rollback it belongs to.
		expect(queuedValues(collection), 'both of the stamp\'s actions are discarded').to.deep.equal([]);
		expectNoActionsFromStamp(collections, staged.stampId, 're-registration rollback');
	});

	it('rolls back a replacement instance registered under an id already in the map', async () => {
		const id = 'rb-instance-swap';
		const transactor = new TestTransactor();
		const { coordinator, collections } = await makeCoordinator(transactor, [id]);
		const original = collections.get(id)!;
		const staged = await stage(coordinator, [{ collectionId: id, value: 'on-original' }]);

		// A table re-initializes mid-transaction: a DIFFERENT Collection object replaces the value
		// stored under the same id. An id-keyed snapshot would push the OLD instance's staged state
		// onto the NEW one; instance keys give the replacement its own capture instead.
		const replacement = await registerLate(transactor, collections, id);
		expect(replacement, 'the map really holds a new instance').to.not.equal(original);
		await stageMore(coordinator, staged, [{ collectionId: id, value: 'on-replacement' }]);

		await coordinator.rollback(staged.stampId);

		expect(queuedValues(replacement), 'the live instance is rewound').to.deep.equal([]);
		expect(queuedValues(original), 'the detached instance is rewound to its own capture')
			.to.deep.equal([]);
		expectNoActionsFromStamp(collections, staged.stampId, 'instance-swap rollback');
	});

	it('leaves a late-registered, transaction-created collection readable and committable', async () => {
		const [early, late] = ['rb-late-read-early', 'rb-late-read-new'];
		const transactor = new TestTransactor();
		const { coordinator, collections } = await makeCoordinator(transactor, [early]);
		const staged = await stage(coordinator, [{ collectionId: early, value: 'early' }]);
		const lateCollection = await registerLate(transactor, collections, late);
		await stageMore(coordinator, staged, [{ collectionId: late, value: 'aborted' }]);

		await coordinator.rollback(staged.stampId);

		// This collection has no committed revision, so its header/root blocks live in the tracker.
		// Restoring the SNAPSHOT (rather than resetting to empty) is what keeps them there; a reset
		// would leave the collection unreadable and the commit below could not resolve.
		const kept = await stage(coordinator, [{ collectionId: late, value: 'kept' }]);
		await coordinator.commit(kept.transaction);

		expect(await logValues(lateCollection), 'only the kept action is durable').to.deep.equal(['kept']);
	});
});
