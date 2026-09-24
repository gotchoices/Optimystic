import type { ITransactor, GetBlockResults, ActionBlocks, ActionLineage, BlockLineage, BlockActionStatus, PendResult, CommitResult, PendRequest, BlockId, CommitRequest, BlockGets, IBlock, ActionId, ActionRev, ActionTransforms, StaleFailure, Transform, Transforms, ClusterNomineesResult, CollectionId } from "../index.js";
import { highestStaleAt, isOwnRevision } from "../network/stale-failure.js";
import { localDurability } from "../network/durability.js";
import { ensuredMap } from "../utility/ensured.js";
import { Latches } from "../utility/latches.js";
import { applyTransform, blockIdsForTransforms, transformForBlockId, emptyTransforms, concatTransform, transformsFromTransform } from "../transform/index.js";
import { Tree } from "../collections/tree/tree.js";
import type { TreeReplaceAction } from "../collections/tree/struct.js";
import type { Collection } from "../collection/collection.js";

type RevisionNumber = number;

type BlockState = {
  /** The current materialized block at each revision */
  materializedBlocks: Map<RevisionNumber, IBlock>;
  /** The latest revision number */
  latestRev: RevisionNumber;
  /** The action that created each revision */
  revisionActions: Map<RevisionNumber, ActionId>;
  /** Currently pending actions */
  pendingActions: Map<ActionId, Transform>;
	/** Committed actions */
	committedActions: Map<ActionId, Transform>;
}

// Simple in-memory transactor for testing that maintains materialized blocks for every revision
export class TestTransactor implements ITransactor {
  private blocks = new Map<BlockId, BlockState>();
	available = true;
	private getLocks = new Map<BlockId, Promise<() => void>>(); // Track lock releases

  constructor() {}

  async get(blockGets: BlockGets): Promise<GetBlockResults> {
		this.checkAvailable();
    const results: GetBlockResults = {};
		const uniqueBlockIds = [...new Set(blockGets.blockIds)].sort(); // Ensure consistent lock order if needed, though get is read-only
		const releases: (() => void)[] = [];

		try {
			// Acquire locks for all requested blocks to ensure consistent read
			for (const blockId of uniqueBlockIds) {
				const lockId = `TestTransactor.commit:${blockId}`; // Use the same lock as commit
				// Wait for any existing lock promise to resolve before acquiring the next
				let release = await this.getLocks.get(lockId);
				if (release) await Promise.resolve(release); // Ensure previous lock released if overlapping calls happen

				const releasePromise = Latches.acquire(lockId);
				this.getLocks.set(blockId, releasePromise.then(r => () => {
					r();
					this.getLocks.delete(blockId); // Clean up map entry after release
				}));
				release = await releasePromise;
				releases.push(release);
			}

			// --- Start of Critical Section (Read) ---
			for (const blockId of blockGets.blockIds) {
				const blockState = this.blocks.get(blockId);
				if (!blockState) {
					// Block doesn't exist yet
					results[blockId] = {
						block: undefined,
						state: { latest: undefined, pendings: [] }
					};
					continue;
				}

				// Get the appropriate materialized block based on context
				let block: IBlock | undefined;
				// The revision `block` was actually materialized at, reported (with its action id) as
				// GetBlockResult.materialized. Equals `latestRev` on every unpinned path; only a
				// revision-pinned read of a block committed further since the pin makes them differ,
				// and there the pinned value is what the reader observed (see the field's doc).
				let materializedRev: number | undefined;
				if (blockGets.context?.actionId !== undefined) {
					// If requesting a specific action, apply pending transform if it exists
					const pendingTransform = blockState.pendingActions.get(blockGets.context.actionId);
					if (pendingTransform) {
						// Read latest committed block as base for pending transform
						const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
						block = applyTransformSafe(baseBlock, pendingTransform);
						// A pending carries no revision of its own — report the committed base it was
						// applied over. Absent when there was no base (a pending-only insert).
						if (baseBlock) materializedRev = blockState.latestRev;
					} else {
						// Action not pending, maybe committed? Or maybe invalid actionId for context.
						// For simplicity, return undefined block if specific pending action not found.
						// A more complex impl might check committedActions history.
						block = undefined;
					}
				} else if (blockGets.context?.committed) {
					// Check context.committed for matching pending actions — mirrors coordinator
					// behavior: context.committed proves the action succeeded, so pending blocks
					// for that action should be served.
					for (const { actionId: cId } of blockGets.context.committed) {
						const pendingTransform = blockState.pendingActions.get(cId);
						if (pendingTransform) {
							const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
							block = applyTransformSafe(baseBlock, pendingTransform);
							if (baseBlock) materializedRev = blockState.latestRev;
							break;
						}
					}
					// Fall through to standard resolution if no pending match
					if (block === undefined) {
						if (blockGets.context.rev !== undefined) {
							const found = latestMaterializedAt(blockState, blockGets.context.rev);
							block = structuredClone(found?.block);
							materializedRev = found?.rev;
						} else {
							block = structuredClone(blockState.materializedBlocks.get(blockState.latestRev));
							if (block) materializedRev = blockState.latestRev;
						}
					}
				} else if (blockGets.context?.rev !== undefined) {
					// Return the materialized block at the highest revision ≤ requested
					const found = latestMaterializedAt(blockState, blockGets.context.rev);
					block = structuredClone(found?.block);
					materializedRev = found?.rev;
				} else {
					// Otherwise return latest materialized block
					block = structuredClone(blockState.materializedBlocks.get(blockState.latestRev));
					if (block) materializedRev = blockState.latestRev;
				}


				const actionId = blockState.revisionActions.get(blockState.latestRev);
				// The materialized revision travels WITH its action id (one field, so the pair can
				// never disagree) — the same `(rev, actionId)` the commit recorded for it.
				const materializedActionId = materializedRev !== undefined
					? blockState.revisionActions.get(materializedRev) : undefined;
				results[blockId] = {
					block,
					...(materializedRev !== undefined && materializedActionId !== undefined
						? { materialized: { rev: materializedRev, actionId: materializedActionId } } : {}),
					state: {
						latest: actionId !== undefined ? {
							rev: blockState.latestRev,
							actionId
						} : undefined,
						pendings: Array.from(blockState.pendingActions.keys())
					}
				};
			}
			// --- End of Critical Section (Read) ---

		} finally {
			// Release locks in reverse order
			releases.reverse().forEach(release => release());
		}
    return results;
  }

