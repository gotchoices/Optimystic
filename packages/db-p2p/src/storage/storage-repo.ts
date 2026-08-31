import type {
	IRepo, MessageOptions, BlockId, CommitRequest, CommitResult, GetBlockResults, PendRequest, PendResult, ActionBlocks,
	ActionId, BlockGets, ActionPending, PendSuccess, ActionTransform, ActionTransforms,
	GetBlockResult, IBlock, ActionRev, BlockUnavailableReason,
	PendValidationHook,
	CollectionId, IBlockChangeNotifier, CollectionChangeListener, CollectionChangeEvent,
	StaleFailure
} from "@optimystic/db-core";
import {
	transformForBlockId, applyTransform, groupBy, concatTransform, emptyTransforms,
	blockIdsForTransforms, transformsFromTransform, highestStaleAt, canonicalBlockHash
} from "@optimystic/db-core";
import { asyncIteratorToArray } from "../it-utility.js";
import type { IBlockStorage } from "./i-block-storage.js";
import type { IBlockReplicaStore } from "../cluster/block-transfer-service.js";
import { proofDeclaredDigest, type BlockCommitProof } from "../cluster/commit-proof.js";
import { RevisionNotCoveredError } from "./i-block-storage.js";
import { acquireBlockWriteLatches, withBlockWriteLatch, type BlockWriteLatch } from "./block-latch.js";
import { createLogger } from "../logger.js";

const log = createLogger('storage-repo');

/**
 * Stable, greppable prefix on the failure reason a commit carries when this node cannot materialize
 * the revision it was asked to record. It is a STRING marker rather than only an error class because
 * {@link StorageRepo.commit} reports per-block faults as `StaleFailure.reason` (a plain string that
 * also crosses the wire), so the class identity is lost by the time a caller inspects the result.
 */
export const MISSING_BASE_REVISION_REASON = 'missing-base-revision';

/**
 * This node was asked to commit revision N of a block it holds no materializable base for, so
 * applying the transform would materialize nothing while `latest` advanced to N — a block that is
 * then unreadable locally, unservable to peers, and that rejects every later write (see
 * {@link StorageRepo.internalCommit}). The commit is refused instead; the caller heals the node
 * out-of-band (`ClusterMember` pulls the committed revision from a cohort peer) and retries.
 */
export class MissingBaseRevisionError extends Error {
	constructor(readonly blockId: BlockId, readonly rev: number, detail: string) {
		super(`${MISSING_BASE_REVISION_REASON}: block ${blockId} cannot materialize rev ${rev} — ${detail}`);
		this.name = 'MissingBaseRevisionError';
	}
}

/**
 * True when a {@link CommitResult} failed because this node holds no materializable base for one of
 * the committed blocks. Distinguishes that recoverable divergence (heal by fetching the block from a
 * cohort peer) from a genuine storage fault, which must still propagate.
 */
export function isMissingBaseRevisionFailure(result: CommitResult): boolean {
	return !result.success && (result.reason?.startsWith(MISSING_BASE_REVISION_REASON) ?? false);
}

export type StorageRepoOptions = {
	/** Optional hook to validate transactions in PendRequests */
	validatePend?: PendValidationHook;
};

/**
 * What {@link StorageRepo.previewCommitDigest} predicts a commit would materialize. `digest` is the
 * {@link canonicalBlockHash} of the materialized content, or `undefined` when the transform
 * materializes nothing (a delete/tombstone, updates with no base to apply them to) or the base
 * exists but cannot be materialized locally. `baseRev` is the local committed revision the preview
 * was computed against (absent when there is none, or when the transform is base-independent and no
 * base was read). `baseIndependent` is true when the pended transform carries an `insert`, making
 * the result identical on every member regardless of what base it holds.
 */
export type CommitDigestPreview = {
	digest?: string;
	baseRev?: number;
	baseIndependent: boolean;
};

/**
 * The capability {@link ClusterMember.validateCommitOperations} probes its `storageRepo` for. Named
 * (rather than written inline at the probe) so there is ONE definition of the contract and so a repo
 * decorator wrapping the member's storage seam has something to `implements` and forward — a wrapper
 * that drops the method silently disables the commit content-digest check on that node.
 */
export interface ICommitDigestPreviewer {
	previewCommitDigest(blockId: BlockId, actionId: ActionId, rev: number): Promise<CommitDigestPreview | undefined>;
}

/**
 * The capability `ClusterMember.applyConsensusOperation` casts its `storageRepo` to when handing a
 * {@link BlockCommitProof} down the commit path. Named for the same reason as
 * {@link ICommitDigestPreviewer}: one definition of the widened contract, and something a repo
 * decorator can `implements` and forward. `IRepo.commit` takes two arguments; the third is
 * harmless at runtime for a plain `IRepo` implementation (the extra argument is ignored), so
 * callers cast rather than structurally probe — but a decorator that narrows back to `IRepo`
 * silently stops persisting proofs on that node.
 */
export interface ICommitProofPersister {
	commit(request: CommitRequest, options?: MessageOptions, proof?: BlockCommitProof): Promise<CommitResult>;
}

/**
 * The capability that answers "which action committed revision N of this block?" — the question the
 * commit-tier stale checks need when local `latest` has already advanced PAST a contested revision,
 * so `latest.actionId` alone can no longer distinguish "my commit landed and history moved on"
 * (abstain / not a conflict) from "a rival took my revision" (reject / retryable conflict).
 * Consumed by the cluster member's promise-round stale-commit check
 * (`ClusterMember.validateCommitRevisions`) and by `CoordinatorRepo`'s commit rejection classifier.
 * Named (rather than probed inline) for the same reason as {@link ICommitDigestPreviewer}: one
 * definition of the contract, and something a repo decorator can `implements` and forward — a
 * wrapper that drops the method silently degrades both checks to an abstain on that node.
 */
export interface IRevisionActionReader {
	/**
	 * The action id recorded for `rev` of `blockId`, or `undefined` when this node holds no revision
	 * record for it (never seen, or history truncated below `rev`). Read-only; never takes the block
	 * write latch (callers are on vote/classification paths and must treat a throw as "unknown").
	 */
	getRevisionAction(blockId: BlockId, rev: number): Promise<ActionId | undefined>;
}

export class StorageRepo implements IRepo, IBlockChangeNotifier, IBlockReplicaStore, ICommitDigestPreviewer, ICommitProofPersister, IRevisionActionReader {
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
			// Set when this node KNOWS its answer for the block is a guess: the promotion
			// below refused for a missing base, or getBlock() threw (truncated history /
			// failed restore). An absent-reading block then reports `unavailable` instead of
			// posing as an authoritative "never existed" — see BlockUnavailableReason.
			let unavailable: BlockUnavailableReason | undefined;

