import { expect } from 'chai';
import { TransactionCoordinator, blockIdsForTransforms } from '../src/index.js';
import { Tracker } from '../src/transform/tracker.js';
import type {
	BlockSource,
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
		private readonly throwCollections: Set<string> = new Set(),
		// Collections whose commit THROWS (transient/unreachable) rather than returning a stale
		// { success:false }. Distinguishes the retry-worthy class from the permanent stale class.
		private readonly throwCommitCollections: Set<string> = new Set(),
		// Collections whose pend returns a CONFIRMED lost race: `conflict: true` with only a reason
		// and no missing/pending evidence — exactly what CoordinatorRepo.classifyStaleRejection
		// emits after a local re-read confirms the requested rev was taken.
		private readonly conflictPendCollections: Set<string> = new Set()
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
			await Promise.resolve();
			const collectionId = collectionOfTransforms(request.transforms);
			const blockIds = blockIdsForTransforms(request.transforms);
			if (this.throwCollections.has(collectionId)) {
				throw new Error(`forced pend throw: ${collectionId}`);
			}
			if (this.conflictPendCollections.has(collectionId)) {
				return { success: false, conflict: true, reason: `stale revision: block ${collectionId}-tail at rev 3, requested rev 3` };
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
			await Promise.resolve();
			const collectionId = collectionOfBlockId(request.blockIds[0]!);
			this.commitAttemptsByCollection.set(collectionId, (this.commitAttemptsByCollection.get(collectionId) ?? 0) + 1);
			if (this.throwCommitCollections.has(collectionId)) {
				throw new Error(`forced commit throw: ${collectionId}`);
			}
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

/** Fake collections map: the phases call `getNextRev()` and read `tracker` (to declare the
 *  per-block content digests riding on the commit) off each collection. The tracker here has no
 *  staged transforms, so it declares nothing — these tests are about phase control flow, and the
 *  digest content itself is covered by commit-digest-threading.spec.ts. */
function fakeCollections(collectionIds: string[]): Map<CollectionId, unknown> {
	const map = new Map<CollectionId, unknown>();
	const emptySource: BlockSource<IBlock> = {
		createBlockHeader: (type, newId) => ({ type, id: newId ?? 'fake', collectionId: 'fake' }),
		async tryGet() { return undefined; },
		generateId: () => 'fake',
	};
	let rev = 1;
	for (const id of collectionIds) {
		map.set(id, { getNextRev: () => rev++, tracker: new Tracker(emptySource) });
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
			const transactor = new InstrumentedTransactor(new Set(), new Set([throwing]));
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const collectionTransforms = new Map<CollectionId, Transforms>(
				collectionIds.map(id => [id, transformsForCollection(id)])
			);

			const result = await (coordinator as unknown as {
				pendPhase: (t: Transaction, h: string, ct: Map<CollectionId, Transforms>, n: null) => Promise<{ success: boolean; error?: string }>;
			}).pendPhase(transaction, 'ops:hash', collectionTransforms, null);

			expect(result.success).to.be.false;
			expect(result.error).to.contain(throwing);

			// Every collection that DID pend must be cancelled. The pends fan out concurrently,
			// so which ones settled before the throw is not deterministic — compare as a set.
			const expectedCancels = collectionIds.filter(id => id !== throwing).map(id => `${id}-tail`);
			expect([...transactor.cancelledBlockIds].sort()).to.deep.equal([...expectedCancels].sort());
		});

		// Retryability must come from the failure response's explicit `conflict` flag, not from
		// whether it happens to carry `missing`/`pending` evidence. A confirmed lost race can arrive
		// with only a reason (CoordinatorRepo.classifyStaleRejection re-reads its own storage, which
		// says the rev is taken but not by which actions) — inferring from shape used to call that a
		// hard rejection and refuse to retry it.
		it('reports staleLoss for a conflict-flagged pend failure that carries no missing/pending', async () => {
			const collectionIds = ['c0', 'c1'];
			const losing = 'c1';
			const transactor = new InstrumentedTransactor(new Set(), new Set(), new Set(), new Set([losing]));
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const collectionTransforms = new Map<CollectionId, Transforms>(
				collectionIds.map(id => [id, transformsForCollection(id)])
			);

			const result = await (coordinator as unknown as {
				pendPhase: (t: Transaction, h: string, ct: Map<CollectionId, Transforms>, n: null) => Promise<{ success: boolean; error?: string; staleLoss?: boolean }>;
			}).pendPhase(transaction, 'ops:hash', collectionTransforms, null);

			expect(result.success).to.be.false;
			expect(result.error).to.match(/stale revision/);
			expect(result.staleLoss, 'confirmed lost race must be retryable').to.be.true;
			// The sibling that did pend is still cancelled — retryability changes the verdict, not the cleanup.
			expect(transactor.cancelledBlockIds).to.deep.equal(['c0-tail']);
		});

		it('does not report staleLoss for a reason-only pend failure with no conflict flag', async () => {
			const collectionIds = ['c0', 'c1'];
			const failing = 'c1';
			const transactor = new InstrumentedTransactor(new Set([failing]));
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const collectionTransforms = new Map<CollectionId, Transforms>(
				collectionIds.map(id => [id, transformsForCollection(id)])
			);

			const result = await (coordinator as unknown as {
				pendPhase: (t: Transaction, h: string, ct: Map<CollectionId, Transforms>, n: null) => Promise<{ success: boolean; error?: string; staleLoss?: boolean }>;
			}).pendPhase(transaction, 'ops:hash', collectionTransforms, null);

			expect(result.success).to.be.false;
			// Genuine hard rejections (storage fault, validator policy) also arrive reason-only;
			// re-driving them would burn the whole retry budget for nothing.
			expect(result.staleLoss, 'unclassified reason-only failure stays a hard rejection').to.be.false;
		});

		it('reports staleLoss when the failure carries missing/pending but no conflict flag (older producer)', async () => {
			// Fallback path in isConflictFailure: a peer on a build that never sets `conflict` still
			// gets its optimistic-concurrency loss classified from the evidence it does send.
			const collectionIds = ['c0'];
			const transactor: ITransactor = {
				async get(): Promise<GetBlockResults> { throw new Error('unused'); },
				async getStatus(): Promise<BlockActionStatus[]> { throw new Error('unused'); },
				async pend(): Promise<PendResult> {
					return { success: false, pending: [{ blockId: 'c0-tail', actionId: 'rival-action' }] };
				},
				async commit(): Promise<CommitResult> { throw new Error('unused'); },
				async cancel(): Promise<void> { },
			};
			const coordinator = new TransactionCoordinator(transactor, fakeCollections(collectionIds) as never);

			const result = await (coordinator as unknown as {
				pendPhase: (t: Transaction, h: string, ct: Map<CollectionId, Transforms>, n: null) => Promise<{ success: boolean; staleLoss?: boolean }>;
			}).pendPhase(transaction, 'ops:hash', new Map([['c0', transformsForCollection('c0')]]), null);

			expect(result.success).to.be.false;
			expect(result.staleLoss).to.be.true;
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

		it('partitions committed vs failed and does NOT retry a returned stale failure', async () => {
			// A returned { success:false } is a permanent stale loss — retrying the identical
			// request can never win. It must be attempted exactly once, not three times.
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
			// Stale failure → attempted exactly once (no retry).
			expect(transactor.commitAttemptsByCollection.get(failing)).to.equal(1);
			// The successful ones committed on their first attempt.
			expect(transactor.commitAttemptsByCollection.get('c0')).to.equal(1);
		});

		it('retries a transient (thrown) commit failure the full 3 attempts before giving up', async () => {
			// A thrown commit is transient (unreachable peers, timeout) — the retry-worthy class.
			const collectionIds = ['c0', 'c1', 'c2'];
			const failing = 'c1';
			const transactor = new InstrumentedTransactor(new Set(), new Set(), new Set([failing]));
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
			// Transient failure → retried the full 3 attempts before giving up.
			expect(transactor.commitAttemptsByCollection.get(failing)).to.equal(3);
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
