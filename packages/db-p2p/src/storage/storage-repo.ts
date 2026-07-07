import type {
	IRepo, MessageOptions, BlockId, CommitRequest, CommitResult, GetBlockResults, PendRequest, PendResult, ActionBlocks,
	ActionId, BlockGets, ActionPending, PendSuccess, ActionTransform, ActionTransforms,
	GetBlockResult, IBlock, ActionRev,
	PendValidationHook,
	CollectionId, IBlockChangeNotifier, CollectionChangeListener, CollectionChangeEvent
} from "@optimystic/db-core";
import {
	Latches, transformForBlockId, applyTransform, groupBy, concatTransform, emptyTransforms,
	blockIdsForTransforms, transformsFromTransform
} from "@optimystic/db-core";
import { asyncIteratorToArray } from "../it-utility.js";
import type { IBlockStorage } from "./i-block-storage.js";
import type { IBlockReplicaStore } from "../cluster/block-transfer-service.js";
import { createLogger } from "../logger.js";

const log = createLogger('storage-repo');

/**
 * Single source of truth for the per-block commit latch key. Held by {@link StorageRepo.commit} and
 * {@link StorageRepo.saveReplicatedBlock}, and — through an injected runner ({@link withBlockCommitLatch})
 * — by the invalidation-apply path. Every out-of-band writer of a block's `meta.latest` must serialize
 * on this key against a concurrent local commit on the same block; keeping all call sites on this helper
 * is what prevents the key from drifting between them.
 */
export const commitLatchKey = (blockId: BlockId): string => `StorageRepo.commit:${blockId}`;

/**
 * Runs `fn` while holding the per-block commit latch {@link commitLatchKey}. This is the capability the
 * dispute module's `applyInvalidation` is handed (through its context) so its compensating
 * `saveReplica`/`saveDeletion` read-modify-write of `meta.latest` is mutually exclusive with a concurrent
 * {@link StorageRepo.commit} on the same block — otherwise an invalidation advancing `latest` outside
 * that latch is invisible to commit's staleness guard and can be clobbered (a non-monotonic regression).
 *
 * Acquire/release is per call, so a caller holds at most one block latch at any instant and cannot
 * deadlock against commit's sorted, up-front multi-latch acquisition.
 */
export async function withBlockCommitLatch<T>(blockId: BlockId, fn: () => Promise<T>): Promise<T> {
	const release = await Latches.acquire(commitLatchKey(blockId));
	try {
		return await fn();
	} finally {
		release();
	}
}

export type StorageRepoOptions = {
	/** Optional hook to validate transactions in PendRequests */
	validatePend?: PendValidationHook;
};

export class StorageRepo implements IRepo, IBlockChangeNotifier, IBlockReplicaStore {
	private readonly validatePend?: PendValidationHook;
	/** Per-collection change listeners; empty sets are pruned on unsubscribe. */
	private readonly changeListeners = new Map<CollectionId, Set<CollectionChangeListener>>();
	/** Catch-all change listeners — fire for EVERY collection's commit on this node. */
	private readonly anyChangeListeners = new Set<CollectionChangeListener>();

	constructor(
		private readonly createBlockStorage: (blockId: BlockId) => IBlockStorage,
		options?: StorageRepoOptions
	) {
		this.validatePend = options?.validatePend;
	}

	/**
	 * Subscribe to commits that mutate `collectionId`'s blocks on this node.
	 * Returns an idempotent unsubscribe. See {@link IBlockChangeNotifier}.
	 */
	onCollectionChange(collectionId: CollectionId, listener: CollectionChangeListener): () => void {
		let set = this.changeListeners.get(collectionId);
		if (!set) {
			set = new Set();
			this.changeListeners.set(collectionId, set);
		}
		set.add(listener);
		let unsubscribed = false;
		return () => {
			if (unsubscribed) return;
			unsubscribed = true;
			const current = this.changeListeners.get(collectionId);
			if (current) {
				current.delete(listener);
				if (current.size === 0) {
					this.changeListeners.delete(collectionId);
				}
			}
		};
	}

