import type { IRawStorage } from './storage/i-raw-storage.js';

/**
 * Seed the resilience monitors' shared owned-block set from blocks already
 * durable in raw storage from a previous process run.
 *
 * The live owned-block feed (`storageRepo.onAnyCollectionChange`, wired in
 * `createLibp2pNodeBase`) only fires on NEW commits and RECEIVED replicas, so a
 * block that was already durable on disk from a previous run is not tracked
 * after a restart until it happens to be committed or replicated again — a
 * freshly restarted node would under-protect exactly the data it already holds.
 * This scan closes that gap by enumerating the metadata store (one id per block
 * with a committed revision or persisted replica — the same population the live
 * feed tracks) and adding each id to `ownedBlocks`.
 *
 * Called AFTER the live feed is already subscribed, so a block committed/replicated
 * mid-scan is independently caught by the feed; `Set.add` is idempotent, so the
 * overlap is harmless. `isStopping()` is checked each iteration so a scan over a
 * huge store aborts promptly when the node is stopping (the `for await` then calls
 * the iterator's `return()` to release the backend cursor). A cooperative yield
 * every `yieldEvery` ids keeps a tight add-loop from monopolizing an event-loop tick.
 *
 * Backends that omit `listBlockIds` (or an in-memory backend with nothing durable
 * across a restart) yield no seed — the monitors still populate over time via the
 * live feed.
 */
export async function seedOwnedBlocksFromStorage(
	rawStorage: Pick<IRawStorage, 'listBlockIds'>,
	ownedBlocks: Set<string>,
	isStopping: () => boolean,
	yieldEvery = 1000,
): Promise<void> {
	if (typeof rawStorage.listBlockIds !== 'function') return;
	let n = 0;
	for await (const blockId of rawStorage.listBlockIds()) {
		if (isStopping()) break;
		ownedBlocks.add(blockId);
		if (++n % yieldEvery === 0) await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
