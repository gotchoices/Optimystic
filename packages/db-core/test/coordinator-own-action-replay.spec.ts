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
 * The last case is the other half of that invariant: a mark that outlived its commit would let a
 * LATER, unrelated refresh consume a foreign entry that happens to carry the same id — silently
 * dropping pending work that was never made durable.
 *
 * Recognising the entry is not enough on its own. The entry proves only that the LOG TAIL landed;
 * in the shape the network transactor actually produces, the blocks after the tail did not, and
 * the coordinator's cancel has dropped their pending records. So the refresh must FINISH the action
 * (re-send the retained attempt at the same id and revision) before it consumes the entry, and
 * `commit()` may return only once every block the entry names holds the action. The
 * `CommitLandsButReportsStale` cases cover the entry being recognised when everything did land;
 * the `TailLandsButReportsStale` cases cover the half-landed shape, which is the one that lost data.
 */

import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	Collection,
	Log,
	TornActionError,
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
	type PendRequest,
	type PendResult,
	type Transaction,
} from '../src/index.js';
import {
	CommitLandsButReportsStale,
	DelegatingTransactor,
	TailLandsButReportsStale,
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

/**
 * The blocks `actionId`'s log entry names, in `collectionId`, that do NOT hold that action in
 * durable storage. Empty is the definition of "this write is saved": readers materialize blocks,
 * not log entries, so an entry whose blocks never landed is a write that silently never happened.
 *
 * Read through a fresh collection over the UNWRAPPED transactor, so this is storage's answer and
 * not the writing instance's view of it.
 */
async function unlandedBlocks(inner: TestTransactor, collectionId: string, actionId: string): Promise<BlockId[]> {
	const reader = await Collection.createOrOpen<SpecAction>(inner, collectionId, init());
	const log = await Log.open<Action<SpecAction>>(reader.tracker, collectionId);
	const entry = (await log!.getFrom(0)).entries.find(e => e.actionId === actionId);
	expect(entry, `${collectionId} logs an entry for action ${actionId}`).to.not.equal(undefined);
	const [status] = await inner.getStatus([{ actionId, blockIds: entry!.blockIds }]);
	return entry!.blockIds.filter((_, i) => status!.statuses[i] !== 'committed');
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
		// The injection fired. (Not `=== 1`: the refresh now re-sends the retained attempt to make
		// sure the action is whole, and with every block already holding it that re-send is an
		// idempotent commit that writes nothing but still succeeds — so this counter cannot tell
		// "finished" from "replayed". The revision assertions below are what can: a replay takes a
		// SECOND revision.)
		expect(transactor.landedCommits, 'the masked commit really landed').to.be.at.least(1);
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
		expect(reader.committedRevision(), 'storage holds ONE revision — a replay would have taken a second')
			.to.equal(1);
		// This is the case where every block really did land: finishing had nothing left to do.
		expect(await unlandedBlocks(inner, collectionId, transaction.id)).to.deep.equal([]);
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

		expect(transactor.landedCommits, 'both injections fired: a masked landing and a real retry')
			.to.be.at.least(2);
		expect(torn.hasUnsyncedChanges(), 'torn participant left nothing staged').to.equal(false);
		expect(lost.hasUnsyncedChanges(), 'lost participant left nothing staged').to.equal(false);

		// Durable storage agrees with both local views.
		const tornReader = await Collection.createOrOpen<SpecAction>(inner, tornId, init());
		const lostReader = await Collection.createOrOpen<SpecAction>(inner, lostId, init());
		expect(await logValues(tornReader), 'durable log of the torn collection').to.deep.equal(['torn']);
		expect(await logValues(lostReader), 'durable log of the lost collection').to.deep.equal(['lost']);
		// One revision per collection: the torn one's masked commit, and the retry that carried the
		// other. A replayed torn action would show up as a SECOND revision on the torn collection.
		// (Counting successful commits no longer discriminates — the refresh's re-send of the torn
		// participant's attempt is an idempotent commit that succeeds while writing nothing.)
		expect(tornReader.committedRevision(), 'the torn collection took one revision').to.equal(1);
		expect(lostReader.committedRevision(), 'the lost collection took one revision').to.equal(1);
	});

	/** One durable commit through the UNWRAPPED transactor, so the collection under test opens
	 *  against a committed header. The half-landed shape is only observable then: a first commit
	 *  that lands nothing but its log tail leaves the header uncommitted, so the refresh cannot
	 *  reach the log at all and the retry is an ordinary one. */
	async function seed(inner: TestTransactor, collectionId: string): Promise<void> {
		const seeded = await Collection.createOrOpen<SpecAction>(inner, collectionId, init());
		await seeded.act({ type: 'set', data: { value: 'seed' } });
		await seeded.sync(retryFast);
	}

	it('finishes a half-landed commit rather than reporting it saved on its log entry alone (single collection)', async () => {
		const collectionId = 'coord-tail-only-single';
		const inner = new TestTransactor();
		await seed(inner, collectionId);
		// Only the LOG TAIL of the first commit lands; the block the action inserted does not, and
		// cancelPhase then drops its pending record. This is what NetworkTransactor.commit leaves
		// behind when the tail commit answers failure after the tail was stored.
		const transactor = new TailLandsButReportsStale(inner);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionId, collection]]));
		const transaction = await stage(coordinator, [{ collectionId, value: 'local' }]);

		await coordinator.commit(transaction, retryFast);

		expect(transactor.tears, 'the tail-only landing was actually injected').to.equal(1);
		// The contract: commit() returned, so every block the entry names holds the action.
		expect(await unlandedBlocks(inner, collectionId, transaction.id),
			'no block the log entry names was left behind').to.deep.equal([]);
		expect(await logValues(collection), 'and the action is still logged exactly once')
			.to.deep.equal(['seed', 'local']);
		expect(collection.hasUnsyncedChanges(), 'nothing left staged').to.equal(false);
		expect(collection.committedRevision(), 'finished AT the revision its tail took, not a new one').to.equal(2);
		expect(collection.committedActionId()).to.equal(transaction.id);
	});

	it('finishes every half-landed participant of a multi-collection commit', async () => {
		const idA = 'coord-tail-only-multi-a';
		const idB = 'coord-tail-only-multi-b';
		const inner = new TestTransactor();
		await seed(inner, idA);
		await seed(inner, idB);
		// Both participants tear the same way, so neither counts as committed and the attempt is a
		// clean stale loss — the retryable shape, whose refresh is the code under test.
		const transactor = new TailLandsButReportsStale(inner, 2);
		const a = await Collection.createOrOpen<SpecAction>(transactor, idA, init());
		const b = await Collection.createOrOpen<SpecAction>(transactor, idB, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[idA, a], [idB, b]]));
		const transaction = await stage(coordinator, [
			{ collectionId: idA, value: 'local-a' },
			{ collectionId: idB, value: 'local-b' },
		]);

		await coordinator.commit(transaction, retryFast);

		expect(transactor.tears, 'both participants were torn').to.equal(2);
		expect(await unlandedBlocks(inner, idA, transaction.id), 'participant A is whole').to.deep.equal([]);
		expect(await unlandedBlocks(inner, idB, transaction.id), 'participant B is whole').to.deep.equal([]);
		expect(await logValues(a)).to.deep.equal(['seed', 'local-a']);
		expect(await logValues(b)).to.deep.equal(['seed', 'local-b']);
		expect(a.hasUnsyncedChanges() || b.hasUnsyncedChanges(), 'nothing left staged').to.equal(false);
	});

	it('refuses by name, and keeps the staged action, when a rival took the revision a half-landed commit still needed', async () => {
		const collectionId = 'coord-tail-only-rival';
		const inner = new TestTransactor();
		await seed(inner, collectionId);
		// The rival commits right after this transaction's cancel, on top of the torn log entry it
		// can already see. The log tail now holds the rival's revision, so nothing can land this
		// transaction's remaining block at its own revision any more.
		const transactor = new TailLandsButReportsStale(inner, 1, async unwrapped => {
			const rival = await Collection.createOrOpen<SpecAction>(unwrapped, collectionId, init());
			await rival.act({ type: 'set', data: { value: 'rival' } });
			await rival.sync(retryFast);
		});
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionId, collection]]));
		const transaction = await stage(coordinator, [{ collectionId, value: 'local' }]);

		let thrown: unknown;
		try {
			await coordinator.commit(transaction, retryFast);
		} catch (err) {
			thrown = err;
		}

		expect(thrown, 'the commit is refused, never acknowledged').to.be.instanceOf(TornActionError);
		const torn = thrown as TornActionError;
		expect(torn.reason).to.equal('rival-holds-revision');
		expect(torn.collectionId).to.equal(collectionId);
		expect(torn.actionId).to.equal(transaction.id);
		expect(torn.rev).to.equal(2);
		// Not re-driven under a new revision (that would log the action twice), and not silently
		// dropped either: the action is still staged for the caller to decide about.
		expect(await unlandedBlocks(inner, collectionId, transaction.id), 'the block never landed')
			.to.not.be.empty;
		expect(collection.hasUnsyncedChanges(), 'the unsaved action is still staged').to.equal(true);
		const reader = await Collection.createOrOpen<SpecAction>(inner, collectionId, init());
		expect(await logValues(reader), 'one entry per writer — no second copy of the torn action')
			.to.deep.equal(['seed', 'local', 'rival']);
	});

	it('gives up as a TORN commit, not as a plain stale loss, when finishing keeps being refused', async () => {
		const collectionId = 'coord-finish-refused-forever';
		const inner = new TestTransactor();
		await seed(inner, collectionId);
		// Every multi-block commit lands only its tail: the first attempt tears, and so does every
		// re-send that tries to finish it. The refresh — never a new commitOnce — is what is retried,
		// so exactly one revision is ever taken.
		const transactor = new TailLandsButReportsStale(inner, Infinity);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionId, collection]]));
		const transaction = await stage(coordinator, [{ collectionId, value: 'local' }]);

		let thrown: unknown;
		try {
			await coordinator.commit(transaction, retryFast);
		} catch (err) {
			thrown = err;
		}

		// A CoordinatorStaleLossError would say nothing landed and invite a re-drive; the log
		// already holds this transaction's entry.
		expect(thrown).to.be.instanceOf(TornActionError);
		expect((thrown as TornActionError).reason).to.equal('completion-refused');
		expect((thrown as TornActionError).rev).to.equal(2);
		expect(collection.hasUnsyncedChanges(), 'the unsaved action is still staged').to.equal(true);
		expect(collection.committedRevision(), 'the writer did not advance past its unsaved write').to.equal(1);
		const reader = await Collection.createOrOpen<SpecAction>(inner, collectionId, init());
		expect(await logValues(reader), 'logged once — no attempt rebuilt the entry at a new revision')
			.to.deep.equal(['seed', 'local']);
		expect(reader.committedRevision()).to.equal(2);
	});

	it('one participant finished and another torn for good: the commit rejects and neither is misreported locally', async () => {
		const idA = 'coord-mixed-a-finished';
		const idB = 'coord-mixed-b-torn';
		const inner = new TestTransactor();
		await seed(inner, idA);
		await seed(inner, idB);
		// Both participants land only their tails. A rival then commits to B alone, so the refresh
		// can finish A but can never finish B.
		const transactor = new TailLandsButReportsStale(inner, 2, async unwrapped => {
			const rival = await Collection.createOrOpen<SpecAction>(unwrapped, idB, init());
			await rival.act({ type: 'set', data: { value: 'rival' } });
			await rival.sync({ maxAttempts: 10, baseBackoffMs: 1, maxBackoffMs: 5 });
		});
		const a = await Collection.createOrOpen<SpecAction>(transactor, idA, init());
		const b = await Collection.createOrOpen<SpecAction>(transactor, idB, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[idA, a], [idB, b]]));
		const transaction = await stage(coordinator, [
			{ collectionId: idA, value: 'local-a' },
			{ collectionId: idB, value: 'local-b' },
		]);

		let thrown: unknown;
		try {
			await coordinator.commit(transaction, retryFast);
		} catch (err) {
			thrown = err;
		}

		// NOTE: only the facts that hold whichever error names this outcome are pinned here. Today
		// the torn participant's TornActionError escapes bare, which does not tell the caller that A
		// IS saved (tickets/fix/a-half-saved-multi-collection-commit-is-reported-as-not-saved); the
		// fix is expected to wrap it, so the torn error is looked for on the error or its `reason`.
		expect(thrown, 'the commit is not acknowledged').to.be.instanceOf(Error);
		const torn = thrown instanceof TornActionError ? thrown : (thrown as { reason?: unknown }).reason;
		expect(torn, 'the torn participant is named').to.be.instanceOf(TornActionError);
		expect((torn as TornActionError).collectionId).to.equal(idB);
		expect((torn as TornActionError).reason).to.equal('rival-holds-revision');

		expect(await unlandedBlocks(inner, idA, transaction.id), 'participant A was finished').to.deep.equal([]);
		expect(a.hasUnsyncedChanges(), 'and A holds nothing staged').to.equal(false);
		expect(await unlandedBlocks(inner, idB, transaction.id), "participant B's block never landed").to.not.be.empty;
		expect(b.hasUnsyncedChanges(), "and B's action is still staged").to.equal(true);
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
