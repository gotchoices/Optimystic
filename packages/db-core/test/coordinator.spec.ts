import { expect } from 'chai';
import { TransactionCoordinator, blockIdsForTransforms } from '../src/index.js';
import type {
	ITransactor,
	PendRequest,
	CommitRequest,
	ActionBlocks,
	BlockActionStatus,
	PendResult,
	CommitResult,
	BlockGets,
	GetBlockResults,
	CollectionId,
	BlockId,
	Transforms,
	Transaction,
	IBlock,
} from '../src/index.js';

// These tests exercise the coordinator's PEND / COMMIT / CANCEL phases directly (via the
// private phase methods) to assert their concurrency and cancel-on-failure behavior in
// isolation — no network, no real collections. The phases fan the independent per-collection
// work out concurrently and, on any failure, cancel EVERY successfully-pended collection.

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Build a minimal single-block transforms set whose tail block header carries the collection id. */
function transformsForCollection(collectionId: string): Transforms {
	const blockId = `${collectionId}-tail` as BlockId;
	return {
		inserts: { [blockId]: { header: { id: blockId, type: 'test', collectionId } } as unknown as IBlock },
		updates: {},
		deletes: [],
	};
}

/** Recover the collection id from a pend request's transforms (first insert's header). */
function collectionOfTransforms(transforms: Transforms): string {
	const firstInsert = Object.values(transforms.inserts ?? {})[0] as IBlock | undefined;
	return firstInsert?.header.collectionId ?? 'unknown';
}

/** Recover the collection id from a commit request's block ids (the `${id}-tail` convention). */
function collectionOfBlockId(blockId: BlockId): string {
	return String(blockId).replace(/-tail$/, '');
}

/**
 * Instrumented transactor: records peak concurrent pend/commit calls, which collections
 * pended/committed/cancelled, and forces a chosen set of collections to fail. get/getStatus
 * are unused on these phase paths and throw if reached.
 */
class InstrumentedTransactor implements ITransactor {
	pendInFlight = 0;
	pendMaxInFlight = 0;
	commitInFlight = 0;
	commitMaxInFlight = 0;
	pendedCollections: string[] = [];
	committedCollections: string[] = [];
	cancelledBlockIds: BlockId[] = [];
	commitAttemptsByCollection = new Map<string, number>();

	constructor(
		private readonly failCollections: Set<string> = new Set(),
		private readonly stepMs = 5,
		private readonly throwCollections: Set<string> = new Set()
	) {}

	async get(_blockGets: BlockGets): Promise<GetBlockResults> {
		throw new Error('unused on the phase path');
	}
	async getStatus(_actionRefs: ActionBlocks[]): Promise<BlockActionStatus[]> {
		throw new Error('unused on the phase path');
	}

	async pend(request: PendRequest): Promise<PendResult> {
		this.pendInFlight++;
		this.pendMaxInFlight = Math.max(this.pendMaxInFlight, this.pendInFlight);
		try {
			await delay(this.stepMs);
			const collectionId = collectionOfTransforms(request.transforms);
			const blockIds = blockIdsForTransforms(request.transforms);
			if (this.throwCollections.has(collectionId)) {
				throw new Error(`forced pend throw: ${collectionId}`);
			}
			if (this.failCollections.has(collectionId)) {
				return { success: false, reason: `forced pend failure: ${collectionId}` };
			}
			this.pendedCollections.push(collectionId);
			return { success: true, pending: [], blockIds } as PendResult;
		} finally {
			this.pendInFlight--;
		}
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		this.commitInFlight++;
		this.commitMaxInFlight = Math.max(this.commitMaxInFlight, this.commitInFlight);
		try {
			await delay(this.stepMs);
			const collectionId = collectionOfBlockId(request.blockIds[0]!);
			this.commitAttemptsByCollection.set(collectionId, (this.commitAttemptsByCollection.get(collectionId) ?? 0) + 1);
			if (this.failCollections.has(collectionId)) {
				return { success: false, reason: `forced commit failure: ${collectionId}` };
			}
			this.committedCollections.push(collectionId);
			return { success: true };
		} finally {
			this.commitInFlight--;
		}
	}

	async cancel(actionRef: ActionBlocks): Promise<void> {
		this.cancelledBlockIds.push(...actionRef.blockIds);
	}
}

/** Fake collections map: the phases only call `getNextRev()` on each collection. */
function fakeCollections(collectionIds: string[]): Map<CollectionId, unknown> {
	const map = new Map<CollectionId, unknown>();
	let rev = 1;
	for (const id of collectionIds) {
		map.set(id, { getNextRev: () => rev++ });
	}
	return map;
}