  async getStatus(actionRefs: ActionBlocks[]): Promise<BlockActionStatus[]> {
    return actionRefs.map(ref => ({
      ...ref,
      statuses: ref.blockIds.map(blockId => {
        const blockState = this.blocks.get(blockId);
        if (!blockState) return 'aborted';
        return blockState.pendingActions.has(ref.actionId) ? 'pending'
					: Array.from(blockState.revisionActions.values()).some(actionId => actionId === ref.actionId) ? 'committed'
					: 'aborted';
      })
    }));
  }

	/** One store, no replicas: every revision was applied here onto the one before it, so the
	 *  revision index answers for lineage outright — mirroring `BlockStorage.lineageOf`, including
	 *  the one way a later revision does NOT build on its predecessor (an insert replaces the block
	 *  wholesale). The "cohort" is this store alone, which is what the durability says. */
	async getLineage(ref: ActionBlocks & { rev: number }): Promise<ActionLineage> {
		this.checkAvailable();
		const blocks = ref.blockIds.map((blockId): BlockLineage => {
			const blockState = this.blocks.get(blockId);
			if (!blockState || blockState.latestRev < ref.rev) return 'behind';
			if (blockState.revisionActions.get(ref.rev) !== ref.actionId) return 'excludes';
			const replacedSince = Array.from(blockState.revisionActions.entries()).some(([rev, actionId]) =>
				rev > ref.rev && blockState.committedActions.get(actionId)?.insert !== undefined);
			return replacedSince ? 'unknown' : 'contains';
		});
		return {
			blocks,
			...(blocks.length > 0 && blocks.every(lineage => lineage === 'contains') ? { durability: localDurability() } : {})
		};
	}

