/**
 * A coordinator built with `pendValidation: 'none'` sends pends that carry NO `validation`
 * payload — the shape the Quereus adapter's legacy multi-tree commit needs, since its rows were
 * staged straight into the trees and there are no statements for a member to re-execute — and
 * carries the aged retry priority on the pend itself (`PendRequest.priority`), the carrier a
 * member's `resolveRace` falls back to when there is no transaction to read it from. Without
 * that carrier a repeatedly-losing legacy commit would never out-rank fresh rivals.
 *
 * The default coordinator is pinned beside it so the two shapes cannot silently converge: its
 * pends carry the pair and age the priority INSIDE the transaction, never on the pend.
 */
import { expect } from 'chai';
import {
	TransactionCoordinator,
	Tree,
	createTransactionId,
	createTransactionStamp,
	type CoordinatorOptions,
	type IBlock,
	type PendRequest,
	type PendResult,
	type Transaction,
} from '../src/index.js';
import { DelegatingTransactor, TestTransactor } from '../src/testing/test-transactor.js';

type Entry = { key: number; name: string };

/** What one pend carried, captured at send time — `transaction.priority` is mutated in place
 *  between attempts, so reading it off the recorded request later would show the final value. */
interface PendShape {
	collectionId: string;
	validated: boolean;
	/** `validation.transaction.priority` when the pend carried the pair. */
	transactionPriority: number | undefined;
	/** Top-level `PendRequest.priority`. */
	pendPriority: number | undefined;
}

/**
 * Records every pend's shape and refuses the first `refuse` pends as a clean stale loss (a
 * confirmed lost race), so the coordinator re-drives with an aged priority that the recording
 * makes observable. Everything else delegates to the real in-memory transactor.
 */
class RecordingPendTransactor extends DelegatingTransactor {
	readonly pends: PendShape[] = [];
	constructor(inner: TestTransactor, private readonly refuse: number) {
		super(inner);
	}
	override async pend(request: PendRequest): Promise<PendResult> {
		const firstInsert = Object.values(request.transforms.inserts ?? {})[0] as IBlock | undefined;
		this.pends.push({
			collectionId: firstInsert?.header.collectionId ?? 'unknown',
			validated: request.validation !== undefined,
			transactionPriority: request.validation?.transaction.priority,
			pendPriority: request.priority,
		});
		if (this.pends.length <= this.refuse) {
			return { success: false, conflict: true, reason: 'stale conflict' };
		}
		return this.inner.pend(request);
	}
}

/** Two invented trees with one staged row each, a coordinator over both, and a statement-less
 *  transaction — the legacy commit's shape. */
async function stagedPair(transactor: RecordingPendTransactor, options: CoordinatorOptions) {
	const alpha = await Tree.createOrOpen<number, Entry>(transactor, 'alpha', e => e.key);
	const beta = await Tree.createOrOpen<number, Entry>(transactor, 'beta', e => e.key);
	await alpha.stage([[1, { key: 1, name: 'one' }]]);
	await beta.stage([[2, { key: 2, name: 'two' }]]);
	const coordinator = new TransactionCoordinator(
		transactor,
		new Map<string, any>([['alpha', alpha.getCollection()], ['beta', beta.getCollection()]]),
		options,
	);
	const stamp = await createTransactionStamp('peer', Date.now(), '', 'legacy');
	const transaction: Transaction = { stamp, statements: [], reads: [], id: await createTransactionId(stamp.id, [], []) };
	return { alpha, beta, coordinator, transaction };
}

/** Commit with the first attempt's two pends refused, so a retry with aged priority follows. */
async function commitAfterOneLoss(options: CoordinatorOptions) {
	const inner = new TestTransactor();
	const transactor = new RecordingPendTransactor(inner, 2);
	const { alpha, beta, coordinator, transaction } = await stagedPair(transactor, options);
	await coordinator.commit(transaction, { baseBackoffMs: 1, maxBackoffMs: 2 });
	expect(transactor.pends.map(p => p.collectionId).sort(), 'two pends per attempt, two attempts')
		.to.deep.equal(['alpha', 'alpha', 'beta', 'beta']);
	expect(await alpha.get(1), 'the retry landed alpha').to.deep.equal({ key: 1, name: 'one' });
	expect(await beta.get(2), 'the retry landed beta').to.deep.equal({ key: 2, name: 'two' });
	return { transactor, transaction, inner };
}

describe('TransactionCoordinator pend validation shape', () => {
	it(`pendValidation: 'none' — no pend carries a validation payload, and the retry's aged priority rides on the pend`, async () => {
		const { transactor, inner } = await commitAfterOneLoss({ pendValidation: 'none' });
		const [firstAlpha, firstBeta, retryAlpha, retryBeta] = transactor.pends;

		for (const pend of transactor.pends) {
			expect(pend.validated, `the ${pend.collectionId} pend carries no transaction to re-execute`).to.equal(false);
			expect(pend.transactionPriority).to.equal(undefined);
		}
		// The first attempt is priority 0, sent as an absent field — the same bytes a
		// single-collection Collection.sync pend sends on ITS first attempt.
		expect(firstAlpha!.pendPriority, 'first attempt: no priority field').to.equal(undefined);
		expect(firstBeta!.pendPriority, 'first attempt: no priority field').to.equal(undefined);
		// One clean loss ages the transaction to priority 1, carried on the pend itself.
		expect(retryAlpha!.pendPriority, 'retry: aged priority on the pend').to.equal(1);
		expect(retryBeta!.pendPriority, 'retry: aged priority on the pend').to.equal(1);

		// Durable exactly once under the transaction's id, on a fresh read around the trees.
		const fresh = await Tree.createOrOpen<number, Entry>(inner, 'alpha', e => e.key);
		expect(await fresh.get(1)).to.deep.equal({ key: 1, name: 'one' });
	});

	it('default — every pend carries the validation pair, and the aged priority rides inside the transaction, never on the pend', async () => {
		const { transactor, transaction } = await commitAfterOneLoss({});
		const [firstAlpha, firstBeta, retryAlpha, retryBeta] = transactor.pends;

		for (const pend of transactor.pends) {
			expect(pend.validated, `the ${pend.collectionId} pend carries the transaction`).to.equal(true);
			expect(pend.pendPriority, 'a validated pend never carries a top-level priority').to.equal(undefined);
		}
		expect(firstAlpha!.transactionPriority, 'first attempt: unaged').to.equal(undefined);
		expect(firstBeta!.transactionPriority, 'first attempt: unaged').to.equal(undefined);
		expect(retryAlpha!.transactionPriority, 'retry: aged inside the transaction').to.equal(1);
		expect(retryBeta!.transactionPriority, 'retry: aged inside the transaction').to.equal(1);
		expect(transaction.priority, 'the transaction object itself was aged').to.equal(1);
	});
});