	/**
	 * Subscribe to commits mutating ANY collection on this node — the catch-all feed the
	 * cohort-topic origination bridge consumes (it cannot enumerate collection ids ahead of time,
	 * so a per-collection {@link onCollectionChange} subscription cannot see every commit). Fires for
	 * the same `(pending → committed)` transitions as {@link onCollectionChange}, but across every
	 * collection. Returns an idempotent unsubscribe; a throwing listener is isolated + logged.
	 */
	onAnyCollectionChange(listener: CollectionChangeListener): () => void {
		this.anyChangeListeners.add(listener);
		let unsubscribed = false;
		return () => {
			if (unsubscribed) return;
			unsubscribed = true;
			this.anyChangeListeners.delete(listener);
		};
	}

	/**
	 * Fire one {@link CollectionChangeEvent} per distinct collection that was
	 * newly committed. Called AFTER the commit critical section (locks released),
	 * fire-and-forget synchronous; a throwing listener is isolated and logged. Each event reaches
	 * both that collection's {@link onCollectionChange} subscribers and every
	 * {@link onAnyCollectionChange} catch-all subscriber.
	 *
	 * `tailId` is the `CommitRequest.tailId` on the commit path; `undefined` on read-driven
	 * promotions (the get/emitPromotions path has no commit request). A single commit is for one
	 * collection's chain in practice, so all events from one commit share the same `tailId`.
	 */
	private emitCollectionChanges(collectionBlocks: Map<CollectionId, BlockId[]>, actionId: ActionId, rev: number, tailId?: BlockId): void {
		const hasCatchAll = this.anyChangeListeners.size > 0;
		for (const [collectionId, blockIds] of collectionBlocks) {
			const listeners = this.changeListeners.get(collectionId);
			if ((!listeners || listeners.size === 0) && !hasCatchAll) {
				continue;
			}
			const event: CollectionChangeEvent = { collectionId, blockIds, actionId, rev, tailId };
			if (listeners && listeners.size > 0) {
				this.fireChangeListeners(listeners, event);
			}
			if (hasCatchAll) {
				this.fireChangeListeners(this.anyChangeListeners, event);
			}
		}
	}

	/** Dispatch `event` to a snapshot of `listeners` (safe under mid-emit (un)subscribe), isolating + logging any throw. */
	private fireChangeListeners(listeners: Set<CollectionChangeListener>, event: CollectionChangeEvent): void {
		for (const listener of Array.from(listeners)) {
			try {
				listener(event);
			} catch (err) {
				log('onCollectionChange listener threw for collection=%s: %o', event.collectionId, err);
			}
		}
	}

