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
 * This scan closes that gap by enumerating the metadata store — one id per block
 * with ANY durable metadata — and adding each id to `ownedBlocks`.
 *
 * That population is a superset of what the live feed tracks. The feed fires only
 * on a commit or a received replica, whereas metadata is also written on a plain
 * pend: `BlockStorage.savePendingTransaction` seeds `{ latest: undefined, ranges: [] }`
 * for a block that has none before storing the pending transform, and every backend's
 * `listBlockIds` enumerates metadata keys. So a block whose only durable state is an
 * uncommitted pending transform IS seeded — see the NOTE below.
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
	// NOTE: accepted over-inclusion — this seeds pend-only blocks (metadata exists, no committed
	// revision) alongside committed/replicated ones. Filtering to committed-only would mean reading and
	// decoding metadata for every id at startup — a per-block read on the fs backend, exactly the cost
	// the streamed key enumeration exists to avoid. It is benign today because every consumer of the
	// shared set re-checks local data before acting: `SpreadOnChurnMonitor.spreadCheck` untracks a
	// tracked block whose `repo.get` returns nothing, and `BlockTransferCoordinator.confirmReplicated`
	// reports a no-local-data block as unconfirmed, so it is never released and never becomes
	// GC-eligible. REVISIT IF any consumer of the shared owned-block set ever takes a destructive or
	// irreversible action keyed on membership alone, without a local-data check — then this scan must
	// filter to committed blocks. Asserted as-is by `test/owned-block-seed-node-wiring.spec.ts`.
	if (typeof rawStorage.listBlockIds !== 'function') return;
	let n = 0;
	for await (const blockId of rawStorage.listBlockIds()) {
		if (isStopping()) break;
		ownedBlocks.add(blockId);
		if (++n % yieldEvery === 0) await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