  async pend(request: PendRequest): Promise<PendResult> {
		this.checkAvailable();
		const { actionId, transforms, policy, rev } = request;
		const blockIds = blockIdsForTransforms(transforms);
		const conflictingPendings: { blockId: BlockId, actionId: ActionId }[] = [];
		const missing: ActionTransforms[] = [];
		// Confirmed revisions this pend is up against, mirroring StorageRepo.pend: a block whose own
		// storage is already at or past the requested revision, held by someone other than this same
		// action. Reported as `staleAt` so a caller reading the shared harness sees the real shape.
		const staleCandidates: StaleFailure['staleAt'][] = [];
		// Blocks this SAME action already committed at exactly the requested revision — the durable
		// half of a torn action, met again by its own retry. Mirrors StorageRepo.pend's `satisfied`
		// set: such a block is neither a committed conflict nor a pending one, and no pending record
		// is written for it (commit's own-revision arm below never promotes one, so it would never
		// clear). It still rides in the returned `blockIds`, as in the real repo, so `cancel` covers it.
		const satisfied = new Set<BlockId>();

		// Check for conflicts (pending or committed based on rev/insert)
		for (const blockId of blockIds) {
			const blockState = this.blocks.get(blockId);
			const blockTransform = transformForBlockId(transforms, blockId);
			if (!blockTransform) continue; // Should not happen

			if (blockState && isOwnRevision(latestActionRev(blockState), rev, actionId)) {
				satisfied.add(blockId);
				continue;
			}

			if (blockState) {
				// Check for existing pending actions
				if (blockState.pendingActions.size > 0) {
					blockState.pendingActions.forEach((_, pendingActionId) => {
						conflictingPendings.push({ blockId, actionId: pendingActionId });
					});
				}

				// Check for conflicting committed revisions (if rev specified or it's an insert)
				if (rev !== undefined || blockTransform.insert) {
					const checkRev = rev ?? 0; // Check from revision 0 if it's an insert
					if (blockState.latestRev >= checkRev) {
						// Mirrors StorageRepo.pend exactly: only a real revision race yields a
						// meaningful `staleAt`. A rev-less pend reaches here as an insert collision
						// (`checkRev` degraded to 0), where the block's revision answers a question
						// nobody asked. (Our own durable half of a torn action never reaches here —
						// it was set aside as `satisfied` above.)
						if (rev !== undefined) {
							staleCandidates.push({ blockId, rev: blockState.latestRev });
						}
						// Collect conflicting committed actions
						const missingForBlock = new Map<ActionId, { rev: number, transform: Transform }>();
						for (let r = checkRev as number; r <= blockState.latestRev; r++) {
							const committedActionId = blockState.revisionActions.get(r);
							if (committedActionId !== undefined) {
								const committedTransform = blockState.committedActions.get(committedActionId);
								if (committedTransform) {
									missingForBlock.set(committedActionId, { rev: r, transform: committedTransform });
								}
							}
						}

						// Add collected missing transforms for this block to the main missing list
						for (const [mActionId, data] of missingForBlock.entries()) {
							let existing = missing.find(m => m.actionId === mActionId);
							if (!existing) {
								existing = { actionId: mActionId, rev: data.rev, transforms: emptyTransforms() };
								missing.push(existing);
							}
							existing.rev = Math.max(existing.rev ?? 0, data.rev);
							existing.transforms = concatTransform(existing.transforms, blockId, data.transform);
						}
					}
				}
			}
		}

		// Handle failure due to committed conflicts first.
		// `conflict: true` on the three optimistic-concurrency returns below mirrors what
		// StorageRepo.pend now emits, so consumers of this test transactor see the real shape.
		if (missing.length > 0) {
			const staleAt = highestStaleAt(staleCandidates);
			return {
				success: false,
				conflict: true,
				missing,
				...(staleAt ? { staleAt } : {})
			};
		}

		// Handle failure/retry due to pending conflicts
		if (conflictingPendings.length > 0) {
			if (policy === 'f') {
				return { success: false, conflict: true, pending: conflictingPendings };
			} else if (policy === 'r') {
				// Simulate fetching pending transforms for 'r' policy
				const pendingWithTransforms = conflictingPendings
					.map(({ blockId: pBlockId, actionId: pActionId }) => {
						const pBlockState = this.blocks.get(pBlockId);
						const pTransform = pBlockState?.pendingActions.get(pActionId)
							?? pBlockState?.committedActions.get(pActionId); // Might have been committed since check
						if (pTransform) {
							return { blockId: pBlockId, actionId: pActionId, transform: pTransform };
						}
						return null; // Handle case where it disappeared (cancelled?)
					})
					.filter(p => p !== null) as { blockId: BlockId, actionId: ActionId, transform: Transform }[];

				return {
					success: false,
					conflict: true,
					pending: pendingWithTransforms
				};
			}
			// Policy 'w' allows proceeding despite pending transactions
		}

		// No fatal conflicts found, proceed to pend
		for (const blockId of blockIds) {
			if (satisfied.has(blockId)) continue;
			const blockTransform = transformForBlockId(transforms, blockId);
			if (blockTransform) {
				const blockState = ensuredMap(this.blocks, blockId, () => newBlockState());
				blockState.pendingActions.set(actionId, blockTransform);
			}
		}

		// Return success, include pending list as per StorageRepo behavior. The in-memory double is one
		// node with no cohort, so its honest class is `local` — exactly what a bare StorageRepo answers.
		return {
			success: true,
			pending: conflictingPendings,
			blockIds,
			durability: localDurability()
		} as PendResult;
	}

