/**
 * The multi-collection mirror of collection-own-action-replay.spec.ts.
 *
 * A write can HALF-LAND: `NetworkTransactor.commit` commits the collection header and log tail
 * before sweeping the remaining blocks, so a later sweep block that loses a race reports the whole
 * commit as failed even though the log entry is already permanently stored. The writer is then
 * told "stale", retries — and unless the retry recognises that durable entry as its OWN, it
 * re-appends the same actions under the same action id at a second revision.
 *
 * `Collection.sync` learned to recognise its own entry first. These cases cover the OTHER write
 * path: `TransactionCoordinator.commit`, whose inter-attempt refresh goes through the same
 * `Collection.update()` a reader calls. It can only tell the difference because the collection
 * itself remembers which of its own writes is in flight (`Collection.beginInFlightAction`, read by
 * the refresh) — the coordinator marks each participant under its latch and clears the marks in a
 * `finally` around the WHOLE retry loop, since the refresh that reads them runs between attempts,
 * outside the latched span.
 *
 * Case 3 is the other half of that invariant: a mark that outlived its commit would let a LATER,
 * unrelated refresh consume a foreign entry that happens to carry the same id — silently dropping
 * pending work that was never made durable.
 */

import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	Collection,
	TransactionCoordinator,
	createActionsStatements,
	createTransactionId,
	createTransactionStamp,
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
import {
	CommitLandsButReportsStale,
	DelegatingTransactor,
	TestTransactor,
} from '../src/testing/test-transactor.js';

type SpecAction = { value: string };

/** Each action inserts one fresh block, so a landed action leaves a durable trace and a lost one
 *  leaves none — same shape as coordinator-latch-interleaving.spec.ts. */
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

/** Short, bounded backoff: these cases are about WHAT the retry does, not how long it waits. */
const retryFast = { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 };

/** Every action recorded in a collection's committed log, oldest first. One entry per landed
 *  transaction, so the length is the no-duplicate-entry assertion. */
async function logValues(collection: Collection<SpecAction>): Promise<string[]> {
	const out: string[] = [];
	for await (const action of collection.selectLog()) out.push(action.data.value);
	return out;
}

/** Stage one `set` action per entry into `coordinator`'s collections and return the transaction
 *  that will commit them. Mirrors stageOne in coordinator-latch-interleaving.spec.ts, generalised
 *  to more than one collection.
 *
 *  `idOverride` forces the resulting transaction's action id — used by the abandoned-commit case to
 *  mint a FOREIGN transaction that nonetheless carries a specific id. */
async function stage(
	coordinator: TransactionCoordinator,
	entries: { collectionId: string; value: string }[],
	idOverride?: string,
): Promise<Transaction> {
	const actions: CollectionActions[] = entries.map(({ collectionId, value }) => ({
		collectionId,
		actions: [{ type: 'set', data: { value } }],
	}));
	const statements = createActionsStatements(actions);
	const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
	const transaction: Transaction = {
		stamp, statements, reads: [],
		id: idOverride ?? await createTransactionId(stamp.id, statements, []),
	};
	await coordinator.applyActions(actions, stamp.id);
	return transaction;
}

/**
 * Tears ONE collection's commit and cleanly loses the OTHER's, in a single attempt.
 *
 * The distinction is the whole point of the multi-collection case:
 *  - the TORN collection's commit reaches the inner transactor and is made durable, then is masked
 *    as `{ success:false, conflict:true }` — its log entry survives the reported failure;
 *  - the CLEANLY-LOST collection's commit never reaches the inner transactor at all, so nothing of
 *    it is durable.
 *
 * If the second one had committed durably too, the coordinator would classify the attempt as a
 * PARTIAL LANDING (`CoordinatorPartialCommitError`, deliberately not retryable) and the retry path
 * — the path under test — would never run. Every later commit passes through, so the retry can
 * actually complete.
 *
 * Collections are told apart by block id, not call order: `createOrOpen` uses the collection id as
 * its header block id, and a first commit carries that header among its blocks. Call order across
 * `commitPhase`'s concurrent fan-out is not contractual.
 */