	async get({ blockIds, context }: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		const distinctBlockIds = Array.from(new Set(blockIds));
		log('get blockIds=%d', distinctBlockIds.length);
		// Read-driven promotions that land durably here, captured so we can emit a
		// change event per durable landing after the parallel reads complete (mirrors
		// commit's "emit after the work" ordering). The array is shared across the
		// parallel map closures below — safe because each push happens synchronously
		// between awaits (single-threaded), never concurrently.
		const promotions: { collectionId: CollectionId, blockId: BlockId, actionId: ActionId, rev: number }[] = [];
		const results = await Promise.all(distinctBlockIds.map(async (blockId) => {
			const blockStorage = this.createBlockStorage(blockId);

			// Ensure that all outstanding transactions in the context are committed
			if (context) {
				const latest = await blockStorage.getLatest();
				const missing = latest
					? context.committed.filter(c => c.rev > latest.rev)
					: context.committed;
				for (const { actionId, rev } of missing.sort((a, b) => a.rev - b.rev)) {
					const pending = await blockStorage.getPendingTransaction(actionId);
					if (pending) {
						const collectionId = await this.internalCommit(blockId, actionId, rev, blockStorage);
						if (collectionId !== undefined) {
							promotions.push({ collectionId, blockId, actionId, rev });
						}
					}
				}
			}

			// NOTE: a Crash-D3 block (durably promoted + revision saved, but the setLatest lost so
			// meta.latest is stale and the pending record is gone) reads as empty/stale here — a
			// context-driven get skips promotion (pending gone) and a default getBlock() sees the
			// stale latest. It is soft-wedged (stale), not hard-wedged: the next commit-retry for
			// (actionId, rev) self-heals it via storage.recover() in commit(). Not repaired lazily on
			// the read path because get() holds no commit latch; if stale reads on unwritten blocks
			// ever become a problem, add a latched lazy recover() here.
			const blockRev = await blockStorage.getBlock(context?.rev);

			// Include pending action if requested — handled first so a pending-only
			// insert (no committed revision yet) can still be served by applying the
			// pending transform to an undefined prior block.
			if (context?.actionId !== undefined) {
				const pendingTransform = await blockStorage.getPendingTransaction(context.actionId);
				if (!pendingTransform) {
					throw new Error(`Pending action ${context.actionId} not found`);
				}
				const block = applyTransform(blockRev?.block, pendingTransform);
				return [blockId, {
					block,
					state: {
						latest: await blockStorage.getLatest(),
						pendings: [context.actionId]
					}
				}];
			}

			if (!blockRev) {
				return [blockId, { state: {} } as GetBlockResult];
			}

			const pendings = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			return [blockId, {
				block: blockRev.block,
				state: {
					latest: await blockStorage.getLatest(),
					pendings
				}
			}];
		}));

		// Emit per durable read-driven landing (Option A — emit eagerly). Done after the
		// parallel reads complete so emission stays outside the per-block work, matching
		// commit's ordering. No-op when nothing was promoted.
		this.emitPromotions(promotions);

		return Object.fromEntries(results);
	}

	/**
	 * Emit a {@link CollectionChangeEvent} for each read-driven promotion that landed
	 * during a {@link get}. A single get() can promote multiple distinct actions, each
	 * at its own `(actionId, rev)`, so group by `(actionId, rev)` and route each group
	 * through {@link emitCollectionChanges} once.
	 */
	private emitPromotions(promotions: { collectionId: CollectionId, blockId: BlockId, actionId: ActionId, rev: number }[]): void {
		if (promotions.length === 0) {
			return;
		}
		const groups = new Map<string, { actionId: ActionId, rev: number, collectionBlocks: Map<CollectionId, BlockId[]> }>();
		for (const { collectionId, blockId, actionId, rev } of promotions) {
			const key = `${actionId} ${rev}`;
			let group = groups.get(key);
			if (!group) {
				group = { actionId, rev, collectionBlocks: new Map() };
				groups.set(key, group);
			}
			const list = group.collectionBlocks.get(collectionId) ?? [];
			list.push(blockId);
			group.collectionBlocks.set(collectionId, list);
		}
		for (const { actionId, rev, collectionBlocks } of groups.values()) {
			this.emitCollectionChanges(collectionBlocks, actionId, rev);
		}
	}