  async cancel(actionRef: ActionBlocks): Promise<void> {
		this.checkAvailable();
    for (const blockId of actionRef.blockIds) {
      const blockState = this.blocks.get(blockId);
      if (blockState) {
        blockState.pendingActions.delete(actionRef.actionId);
      }
    }
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
		this.checkAvailable();
    const { actionId, rev, blockIds } = request;
    const uniqueBlockIds = [...new Set(blockIds)].sort();
    const releases: (() => void)[] = [];

    try {
      // Simulate acquiring locks sequentially like StorageRepo
      for (const id of uniqueBlockIds) {
        const lockId = `TestTransactor.commit:${id}`;
        const release = await Latches.acquire(lockId);
        releases.push(release);
      }

      // --- Start of Critical Section (Simulated) ---

      // Blocks this same action already committed at exactly this revision: an idempotent no-op,
      // mirroring StorageRepo.commit's `alreadyDone` partition. They are neither stale nor in need
      // of a pending record (pend wrote none for them — see `satisfied` there), which is what lets
      // a torn action's retry roll its remaining blocks forward.
      const alreadyDone = new Set(blockIds.filter(blockId => {
        const blockState = this.blocks.get(blockId);
        return blockState !== undefined && isOwnRevision(latestActionRev(blockState), rev, actionId);
      }));

      // Check for stale revisions
      const staleBlocks = blockIds.filter(blockId => {
        const blockState = this.blocks.get(blockId);
        return blockState && blockState.latestRev >= rev && !alreadyDone.has(blockId);
      });

      if (staleBlocks.length > 0) {
        // Collect missing actions for stale blocks
        const missingByAction = new Map<ActionId, Transforms>();
        for (const blockId of staleBlocks) {
          const blockState = this.blocks.get(blockId)!;
          for (let r = rev; r <= blockState.latestRev; r++) {
            const committedActionId = blockState.revisionActions.get(r);
            if (committedActionId) {
              const transform = blockState.committedActions.get(committedActionId);
              if (transform) {
                const existing = missingByAction.get(committedActionId) ?? emptyTransforms();
                missingByAction.set(committedActionId, concatTransform(existing, blockId, transform));
              }
            }
          }
        }

        const missing: ActionTransforms[] = Array.from(missingByAction.entries()).map(([actionId, transforms]) => ({
          actionId,
          rev: Array.from(this.blocks.values())
            .flatMap(bs => Array.from(bs.revisionActions.entries()))
            .find(([, aId]) => aId === actionId)?.[0] ?? rev,
          transforms
        }));
        // Same rule as StorageRepo.commit's missedCommits branch: report the highest confirmed
        // revision a stale block is already at. A block held by this very action never reaches
        // here — it was partitioned out as `alreadyDone` above.
        const staleAt = highestStaleAt(staleBlocks.map(blockId =>
          ({ blockId, rev: this.blocks.get(blockId)!.latestRev })));
        return { success: false, missing, ...(staleAt ? { staleAt } : {}) };
      }

      const toCommit = blockIds.filter(blockId => !alreadyDone.has(blockId));

      // Verify all blocks that still need committing have the pending action
      for (const blockId of toCommit) {
        const blockState = this.blocks.get(blockId);
        if (!blockState || !blockState.pendingActions.has(actionId)) {
          return {
            success: false,
            reason: `Action ${actionId} not found or not pending for block ${blockId}`
          };
        }
      }

      // Commit the action for each block
      for (const blockId of toCommit) {
        const blockState = this.blocks.get(blockId)!;
        const transform = blockState.pendingActions.get(actionId)!;

        // Get base block to apply transform to
        const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);

        let newBlock: IBlock | undefined;
        if (!baseBlock) {
          if (!transform.insert) {
            throw new Error(`Commit Error: Action ${actionId} has no insert for new block ${blockId}`);
          }
          newBlock = structuredClone(transform.insert);
        } else {
          newBlock = applyTransformSafe(baseBlock, transform);
          if (!newBlock && !transform.delete) {
            throw new Error(`Commit Error: Action ${actionId} resulted in undefined block but had no delete flag for block ${blockId}`);
          }
        }

        if (newBlock) {
          blockState.materializedBlocks.set(rev, newBlock);
        }

        // Update block state
        blockState.latestRev = rev;
        blockState.revisionActions.set(rev, actionId);
        blockState.committedActions.set(actionId, transform);
        blockState.pendingActions.delete(actionId);
      }

      // --- End of Critical Section (Simulated) ---

      return { success: true, durability: localDurability() };

    } finally {
      // Release locks in reverse order
      releases.reverse().forEach(release => release());
    }
  }

  // Helper methods for testing
  reset() {
    this.blocks.clear();
  }

  getPendingActions(): Map<ActionId, ActionTransforms> {
    const allPending = new Map<ActionId, ActionTransforms>();
    for (const [blockId, blockState] of this.blocks.entries()) {
      for (const [actionId, transform] of blockState.pendingActions) {
        const existing = allPending.get(actionId);
        if (!existing) {
          allPending.set(actionId, { actionId, transforms: transformsFromTransform(transform, blockId) });
        } else {
          existing.transforms = concatTransform(existing.transforms, blockId, transform);
        }
      }
    }
    return allPending;
  }

  getCommittedActions(): Map<ActionId, ActionTransforms> {
    const allCommitted = new Map<ActionId, ActionTransforms>();
    for (const [blockId, blockState] of this.blocks.entries()) {
      for (const [rev, actionId] of blockState.revisionActions) {
        const transform = blockState.committedActions.get(actionId);
        if (transform) {
          const existing = allCommitted.get(actionId);
          if (!existing) {
            allCommitted.set(actionId, {
              actionId,
              rev,
              transforms: transformsFromTransform(transform, blockId)
            });
          } else {
            existing.transforms = concatTransform(existing.transforms, blockId, transform);
          }
        }
      }
    }
    return allCommitted;
  }

	setAvailable(available: boolean) {
		this.available = available;
	}

	checkAvailable() {
		if (!this.available) {
			throw new Error('Transactor is not available');
		}
	}

	/** Optional method for querying cluster nominees (used in GATHER phase for multi-collection transactions) */
	queryClusterNominees?: (blockId: BlockId) => Promise<ClusterNomineesResult>;
}

/**
 * Base for the intercepting wrappers below: forwards every {@link ITransactor} member to `inner`,
 * so a wrapper overrides only the one call it intercepts and cannot silently drop the rest.
 *
 * `queryClusterNominees` is forwarded through a GETTER rather than a method, because the coordinator
 * treats its ABSENCE as "no supercluster" (see `gatherPhase`). A wrapper that always defined it
 * would push every wrapped multi-collection test onto the GATHER path even when the inner
 * transactor never opted in; a wrapper that omits it (as these did before) does the opposite —
 * a test that sets `inner.queryClusterNominees` and then wraps would skip GATHER and pass
 * vacuously. The getter reproduces the inner transactor's own answer either way.
 */