class TearsOneLosesOtherTransactor extends DelegatingTransactor {
	/** Commits that actually landed on the inner transactor (masked or not). */
	landedCommits = 0;
	private tornInjected = false;
	private lossInjected = false;
	/** Header block id — equivalently, collection id — of the collection whose commit tears. */
	private readonly tornCollectionId: BlockId;
	/** Header block id of the collection whose commit is a clean loss. */
	private readonly lostCollectionId: BlockId;

	constructor(inner: TestTransactor, tornCollectionId: BlockId, lostCollectionId: BlockId) {
		super(inner);
		this.tornCollectionId = tornCollectionId;
		this.lostCollectionId = lostCollectionId;
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (!this.lossInjected && request.blockIds.includes(this.lostCollectionId)) {
			this.lossInjected = true;
			// Never delegated: nothing of this collection is durable.
			return { success: false, conflict: true, reason: 'stale commit: injected clean loss' };
		}
		const result = await this.inner.commit(request);
		if (result.success) {
			this.landedCommits++;
			if (!this.tornInjected && request.blockIds.includes(this.tornCollectionId)) {
				this.tornInjected = true;
				return { success: false, conflict: true, reason: 'stale commit: injected torn-action conflict' };
			}
		}
		return result;
	}
}

/**
 * Fails the FIRST pend as a hard (non-conflict) rejection, so the commit is not retryable and
 * escapes `TransactionCoordinator.commit` as a plain Error — an ABANDONED commit. Nothing of it is
 * ever durable, and the in-flight mark it set on the participant must be gone when it leaves.
 * Later pends delegate, so the collection is still usable afterwards.
 */
class PendFailsHardOnce extends DelegatingTransactor {
	private failed = false;

	constructor(inner: TestTransactor) {
		super(inner);
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		if (!this.failed) {
			this.failed = true;
			// No `conflict`, no `missing`/`pending` → isConflictFailure() is false → hard failure.
			return { success: false, reason: 'injected hard pend rejection' };
		}
		return this.inner.pend(request);
	}
}