	async pend(request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		// Validate transaction if present and validation hook is configured
		if (this.validatePend && request.transaction && request.operationsHash) {
			const validationResult = await this.validatePend(request.transaction, request.operationsHash);
			if (!validationResult.valid) {
				return {
					success: false,
					reason: validationResult.reason ?? 'Transaction validation failed'
				};
			}
		}

		const blockIds = blockIdsForTransforms(request.transforms);
		log('pend actionId=%s blockIds=%d rev=%s', request.actionId, blockIds.length, request.rev);
		const pendings: ActionPending[] = [];
		const missing: ActionTransforms[] = [];

		// Potential race condition: A concurrent commit operation could complete
		// between the conflict checks (latest.rev, listPendingTransactions) and the
		// savePendingTransaction call below. This pend operation might succeed based on
		// stale information, but the subsequent commit for this pend would likely
		// fail correctly later if a conflict arose. Locking here could make the initial
		// check more accurate but adds overhead. The current approach prioritizes
		// letting the commit be the final arbiter.
		for (const blockId of blockIds) {
			const blockStorage = this.createBlockStorage(blockId);
			const transforms = transformForBlockId(request.transforms, blockId);

			// First handle any pending actions
			const pending = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			pendings.push(...pending.map(actionId => ({ blockId, actionId })));

			// Handle any conflicting revisions
			if (request.rev !== undefined || transforms.insert) {
				const latest = await blockStorage.getLatest();
				if (latest && latest.rev >= (request.rev ?? 0)) {
					const transforms = await asyncIteratorToArray(blockStorage.listRevisions(request.rev ?? 0, latest.rev));
					for (const actionRev of transforms) {
						const transform = await blockStorage.getTransaction(actionRev.actionId);
						if (!transform) {
							throw new Error(`Missing action ${actionRev.actionId} for block ${blockId}`);
						}
						missing.push({
							actionId: actionRev.actionId,
							rev: actionRev.rev,
							transforms: transformsFromTransform(transform, blockId)
						});
					}
				}
			}
		}

		if (missing.length) {
			log('pend:stale actionId=%s missing=%d', request.actionId, missing.length);
			return {
				success: false,
				missing
			};
		}

		if (pendings.length > 0) {
			if (request.policy === 'f') {	// Fail on pending actions
				return { success: false, pending: pendings };
			} else if (request.policy === 'r') {	// Return populated pending actions
				return {
					success: false,
					pending: await Promise.all(pendings.map(async action => {
						const blockStorage = this.createBlockStorage(action.blockId);
						return {
							blockId: action.blockId,
							actionId: action.actionId,
							transform: (await blockStorage.getPendingTransaction(action.actionId))
								?? (await blockStorage.getTransaction(action.actionId))!	// Possible that since enumeration, the action has been promoted
						}
					}))
				};
			}
		}


		// Simultaneously save pending action for each block
		// Note: that this is not atomic, after we checked for conflicts and pending actions
		// new pending or committed actions may have been added.  This is okay, because
		// this check during pend is conservative.
		await Promise.all(blockIds.map(blockId => {
			const blockStorage = this.createBlockStorage(blockId);
			const blockTransform = transformForBlockId(request.transforms, blockId);
			return blockStorage.savePendingTransaction(request.actionId, blockTransform);
		}));

		return {
			success: true,
			pending: pendings,
			blockIds
		} as PendSuccess;
	}