export abstract class DelegatingTransactor implements ITransactor {
	protected constructor(protected readonly inner: TestTransactor) {}

	get(b: BlockGets): Promise<GetBlockResults> { return this.inner.get(b); }
	getStatus(a: ActionBlocks[]): Promise<BlockActionStatus[]> { return this.inner.getStatus(a); }
	pend(r: PendRequest): Promise<PendResult> { return this.inner.pend(r); }
	cancel(a: ActionBlocks): Promise<void> { return this.inner.cancel(a); }
	commit(r: CommitRequest): Promise<CommitResult> { return this.inner.commit(r); }
	getLineage(ref: ActionBlocks & { rev: number }): Promise<ActionLineage> { return this.inner.getLineage(ref); }

	get queryClusterNominees(): ((blockId: BlockId) => Promise<ClusterNomineesResult>) | undefined {
		return this.inner.queryClusterNominees?.bind(this.inner);
	}
}

/**
 * Wraps a {@link TestTransactor} and forces its commit phase to fail a bounded (or unbounded)
 * number of times before delegating, so tests can exercise the sync retry / backoff / give-up
 * path deterministically. Everything else delegates unchanged, so the pend→commit→cancel
 * round-trip runs exactly as in production.
 */
export class FlakyCommitTransactor extends DelegatingTransactor {
	/** Number of commit() calls observed so far (across success and forced failure). */
	commitAttempts = 0;

	/**
	 * @param inner delegate transactor
	 * @param failFirstN number of initial commit() calls to fail; Infinity to always fail
	 * @param reason the StaleFailure.reason returned on a forced failure
	 */
	constructor(
		inner: TestTransactor,
		private readonly failFirstN: number,
		private readonly reason = 'forced stale',
	) {
		super(inner);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		this.commitAttempts++;
		if (this.commitAttempts <= this.failFirstN) {
			return { success: false, reason: this.reason };
		}
		return this.inner.commit(request);
	}
}

/**
 * Commits the WHOLE action durably on the inner {@link TestTransactor}, then reports a stale
 * failure anyway — a write that fully landed but whose writer was told it failed.
 *
 * This is NOT the shape `NetworkTransactor.commit` produces when it refuses a write whose log tail
 * landed: there the tail is committed BEFORE the sweep of the remaining blocks, so the blocks after
 * the tail did NOT land. That shape is {@link TailLandsButReportsStale}, and it is the one that
 * matters in production. This double makes "my own log entry is visible" and "my action is fully
 * durable" the same thing, so on its own it cannot tell a writer that finishes its half-landed
 * action from one that merely assumes it is finished. Keep it for the case it does model — every
 * block already holds the action's revision, so the writer's completion pass has nothing left to
 * land and must not duplicate or move the entry.
 *
 * Safe against the inner transactor's bookkeeping because `TransactorSource.transact` cancels
 * the pend on the reported failure and {@link TestTransactor.cancel} only deletes PENDING records
 * — the real commit already promoted them, so the cancel is a no-op.
 *
 * `afterLanding`, when given, runs a competing writer ONCE, after the first masked commit has
 * landed and before its failure is reported: the rival reads the landed write and commits the next
 * revision ON TOP of it, so by the time the writer looks again every block it wrote has moved past
 * its revision while still containing it. Safe to await from inside `commit` here (unlike
 * {@link TailLandsButReportsStale}'s rival, which has to wait for the cancel): the whole action
 * landed, so it left no pending record for the rival's pend to collide with.
 *
 * Used by both write paths' own-entry regression suites (collection-own-action-replay.spec.ts and
 * coordinator-own-action-replay.spec.ts); it lives here so the two cannot drift apart.
 */
export class CommitLandsButReportsStale extends DelegatingTransactor {
	/** Remaining number of successful commits to mask as stale failures. */
	private injections: number;
	/** Commits that actually landed on the inner transactor (masked or not). */
	landedCommits = 0;
	private rivalDue: boolean;

	constructor(inner: TestTransactor, injections = 1, private readonly afterLanding?: RivalWrite) {
		super(inner);
		this.injections = injections;
		this.rivalDue = afterLanding !== undefined;
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		const result = await this.inner.commit(request);
		if (result.success) {
			this.landedCommits++;
			if (this.injections-- > 0) {
				if (this.rivalDue) {
					this.rivalDue = false;
					await this.afterLanding!(this.inner);
				}
				return { success: false, conflict: true, reason: 'stale commit: injected torn-action conflict' };
			}
		}
		return result;
	}
}