describe('TransactionCoordinator: own committed action on retry', () => {
	it('consumes its own durably committed entry instead of replaying it (single collection)', async () => {
		const collectionId = 'coord-torn-single';
		const inner = new TestTransactor();
		const transactor = new CommitLandsButReportsStale(inner);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionId, collection]]));
		const transaction = await stage(coordinator, [{ collectionId, value: 'local' }]);

		// Must RESOLVE, not throw: the action IS durable, so the writer is owed a success. Attempt 1
		// tears; the refresh consumes the durable entry and empties the tracker, so attempt 2 finds
		// nothing left to commit and returns.
		await coordinator.commit(transaction, retryFast);

		// Pre-fix the retry replays the pending action and commits a second copy of it (the injection
		// is spent), leaving the SAME action id recorded at two revisions.
		expect(await logValues(collection), 'the action is logged exactly once')
			.to.deep.equal(['local']);
		expect(transactor.landedCommits, 'exactly one commit ever landed on storage').to.equal(1);
		expect(collection.hasUnsyncedChanges(), 'nothing left staged').to.equal(false);

		// The refresh — not recordCommitted, which never ran — is what advanced the context, and it
		// landed on exactly the revision and lineage storage assigned.
		expect(collection.committedRevision(), 'context advanced onto the durable revision').to.equal(1);
		expect(collection.committedActionId(), "under this transaction's own action id")
			.to.equal(transaction.id);

		// A second reader over the UNWRAPPED transactor sees the same single entry, so this is the
		// durable log agreeing, not just this instance's view of it.
		const reader = await Collection.createOrOpen<SpecAction>(inner, collectionId, init());
		expect(await logValues(reader), 'the durable log agrees').to.deep.equal(['local']);
	});

	it('one participant tearing while another cleanly loses leaves each action logged once', async () => {
		const tornId = 'coord-torn-multi-a';
		const lostId = 'coord-torn-multi-b';
		const inner = new TestTransactor();
		const transactor = new TearsOneLosesOtherTransactor(inner, tornId, lostId);
		const torn = await Collection.createOrOpen<SpecAction>(transactor, tornId, init());
		const lost = await Collection.createOrOpen<SpecAction>(transactor, lostId, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([
			[tornId, torn],
			[lostId, lost],
		]));
		const transaction = await stage(coordinator, [
			{ collectionId: tornId, value: 'torn' },
			{ collectionId: lostId, value: 'lost' },
		]);

		await coordinator.commit(transaction, retryFast);

		// The torn participant consumed its own entry on the inter-attempt refresh and dropped out of
		// the retry; the cleanly-lost one re-pended and won. Neither is logged twice.
		expect(await logValues(torn), "the torn participant's action is logged once")
			.to.deep.equal(['torn']);
		expect(await logValues(lost), "the cleanly-lost participant's action is logged once")
			.to.deep.equal(['lost']);

		// One landing per collection: the torn one's masked commit, and the retry that carried the
		// other. A replayed torn action would show up here as a third.
		expect(transactor.landedCommits, 'exactly two commits landed on storage').to.equal(2);
		expect(torn.hasUnsyncedChanges(), 'torn participant left nothing staged').to.equal(false);
		expect(lost.hasUnsyncedChanges(), 'lost participant left nothing staged').to.equal(false);

		// Durable storage agrees with both local views.
		const tornReader = await Collection.createOrOpen<SpecAction>(inner, tornId, init());
		const lostReader = await Collection.createOrOpen<SpecAction>(inner, lostId, init());
		expect(await logValues(tornReader), 'durable log of the torn collection').to.deep.equal(['torn']);
		expect(await logValues(lostReader), 'durable log of the lost collection').to.deep.equal(['lost']);
	});

	it('an abandoned commit leaves no in-flight mark behind for a later refresh to consume', async () => {
		const collectionId = 'coord-abandoned';
		const inner = new TestTransactor();
		const transactor = new PendFailsHardOnce(inner);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionId, collection]]));
		const transaction = await stage(coordinator, [{ collectionId, value: 'mine' }]);

		// A hard pend rejection is not a clean stale loss, so it is not retried — the commit is
		// abandoned with nothing durable and the participant's tracker restored to pre-append.
		let abandoned: unknown;
		try {
			await coordinator.commit(transaction, retryFast);
		} catch (err) {
			abandoned = err;
		}
		expect(abandoned, 'the commit failed hard rather than retrying').to.be.instanceOf(Error);
		expect(collection.hasUnsyncedChanges(), 'the never-committed action is still staged').to.equal(true);

		// A DIFFERENT writer now lands an entry that happens to carry the abandoned transaction's
		// action id — the situation a leaked mark turns into silent data loss.
		const foreignCollection = await Collection.createOrOpen<SpecAction>(inner, collectionId, init());
		const foreignCoordinator = new TransactionCoordinator(inner, new Map([[collectionId, foreignCollection]]));
		const foreign = await stage(foreignCoordinator, [{ collectionId, value: 'theirs' }], transaction.id);
		await foreignCoordinator.commit(foreign, retryFast);

		// The refresh must REPLAY our pending action against that entry, not consume it: our action
		// was never made durable, so consuming it would drop it on the floor. With a leaked mark this
		// update() empties `pending` and hasUnsyncedChanges() goes false.
		await collection.update();
		expect(collection.hasUnsyncedChanges(), 'our pending action survived the foreign entry')
			.to.equal(true);

		await collection.sync(retryFast);
		expect(await logValues(collection), 'both actions are logged, ours after theirs')
			.to.deep.equal(['theirs', 'mine']);
	});
});
