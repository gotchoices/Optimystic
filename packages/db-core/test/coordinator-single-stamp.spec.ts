/**
 * `TransactionCoordinator` permits at most ONE open transaction stamp at a time — the invariant
 * documented on its `stampData` map. The coordinator's registered collections hold exactly one
 * staged state each (one tracker transform set, one pending action queue), shared by every open
 * stamp, so two concurrent stamps cannot be kept apart: committing either would write the other's
 * staged actions into its own durable log entry. The coordinator therefore refuses the second
 * stamp with `CoordinatorConcurrentStampError` instead of corrupting the log.
 *
 * These cases lock the refusal at all three entry points (`applyActions` throws, `commit` throws,
 * `execute` returns a failure result), the release paths that reopen the coordinator (commit —
 * success or partial — and rollback), the deliberate wedge after a CLEAN commit failure (the
 * stamp stays open so `rollback` remains a complete recovery), and the non-refusal cases: many
 * batches under ONE stamp, including the empty-actions pre-stage barrier the Quereus bridge sends.
 *
 * Fixtures are modeled on coordinator-rollback-pending.spec.ts.
 */

import { expect } from 'chai';
import {
	ACTIONS_ENGINE_ID,
	ActionsEngine,
	Collection,
	CoordinatorConcurrentStampError,
	CoordinatorPartialCommitError,
	TransactionCoordinator,
	blockIdsForTransforms,
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
import { DelegatingTransactor, TestTransactor } from '../src/testing/test-transactor.js';

type SpecAction = { value: string };

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

type Staged = { stampId: string; transaction: Transaction };

/** Build the actions + transaction for one `set` per entry under a FRESH stamp, WITHOUT applying
 *  anything — so a case can choose to apply, to commit untracked, or to attempt-and-expect-refusal. */
async function build(
	entries: { collectionId: string; value: string }[],
): Promise<Staged & { actions: CollectionActions[] }> {
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
	return { stampId: stamp.id, transaction, actions };
}

/** Stage one `set` per entry under a fresh stamp (build + applyActions). One call models one
 *  session's first statement. */
async function stage(
	coordinator: TransactionCoordinator,
	entries: { collectionId: string; value: string }[],
): Promise<Staged> {
	const built = await build(entries);
	await coordinator.applyActions(built.actions, built.stampId);
	return built;
}

/** Attempt to stage under a fresh stamp and return the refusal, or undefined if it was accepted. */
async function stageRefusal(
	coordinator: TransactionCoordinator,
	entries: { collectionId: string; value: string }[],
): Promise<unknown> {
	const built = await build(entries);
	try {
		await coordinator.applyActions(built.actions, built.stampId);
		return undefined;
	} catch (err) {
		return err;
	}
}

/** Every action recorded in a collection's committed log, oldest first, read through a FRESH
 *  Collection instance over the same storage — so the assertion sees only durable state, never
 *  the staging instance's in-memory tracker. */
async function durableLogValues(
	transactor: TestTransactor | DelegatingTransactor,
	collectionId: string,
): Promise<string[]> {
	const reader = await Collection.createOrOpen<SpecAction>(transactor as any, collectionId, init());
	const out: string[] = [];
	for await (const action of reader.selectLog()) out.push(action.data.value);
	return out;
}

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

/** Hard-rejects every pend (no conflict markers → not retryable), so a commit fails CLEANLY:
 *  nothing durable, snapshots restored, and — the point here — the stamp entry KEPT. */
class PendAlwaysFailsHard extends DelegatingTransactor {
	constructor(inner: TestTransactor) { super(inner); }
	override async pend(_request: PendRequest): Promise<PendResult> {
		return { success: false, reason: 'injected hard pend rejection' };
	}
}

/** Hard-rejects the FIRST pend only, so a commit fails cleanly once and the caller's own retry
 *  (a second `commit()` of the same transaction) succeeds. */
class PendFailsOnce extends DelegatingTransactor {
	private failed = false;
	constructor(inner: TestTransactor) { super(inner); }
	override async pend(request: PendRequest): Promise<PendResult> {
		if (!this.failed) {
			this.failed = true;
			return { success: false, reason: 'injected first-attempt pend rejection' };
		}
		return this.inner.pend(request);
	}
}

/** Permanently loses the COMMIT for one collection while the other lands — the partial landing
 *  that drops the stamp entry. Same shape as coordinator-rollback-pending.spec.ts. */
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

describe('TransactionCoordinator: single open stamp', () => {
	it('refuses a second stamp, and the first then commits exactly its own actions', async () => {
		// The acceptance case for the refusal: pre-guard, staging 'B' under a second stamp and
		// committing A wrote ['A','B'] into A's durable entry; rolling B back then re-queued A's
		// already-durable action, and the next commit made the log ['A','C'] with 'A' twice-written
		// and 'B' orphaned. Now the second stamp never gets in.
		const id = 'ss-repro';
		const transactor = new TestTransactor();
		const { coordinator } = await makeCoordinator(transactor, [id]);

		const a = await stage(coordinator, [{ collectionId: id, value: 'A' }]);

		const refusal = await stageRefusal(coordinator, [{ collectionId: id, value: 'B' }]);
		expect(refusal, 'second stamp is refused').to.be.instanceOf(CoordinatorConcurrentStampError);
		const err = refusal as CoordinatorConcurrentStampError;
		expect(err.openStampId, 'the refusal names the open stamp').to.equal(a.stampId);
		expect(err.message, 'the message names the open stamp').to.contain(a.stampId);
		expect(err.message, 'the message states the recovery').to.match(/[Cc]ommit or roll back/);

		await coordinator.commit(a.transaction);
		expect(await durableLogValues(transactor, id), 'only A\'s own action is durable')
			.to.deep.equal(['A']);

		// The commit released the stamp: a fresh stamp is accepted and commits cleanly.
		const c = await stage(coordinator, [{ collectionId: id, value: 'C' }]);
		await coordinator.commit(c.transaction);
		expect(await durableLogValues(transactor, id), 'the follow-up lands exactly once')
			.to.deep.equal(['A', 'C']);
	});

	it('commit of an untracked stamp throws while another stamp is tracked', async () => {
		// The Tree.stage / deferred-DML shape: actions staged straight into the collection create
		// no stampData entry, so the commit guard is the only thing standing between such a caller
		// and sweeping the tracked sibling's queue into its own log entry.
		const id = 'ss-untracked-commit';
		const transactor = new TestTransactor();
		const { coordinator, collections } = await makeCoordinator(transactor, [id]);

		const tracked = await stage(coordinator, [{ collectionId: id, value: 'tracked' }]);
		const untracked = await build([{ collectionId: id, value: 'direct' }]);
		await collections.get(id)!.act({ type: 'set', data: { value: 'direct' }, transaction: untracked.stampId });

		let err: unknown;
		try {
			await coordinator.commit(untracked.transaction);
		} catch (e) { err = e; }
		expect(err, 'the untracked commit is refused').to.be.instanceOf(CoordinatorConcurrentStampError);
		expect((err as CoordinatorConcurrentStampError).openStampId).to.equal(tracked.stampId);
		expect(await durableLogValues(transactor, id), 'nothing reached the durable log').to.deep.equal([]);
	});

	it('execute returns a failure result naming the open stamp', async () => {
		const id = 'ss-execute';
		const transactor = new TestTransactor();
		const { coordinator } = await makeCoordinator(transactor, [id]);

		const open = await stage(coordinator, [{ collectionId: id, value: 'open' }]);
		const second = await build([{ collectionId: id, value: 'second' }]);

		const result = await coordinator.execute(second.transaction, new ActionsEngine());

		expect(result.success, 'execute reports the refusal as a result, not a throw').to.equal(false);
		expect(result.error, 'the error names the open stamp').to.contain(open.stampId);
		expect(result.error, 'the error names the refused stamp').to.contain(second.stampId);
		expect(await durableLogValues(transactor, id), 'nothing reached the durable log').to.deep.equal([]);
	});

	it('does not refuse a second stamp that stages nothing', async () => {
		// The guard sits BELOW execute()'s empty-actions short-circuit on purpose: a transaction
		// that stages nothing has no state to mix with the open stamp's, and it opens no stampData
		// entry either. Hoisting the guard to the top of execute() would refuse read-only work
		// alongside an open stamp; this case is what bites if someone does.
		const id = 'ss-execute-empty';
		const transactor = new TestTransactor();
		const { coordinator } = await makeCoordinator(transactor, [id]);

		await stage(coordinator, [{ collectionId: id, value: 'open' }]);
		const readOnly = await build([]);

		const result = await coordinator.execute(readOnly.transaction, new ActionsEngine());
		expect(result.success, 'a no-action transaction runs alongside the open stamp').to.equal(true);
		expect(result.error, 'and reports no refusal').to.equal(undefined);
	});

	it('re-commits the same stamp after a clean commit failure — the other advertised recovery',
		async () => {
		// The refusal message offers TWO ways out: "commit or roll back". The rollback half is
		// covered by the wedge case below; this locks the commit half, which the kept stamp entry
		// and the restored pre-append snapshots are what make possible.
		const id = 'ss-recommit';
		const inner = new TestTransactor();
		const failing = new PendFailsOnce(inner);
		const { coordinator } = await makeCoordinator(failing, [id]);

		const staged = await stage(coordinator, [{ collectionId: id, value: 'retried' }]);
		let commitErr: unknown;
		try {
			await coordinator.commit(staged.transaction, { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 5 });
		} catch (e) { commitErr = e; }
		expect(commitErr, 'the first attempt failed cleanly').to.be.instanceOf(Error);

		// Same stamp, so the guard lets it through, and the restored queue re-appends exactly once.
		await coordinator.commit(staged.transaction);
		expect(await durableLogValues(inner, id), 'the retry lands the action exactly once')
			.to.deep.equal(['retried']);

		// The successful retry released the stamp.
		const accepted = await stageRefusal(coordinator, [{ collectionId: id, value: 'after' }]);
		expect(accepted, 'a fresh stamp is accepted after the retry committed').to.equal(undefined);
	});

	it('rollback releases the stamp, so a fresh stamp is accepted and commits', async () => {
		const id = 'ss-release-rollback';
		const transactor = new TestTransactor();
		const { coordinator } = await makeCoordinator(transactor, [id]);

		const first = await stage(coordinator, [{ collectionId: id, value: 'aborted' }]);
		await coordinator.rollback(first.stampId);

		const next = await stage(coordinator, [{ collectionId: id, value: 'kept' }]);
		await coordinator.commit(next.transaction);
		expect(await durableLogValues(transactor, id), 'only the post-rollback stamp is durable')
			.to.deep.equal(['kept']);
	});

	it('accepts many batches under one stamp, including the empty-actions pre-stage barrier', async () => {
		// The Quereus bridge drives applyActions once per STATEMENT under the same stamp id, and
		// its first call is an EMPTY batch that exists purely as the pre-stage capture barrier.
		// None of that may trip the guard — it keys on "a DIFFERENT stamp is tracked", never on
		// "a stamp is tracked".
		const id = 'ss-many-batches';
		const transactor = new TestTransactor();
		const { coordinator, collections } = await makeCoordinator(transactor, [id]);

		const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
		await coordinator.applyActions([], stamp.id); // the pre-stage barrier: opens the stamp
		await coordinator.applyActions(
			[{ collectionId: id, actions: [{ type: 'set', data: { value: 'one' } }] }], stamp.id);
		await coordinator.applyActions(
			[{ collectionId: id, actions: [{ type: 'set', data: { value: 'two' } }] }], stamp.id);

		expect(collections.get(id)!.getPendingActions().map(a => a.data.value),
			'both batches staged under the one stamp').to.deep.equal(['one', 'two']);

		const actions: CollectionActions[] = [{
			collectionId: id,
			actions: [
				{ type: 'set', data: { value: 'one' } },
				{ type: 'set', data: { value: 'two' } },
			],
		}];
		const statements = createActionsStatements(actions);
		const transaction: Transaction = {
			stamp, statements, reads: [],
			id: await createTransactionId(stamp.id, statements, []),
		};
		await coordinator.commit(transaction);
		expect(await durableLogValues(transactor, id), 'one entry carries both batches')
			.to.deep.equal(['one', 'two']);
	});

	it('a CLEAN commit failure keeps the stamp open — wedging new stamps until rollback', async () => {
		// Deliberate: the entry is kept so rollback(stampId) stays a complete recovery. The cost
		// is that an abandoned failed commit holds the coordinator against new stamps; the error
		// message names the recovery for exactly this situation.
		const id = 'ss-wedge';
		const inner = new TestTransactor();
		const { coordinator } = await makeCoordinator(new PendAlwaysFailsHard(inner), [id]);

		const doomed = await stage(coordinator, [{ collectionId: id, value: 'doomed' }]);
		let commitErr: unknown;
		try {
			await coordinator.commit(doomed.transaction, { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 5 });
		} catch (e) { commitErr = e; }
		expect(commitErr, 'the hard pend rejection failed the commit').to.be.instanceOf(Error);
		expect(commitErr, 'a clean failure is not the concurrent-stamp refusal')
			.to.not.be.instanceOf(CoordinatorConcurrentStampError);

		const refusal = await stageRefusal(coordinator, [{ collectionId: id, value: 'blocked' }]);
		expect(refusal, 'the failed commit\'s stamp still wedges new stamps')
			.to.be.instanceOf(CoordinatorConcurrentStampError);
		expect((refusal as CoordinatorConcurrentStampError).openStampId).to.equal(doomed.stampId);

		await coordinator.rollback(doomed.stampId);
		const accepted = await stageRefusal(coordinator, [{ collectionId: id, value: 'after' }]);
		expect(accepted, 'rollback releases the wedge').to.equal(undefined);
	});

	it('a partial commit drops the stamp, so a new stamp is accepted', async () => {
		// The partial-commit branch deletes the entry (rollback of a half-landed transaction would
		// rewind the durable winner), so the coordinator reopens even though the collection state
		// is degraded — refusing reads there is the bridge's degraded latch, not this guard.
		const [winner, loser] = ['ss-partial-win', 'ss-partial-lose'];
		const inner = new TestTransactor();
		const transactor = new PartialLossTransactor(inner, loser);
		const { coordinator } = await makeCoordinator(transactor, [winner, loser]);

		const staged = await stage(coordinator, [
			{ collectionId: winner, value: 'win' },
			{ collectionId: loser, value: 'lose' },
		]);
		let err: unknown;
		try {
			await coordinator.commit(staged.transaction);
		} catch (e) { err = e; }
		expect(err, 'the split surfaced as a partial commit').to.be.instanceOf(CoordinatorPartialCommitError);

		const accepted = await stageRefusal(coordinator, [{ collectionId: winner, value: 'next' }]);
		expect(accepted, 'a fresh stamp is accepted after the partial landing').to.equal(undefined);
	});
});