/**
 * Lands ONLY the action's log tail on the inner {@link TestTransactor}, then reports a retryable
 * failure — the shape `NetworkTransactor.commit` actually produces for a half-landed write. It
 * commits the tail first and sweeps the remaining blocks only if the tail answered success, and a
 * failed tail answer does not mean the tail is absent: the coordinator's durability gate answers
 * `commit-not-durable` whenever fewer than a majority of the cohort hold the revision, even though
 * some members stored it. So the writer is told "failed" over a log entry that is durable, while
 * none of the entry's other blocks were ever committed — and the writer's own cancel then drops
 * their pending records.
 *
 * A commit carrying nothing but the tail is delegated untouched (there is nothing to abandon), and
 * does not consume an injection.
 *
 * `afterCancel`, when given, runs a competing writer ONCE, right after the writer's cancel of the
 * torn attempt has been delegated. It is on `cancel` and not inside `commit` for the reason
 * {@link CompetingWriterTransactor} documents: until that cancel lands, the torn action's data
 * blocks still carry its pending records, a rival pending with policy `'r'` collides with them, and
 * awaiting that rival from inside the writer's own commit is a livelock.
 */
export class TailLandsButReportsStale extends DelegatingTransactor {
	/** Remaining number of commits to tear. */
	private injections: number;
	/** Commits torn so far: the tail landed, every other block of the action was abandoned. */
	tears = 0;
	/** Commits delegated whole that succeeded on the inner transactor. */
	landedCommits = 0;
	private rivalDue = false;

	constructor(inner: TestTransactor, injections = 1, private readonly afterCancel?: RivalWrite) {
		super(inner);
		this.injections = injections;
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (this.injections > 0 && request.blockIds.some(blockId => blockId !== request.tailId)) {
			const tail = await this.inner.commit({ ...request, blockIds: [request.tailId] });
			// A tail that itself lost is an ordinary loss — nothing is torn, so report it verbatim
			// and keep the injection for a commit that can actually tear.
			if (!tail.success) return tail;
			this.injections--;
			this.tears++;
			this.rivalDue = this.afterCancel !== undefined;
			return { success: false, conflict: true, reason: 'commit-not-durable: injected tail-only landing' };
		}
		const result = await this.inner.commit(request);
		if (result.success) this.landedCommits++;
		return result;
	}

	override async cancel(actionRef: ActionBlocks): Promise<void> {
		await this.inner.cancel(actionRef);
		if (this.rivalDue) {
			this.rivalDue = false;
			await this.afterCancel!(this.inner);
		}
	}
}

/** What one attempt of a write put on the wire: the pend's transforms, with the action id and
 *  revision it was pended under. Recorded by {@link RecordsAttemptsRefusesFirstCommit}. */
export type RecordedAttempt = {
	actionId: ActionId;
	rev?: number;
	transforms: Transforms;
};

/**
 * Records what every attempt of a write pends, and refuses the FIRST commit outright — nothing is
 * delegated, so nothing lands and the retry's refresh cannot find the write's own log entry.
 *
 * That is the case `Collection.completeOwnEntry` does NOT reach: the refused commit left the log
 * block (and, for a brand-new collection, the header) uncommitted, so the refresh has no entry to
 * finish from and the retry REBUILDS its log append from scratch. Storage identifies a saved block
 * revision by `(action id, revision)` and deliberately accepts a retry of the same action at the
 * same revision, so any per-attempt value in that rebuild becomes two contents under one
 * `(action, revision)` across the machines that landed different attempts.
 *
 * `attempts` is therefore asserted on WHOLE — not field by field — so the rule it pins ("a retry at
 * the same revision sends byte-identical transforms") fails for any future per-attempt value, not
 * only the ones known today. Transforms are cloned on the way in, since the caller keeps mutating
 * the live tracker afterwards.
 *
 * Lives here beside {@link CommitLandsButReportsStale} for the reason that one gives: the
 * collection-path and coordinator-path specs must not drift apart on the double they share.
 */
export class RecordsAttemptsRefusesFirstCommit extends DelegatingTransactor {
	readonly attempts: RecordedAttempt[] = [];
	private refusals: number;

	constructor(inner: TestTransactor, refusals = 1) {
		super(inner);
		this.refusals = refusals;
	}

	/** Arm (or re-arm) the refusal counter, so a test can let its setup writes land cleanly and
	 *  then refuse only the write under test. Replaces whatever is left of the current count. */
	refuseNextCommits(count: number): void {
		this.refusals = count;
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		this.attempts.push({
			actionId: request.actionId,
			rev: request.rev,
			transforms: structuredClone(request.transforms),
		});
		return this.inner.pend(request);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (this.refusals > 0) {
			this.refusals--;
			// Never delegated: nothing of this attempt is durable, so `TransactorSource.transact`
			// cancels the pend and the writer re-drives at the same action id and revision.
			return { success: false, conflict: true, reason: 'stale commit: injected refusal, nothing landed' };
		}
		return this.inner.commit(request);
	}
}

/** A competing writer: a real write driven against the UNWRAPPED transactor, so its own
 *  pend/commit calls are invisible to {@link CompetingWriterTransactor}'s counters and cannot
 *  re-trigger the interception. See {@link commitRivalTreeWrite} for the usual implementation. */
export type RivalWrite = (inner: ITransactor) => Promise<void>;

