/**
 * A write that is refused is retried under the SAME action id, and — when nothing else committed in
 * between — at the SAME revision. Storage identifies a saved block revision by `(action id,
 * revision)` and deliberately accepts a retry of the same action at the same revision: a machine
 * that already stored that revision keeps what it has, a machine that did not stores what the retry
 * sent. So a retry that REBUILDS its log append instead of re-sending it writes different content
 * for one `(action id, revision)` on the machines that missed the first attempt.
 *
 * The neighbouring case is already closed: when the retry's refresh FINDS the write's own log entry
 * it re-sends the refused attempt verbatim (`Collection.completeOwnEntry`). These cases are the one
 * that path does not reach — the first commit is refused outright, so nothing landed, the refresh
 * finds no entry, and the retry rebuilds.
 *
 * The rule pinned here is general, not a list of the two values that were found to vary: **two
 * attempts of one action at one revision produce byte-identical transforms.** Every case therefore
 * asserts on the WHOLE recorded transform set, so it fails for any future per-attempt value.
 *
 * Three cases, because three different code paths mint per-attempt values: the collection write
 * path with room in the current history block (where only the entry's timestamp varied), the same
 * path with the history block full (where the id of the new history block varied, taking the
 * `nextId`/`tailId` updates of two PRE-EXISTING blocks with it), and the coordinator write path.
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
	type IBlock,
	type Transaction,
} from '../src/index.js';
import { EntriesPerBlock } from '../src/chain/chain.js';
import { RecordsAttemptsRefusesFirstCommit, TestTransactor, type RecordedAttempt } from '../src/testing/test-transactor.js';

type SpecAction = { value: string };

/** Each action inserts one fresh block, so every sync touches a data block as well as the log. */
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

/** Short, bounded backoff: these cases are about WHAT the retry sends, not how long it waits. */
const retryFast = { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 };

/**
 * The assertion every case shares. Two attempts of one write, at one revision, must be
 * indistinguishable on the wire.
 *
 * Deliberately a whole-object comparison rather than a field-by-field one: the point is to catch
 * ANY per-attempt value the log append might mint in future, not only the timestamp and the new
 * history-block id that were found to vary.
 */
function expectAttemptsIdentical(attempts: RecordedAttempt[]): void {
	expect(attempts.length, 'the refused attempt was retried').to.be.at.least(2);
	const first = attempts[0]!;
	for (let i = 1; i < attempts.length; i++) {
		const retry = attempts[i]!;
		expect(retry.actionId, `attempt ${i + 1} reuses the action id`).to.equal(first.actionId);
		expect(retry.rev, `attempt ${i + 1} requests the same revision`).to.equal(first.rev);
		expect(retry.transforms, `attempt ${i + 1} re-sends the first attempt, byte for byte`)
			.to.deep.equal(first.transforms);
	}
}

/** Whether this attempt moved the log's tail — i.e. the history block filled and `Chain.add` minted
 *  a new one, rewriting `tailId` on the collection header. The header block's id IS the collection
 *  id, so a `tailId` update against it is the overflow's own signature. */
function movedTheLogTail(attempt: RecordedAttempt, collectionId: string): boolean {
	const ops = attempt.transforms.updates?.[collectionId] ?? [];
	return ops.some(([entity]) => entity === 'tailId');
}

describe('Retry: a re-sent write is byte-identical to the attempt it repeats', () => {
	it('collection path: a retry with room in the history block re-sends the same entry', async () => {
		const collectionId = 'retry-identical-room';
		const inner = new TestTransactor();
		const transactor = new RecordsAttemptsRefusesFirstCommit(inner);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());

		await collection.act({ type: 'set', data: { value: 'once' } });
		await collection.sync(retryFast);

		expectAttemptsIdentical(transactor.attempts);
		expect(movedTheLogTail(transactor.attempts[0]!, collectionId),
			'the history block had room, so no new one was minted').to.equal(false);
	});

	it('collection path: a retry that overflows the history block re-mints nothing', async () => {
		const collectionId = 'retry-identical-overflow';
		const inner = new TestTransactor();
		// Armed only once the history block is full: the fill writes land cleanly.
		const transactor = new RecordsAttemptsRefusesFirstCommit(inner, 0);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());

		// Fill the first history block exactly: each sync appends one entry.
		for (let i = 0; i < EntriesPerBlock; i++) {
			await collection.act({ type: 'set', data: { value: `fill-${i}` } });
			await collection.sync(retryFast);
		}
		// Only the overflowing write's attempts are under test.
		transactor.attempts.length = 0;
		transactor.refuseNextCommits(1);

		await collection.act({ type: 'set', data: { value: 'overflows' } });
		await collection.sync(retryFast);

		expect(movedTheLogTail(transactor.attempts[0]!, collectionId),
			'the case under test ran: the history block was full, so a new one was minted').to.equal(true);
		expectAttemptsIdentical(transactor.attempts);
	});

	it('coordinator path: a retry re-sends the same entry', async () => {
		const collectionId = 'retry-identical-coordinator';
		const inner = new TestTransactor();
		const transactor = new RecordsAttemptsRefusesFirstCommit(inner);
		const collection = await Collection.createOrOpen<SpecAction>(transactor, collectionId, init());
		const coordinator = new TransactionCoordinator(transactor, new Map([[collectionId, collection]]));

		const actions: CollectionActions[] = [{ collectionId, actions: [{ type: 'set', data: { value: 'once' } }] }];
		const statements = createActionsStatements(actions);
		const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
		const transaction: Transaction = {
			stamp, statements, reads: [],
			id: await createTransactionId(stamp.id, statements, []),
		};
		await coordinator.applyActions(actions, stamp.id);

		await coordinator.commit(transaction, retryFast);

		expectAttemptsIdentical(transactor.attempts);
	});
});
