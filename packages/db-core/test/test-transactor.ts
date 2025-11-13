import { type ITransactor, type GetBlockResults, type ActionBlocks, type BlockActionStatus, type PendResult, type CommitResult, type PendRequest, type BlockId, type CommitRequest, type BlockGets, type IBlock, type ActionId, type ActionTransforms, type Transform, type Transforms, ensuredMap, Latches } from "../src/index.js";
import { applyTransform, blockIdsForTransforms, transformForBlockId, emptyTransforms, concatTransform, transformsFromTransform } from "../src/transform/index.js";

type RevisionNumber = number;

type BlockState = {
  /** The current materialized block at each revision */
  materializedBlocks: Map<RevisionNumber, IBlock>;
  /** The latest revision number */
  latestRev: RevisionNumber;
  /** The transaction that created each revision */
  revisionTrxs: Map<RevisionNumber, ActionId>;
  /** Currently pending transactions */
  pendingTrxs: Map<ActionId, Transform>;
	/** Committed transactions */
	committedTrxs: Map<ActionId, Transform>;
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
				if (blockGets.context?.actionId !== undefined) {
					// If requesting a specific transaction, apply pending transform if it exists
					const pendingTransform = blockState.pendingTrxs.get(blockGets.context.actionId);
					if (pendingTransform) {
						// Read latest committed block as base for pending transform
						const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
						block = applyTransformSafe(baseBlock, pendingTransform);
					} else {
						// Trx not pending, maybe committed? Or maybe invalid actionId for context.
						// For simplicity, return undefined block if specific pending trx not found.
						// A more complex impl might check committedTrxs history.
						block = undefined;
					}
				} else if (blockGets.context?.rev !== undefined) {
					// If requesting a specific revision, get the materialized block at that revision
					block = structuredClone(blockState.materializedBlocks.get(blockGets.context.rev));
				} else {
					// Otherwise return latest materialized block
					block = structuredClone(blockState.materializedBlocks.get(blockState.latestRev));
				}


				const actionId = blockState.revisionTrxs.get(blockState.latestRev);
				results[blockId] = {
					block,
					state: {
						latest: actionId !== undefined ? {
							rev: blockState.latestRev,
							actionId
						} : undefined,
						pendings: Array.from(blockState.pendingTrxs.keys())
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

  async getStatus(trxRefs: ActionBlocks[]): Promise<BlockActionStatus[]> {
    return trxRefs.map(ref => ({
      ...ref,
      statuses: ref.blockIds.map(blockId => {
        const blockState = this.blocks.get(blockId);
        if (!blockState) return 'aborted';
        return blockState.pendingTrxs.has(ref.actionId) ? 'pending'
					: Array.from(blockState.revisionTrxs.values()).some(actionId => actionId === ref.actionId) ? 'committed'
					: 'aborted';
      })
    }));
  }

  async pend(request: PendRequest): Promise<PendResult> {
		this.checkAvailable();
		const { actionId, transforms, policy, rev } = request;
		const blockIds = blockIdsForTransforms(transforms);
		const conflictingPendings: { blockId: BlockId, actionId: ActionId }[] = [];
		const missing: ActionTransforms[] = [];

		// Check for conflicts (pending or committed based on rev/insert)
		for (const blockId of blockIds) {
			const blockState = this.blocks.get(blockId);
			const blockTransform = transformForBlockId(transforms, blockId);
			if (!blockTransform) continue; // Should not happen

			if (blockState) {
				// Check for existing pending transactions
				if (blockState.pendingTrxs.size > 0) {
					blockState.pendingTrxs.forEach((_, pendingTrxId) => {
						conflictingPendings.push({ blockId, actionId: pendingTrxId });
					});
				}

				// Check for conflicting committed revisions (if rev specified or it's an insert)
				if (rev !== undefined || blockTransform.insert) {
					const checkRev = rev ?? 0; // Check from revision 0 if it's an insert
					if (blockState.latestRev >= checkRev) {
						// Collect conflicting committed transactions
						const missingForBlock = new Map<ActionId, { rev: number, transform: Transform }>();
						for (let r = checkRev as number; r <= blockState.latestRev; r++) {
							const committedTrxId = blockState.revisionTrxs.get(r);
							if (committedTrxId !== undefined) {
								const committedTransform = blockState.committedTrxs.get(committedTrxId);
								if (committedTransform) {
									missingForBlock.set(committedTrxId, { rev: r, transform: committedTransform });
								}
							}
						}

						// Add collected missing transforms for this block to the main missing list
						for (const [mTrxId, data] of missingForBlock.entries()) {
							let existing = missing.find(m => m.actionId === mTrxId);
							if (!existing) {
								existing = { actionId: mTrxId, rev: data.rev, transforms: emptyTransforms() };
								missing.push(existing);
							}
							existing.rev = Math.max(existing.rev ?? 0, data.rev);
							existing.transforms = concatTransform(existing.transforms, blockId, data.transform);
						}
					}
				}
			}
		}

		// Handle failure due to committed conflicts first
		if (missing.length > 0) {
			return {
				success: false,
				missing
			};
		}

		// Handle failure/retry due to pending conflicts
		if (conflictingPendings.length > 0) {
			if (policy === 'f') {
				return { success: false, pending: conflictingPendings };
			} else if (policy === 'r') {
				// Simulate fetching pending transforms for 'r' policy
				const pendingWithTransforms = conflictingPendings
					.map(({ blockId: pBlockId, actionId: pTrxId }) => {
						const pBlockState = this.blocks.get(pBlockId);
						const pTransform = pBlockState?.pendingTrxs.get(pTrxId)
							?? pBlockState?.committedTrxs.get(pTrxId); // Might have been committed since check
						if (pTransform) {
							return { blockId: pBlockId, actionId: pTrxId, transform: pTransform };
						}
						return null; // Handle case where it disappeared (cancelled?)
					})
					.filter(p => p !== null) as { blockId: BlockId, actionId: ActionId, transform: Transform }[];

				return {
					success: false,
					pending: pendingWithTransforms
				};
			}
			// Policy 'w' allows proceeding despite pending transactions
		}

		// No fatal conflicts found, proceed to pend
		for (const blockId of blockIds) {
			const blockTransform = transformForBlockId(transforms, blockId);
			if (blockTransform) {
				const blockState = ensuredMap(this.blocks, blockId, () => newBlockState());
				blockState.pendingTrxs.set(actionId, blockTransform);
			}
		}

		// Return success, include pending list as per StorageRepo behavior
		return {
			success: true,
			pending: conflictingPendings,
			blockIds
		} as PendResult;
	}

  async cancel(trxRef: ActionBlocks): Promise<void> {
		this.checkAvailable();
    for (const blockId of trxRef.blockIds) {
      const blockState = this.blocks.get(blockId);
      if (blockState) {
        blockState.pendingTrxs.delete(trxRef.actionId);
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

      // Check for stale revisions
      const staleBlocks = blockIds.filter(blockId => {
        const blockState = this.blocks.get(blockId);
        return blockState && blockState.latestRev >= rev;
      });

      if (staleBlocks.length > 0) {
        // Collect missing transactions for stale blocks
        const missingByTrx = new Map<ActionId, Transforms>();
        for (const blockId of staleBlocks) {
          const blockState = this.blocks.get(blockId)!;
          for (let r = rev; r <= blockState.latestRev; r++) {
            const committedTrxId = blockState.revisionTrxs.get(r);
            if (committedTrxId) {
              const transform = blockState.committedTrxs.get(committedTrxId);
              if (transform) {
                const existing = missingByTrx.get(committedTrxId) ?? emptyTransforms();
                missingByTrx.set(committedTrxId, concatTransform(existing, blockId, transform));
              }
            }
          }
        }

        const missing: ActionTransforms[] = Array.from(missingByTrx.entries()).map(([actionId, transforms]) => ({
          actionId,
          rev: Array.from(this.blocks.values())
            .flatMap(bs => Array.from(bs.revisionTrxs.entries()))
            .find(([, tId]) => tId === actionId)?.[0] ?? rev,
          transforms
        }));
        return { success: false, missing };
      }

      // Verify all blocks have the pending transaction
      for (const blockId of blockIds) {
        const blockState = this.blocks.get(blockId);
        if (!blockState || !blockState.pendingTrxs.has(actionId)) {
          return {
            success: false,
            reason: `Transaction ${actionId} not found or not pending for block ${blockId}`
          };
        }
      }

      // Commit the transaction for each block
      for (const blockId of blockIds) {
        const blockState = this.blocks.get(blockId)!;
        const transform = blockState.pendingTrxs.get(actionId)!;

        // Get base block to apply transform to
        const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);

        let newBlock: IBlock | undefined;
        if (!baseBlock) {
          if (!transform.insert) {
            throw new Error(`Commit Error: Transaction ${actionId} has no insert for new block ${blockId}`);
          }
          newBlock = structuredClone(transform.insert);
        } else {
          newBlock = applyTransformSafe(baseBlock, transform);
          if (!newBlock && !transform.delete) {
            throw new Error(`Commit Error: Transaction ${actionId} resulted in undefined block but had no delete flag for block ${blockId}`);
          }
        }

        if (newBlock) {
          blockState.materializedBlocks.set(rev, newBlock);
        }

        // Update block state
        blockState.latestRev = rev;
        blockState.revisionTrxs.set(rev, actionId);
        blockState.committedTrxs.set(actionId, transform);
        blockState.pendingTrxs.delete(actionId);
      }

      // --- End of Critical Section (Simulated) ---

      return { success: true };

    } finally {
      // Release locks in reverse order
      releases.reverse().forEach(release => release());
    }
  }

  // Helper methods for testing
  reset() {
    this.blocks.clear();
  }

  getPendingTransactions(): Map<ActionId, ActionTransforms> {
    const allPending = new Map<ActionId, ActionTransforms>();
    for (const [blockId, blockState] of this.blocks.entries()) {
      for (const [actionId, transform] of blockState.pendingTrxs) {
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

  getCommittedTransactions(): Map<ActionId, ActionTransforms> {
    const allCommitted = new Map<ActionId, ActionTransforms>();
    for (const [blockId, blockState] of this.blocks.entries()) {
      for (const [rev, actionId] of blockState.revisionTrxs) {
        const transform = blockState.committedTrxs.get(actionId);
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
}

function newBlockState(): BlockState {
	return {
		materializedBlocks: new Map(),
		latestRev: 0,
		revisionTrxs: new Map(),
		pendingTrxs: new Map(),
		committedTrxs: new Map()
	};
}

function applyTransformSafe(block: IBlock | undefined, transform: Transform): IBlock | undefined {
  if (!block) return undefined;
  return applyTransform(structuredClone(block), transform);
}