			// Ensure that all outstanding transactions in the context are committed.
			// This promotes a landed-elsewhere pending via internalCommit, which writes the
			// block's metadata — the same read-modify-write commit()/saveReplicatedBlock guard
			// with the per-block write latch. It MUST hold that latch too, or a promotion
			// racing a concurrent commit on the block regresses latest non-monotonically /
			// cross-writes a revision. Cheap unlatched pre-scan first so the common
			// contextless read and no-pending read never pay for latch acquisition; the
			// authoritative decision is re-made inside the latch.
			if (context) {
				const preLatest = await blockStorage.getLatest();
				const preMissing = preLatest
					? context.committed.filter(c => c.rev > preLatest.rev)
					: context.committed;
				if (preMissing.length > 0) {
					await withBlockWriteLatch(blockId, async (latch) => {
						// Re-read authoritative state under the latch: a concurrent commit may have
						// promoted or superseded a pending between the unlatched pre-scan and here.
						// Recompute which committed entries are still ahead of `latest` (drops the
						// superseded, rev <= latest.rev) and re-fetch each pending inside the loop
						// (skips the already-promoted, pending gone). This makes read-driven
						// promotion idempotent under races, mirroring commit()'s alreadyDone/stale
						// partitioning.
						const latest = await blockStorage.getLatest();
						const missing = latest
							? context.committed.filter(c => c.rev > latest.rev)
							: context.committed;
						// Sort a COPY: when `latest` is undefined, `missing` aliases the caller's
						// `context.committed` array, and an in-place `.sort()` would reorder the shared
						// request context under the caller's feet.
						try {
							for (const { actionId, rev } of [...missing].sort((a, b) => a.rev - b.rev)) {
								const pending = await blockStorage.getPendingTransaction(actionId);
								if (pending) {
									const collectionId = await this.internalCommit(blockId, actionId, rev, blockStorage, latch);
									if (collectionId !== undefined) {
										promotions.push({ collectionId, blockId, actionId, rev });
									}
								}
							}
						} catch (err) {
							// This node holds no materializable base for the block, so NO context revision
							// can be promoted here (each builds on the one before). Leave `latest` where it
							// is — the invariant internalCommit just enforced — and let the commit-path
							// healing supply the content; a read must not fail for it. Every other fault
							// still propagates.
							if (!(err instanceof MissingBaseRevisionError)) {
								throw err;
							}
							// This node holds records PROVING the block exists (a pending it could not
							// promote); if the block then reads as absent below, the answer is a guess,
							// not an authoritative "never existed".
							unavailable = 'unmaterializable';
							log('get:promote-skipped-missing-base blockId=%s rev=%d reason=%s', blockId, err.rev, err.message);
						}
					});
				}
			}

			// NOTE: a Crash-D3 block (durably promoted + revision saved, but the setLatest lost so
			// meta.latest is stale and the pending record is gone) reads as empty/stale here — a
			// context-driven get skips promotion (pending gone) and a default getBlock() sees the
			// stale latest. It is soft-wedged (stale), not hard-wedged: the next commit-retry for
			// (actionId, rev) self-heals it via storage.recover() in commit(). Not repaired lazily on
			// the read path because the plain read below holds no write latch; if stale reads on
			// unwritten blocks ever become a problem, add a latched lazy recover() here.
			//
			// readBlockHealing() THROWS when this node holds a `latest` it cannot materialize
			// (truncated history: "Failed to find materialized block", or a failed restore). Caught
			// PER BLOCK so one broken block cannot fail the whole batch's Promise.all and take healthy
			// siblings down with it. The read still fails for THIS block — TransactorSource throws
			// BlockUnavailableError on the flagged entry — so nothing is swallowed.
			let blockRev: Awaited<ReturnType<IBlockStorage['getBlock']>>;
			try {
				blockRev = await this.readBlockHealing(blockId, blockStorage, context?.rev);
			} catch (err) {
				// NOTE: the entry drops `state.latest`, which this node does know (getLatest() does not
				// materialize, so it does not throw). Empty state is what makes CoordinatorRepo treat the
				// block as missing and consult the cohort — exactly the repair this block needs. If a
				// consumer ever needs the revision behind an unavailable answer (e.g. to ask the cohort
				// for a specific rev instead of the whole block), carry `latest` here and widen the
				// coordinator's consult trigger to `isMissing || unavailable` so repair still fires.
				log('get:unmaterializable blockId=%s error=%s', blockId,
					err instanceof Error ? err.message : String(err));
				return [blockId, { state: {}, unavailable: 'unmaterializable' } as GetBlockResult];
			}

			// Include pending action if requested, applying the pending transform over whatever
			// committed base getBlock() resolved (possibly none — a pending-only insert has no
			// committed revision under it and getBlock reports that as an absent base, not a fault).
			if (context?.actionId !== undefined) {
				const pendingTransform = await blockStorage.getPendingTransaction(context.actionId);
				if (!pendingTransform) {
					if (unavailable !== undefined) {
						// The promotion refusal above deleted this very pending record
						// (`refuseMissingBase` drops the pending it cannot promote). This node DID hold
						// the record and dropped it, so the honest answer is an availability one — not
						// a caller-contract violation, and never a throw that would fail the whole batch.
						return [blockId, { state: {}, unavailable } as GetBlockResult];
					}
					// Caller-contract violation (the caller asserted a pending this repo never had, or
					// cancelled) — an error, not an availability question. Deliberately NOT `unavailable`.
					//
					// It is NOT the only way to reach here. A context that both PROVES its own action
					// (`committed` names it) and names it as the pending overlay (`actionId`) is
					// self-contradictory, and the two halves of that contradiction land differently: if
					// the read-driven promotion above REFUSED, the arm above answers gracefully; if it
					// SUCCEEDED, `promotePendingTransaction` moved the record and we throw here — failing
					// the whole batch for a request the refusal path tolerates. No production code sets
					// `ActionContext.actionId` at all today, so neither is reachable except from tests or
					// a peer that crafts the field on the wire. See
					// tickets/blocked/repo-pending-overlay-has-no-producer.
					throw new Error(`Pending action ${context.actionId} not found`);
				}
				const block = applyTransform(blockRev?.block, pendingTransform);
				return [blockId, {
					block,
					state: {
						latest: await blockStorage.getLatest(),
						pendings: [context.actionId]
					},
					// The COMMITTED revision underneath the pending overlay. A pending has no revision
					// of its own, so the honest answer is the base it was applied to. Absent when there
					// was no base at all — a pending-only insert served over an absent committed base,
					// where fabricating a revision would claim content this node never committed.
					...(blockRev ? { materialized: blockRev.actionRev } : {}),
					// A pending applied to a missing base can materialize nothing (applyTransform drops
					// updates with no block to apply them to) — that absence is a guess, and is flagged.
					// A materialized block is a real answer regardless of the earlier refusal. TWO ways
					// an empty result is a guess: the promotion refusal fired (`unavailable` set), or
					// there was no committed base under the overlay at all (`blockRev === undefined`) —
					// this node holds a pending record PROVING the block exists and produced nothing.
					// The second clause's ABSENCE in the other direction is equally load-bearing: a
					// pending DELETE over a real committed base also lands here with no block, and that
					// is an authoritative tombstone which must stay unflagged.
					...(block === undefined && (unavailable !== undefined || blockRev === undefined)
						? { unavailable: unavailable ?? 'unmaterializable' }
						: {})
				} as GetBlockResult];
			}

			if (!blockRev) {
				// `unavailable` distinguishes "never existed" (the common insert-probe case, no flag)
				// from "this node cannot reconstruct it" (the promotion above refused for a missing
				// base). A tombstoned block also lands here with meta.latest set, but it never enters
				// the missing-base catch, so it stays an authoritative absent — keyed off the explicit
				// flag, not off "no block".
				return [blockId, { state: {}, ...(unavailable !== undefined ? { unavailable } : {}) } as GetBlockResult];
			}