	async cancel(actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> {
		log('cancel actionId=%s blockIds=%d', actionRef.actionId, actionRef.blockIds.length);
		await Promise.all(actionRef.blockIds.map(blockId => {
			const blockStorage = this.createBlockStorage(blockId);
			return blockStorage.deletePendingTransaction(actionRef.actionId);
		}));
	}

	async commit(request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		log('commit actionId=%s rev=%d blockIds=%d', request.actionId, request.rev, request.blockIds.length);
		const uniqueBlockIds = Array.from(new Set(request.blockIds)).sort();
		const releases: (() => void)[] = [];
		// Collects the blocks newly committed in this call, grouped by collection,
		// so we can emit change events once locks are released. Blocks that land before
		// a mid-loop failure stay here and are still emitted (Option A — emit eagerly):
		// they are durably committed and a retry rolls the remainder forward.
		const collectionBlocks = new Map<CollectionId, BlockId[]>();
		// Captured when internalCommit throws mid-loop; we break (rather than return)
		// so locks release and accumulated landings still emit before we report failure.
		let failure: { reason: string } | undefined;

		try {
			// Acquire locks sequentially based on sorted IDs to prevent deadlocks
			for (const id of uniqueBlockIds) {
				const lockId = commitLatchKey(id);
				const release = await Latches.acquire(lockId);
				releases.push(release);
			}

			// --- Start of Critical Section ---

			const blockStorages = request.blockIds.map(blockId => ({
				blockId,
				storage: this.createBlockStorage(blockId)
			}));

			// Partition blocks into:
			//   - alreadyDone: latest.rev === request.rev && latest.actionId === request.actionId
			//     (idempotent retry — a prior commit of this same action already landed here;
			//     skip rather than treat as a conflict. Needed to rollforward stranded blocks
			//     after a mid-batch crash committed some but not all blocks.)
			//   - missedCommits: latest.rev >= request.rev but not the same actionId → real stale conflict.
			//   - toCommit: latest.rev < request.rev or no latest yet → run internalCommit.
			const toCommit: { blockId: BlockId, storage: IBlockStorage }[] = [];
			const missedCommits: { blockId: BlockId, transforms: ActionTransform[] }[] = [];
			for (const entry of blockStorages) {
				const { blockId, storage } = entry;
				const latest = await storage.getLatest();
				if (latest && latest.rev >= request.rev) {
					if (latest.rev === request.rev && latest.actionId === request.actionId) {
						// Idempotent no-op for this block — already committed with this exact (actionId, rev).
						continue;
					}
					const transforms: ActionTransform[] = [];
					for await (const actionRev of storage.listRevisions(request.rev, latest.rev)) {
						const transform = await storage.getTransaction(actionRev.actionId);
						if (!transform) {
							throw new Error(`Missing action ${actionRev.actionId} for block ${blockId}`);
						}
						transforms.push({
							actionId: actionRev.actionId,
							rev: actionRev.rev,
							transform
						});
					}
					missedCommits.push({ blockId, transforms });	// Push, even if transforms is empty, because we want to reject the older version
					continue;
				}
				toCommit.push(entry);
			}

			if (missedCommits.length) {
				log('commit:stale actionId=%s missed=%d', request.actionId, missedCommits.length);
				return { // Return directly, locks will be released in finally
					success: false,
					missing: perBlockActionTransformsToPerAction(missedCommits)
				};
			}

			// Check for missing pending actions only on blocks that still need to commit.
			// Already-done blocks will have had their pending promoted, so skipping them here
			// is what makes the idempotent rollforward work.
			//
			// A toCommit block whose pending is absent is one of two states:
			//   - Crash-D3: the action was durably promoted and its revision saved, but the crash
			//     lost the setLatest, so meta.latest is still < request.rev and the pending record
			//     is gone. getTransaction(actionId) returns the promoted transform. Self-heal here
			//     via storage.recover() (redoes the lost setLatest, advancing latest to the highest
			//     contiguous promoted rev, >= request.rev). recover() is idempotent + monotonic, so
			//     calling it under the already-held commit latch is safe. Recovered blocks are then
			//     excluded from the internalCommit loop below — their pending is gone, so
			//     internalCommit would throw.
			//   - Genuine missing pend: the action was never promoted (getTransaction → undefined),
			//     so the pend is truly missing. Throw exactly as before.
			// Crash-D2 never reaches this branch: its pending record is still present.
			const missingPends: { blockId: BlockId, actionId: ActionId }[] = [];
			const recovered = new Set<BlockId>();
			for (const { blockId, storage } of toCommit) {
				const pendingAction = await storage.getPendingTransaction(request.actionId);
				if (pendingAction) {
					continue;
				}
				const promoted = await storage.getTransaction(request.actionId);
				if (!promoted) {
					missingPends.push({ blockId, actionId: request.actionId });
					continue;
				}
				// Crash-D3 signature (pending absent + action durably promoted). Redo the lost setLatest.
				const result = await storage.recover();
				if (result.latest !== undefined && result.latest.rev >= request.rev) {
					recovered.add(blockId);
				} else {
					// Torn/partial state: recover() could not advance latest to request.rev (metadata
					// absent, or a revision entry missing despite the promoted transaction). Fall back
					// to treating the block as a genuine missing-pend error rather than silently succeeding.
					missingPends.push({ blockId, actionId: request.actionId });
				}
			}

			if (missingPends.length) {
				throw new Error(`Pending action ${request.actionId} not found for block(s): ${missingPends.map(p => p.blockId).join(', ')}`);
			}

			// The original commit crashed before setLatest, so it also never emitted a change event
			// for a recovered (Crash-D3) block. Now that recover() has committed it at request.rev,
			// report its collection so downstream watchers wake — mirroring internalCommit. Resolve
			// the collectionId from the now-materialized block; skip the emit when it can't be resolved
			// (e.g. a tombstone with no materialized block), the same fallback internalCommit uses.
			for (const { blockId, storage } of toCommit) {
				if (!recovered.has(blockId)) {
					continue;
				}
				const collectionId = (await storage.getBlock(request.rev))?.block.header.collectionId;
				if (collectionId !== undefined) {
					const list = collectionBlocks.get(collectionId) ?? [];
					list.push(blockId);
					collectionBlocks.set(collectionId, list);
				}
			}

			// Commit the action for each block that still needs it.
			// This loop will execute atomically for all blocks due to the acquired locks.
			// Recovered (Crash-D3) blocks are already committed at request.rev and their pending is
			// gone, so skip them — internalCommit would throw on the missing pending record.
			for (const { blockId, storage } of toCommit) {
				if (recovered.has(blockId)) {
					continue;
				}
				try {
					// internalCommit will throw if it encounters an issue
					const collectionId = await this.internalCommit(blockId, request.actionId, request.rev, storage);
					if (collectionId !== undefined) {
						const list = collectionBlocks.get(collectionId) ?? [];
						list.push(blockId);
						collectionBlocks.set(collectionId, list);
					}
				} catch (err) {
					// Partial-commit recovery: blocks already in collectionBlocks DID land
					// durably and must still emit; a retry with the same (actionId, rev)
					// treats them as idempotent no-ops and advances the remainder. Break
					// instead of returning so locks release and those landings emit below.
					failure = { reason: err instanceof Error ? err.message : 'Unknown error during commit' };
					break;
				}
			}
		}
		finally {
			// Release locks in reverse order of acquisition
			releases.reverse().forEach(release => release());
		}

		// Notify after the critical section, for every block newly committed here —
		// including those that landed before a mid-loop failure (alreadyDone / stale
		// partitions never reach `collectionBlocks`).
		this.emitCollectionChanges(collectionBlocks, request.actionId, request.rev, request.tailId);

		return failure ? { success: false, reason: failure.reason } : { success: true };
	}

	/**
	 * Reconciles `metadata.latest` for a single block with the highest contiguous
	 * fully-promoted revision in durable storage. Use after a crash between
	 * `promotePendingTransaction` and `setLatest` when retry-commit cannot help
	 * (the pending record is already gone) but the revision and committed-log entry
	 * are durable. Idempotent and monotonic.
	 */
	async recoverBlock(blockId: BlockId): Promise<void> {
		log('recoverBlock blockId=%s', blockId);
		const storage = this.createBlockStorage(blockId);
		await storage.recover();
	}

	/**
	 * Persist a replica of a block received out-of-band (churn re-replication) into
	 * local storage. Distinct from the {@link IRepo} commit funnel: the block arrives
	 * already materialized from a departing owner, not as a pend/commit. See
	 * {@link IBlockStorage.saveReplica} for the durability/monotonicity contract.
	 *
	 * Held under the same `StorageRepo.commit:<id>` latch as {@link commit} so the
	 * replica's read-modify-write of `latest` is mutually exclusive with a concurrent
	 * local commit on the same block — otherwise `saveReplica`'s monotonic guard could
	 * read a stale `latest` and clobber a commit that advanced it in between.
	 */
	async saveReplicatedBlock(blockId: BlockId, block: IBlock, source?: ActionRev): Promise<void> {
		log('saveReplicatedBlock blockId=%s rev=%s', blockId, source?.rev);
		const storage = this.createBlockStorage(blockId);
		const release = await Latches.acquire(commitLatchKey(blockId));
		// Captured under the latch; emitted after release to match commit's ordering.
		let landed: { collectionId: CollectionId, actionId: ActionId, rev: number } | undefined;
		try {
			const priorLatest = await storage.getLatest();
			const effective = await storage.saveReplica(block, source);
			// Advanced iff there was no prior revision or the effective rev moved past it. On the
			// monotonic no-op, saveReplica returns the held latest unchanged → effective.rev === priorLatest.rev.
			const advanced = priorLatest === undefined || effective.rev > priorLatest.rev;
			const collectionId = block.header?.collectionId;
			if (advanced && collectionId !== undefined) {
				landed = { collectionId, actionId: effective.actionId, rev: effective.rev };
			}
		} finally {
			release();
		}
		// Replica-persist has no CommitRequest, hence no tailId — like a read-driven promotion,
		// this wakes local onCollectionChange watchers but is cert-gated out of cohort-topic
		// re-origination downstream (change-bridge selfIsCohortMember treats a tail-less event as
		// never a member).
		if (landed) {
			this.emitCollectionChanges(
				new Map([[landed.collectionId, [blockId]]]),
				landed.actionId,
				landed.rev,
			);
		}
	}

	private async internalCommit(blockId: BlockId, actionId: ActionId, rev: number, storage: IBlockStorage): Promise<CollectionId | undefined> {
		// Note: This method is called within the locked critical section of commit()
		// So, operations like getPendingTransaction, getLatest, getBlock, saveMaterializedBlock,
		// saveRevision, promotePendingTransaction, setLatest are protected against
		// concurrent commits for the *same blockId*.

		const transform = await storage.getPendingTransaction(actionId);
		// No need to check if !transform here, as the caller (commit) already verified this.
		// If it's null here, it indicates a logic error or race condition bypassed the lock (unlikely).
		if (!transform) {
			throw new Error(`Consistency Error: Pending action ${actionId} disappeared for block ${blockId} within critical section.`);
		}

		// Get prior materialized block if it exists
		const latest = await storage.getLatest();
		const priorBlock = latest
			? (await storage.getBlock(latest.rev))?.block
			: undefined;

		// Apply transform and save materialized block
		// applyTransform handles undefined priorBlock correctly for inserts
		const newBlock = applyTransform(priorBlock, transform);

		if (newBlock) {
			await storage.saveMaterializedBlock(actionId, newBlock);
		}

		// Save revision and promote action *before* updating latest
		// This ensures that if the process crashes between these steps,
		// the 'latest' pointer doesn't point to a revision that hasn't been fully recorded.
		await storage.saveRevision(rev, actionId);
		await storage.promotePendingTransaction(actionId);

		// Update latest revision *last*
		await storage.setLatest({ actionId, rev });

		// Report the affected collection for change-event routing. For a delete the
		// materialized block is undefined, so fall back to the prior block's header.
		// Either may be absent only for a malformed/headerless block — return
		// undefined so the caller skips it rather than emitting a bogus event.
		return newBlock?.header.collectionId ?? priorBlock?.header.collectionId;
	}
}

/** Converts list of missing actions per block into a list of missing actions across blocks. */
function perBlockActionTransformsToPerAction(missing: { blockId: BlockId; transforms: ActionTransform[]; }[]) {
	const missingFlat = missing.flatMap(({ blockId, transforms }) =>
		transforms.map(transform => ({ blockId, transform }))
	);
	const missingByActionId = groupBy(missingFlat, ({ transform }) => transform.actionId);
	return Object.entries(missingByActionId).map(([actionId, items]) =>
		items.reduce((acc, { blockId, transform }) => {
			concatTransform(acc.transforms, blockId, transform.transform);
			return acc;
		}, {
			actionId: actionId as ActionId,
			rev: items[0]!.transform.rev,	// Assumption: all missing actionIds share the same revision
			transforms: emptyTransforms()
		})
	);
}