const transaction = { id: 'txn-1' } as unknown as Transaction;

describe('TransactionCoordinator phases (concurrency + cancel-on-failure)', () => {
	describe('pendPhase', () => {
		it('pends N independent collections concurrently', async () => {
			const collectionIds = ['c0', 'c1', 'c2', 'c3'];
			const transactor = new InstrumentedTransactor();
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const collectionTransforms = new Map<CollectionId, Transforms>(
				collectionIds.map(id => [id, transformsForCollection(id)])
			);

			const result = await (coordinator as unknown as {
				pendPhase: (t: Transaction, h: string, ct: Map<CollectionId, Transforms>, n: null) => Promise<{ success: boolean; pendedBlockIds?: Map<CollectionId, BlockId[]> }>;
			}).pendPhase(transaction, 'ops:hash', collectionTransforms, null);

			expect(result.success).to.be.true;
			// All four pends were in flight at once — the fan-out ran them concurrently, not serially.
			expect(transactor.pendMaxInFlight).to.equal(collectionIds.length);
			expect(result.pendedBlockIds!.size).to.equal(collectionIds.length);
			for (const id of collectionIds) {
				expect(result.pendedBlockIds!.get(id)).to.deep.equal([`${id}-tail`]);
			}
			// Nothing cancelled on the success path.
			expect(transactor.cancelledBlockIds).to.be.empty;
		});

		it('cancels every successfully-pended collection when one collection fails mid-fan-out', async () => {
			const collectionIds = ['c0', 'c1', 'c2', 'c3'];
			const failing = 'c2';
			const transactor = new InstrumentedTransactor(new Set([failing]));
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const collectionTransforms = new Map<CollectionId, Transforms>(
				collectionIds.map(id => [id, transformsForCollection(id)])
			);

			const result = await (coordinator as unknown as {
				pendPhase: (t: Transaction, h: string, ct: Map<CollectionId, Transforms>, n: null) => Promise<{ success: boolean; error?: string }>;
			}).pendPhase(transaction, 'ops:hash', collectionTransforms, null);

			expect(result.success).to.be.false;
			expect(result.error).to.contain(failing);

			// The three collections that DID pend must all be cancelled — not just those that
			// happened to pend before the failure. Order is not guaranteed under concurrency, so
			// compare as a set.
			const expectedCancels = collectionIds.filter(id => id !== failing).map(id => `${id}-tail`);
			expect([...transactor.cancelledBlockIds].sort()).to.deep.equal([...expectedCancels].sort());
		});

		it('cancels every successfully-pended collection when transactor.pend throws for one collection', async () => {
			const collectionIds = ['c0', 'c1', 'c2', 'c3'];
			const throwing = 'c2';
			const transactor = new InstrumentedTransactor(new Set(), 5, new Set([throwing]));
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const collectionTransforms = new Map<CollectionId, Transforms>(
				collectionIds.map(id => [id, transformsForCollection(id)])
			);

			const result = await (coordinator as unknown as {
				pendPhase: (t: Transaction, h: string, ct: Map<CollectionId, Transforms>, n: null) => Promise<{ success: boolean; error?: string }>;
			}).pendPhase(transaction, 'ops:hash', collectionTransforms, null);

			expect(result.success).to.be.false;
			expect(result.error).to.contain(throwing);

			// The three collections that pended before the throw must all be cancelled.
			const expectedCancels = collectionIds.filter(id => id !== throwing).map(id => `${id}-tail`);
			expect([...transactor.cancelledBlockIds].sort()).to.deep.equal([...expectedCancels].sort());
		});

		it('returns a failure (no throw) when a collection is missing from the map', async () => {
			// 'ghost' has transforms but no collection registered → per-collection failure that
			// still cancels the sibling that pended.
			const transactor = new InstrumentedTransactor();
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(['c0']) as never);

			const collectionTransforms = new Map<CollectionId, Transforms>([
				['c0', transformsForCollection('c0')],
				['ghost', transformsForCollection('ghost')],
			]);

			const result = await (coordinator as unknown as {
				pendPhase: (t: Transaction, h: string, ct: Map<CollectionId, Transforms>, n: null) => Promise<{ success: boolean; error?: string }>;
			}).pendPhase(transaction, 'ops:hash', collectionTransforms, null);

			expect(result.success).to.be.false;
			expect(result.error).to.contain('ghost');
			// c0 pended successfully, so it gets cancelled by the all-on-failure sweep.
			expect(transactor.cancelledBlockIds).to.deep.equal(['c0-tail']);
		});
	});

	describe('commitPhase', () => {
		it('commits N independent collections concurrently', async () => {
			const collectionIds = ['c0', 'c1', 'c2', 'c3'];
			const transactor = new InstrumentedTransactor();
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const pendedBlockIds = new Map<CollectionId, BlockId[]>(
				collectionIds.map(id => [id, [`${id}-tail` as BlockId]])
			);
			const criticalBlockIds = collectionIds.map(id => `${id}-tail` as BlockId);

			const result = await (coordinator as unknown as {
				commitPhase: (a: string, c: BlockId[], p: Map<CollectionId, BlockId[]>) => Promise<{ success: boolean; committedCollections: Set<CollectionId>; failedCollections: Set<CollectionId> }>;
			}).commitPhase('txn-1', criticalBlockIds, pendedBlockIds);

			expect(result.success).to.be.true;
			expect(transactor.commitMaxInFlight).to.equal(collectionIds.length);
			expect([...result.committedCollections].sort()).to.deep.equal([...collectionIds].sort());
			expect(result.failedCollections.size).to.equal(0);
		});

		it('partitions committed vs failed and retries a failing collection 3 times', async () => {
			const collectionIds = ['c0', 'c1', 'c2'];
			const failing = 'c1';
			const transactor = new InstrumentedTransactor(new Set([failing]));
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const pendedBlockIds = new Map<CollectionId, BlockId[]>(
				collectionIds.map(id => [id, [`${id}-tail` as BlockId]])
			);
			const criticalBlockIds = collectionIds.map(id => `${id}-tail` as BlockId);

			const result = await (coordinator as unknown as {
				commitPhase: (a: string, c: BlockId[], p: Map<CollectionId, BlockId[]>) => Promise<{ success: boolean; error?: string; committedCollections: Set<CollectionId>; failedCollections: Set<CollectionId> }>;
			}).commitPhase('txn-1', criticalBlockIds, pendedBlockIds);

			expect(result.success).to.be.false;
			expect(result.error).to.contain(failing);
			expect([...result.committedCollections].sort()).to.deep.equal(['c0', 'c2']);
			expect([...result.failedCollections]).to.deep.equal([failing]);
			// The failing collection was retried the full 3 attempts before giving up.
			expect(transactor.commitAttemptsByCollection.get(failing)).to.equal(3);
			// The successful ones committed on their first attempt.
			expect(transactor.commitAttemptsByCollection.get('c0')).to.equal(1);
		});
	});

	describe('cancelPhase', () => {
		it('cancels every pended collection except the excluded (already-committed) ones', async () => {
			const collectionIds = ['c0', 'c1', 'c2'];
			const transactor = new InstrumentedTransactor();
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const pendedBlockIds = new Map<CollectionId, BlockId[]>(
				collectionIds.map(id => [id, [`${id}-tail` as BlockId]])
			);

			await (coordinator as unknown as {
				cancelPhase: (a: string, p: Map<CollectionId, BlockId[]>, e?: Set<CollectionId>) => Promise<void>;
			}).cancelPhase('txn-1', pendedBlockIds, new Set(['c1']));

			// c1 was excluded; c0 and c2 are cancelled.
			expect([...transactor.cancelledBlockIds].sort()).to.deep.equal(['c0-tail', 'c2-tail']);
		});

		it('swallows a cancel fault so it cannot mask the triggering failure', async () => {
			const collectionIds = ['c0', 'c1'];
			const transactor = new InstrumentedTransactor();
			// Make the FIRST cancel reject; cancelPhase must still resolve and cancel the rest.
			let calls = 0;
			transactor.cancel = async (ref: ActionBlocks) => {
				calls++;
				if (calls === 1) throw new Error('boom');
				transactor.cancelledBlockIds.push(...ref.blockIds);
			};
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const pendedBlockIds = new Map<CollectionId, BlockId[]>(
				collectionIds.map(id => [id, [`${id}-tail` as BlockId]])
			);

			// Resolves (does not reject) despite the first cancel throwing.
			await (coordinator as unknown as {
				cancelPhase: (a: string, p: Map<CollectionId, BlockId[]>) => Promise<void>;
			}).cancelPhase('txn-1', pendedBlockIds);

			expect(calls).to.equal(2);
			expect(transactor.cancelledBlockIds).to.have.length(1);
		});
	});
});