export type CompetingWriterOptions = {
	/** Fires on the first pend whose request satisfies this predicate. `callIndex` is 1-based over
	 *  ALL pend calls seen (not only matching ones). Default: fire on the first pend call. */
	when?: (request: PendRequest, callIndex: number) => boolean;
};

/**
 * Wraps a {@link TestTransactor} and, exactly once, runs a real competing writer to completion
 * BEFORE delegating the intercepted pend. The rival durably commits (real log entry, real
 * revision bump), so the delegated pend then fails as a GENUINE optimistic-concurrency loss —
 * nothing is forced or faked, unlike {@link FlakyCommitTransactor}, which returns a stale failure
 * without ever advancing a block's revision.
 *
 * That distinction is the whole point: only a rival that actually landed can prove the loser
 * OBSERVED a newer revision, re-applied its work on top of it, and did not lose an update.
 *
 * Two deliberate design constraints:
 *
 * 1. **The trigger is on PEND, and there is no commit trigger.** The rival is a real
 *    Collection/Tree, so its write pends with policy `'r'` (see `TransactorSource.transact`), and
 *    {@link TestTransactor.pend} rejects a pend whose blocks already carry a *pending* action.
 *    Firing before the loser's pend delegates means the loser has pended nothing yet, so the
 *    rival pends and commits cleanly and the loser's delegated pend then fails with `missing` — a
 *    real conflict. Firing at COMMIT time instead would leave the loser already pending on the
 *    shared log-tail block, so the rival's own pend would collide with it and spin through its
 *    sync retry budget (~10 attempts, ~21s) while the loser sits awaiting the rival inside its
 *    own commit: a livelock dressed up as a slow test. Do not add a commit trigger.
 *
 * 2. **The rival runs before delegation, never inside {@link TestTransactor}'s critical section.**
 *    `TestTransactor.get`/`commit` hold per-block latches (`TestTransactor.commit:${blockId}`), and
 *    those latch keys are process-global — a rival invoked from inside one of them would
 *    self-deadlock on its own reads. Intercepting here in the wrapper, before
 *    `await this.inner.pend(...)`, is outside every such section.
 */
export class CompetingWriterTransactor extends DelegatingTransactor {
	/** Pend calls observed (including the intercepted one). */
	pendCalls = 0;
	/** Commit calls observed. */
	commitCalls = 0;
	/** The 1-based pend call index the rival fired on; undefined if it never fired. */
	firedAtCall?: number;
	/** How many times the rival ran. Latched to at most 1 — a second firing would collide with the
	 *  loser's now-pending blocks and the transaction under test could never win. */
	rivalRuns = 0;

