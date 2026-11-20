import type { RebalanceMonitor } from '../cluster/rebalance-monitor.js';
import type { BlobResponsibleRecords } from './local-blob-service.js';
import type { OwedBlobLedger } from './owed-blob-ledger.js';

/** What {@link seedHeldBlobs} needs; the node's blob service, its owed ledger and its blob cohort monitor are it. */
export interface HeldBlobSeedDeps {
	/** The records this node keeps for the network: every reference whose record holds `responsible`. */
	records: Pick<BlobResponsibleRecords, 'responsibleRefs'>;
	/** The writer's owed entries, which carry both a reference to track and the holders already known for it. */
	owed: Pick<OwedBlobLedger, 'list'>;
	monitor: Pick<RebalanceMonitor, 'trackBlock' | 'recordBlockHolders'>;
	/** Checked each reference so a long enumeration abandons promptly when the node is stopping. */
	isStopping: () => boolean;
}

/**
 * Seed the blob cohort monitor's tracked set from the blobs this node already keeps for the network
 * (docs/blobs.md §Placement, copying and durability, *When the cohort changes*).
 *
 * `seedOwnedBlocksFromStorage` in `packages/db-p2p/src/owned-block-seed.ts` is the precedent and the
 * reason: the live feed (`LocalBlobService.onHoldsChanged`) only fires on a hold that appears or goes,
 * so a blob already held from a previous run would be untracked until its holds next change — a
 * freshly restarted node would stop following the cohort of exactly the blobs it already keeps.
 * Called AFTER the feed is subscribed and the monitor is started, so a hold taken mid-scan is
 * independently caught by the feed (`trackBlock` is idempotent) and the holder evidence below is not
 * dropped as arriving while stopped.
 *
 * A `responsible` holder has no holder memory to seed — the holders of a blob it is not the writer of
 * are recorded nowhere — so after a restart it announces once to its whole cohort, which receivers
 * answer `whole` cheaply, bounded by the monitor's `growthBlockBudget` references per check and its
 * minimum interval between checks.
 */
export async function seedHeldBlobs(deps: HeldBlobSeedDeps, yieldEvery = 1000): Promise<void> {
	let seeded = 0;
	/** Cooperative yield, as the owned-block seed's does: a long enumeration must not monopolize one event-loop tick. */
	const breathe = async (): Promise<void> => {
		if (++seeded % yieldEvery === 0) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
	};
	for (const ref of await deps.records.responsibleRefs()) {
		if (deps.isStopping()) return;
		deps.monitor.trackBlock(ref);
		await breathe();
	}
	for (const entry of await deps.owed.list()) {
		if (deps.isStopping()) return;
		// Tracked BEFORE its holders are reported: the monitor drops evidence for an id it does not track.
		deps.monitor.trackBlock(entry.ref);
		if (entry.holders.length > 0) {
			// So the first check after a restart does not re-announce to members the writer already knows
			// hold the blob. An entry with no holders has nothing to say, and reporting it would only leave
			// an empty evidence entry for the next check to discard.
			deps.monitor.recordBlockHolders({ blockIds: [entry.ref], holders: entry.holders });
		}
		await breathe();
	}
}