			const pendings = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			return [blockId, {
				block: blockRev.block,
				// `getBlock(context?.rev)` materialized the content at the highest committed revision
				// at or below the pin, and reports it as `actionRev` — report THAT alongside the
				// content. `state.latest` deliberately stays the node's newest revision for the block
				// (StorageRepo.get's own promotion pre-scan and CoordinatorRepo's read-repair compare
				// against it), so the two disagree exactly when a pinned read is serving older content.
				materialized: blockRev.actionRev,
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
	 * The one place a local coverage gap is healed from a peer. `getBlock` is local-only; when it
	 * reports the target revision as not covered ({@link RevisionNotCoveredError}) this fetches it
	 * through `restoreRevision` under the block's write latch — the restore writes revision records
	 * and merges coverage into the metadata blob, so it must serialize against every other writer of
	 * the block — and re-reads. Only the restore is latched; the reads on either side are not, and
	 * the latch is never held across the two.
	 *
	 * A restore that fails on a **pending-only** block (metadata seeded by a pend, no committed
	 * revision) reads as ABSENT, not as a fault: the named revision was a guess about content this
	 * node never held, and the caller's insert-probe / pending-overlay logic already treats an absent
	 * base as "nothing committed here". A failed restore on a block that DOES hold a `latest` is a
	 * real fault (a `latest` this node cannot serve) and propagates, so the caller reports the block
	 * as unavailable. Any throw from the second read (records restored but nothing materializable
	 * under them) propagates the same way.
	 */
	private async readBlockHealing(
		blockId: BlockId,
		storage: IBlockStorage,
		rev: number | undefined
	): Promise<{ block: IBlock, actionRev: ActionRev } | undefined> {
		try {
			return await storage.getBlock(rev);
		} catch (err) {
			if (!(err instanceof RevisionNotCoveredError)) {
				throw err;
			}
			try {
				// NOTE: the peer fetch inside restoreRevision runs UNDER the block's write latch, so a
				// slow restore queues every commit/pend/replica on this block behind one network
				// round-trip. Fine at today's restore rates (a gap is healed once, then served
				// locally); if restore latency ever shows up delaying commits, fetch + vet OUTSIDE the
				// latch and take it only to write, re-checking coverage inside.
				await withBlockWriteLatch(blockId, latch => storage.restoreRevision(err.rev, latch));
			} catch (restoreErr) {
				if (await storage.getLatest() === undefined) {
					log('get:restore-failed-pending-only blockId=%s rev=%d error=%s', blockId, err.rev,
						restoreErr instanceof Error ? restoreErr.message : String(restoreErr));
					return undefined;
				}
				throw restoreErr;
			}
			return await storage.getBlock(rev);
		}
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
				// Hard rejection: the transaction itself is invalid, so no `conflict` flag — a
				// re-read and re-pend would fail the same way and only burn the retry budget.
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
		// Highest revision this node confirms holding among the blocks that are at or past the
		// requested one — reported as StaleFailure.staleAt so a losing writer learns the number
		// instead of parsing prose. Confirmed-local only: we read it from our own storage below.
		let staleAt: StaleFailure['staleAt'];
		// Blocks this action ALREADY committed at exactly the requested revision — the durable half
		// of a torn action whose retry reuses the same actionId. Sibling of the `alreadyDone`
		// partition in `commit` below: satisfied, not merely non-stale, so no pending is recorded
		// for them (see the fan-out at the end of this method).
		const satisfied = new Set<BlockId>();

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

			// Handle any conflicting revisions FIRST: a block this same action already committed at
			// exactly the requested revision is satisfied, and skips both this check and the
			// pending-action listing below.
			if (request.rev !== undefined || transforms.insert) {
				const latest = await blockStorage.getLatest();
				if (latest && request.rev !== undefined && latest.rev === request.rev && latest.actionId === request.actionId) {
					// Our own already-durable work, met again by a retry that reuses the actionId
					// (a torn action: some blocks committed, the rest refused). Treating it as a
					// stale rival would refuse the writer with its own commit, permanently. Only
					// `===` is carved out — never `latest.rev > request.rev`, where the follow-on
					// commit takes the `missedCommits` branch and refuses anyway.
					satisfied.add(blockId);
					continue;
				}
				if (latest && latest.rev >= (request.rev ?? 0)) {
					// Only a real revision race yields a meaningful `staleAt`. When `request.rev` is
					// undefined this same branch fires for an insert collision (the comparison degrades
					// to `latest.rev >= 0`, true for any existing block), and reporting that block's
					// revision would be a number that answers a question nobody asked.
					if (request.rev !== undefined) {
						staleAt = highestStaleAt([staleAt, { blockId, rev: latest.rev }]);
					}
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

			// Then handle any pending actions
			const pending = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			pendings.push(...pending.map(actionId => ({ blockId, actionId })));
		}

		if (missing.length) {
			log('pend:stale actionId=%s missing=%d', request.actionId, missing.length);
			return {
				success: false,
				conflict: true,
				missing,
				...(staleAt === undefined ? {} : { staleAt })
			};
		}

		if (pendings.length > 0) {
			if (request.policy === 'f') {	// Fail on pending actions
				return { success: false, conflict: true, pending: pendings };
			} else if (request.policy === 'r') {	// Return populated pending actions
				return {
					success: false,
					conflict: true,
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
		//
		// Each block's pending write runs under THAT block's write latch, one latch per branch and
		// never nested: savePendingTransaction seeds the block's metadata blob when it has none, and
		// an unlatched seed racing a concurrent commit/replica on a fresh block erases the `latest`
		// the other writer just landed. Never more than one block latch is held by a branch, so this
		// cannot deadlock against commit's sorted multi-latch acquisition.
		//
		// `satisfied` blocks are skipped: this action's commit for them already landed, and
		// `commit`'s `alreadyDone` arm `continue`s past `internalCommit` — the only thing that
		// promotes (and thereby removes) a pending record. A pending saved here would never be
		// cleared and would sit as a permanent durable reservation that the rival-pending checks
		// (this method's own listPendingTransactions scan, and
		// `ClusterMember.validatePendOperations`) refuse every future writer against — a worse
		// wedge than the one this carve-out fixes. They still ride in the returned `blockIds` so
		// `cancel` covers them; `deletePendingTransaction` on an absent record is a no-op.
		await Promise.all(blockIds.filter(blockId => !satisfied.has(blockId)).map(blockId => {
			const blockStorage = this.createBlockStorage(blockId);
			const blockTransform = transformForBlockId(request.transforms, blockId);
			return withBlockWriteLatch(blockId, latch => blockStorage.savePendingTransaction(request.actionId, blockTransform, latch));
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
			return withBlockWriteLatch(blockId, latch => blockStorage.deletePendingTransaction(actionRef.actionId, latch));
		}));
	}

	/**
	 * Commit a previously-pended action across its blocks, under the block write latches.
	 *
	 * **Divergence vs genuine fault.** When the batch cannot be completed, the reason decides what
	 * happens to the pending records the pend left behind. `ClusterMember.applyConsensusOperation`
	 * makes the same split one layer up — it *tolerates* a divergence (and reconciles every
	 * `commit.blockIds` entry from a cohort peer) but *propagates* a genuine fault for retry — so this
	 * method must agree with it:
	 *
	 * - **Divergence** — this node is behind the agreed history, either because it holds no
	 *   materializable base ({@link MissingBaseRevisionError}) or because it never received the pend
	 *   (the `Pending action … not found` throw). Reconcile is guaranteed to follow and will advance
	 *   every block in the batch past `request.rev`, so no pending record here can ever be promoted:
	 *   {@link dropUnpromotablePendings} deletes them (see {@link refuseMissingBase}, which already
	 *   accepts this tradeoff for the single refusing block).
	 * - **Genuine fault** — any other throw out of {@link internalCommit} (a raw-storage error, …).
	 *   `ClusterMember` propagates it and the commit is retried, and a retry can still replay the
	 *   pendings, so they are KEPT.
	 *
	 * The stale/`missedCommits` early return (this node is AHEAD — it already holds a revision at or
	 * past `request.rev`, committed under a different action) deliberately keeps pendings too, and its
	 * cure is the losing client's `cancel`: `CoordinatorRepo.cancel` runs through consensus, so every
	 * member drops the record, not just the coordinator. Replication cannot be the cure here — this
	 * node is already ahead, and a later forward write carries a DIFFERENT action id, which is not
	 * what `BlockStorage.saveForwardRevision` deletes. A client that dies between the stale result and
	 * its `cancel` therefore still strands the record; that is pre-existing and orthogonal to the
	 * divergence split above.
	 */
	async commit(request: CommitRequest, _options?: MessageOptions, proof?: BlockCommitProof): Promise<CommitResult> {
		log('commit actionId=%s rev=%d blockIds=%d', request.actionId, request.rev, request.blockIds.length);
		// Deduped ONCE, in request order — the order blocks are committed and reported in. The latches
		// are acquired in sorted order by `acquireBlockWriteLatches` over this same set, so every
		// `latches.get(blockId)!` below resolves.
		const blockIds = Array.from(new Set(request.blockIds));
		// Collects the blocks newly committed in this call, grouped by collection,
		// so we can emit change events once locks are released. Blocks that land before
		// a mid-loop failure stay here and are still emitted (Option A — emit eagerly):
		// they are durably committed and a retry rolls the remainder forward.
		const collectionBlocks = new Map<CollectionId, BlockId[]>();
		// Captured when internalCommit throws mid-loop; we break (rather than return)
		// so locks release and accumulated landings still emit before we report failure.
		let failure: { reason: string } | undefined;

		// Every block's token is kept so each write below can prove it runs inside that block's latch.
		const { latches, release } = await acquireBlockWriteLatches(blockIds);

		try {
			// --- Start of Critical Section ---

			// Request order, deduped (NOT the sorted acquisition order): the order here is the order
			// blocks are committed and reported in change events, which callers may observe.
			const blockStorages = blockIds.map(blockId => ({
				blockId,
				storage: this.createBlockStorage(blockId),
				latch: latches.get(blockId)!
			}));

			// Partition blocks into:
			//   - alreadyDone: latest.rev === request.rev && latest.actionId === request.actionId
			//     (idempotent retry — a prior commit of this same action already landed here;
			//     skip rather than treat as a conflict. Needed to rollforward stranded blocks
			//     after a mid-batch crash committed some but not all blocks.)
			//   - missedCommits: latest.rev >= request.rev but not the same actionId → real stale conflict.
			//   - toCommit: latest.rev < request.rev or no latest yet → run internalCommit.
			const toCommit: { blockId: BlockId, storage: IBlockStorage, latch: BlockWriteLatch }[] = [];
			const missedCommits: { blockId: BlockId, transforms: ActionTransform[] }[] = [];
			// Highest revision among the blocks confirmed lost to a newer one — reported as
			// StaleFailure.staleAt. The idempotent-retry `continue` below is a no-op, not a loss,
			// so it never seeds this.
			let staleAt: StaleFailure['staleAt'];
			for (const entry of blockStorages) {
				const { blockId, storage, latch } = entry;
				const latest = await storage.getLatest();
				if (latest && latest.rev >= request.rev) {
					if (latest.rev === request.rev && latest.actionId === request.actionId) {
						// Idempotent no-op for this block — already committed with this exact (actionId, rev).
						// A retry can carry a proof the original commit lacked (or crashed before writing):
						// back-fill it, strictly additively, under the same digest-match retention rule the
						// original commit applies. Runs inside the latched critical section.
						await this.backFillProof(blockId, storage, request.rev, request.actionId, proof, latch);
						continue;
					}
					staleAt = highestStaleAt([staleAt, { blockId, rev: latest.rev }]);
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
					missing: perBlockActionTransformsToPerAction(missedCommits),
					...(staleAt === undefined ? {} : { staleAt })
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
			//     calling it under the already-held block write latch is safe. Recovered blocks are then
			//     excluded from the internalCommit loop below — their pending is gone, so
			//     internalCommit would throw.
			//   - Genuine missing pend: the action was never promoted (getTransaction → undefined),
			//     so the pend is truly missing. Throw exactly as before.
			// Crash-D2 never reaches this branch: its pending record is still present.
			const missingPends: { blockId: BlockId, actionId: ActionId }[] = [];
			const recovered = new Set<BlockId>();
			for (const { blockId, storage, latch } of toCommit) {
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
				const result = await storage.recover(latch);
				if (result.latest !== undefined && result.latest.rev >= request.rev) {
					recovered.add(blockId);
				} else {
					// Torn/partial state: recover() could not advance latest to request.rev (metadata
					// absent, or a revision entry missing despite the promoted transaction). Fall back
					// to treating the block as a genuine missing-pend error rather than silently succeeding.
					missingPends.push({ blockId, actionId: request.actionId });
				}
			}

			// NOTE: if a batch ever held BOTH a recovered D3 block and a genuine missing-pend block,
			// this throw fires after recover() already advanced the D3 block durably, so that block's
			// change event is skipped (the retry then treats it as alreadyDone and never re-emits;
			// durable state stays correct, only the emit is lost). Judged unreachable today: a single
			// crash mid-internalCommit leaves exactly one D3 block, with the rest alreadyDone or
			// pending-present — a never-pended block cannot coexist with it in one retry. If a path
			// ever produces that mix, emit recovered blocks' events before throwing here.
			if (missingPends.length) {
				// Divergence (this node is behind): `ClusterMember` treats this throw as the canonical
				// "behind" signal and reconciles EVERY block in the batch, advancing each past
				// `request.rev`. Nothing can promote the pendings the other blocks still hold, so drop
				// them here — while the latches are still held — before reporting. The thrown message
				// must stay byte-identical: `ClusterMember.isMissingPendingActionError` matches on it.
				await this.dropUnpromotablePendings(toCommit, request.actionId);
				throw new Error(`Pending action ${request.actionId} not found for block(s): ${missingPends.map(p => p.blockId).join(', ')}`);
			}

			// The original commit crashed before setLatest, so it also never emitted a change event
			// for a recovered (Crash-D3) block. Now that recover() has committed it at request.rev,
			// report its collection so downstream watchers wake — mirroring internalCommit. Resolve
			// the collectionId from the now-materialized block; a delete materializes to a tombstone
			// (getBlock → undefined), so fall back to the prior materialized block's header exactly as
			// internalCommit does — otherwise a recovered delete would silently fail to wake watchers.
			// Only when neither resolves (a delete-only block with no prior materialization) is the
			// emit skipped, the same terminal fallback internalCommit uses.
			for (const { blockId, storage, latch } of toCommit) {
				if (!recovered.has(blockId)) {
					continue;
				}
				const collectionId = (await storage.getBlock(request.rev))?.block.header.collectionId
					?? (await storage.getBlock(request.rev - 1))?.block.header.collectionId;
				if (collectionId !== undefined) {
					const list = collectionBlocks.get(collectionId) ?? [];
					list.push(blockId);
					collectionBlocks.set(collectionId, list);
				}
				// The recovered block IS committed at request.rev, but it is excluded from the
				// internalCommit loop below — so without this it would be the one landing path that
				// never retains the cohort's proof, even though this very call is carrying it.
				await this.backFillProof(blockId, storage, request.rev, request.actionId, proof, latch);
			}

			// Commit the action for each block that still needs it.
			// This loop will execute atomically for all blocks due to the acquired locks.
			// Recovered (Crash-D3) blocks are already committed at request.rev and their pending is
			// gone, so skip them — internalCommit would throw on the missing pending record.
			//
			// Set when the mid-loop failure was a divergence rather than a genuine fault — the split
			// documented on commit() above, which decides the fate of the batch's pending records.
			let divergentFailure = false;
			for (const { blockId, storage, latch } of toCommit) {
				if (recovered.has(blockId)) {
					continue;
				}
				try {
					// internalCommit will throw if it encounters an issue
					const collectionId = await this.internalCommit(blockId, request.actionId, request.rev, storage, latch, proof);
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
					divergentFailure = err instanceof MissingBaseRevisionError;
					break;
				}
			}

			// The break left every not-yet-reached block still holding its pending record. Whether
			// that record is still usable depends ENTIRELY on why we stopped — see the table on
			// commit() above. Runs inside the try, so the per-block latches are still held.
			// NOTE: a non-divergence fault deliberately KEEPS the batch's pendings so a retry can
			// replay them. If ClusterMember ever stops retrying propagated commit faults, this arm
			// becomes dead weight and the discriminator can collapse to "always drop".
			if (divergentFailure) {
				await this.dropUnpromotablePendings(toCommit, request.actionId);
			}
		}
		finally {
			// Releases every block latch, in reverse acquisition order.
			release();
		}

		// Notify after the critical section, for every block newly committed here —
		// including those that landed before a mid-loop failure (alreadyDone / stale
		// partitions never reach `collectionBlocks`).
		this.emitCollectionChanges(collectionBlocks, request.actionId, request.rev, request.tailId);

		return failure ? { success: false, reason: failure.reason } : { success: true };
	}

	/**
	 * Delete `actionId`'s pending record from every given block, tolerating absence.
	 *
	 * Called by {@link commit} when it abandons a batch **because this node has diverged from the
	 * agreed history** — the caller has already made that determination; this helper does not
	 * re-derive it. Once `ClusterMember` reconciles the batch, every one of these blocks sits at or
	 * past `request.rev`, so a commit retry partitions them as already-done/stale and never revisits
	 * their pendings; left in place they are reported as phantom conflicting actions by {@link pend}
	 * for every later write to the block (under `policy: 'f'`, forever).
	 *
	 * No special-casing is needed for blocks that already landed (record promoted), that were
	 * `recovered` (record already gone), or for the refusing block itself
	 * ({@link refuseMissingBase} deleted its record): deleting an absent pending record is a no-op on
	 * every backend.
	 *
	 * Per-block failures are logged and swallowed rather than propagated: this cleanup must never
	 * replace the failure the caller is about to report — the pre-loop throw's message is pattern-
	 * matched by `ClusterMember.isMissingPendingActionError`, and a swapped error would misroute
	 * consensus. A leftover record only degrades this node's participation in that one block.
	 */
	private async dropUnpromotablePendings(
		blocks: { blockId: BlockId, storage: IBlockStorage, latch: BlockWriteLatch }[],
		actionId: ActionId
	): Promise<void> {
		if (blocks.length === 0) {
			return;
		}
		log('commit:drop-unpromotable-pendings actionId=%s blockIds=%d', actionId, blocks.length);
		await Promise.all(blocks.map(async ({ blockId, storage, latch }) => {
			try {
				await storage.deletePendingTransaction(actionId, latch);
			} catch (err) {
				log('commit:drop-unpromotable-pending-failed blockId=%s actionId=%s error=%s', blockId, actionId,
					err instanceof Error ? err.message : String(err));
			}
		}));
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
		// Hold the block write latch: recover() is a read-modify-write of the metadata blob that
		// blindly writes back the object it read, so its "advance only" guard is TOCTOU — racing a
		// concurrent commit()/saveReplicatedBlock that advanced latest in between would clobber it
		// (a non-monotonic regression). Same latching invariant as every other metadata writer.
		// commit() calls storage.recover(latch) directly under its own held latch, so it never
		// routes through here — no double-acquire / deadlock.
		await withBlockWriteLatch(blockId, latch => storage.recover(latch));
	}

	/**
	 * Persist a replica of a block received out-of-band (churn re-replication) into
	 * local storage. Distinct from the {@link IRepo} commit funnel: the block arrives
	 * already materialized from a departing owner, not as a pend/commit. See
	 * {@link IBlockStorage.saveReplica} for the durability/monotonicity contract.
	 *
	 * Held under the same block write latch as {@link commit} so the replica's
	 * read-modify-write of the metadata blob is mutually exclusive with a concurrent
	 * local commit on the same block — otherwise `saveReplica`'s monotonic guard could
	 * read a stale `latest` and clobber a commit that advanced it in between.
	 *
	 * `verifiedProof` is retained when supplied: both the reconcile path
	 * (`cluster/reconcile-block.ts`) and the certified push path (`BlockTransferService.handlePush`)
	 * pass the {@link BlockCommitProof} they verified against these exact bytes (`certifyContent`'s
	 * digest check), so a repaired replica serves the proof onward and certification no longer decays
	 * across repair hops.
	 *
	 * When the push does NOT advance `latest` (this node already holds that revision), `saveReplica`
	 * is a no-op and persists nothing — so the proof is back-filled here instead, through
	 * {@link backFillProof}'s digest-match rule. It is deliberately NOT persisted inside
	 * `saveReplica`: the proof was verified against the PUSHED bytes, while a back-fill attaches it to
	 * this node's HELD materialization, and a diverged holder's bytes at the same `(rev, actionId)`
	 * may differ. Storing a proof whose declared digest contradicts local content would make this node
	 * serve content that fails its own proof — `digest-mismatch` is an ATTRIBUTABLE fault in
	 * `certified-claims.ts`, so every receiver would penalize it.
	 */
	async saveReplicatedBlock(blockId: BlockId, block: IBlock, source?: ActionRev, verifiedProof?: BlockCommitProof): Promise<void> {
		log('saveReplicatedBlock blockId=%s rev=%s', blockId, source?.rev);
		const storage = this.createBlockStorage(blockId);
		// Captured under the latch; emitted after release to match commit's ordering.
		let landed: { collectionId: CollectionId, actionId: ActionId, rev: number } | undefined;
		await withBlockWriteLatch(blockId, async (latch) => {
			const priorLatest = await storage.getLatest();
			const effective = await storage.saveReplica(block, source, verifiedProof, latch);
			// Advanced iff there was no prior revision or the effective rev moved past it. On the
			// monotonic no-op, saveReplica returns the held latest unchanged → effective.rev === priorLatest.rev.
			const advanced = priorLatest === undefined || effective.rev > priorLatest.rev;
			const collectionId = block.header?.collectionId;
			if (advanced && collectionId !== undefined) {
				landed = { collectionId, actionId: effective.actionId, rev: effective.rev };
			}
			if (!advanced && verifiedProof !== undefined && source !== undefined
				&& effective.rev === source.rev && effective.actionId === source.actionId) {
				// The push named exactly the revision this node already holds, and carried a verified
				// proof for it. Back-fill so a proof-lessly-landed revision stops being corroboration-only
				// the moment valid evidence for it arrives. Requires agreement on BOTH rev and actionId:
				// same rev under a different action is a divergence, not the same revision.
				//
				// A held revision NEWER than the pushed one is deliberately not back-filled: `servableProof`
				// only ever serves the proof for `latest.rev`, so the proof would be keyed to a revision
				// this node will never serve, for content it may not even materialize.
				//
				// Runs under the block write latch already held here — the same latch the commit-path
				// back-fill sites hold, so no new latch interaction. `backFillProof` never throws: the
				// revision is already durable, and a proof-persist fault must not turn a no-op into a
				// failure.
				//
				// NOTE: once a proof IS retained this costs one key lookup per duplicate push
				// (`backFillProof` returns before materializing). A holder whose bytes diverge from the
				// cohort's never retains one, so it re-materializes and re-hashes the block on EVERY
				// certified push of that revision. Bounded by push frequency and fine at spread-on-churn
				// rates; if a diverged holder under repeated push ever shows up in a profile, remember the
				// withheld `(rev, actionId)` and skip the re-check.
				await this.backFillProof(blockId, storage, effective.rev, effective.actionId, verifiedProof, latch);
			}
		});
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

	/**
	 * The digest the block WOULD materialize to if `actionId`'s pending transform committed at `rev`,
	 * plus the base revision it was computed from. Read-only: touches no durable state and takes no
	 * block write latch.
	 *
	 * Mirrors {@link internalCommit}'s reads (pending transform → latest → base → applyTransform) so
	 * the prediction and the eventual commit cannot drift. Consumed by the cluster member's
	 * promise-round content-digest check (`ClusterMember.validateCommitOperations`), which compares it
	 * against the digest the transaction author declared on the commit request.
	 *
	 * Deliberately does NOT take the block write latch: this runs on the vote path, ahead of the
	 * commit that will take it, so taking it here would serialize voting behind commits and risks
	 * deadlocking against commit's sorted up-front multi-block latch acquisition. The price is that a
	 * concurrent commit can move `latest` mid-preview; the caller's checkable rule (base-independent,
	 * or `baseRev` agreement) makes a torn read at worst an abstain, never a false reject of honest
	 * content.
	 *
	 * `rev` is accepted for parity/logging with the commit that would follow; materialization does not
	 * depend on it (internalCommit only records it).
	 *
	 * Returns `undefined` when this node holds no pending transform for the action (it never saw the
	 * pend) — distinct from a defined preview with `digest: undefined` (see {@link CommitDigestPreview}).
	 */
	async previewCommitDigest(blockId: BlockId, actionId: ActionId, rev: number): Promise<CommitDigestPreview | undefined> {
		const storage = this.createBlockStorage(blockId);
		const transform = await storage.getPendingTransaction(actionId);
		if (!transform) {
			return undefined;
		}

		// An insert replaces the block wholesale before updates apply, so the result is the same on
		// every member no matter what base it holds — do not read a base at all (the block may even be
		// locally wedged/unmaterializable, which must not degrade a base-independent preview).
		const baseIndependent = transform.insert !== undefined;
		let base: IBlock | undefined;
		let baseRev: number | undefined;
		if (!baseIndependent) {
			const latest = await storage.getLatest();
			if (latest) {
				baseRev = latest.rev;
				try {
					base = (await storage.getBlock(latest.rev))?.block;
				} catch (err) {
					// This node holds a `latest` it cannot materialize (see readCommitBase). That is a
					// local deficiency, not a content mismatch — report "cannot check" so the caller
					// abstains. Unlike the commit path's refuseMissingBase, this must NOT delete the
					// pending record or throw: preview is read-only and runs before any commit exists.
					log('previewCommitDigest:unmaterializable-base blockId=%s baseRev=%d rev=%d error=%s',
						blockId, latest.rev, rev, err instanceof Error ? err.message : String(err));
					return { baseIndependent: false, baseRev, digest: undefined };
				}
			}
		}

		// Clone both: applyTransform assigns `transform.insert` into the result by reference and
		// applyOperations mutates the block in place, so materializing on live storage/pending objects
		// would corrupt them for the real commit that follows.
		const newBlock = applyTransform(structuredClone(base), structuredClone(transform));
		// `undefined` covers the tombstone (delete transform) and updates-with-no-base (applyTransform
		// drops updates when there is no block to apply them to) — both materialize nothing.
		const digest = newBlock ? await canonicalBlockHash(newBlock) : undefined;
		return { digest, baseRev, baseIndependent };
	}

	/**
	 * See {@link IRevisionActionReader}. Reads the block's revision index directly
	 * (`listRevisions(rev, rev)` — both bounds inclusive per the `IBlockStorage` contract); an empty
	 * range means this node holds no record for that revision.
	 */
	async getRevisionAction(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		const storage = this.createBlockStorage(blockId);
		for await (const actionRev of storage.listRevisions(rev, rev)) {
			return actionRev.actionId;
		}
		return undefined;
	}

	/**
	 * The {@link BlockCommitProof} this node retained for `blockId` at `rev`, or `undefined` when it
	 * kept none — a revision committed before proofs were persisted, a member whose materialization
	 * diverged from the declared digest (see {@link persistProofIfContentMatches}), or simply a
	 * revision this node never landed.
	 *
	 * Public because a peer answering a block-repair fetch serves the proof alongside the revision
	 * (`serveBlockArchive`), which is the only way a requester can check a lone holder's claim
	 * without a second holder to corroborate it. Read-only and unlatched: a proof is written once
	 * and never mutated, so a concurrent commit can only make this return a proof for a revision
	 * that just became stale — which the caller pairs with the revision it actually read.
	 */
	async getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined> {
		return await this.createBlockStorage(blockId).getBlockProof(rev);
	}

	private async internalCommit(blockId: BlockId, actionId: ActionId, rev: number, storage: IBlockStorage, latch: BlockWriteLatch, proof?: BlockCommitProof): Promise<CollectionId | undefined> {
		// Note: This method is called under the block write latch — by commit() (within its locked
		// critical section) and by the read-driven promotion in get() (which takes the same latch);
		// `latch` is the proof of that. So, operations like getPendingTransaction, getLatest,
		// getBlock, saveMaterializedBlock, saveRevision, promotePendingTransaction, setLatest are
		// protected against concurrent writers for the *same blockId*.
		//
		// `getBlock` here (via readCommitBase) is LOCAL-ONLY: the commit path never fetches from a
		// peer while holding N block latches. A coverage gap reads as a missing base, which the
		// healing path repairs by replication instead.

		const transform = await storage.getPendingTransaction(actionId);
		// No need to check if !transform here, as the caller (commit) already verified this.
		// If it's null here, it indicates a logic error or race condition bypassed the lock (unlikely).
		if (!transform) {
			throw new Error(`Consistency Error: Pending action ${actionId} disappeared for block ${blockId} within critical section.`);
		}

		// Get prior materialized block if it exists
		const latest = await storage.getLatest();
		const priorBlock = await this.readCommitBase(blockId, actionId, rev, storage, latest, latch);

		// Apply transform and save materialized block
		// applyTransform handles undefined priorBlock correctly for inserts
		const newBlock = applyTransform(priorBlock, transform);

		// INVARIANT: `latest` must never advance past a revision this node can materialize.
		// `applyTransform` silently drops `updates` when there is no block to apply them to, so a
		// member that missed the block's CREATING revision would otherwise record rev N while storing
		// nothing to serve it from. `latest === undefined` is precisely the "nothing below to fall
		// back to" case: materializeBlock's descending walk needs some materialization at or below the
		// target, and with no prior revision there is none. With a prior `latest` an absent newBlock is
		// a legitimate tombstone (the walk resolves to an earlier materialization), so it stays allowed.
		if (!newBlock && latest === undefined) {
			return await this.refuseMissingBase(blockId, actionId, rev, storage, latch,
				'no committed revision to apply the transform to');
		}

		if (newBlock) {
			await storage.saveMaterializedBlock(actionId, newBlock, latch);
		}

		// Save revision and promote action *before* updating latest
		// This ensures that if the process crashes between these steps,
		// the 'latest' pointer doesn't point to a revision that hasn't been fully recorded.
		await storage.saveRevision(rev, actionId, latch);
		await storage.promotePendingTransaction(actionId, latch);

		// Update latest revision *last*
		await storage.setLatest({ actionId, rev }, latch);

		// Persist the cohort's commit proof AFTER the commit is durably latest — the proof is
		// evidence about a landed revision, never a precondition of landing it. The retention rule
		// (persist only when the LOCAL materialization matches the digest the commit op declared)
		// and its failure logging live in the shared helper; a proof-persist fault must not fail a
		// commit that already landed, so the helper never throws.
		if (proof !== undefined) {
			await this.persistProofIfContentMatches(blockId, actionId, rev, storage, proof, newBlock, latch);
		}

		// Prune the now-superseded prior materialization (checkpoint retention). Runs LAST — after the
		// new rev's materialization + revision + transform + setLatest are all durable — so no crash
		// point can leave a rev unrecoverable: a crash BEFORE this leaves a redundant (harmless)
		// materialization the next commit's prune reclaims; a crash AFTER is fully consistent. The prune
		// only ever deletes a materialization reconstructible from the retained floor + transforms. Runs
		// under the block write latch already held here, so it serializes against concurrent commits.
		// NOTE: prune targets ONLY the immediate prior. A crash between setLatest and this call leaves that
		// one prior materialization un-pruned; since a later commit prunes ITS OWN prior (never the earlier
		// leaked rev), that copy is NOT auto-reclaimed — a bounded (≤1 block-copy per crash), harmless leak
		// (state stays consistent + reconstructible). If crash-before-prune leaks ever accumulate materially,
		// add a bounded look-back (prune non-retained mats in [rev-checkpointInterval, rev)) here, or a
		// periodic reconciliation sweep — do NOT reintroduce a per-read re-cache.
		if (latest !== undefined) {
			await storage.pruneSupersededMaterialization(latest, latch);
		}

		// Report the affected collection for change-event routing. For a delete the
		// materialized block is undefined, so fall back to the prior block's header.
		// Either may be absent only for a malformed/headerless block — return
		// undefined so the caller skips it rather than emitting a bogus event.
		return newBlock?.header.collectionId ?? priorBlock?.header.collectionId;
	}

	/**
	 * Retain `proof` for a block this call found ALREADY committed at `(rev, actionId)` — the paths
	 * that land (or find already landed) a revision without running {@link internalCommit}, and would
	 * otherwise never retain a proof: the idempotent re-commit partition, the Crash-D3 `recover()`
	 * partition, and {@link saveReplicatedBlock}'s monotonic no-op on a certified push. Strictly
	 * additive: an existing proof is left alone, and the same digest-match rule as the fresh-commit
	 * site decides retention.
	 *
	 * `rev`/`actionId` are passed separately rather than as a `CommitRequest` because the replica
	 * caller has no commit request — it has the `(rev, actionId)` the push and the held revision
	 * agree on.
	 *
	 * Callers must hold the block's write latch (`latch`). `getBlock` is local-only and can throw on
	 * an unmaterializable or uncovered base — treated as "no local content", i.e. the proof is withheld.
	 */
	private async backFillProof(
		blockId: BlockId, storage: IBlockStorage, rev: number, actionId: ActionId, proof: BlockCommitProof | undefined,
		latch: BlockWriteLatch
	): Promise<void> {
		if (proof === undefined || await storage.getBlockProof(rev) !== undefined) {
			return;
		}
		let committedBlock: IBlock | undefined;
		try {
			committedBlock = (await storage.getBlock(rev))?.block;
		} catch {
			committedBlock = undefined;
		}
		await this.persistProofIfContentMatches(blockId, actionId, rev, storage, proof, committedBlock, latch);
	}

	/**
	 * The single retention rule for {@link BlockCommitProof}s, shared by the fresh-commit site
	 * ({@link internalCommit}, after `setLatest`) and the already-landed back-fill
	 * ({@link backFillProof}):
	 *
	 * > **A member persists the proof only when its own materialization matches the digest the
	 * > commit operation declared for this block.**
	 *
	 * One rule covers every awkward case without a second flag: a DIVERGED member (committed onto a
	 * lagging base) computes a different hash, stores no proof, and falls back to corroboration
	 * exactly as today — the `commit:proof-digest-mismatch` log line is also the first signal this
	 * system has ever had that a member diverged. A member that abstained at vote time still checks
	 * here (by commit time it HAS materialized) and legitimately keeps the proof on agreement. A
	 * tombstone (no `block`) and a commit with no `blockDigests` (pre-upgrade client) declare no
	 * digest and store no proof (`commit:proof-undeclared`).
	 *
	 * Never throws: the commit this proof describes already durably landed, so a proof-persist
	 * fault must not turn `commit()` into `success:false` for a landed commit — it is logged and
	 * the proof simply is not retained (repair falls back to corroboration).
	 *
	 * NOTE: one commit of N blocks stores the SAME proof under each block's `(blockId, rev)` proofs-store key, and
	 * the proof itself carries the commit op's N `blockIds`/`blockDigests` — so bytes retained per
	 * commit grow with N². Measured base cost is ~4.6 KB for a 10-peer 2-block commit
	 * (`test/commit-proof.spec.ts` "size"), and nothing today bounds `CommitRequest.blockIds`. Fine
	 * at the handful-of-blocks batches the transactor produces now; if per-coordinator batches ever
	 * grow large, store the proof once under its `messageHash` and key each revision to a pointer.
	 */
	private async persistProofIfContentMatches(
		blockId: BlockId,
		actionId: ActionId,
		rev: number,
		storage: IBlockStorage,
		proof: BlockCommitProof,
		block: IBlock | undefined,
		latch: BlockWriteLatch
	): Promise<void> {
		try {
			const declaredDigest = proofDeclaredDigest(proof, { blockId, rev, actionId });
			if (declaredDigest === undefined) {
				log('commit:proof-undeclared blockId=%s rev=%d actionId=%s', blockId, rev, actionId);
				return;
			}
			// A digest was declared but this node materialized nothing (tombstone / unmaterializable
			// read on the back-fill path): the local content provably is not the declared content.
			const localDigest = block === undefined ? undefined : await canonicalBlockHash(block);
			if (localDigest !== declaredDigest) {
				log('commit:proof-digest-mismatch blockId=%s rev=%d actionId=%s declared=%s local=%s',
					blockId, rev, actionId, declaredDigest, localDigest);
				return;
			}
			await storage.saveBlockProof(rev, proof, latch);
		} catch (err) {
			log('commit:proof-persist-failed blockId=%s rev=%d actionId=%s error=%s', blockId, rev, actionId,
				err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * The materialization this commit builds on: the block at `latest`, or `undefined` when the block
	 * holds no committed revision yet (the normal insert case).
	 *
	 * `getBlock` THROWS when this node holds a `latest` it cannot materialize — a block already wedged
	 * by a pre-fix commit, or by truncated history. That is the same divergence as having no base at
	 * all, so it is translated into {@link MissingBaseRevisionError} rather than surfacing as an opaque
	 * storage fault: the healing path can then repair the block instead of the fault resetting the
	 * cluster stream, and a wedged node recovers on the next write touching the block.
	 *
	 * The catch is deliberately UNNARROWED — it also absorbs a transient fault (a raw-storage read
	 * error, a `restoreCallback` timeout on a block whose `ranges` do not cover its own `latest`).
	 * BlockStorage reports every one of these as a bare `Error`, so they cannot be told apart here,
	 * and treating them as divergence is the safe default: this node genuinely cannot materialize the
	 * base right now, and the cluster's policy is to heal rather than throw out of consensus. The
	 * price is that a transient fault ALSO drops pending records — this block's (see
	 * {@link refuseMissingBase}) AND, because {@link commit} keys its cleanup off the same error type,
	 * every not-yet-reached block in the same batch — so those blocks converge by replication instead
	 * of by a replay the retry could have done. That is a wider blast radius than the per-block
	 * refusal alone, and it is why the discriminator must NOT be loosened beyond this error type.
	 * Narrowing this would require typed faults out of BlockStorage; until then, prefer the tolerant
	 * reading.
	 */
	private async readCommitBase(
		blockId: BlockId,
		actionId: ActionId,
		rev: number,
		storage: IBlockStorage,
		latest: ActionRev | undefined,
		latch: BlockWriteLatch
	): Promise<IBlock | undefined> {
		if (!latest) {
			return undefined;
		}
		// NOTE: this read is deliberately LOCAL-ONLY and does not heal. `getBlock` no longer restores
		// from a peer (that moved to the explicit `restoreRevision`, which `StorageRepo.get` calls), so a
		// base this node cannot materialize locally raises {@link MissingBaseRevisionError} here instead
		// of being fetched in line. The reason is the calling context, not the cost of a fetch: `commit`
		// holds the write latch of EVERY block in the batch across this call, and network I/O inside that
		// critical section makes one unreachable peer stall every writer of every block in the batch for
		// the length of a round trip. Healing is out-of-band instead — cohort reconcile supplies the
		// revision (`ClusterMember` → `saveReplicatedBlock`) and the action is retried, by which point
		// this read succeeds locally. Pinned by `test/storage-repo.spec.ts` "commit reads its base
		// locally", which wires a restore callback that would have answered and asserts it is never
		// called. Do not reintroduce a restore on this path; if a commit ever genuinely needs one, fetch
		// BEFORE taking the latches, not underneath them.
		//
		// NOTE: `latest.rev` is always inside `meta.ranges` today — every writer of `latest`
		// (`setLatest`, `saveForwardRevision`, `recover`) merges an open-ended range anchored at or
		// below the new latest in the same `saveMetadata` — so the RevisionNotCoveredError arm below
		// is unreachable from here and only truncated-history corruption lands in the catch. If a
		// future change can leave `latest` uncovered, the ordering in `get` becomes load-bearing: the
		// read-driven promotion runs BEFORE `readBlockHealing`, so a coverage gap under `latest` would
		// make `refuseMissingBase` delete the pending record moments before the healing read would
		// have restored it. Heal before refusing if that day comes.
		try {
			return (await storage.getBlock(latest.rev))?.block;
		} catch (err) {
			log('commit:unmaterializable-base blockId=%s baseRev=%d error=%s', blockId, latest.rev,
				err instanceof Error ? err.message : String(err));
			return await this.refuseMissingBase(blockId, actionId, rev, storage, latch,
				`local rev ${latest.rev} is not materializable here`);
		}
	}

	/**
	 * Refuse a commit this node cannot materialize. Always throws {@link MissingBaseRevisionError};
	 * nothing durable has been written at this point, so the block is left exactly as it was minus the
	 * pending record.
	 *
	 * The pending is dropped because it can never be promoted here: promotion needs a base this node
	 * must obtain out-of-band, and once the healing path lands that revision `latest` is already >= rev,
	 * so a commit retry partitions the block as already-done/stale and never revisits the pending.
	 * Leaving it would also report a phantom conflicting action from {@link pend} for every later write.
	 */
	private async refuseMissingBase(
		blockId: BlockId,
		actionId: ActionId,
		rev: number,
		storage: IBlockStorage,
		latch: BlockWriteLatch,
		detail: string
	): Promise<never> {
		await storage.deletePendingTransaction(actionId, latch);
		log('commit:missing-base blockId=%s rev=%d actionId=%s detail=%s', blockId, rev, actionId, detail);
		throw new MissingBaseRevisionError(blockId, rev, detail);
	}
}

/**
 * Converts list of missing actions per block into a list of missing actions across blocks.
 *
 * NOTE: relies on each (actionId, blockId) pair appearing at most once — one revision per action
 * per block. If a block ever records two revisions under the same actionId, concatTransform now
 * concatenates both revisions' ops into one array rather than dropping the earlier one — still
 * wrong, since ops from distinct revisions are not composable against a single base, but loud
 * rather than silent. Group by (actionId, rev) instead if that case becomes reachable.
 */
function perBlockActionTransformsToPerAction(missing: { blockId: BlockId; transforms: ActionTransform[]; }[]) {
	const missingFlat = missing.flatMap(({ blockId, transforms }) =>
		transforms.map(transform => ({ blockId, transform }))
	);
	const missingByActionId = groupBy(missingFlat, ({ transform }) => transform.actionId);
	return Object.entries(missingByActionId).map(([actionId, items]) =>
		items.reduce((acc, { blockId, transform }) => {
			acc.transforms = concatTransform(acc.transforms, blockId, transform.transform);
			return acc;
		}, {
			actionId: actionId as ActionId,
			rev: items[0]!.transform.rev,	// Assumption: an action commits at one revision, so every block's entry for this actionId agrees. Distinct actionIds may still carry distinct revs.
			transforms: emptyTransforms()
		})
	);
}