	constructor(
		inner: TestTransactor,
		private readonly rival: RivalWrite,
		private readonly options?: CompetingWriterOptions,
	) {
		super(inner);
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		// Increment synchronously, before any await, so call indexes reflect the caller's fan-out
		// order rather than scheduling order.
		const callIndex = ++this.pendCalls;
		const matches = this.options?.when
			? this.options.when(request, callIndex)
			: callIndex === 1;
		if (this.rivalRuns === 0 && matches) {
			this.rivalRuns++;
			this.firedAtCall = callIndex;
			// A throwing rival escapes as a rejected pend, which pendPhase flattens to a bare message
			// string ("hard failure") with the stack discarded — so name the source in the message, or
			// a broken rival reads as an unexplained coordinator pend failure.
			try {
				await this.rival(this.inner);
			} catch (e) {
				throw new Error(`competing writer failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
			}
		}
		return this.inner.pend(request);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		this.commitCalls++;
		return this.inner.commit(request);
	}
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}

/**
 * Parks the commit AFTER the inner transactor has made it durable and BEFORE the result gets back
 * to the coordinator — precisely the window in which storage already holds the new revision but
 * the caller's local fold (`Collection.recordCommitted`) has not run.
 *
 * Everything else delegates, so the pend/commit round trip is otherwise the real one.
 *
 * Parks only the FIRST commit call and delegates every later one: a multi-collection commit issues
 * one `commit` per participant, and parking all of them would mean the span never completes.
 */
export class GatedCommitTransactor extends DelegatingTransactor {
	/** The `rev` carried on each pend request seen, in call order. */
	readonly pendRevs: (number | undefined)[] = [];
	/** The `rev` carried on each commit request seen, in call order. */
	readonly commitRevs: number[] = [];
	/** Resolves once a commit has landed durably in the inner transactor and is parked. */
	readonly commitParked: Promise<void>;
	private readonly parked = deferred();
	private readonly gate = deferred();
	private parkedOnce = false;

	constructor(inner: TestTransactor) {
		super(inner);
		this.commitParked = this.parked.promise;
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		this.pendRevs.push(request.rev);
		return this.inner.pend(request);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		this.commitRevs.push(request.rev);
		const result = await this.inner.commit(request);	// durable FIRST
		if (!this.parkedOnce) {
			this.parkedOnce = true;
			this.parked.resolve();
			await this.gate.promise;
		}
		return result;
	}

	openGate(): void { this.gate.resolve(); }
}

/**
 * Parks the FIRST pend BEFORE it reaches the inner transactor, so a rival can durably take the
 * revision while the coordinator is already committed to a set of transforms it captured at the
 * log append.
 *
 * Snapshots the pair `(what was handed to the network, what the collection's tracker held)` at
 * DELEGATION time — after the gate — for every pend, so a refresh that swapped the tracker's
 * transforms object out from under the coordinator shows up as a divergent pair.
 */
export class GatedPendTransactor<TAction> extends DelegatingTransactor {
	/** One entry per delegated pend, in call order. */
	readonly snapshots: { pended: Transforms; staged: Transforms }[] = [];
	/** Resolves once a pend is parked and has NOT yet reached the inner transactor. */
	readonly pendParked: Promise<void>;
	/** The collection under test. Assigned after construction — the collection is built over this
	 *  wrapper, so it cannot be a constructor argument. */
	collection?: Collection<TAction>;
	private readonly parked = deferred();
	private readonly gate = deferred();
	private parkedOnce = false;

	constructor(inner: TestTransactor) {
		super(inner);
		this.pendParked = this.parked.promise;
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		if (!this.parkedOnce) {
			this.parkedOnce = true;
			this.parked.resolve();
			await this.gate.promise;
		}
		this.snapshots.push({
			pended: structuredClone(request.transforms),
			staged: structuredClone(this.collection!.tracker.transforms),
		});
		return this.inner.pend(request);
	}

	openGate(): void { this.gate.resolve(); }
}

/**
 * Durably commit a conflicting change to a tree collection: opens a SECOND {@link Tree} over the
 * same transactor + collection id and replaces `entries` through it, producing a real log entry
 * and a real revision bump — the durable competitor a {@link CompetingWriterTransactor} needs.
 *
 * `Tree.replace` is act + `updateAndSync`, i.e. a full commit through the single-collection sync
 * path, so the rival's write is indistinguishable from any other client's.
 *
 * Pass the UNWRAPPED transactor (that is what {@link RivalWrite} receives).
 *
 * NOTE: opens the rival tree at the DEFAULT node capacity (64), because fan-out is not persisted
 * in the collection header (see Tree.createOrOpen's `nodeCapacity` note). Fine while every rival
 * race is between default-fan-out trees; if a test ever needs to race a small-capacity tree, add a
 * capacity parameter here and pass the same value both sides, or the two writers will split nodes
 * at different fan-outs.
 */
export async function commitRivalTreeWrite<TKey, TEntry>(
	inner: ITransactor,
	collectionId: CollectionId,
	keyFromEntry: (entry: TEntry) => TKey,
	entries: TreeReplaceAction<TKey, TEntry>,
): Promise<void> {
	const tree = await Tree.createOrOpen<TKey, TEntry>(inner, collectionId, keyFromEntry);
	await tree.replace(entries);
}

function newBlockState(): BlockState {
	return {
		materializedBlocks: new Map(),
		latestRev: 0,
		revisionActions: new Map(),
		pendingActions: new Map(),
		committedActions: new Map()
	};
}

/** This block's latest committed revision in the shape {@link isOwnRevision} compares — the
 *  harness equivalent of `IBlockStorage.getLatest()`. `undefined` when nothing is recorded at that
 *  revision, which is how a never-written block reads (`latestRev` starts at 0 with no entry). */
function latestActionRev(blockState: BlockState): ActionRev | undefined {
	const actionId = blockState.revisionActions.get(blockState.latestRev);
	return actionId === undefined ? undefined : { actionId, rev: blockState.latestRev };
}

/** Returns the materialized block at the highest revision ≤ the given revision, together with
 *  that revision — the caller reports it as {@link GetBlockResult.materialized}. */
function latestMaterializedAt(blockState: BlockState, maxRev: number): { block: IBlock, rev: number } | undefined {
	for (let rev = maxRev; rev >= 0; rev--) {
		const block = blockState.materializedBlocks.get(rev);
		if (block) return { block, rev };
	}
	return undefined;
}

/**
 * `applyTransform` over cloned inputs, so a returned block never aliases stored state.
 *
 * The `insert` clone here is not redundant with `transformForBlockId`'s: callers pass `Transform`
 * values pulled straight out of `blockState.pendingActions` (a `Map<ActionId, Transform>` written
 * once by `pend()`), which can be `get()`'d more than once and read again at commit time before
 * being superseded. `applyTransform` mutates `transform.insert` in place when `updates` ride
 * along, so cloning immediately before each call is what keeps that stored entry pristine across
 * repeated reads.
 *
 * An absent base is NOT a short circuit: an insert needs no base — `applyTransform` adopts it as
 * the block. Bailing out on `!block` made this double silently drop a pending-only insert read
 * through the pending overlay, the one shape `StorageRepo.get` serves with content but no
 * `materialized` (see docs/internals.md § the `unavailable`/`materialized` bullets). A
 * pending UPDATE over an absent base still resolves to undefined, matching the real repo.
 */
function applyTransformSafe(block: IBlock | undefined, transform: Transform): IBlock | undefined {
  return applyTransform(
    block ? structuredClone(block) : undefined,
    transform.insert ? { ...transform, insert: structuredClone(transform.insert) } : transform
  );
}
