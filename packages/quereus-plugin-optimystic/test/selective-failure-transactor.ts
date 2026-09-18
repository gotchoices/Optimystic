/**
 * Test helper: a transactor over a real `StorageRepo` (any raw storage) that can be told to
 * fail the PEND or the COMMIT of the collections a predicate names — PERSISTENTLY while armed.
 *
 * Persistence is the point. A legacy commit with several trees to push goes through a
 * `TransactionCoordinator`, whose commit phase retries a THROWN per-collection commit up to
 * three times (forward recovery for an unreachable cohort). A one-shot injected failure is
 * therefore recovered on the second try and never becomes the outcome under test; a failure
 * that holds for the whole armed window does.
 *
 * A commit request names blocks, not a collection. The map from a block to the collection that
 * owns it is learned from every block header this transactor sees — in `get` results and in the
 * inserts a pend carries — so a spec can target "the index tree" by collection id without
 * knowing any block id. Every block a collection pends or commits was either read through here
 * or inserted through here first, so a tail id always resolves.
 *
 * Used by `legacy-commit-atomicity.spec.ts` (both phases, the reopen assertions) and
 * `committed-read-isolation.spec.ts` (the degraded latch after a commit-phase split).
 */
import type {
	ITransactor,
	BlockGets,
	GetBlockResults,
	ActionBlocks,
	BlockActionStatus,
	PendRequest,
	PendResult,
	CommitRequest,
	CommitResult,
	BlockId,
	Transforms,
} from '@optimystic/db-core';
import { StorageRepo, BlockStorage, type IRawStorage } from '@optimystic/db-p2p';

export interface SelectiveFailure {
	/** Which call to fail. A failed pend is a hard rejection at pend time (nothing durable);
	 * a failed commit is a permanent commit-phase loss (the residual). */
	phase: 'pend' | 'commit';
	/** The collections whose call fails, by collection id (the URI without its scheme, e.g.
	 * `legacy/item/index/idx_item_cat`). */
	matches: (collectionId: string) => boolean;
}

export interface SelectiveFailureTransactor {
	transactor: ITransactor;
	/** Fail every matching call from now until {@link disarm}. Resets the trip count. */
	arm(failure: SelectiveFailure): void;
	disarm(): void;
	/** How many calls the armed failure has refused so far. */
	readonly tripped: number;
}

export function makeSelectiveFailureTransactor(rawStorage: IRawStorage): SelectiveFailureTransactor {
	const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));
	const owners = new Map<BlockId, string>();
	let failure: SelectiveFailure | undefined;
	let tripped = 0;

	const learnOwners = (transforms: Transforms): void => {
		for (const [blockId, block] of Object.entries(transforms.inserts ?? {})) {
			owners.set(blockId, block.header.collectionId);
		}
	};

	/** The collection owning `blockIds` — one pend or commit names blocks of exactly one collection. */
	const ownerOf = (blockIds: readonly BlockId[]): string => {
		for (const blockId of blockIds) {
			const owner = owners.get(blockId);
			if (owner !== undefined) return owner;
		}
		throw new Error(`selective-failure transactor: no known owner for blocks [${blockIds.join(', ')}]`);
	};

	const refuse = (phase: SelectiveFailure['phase'], collectionId: string): void => {
		if (failure?.phase === phase && failure.matches(collectionId)) {
			tripped++;
			throw new Error(`injected ${phase} failure (${collectionId})`);
		}
	};

	const transactor: ITransactor = {
		async get(blockGets: BlockGets): Promise<GetBlockResults> {
			const results = await storageRepo.get(blockGets);
			for (const [blockId, result] of Object.entries(results)) {
				if (result.block) owners.set(blockId, result.block.header.collectionId);
			}
			return results;
		},
		async getStatus(_refs: ActionBlocks[]): Promise<BlockActionStatus[]> {
			throw new Error('getStatus not implemented in the selective-failure transactor');
		},
		async pend(request: PendRequest): Promise<PendResult> {
			learnOwners(request.transforms);
			const blockIds = [
				...Object.keys(request.transforms.inserts ?? {}),
				...Object.keys(request.transforms.updates ?? {}),
				...(request.transforms.deletes ?? []),
			];
			refuse('pend', ownerOf(blockIds));
			return storageRepo.pend(request);
		},
		async commit(request: CommitRequest): Promise<CommitResult> {
			refuse('commit', ownerOf([request.tailId, ...request.blockIds]));
			return storageRepo.commit(request);
		},
		async cancel(trxRef: ActionBlocks): Promise<void> {
			return storageRepo.cancel(trxRef);
		},
	};
	// Change notifications: the plugin feature-detects this, and the specs that use this helper
	// subscribe through it exactly as they would on a plain local transactor.
	(transactor as ITransactor & { onCollectionChange: StorageRepo['onCollectionChange'] }).onCollectionChange =
		storageRepo.onCollectionChange.bind(storageRepo);

	return {
		transactor,
		arm(next: SelectiveFailure) { failure = next; tripped = 0; },
		disarm() { failure = undefined; },
		get tripped() { return tripped; },
	};
}
