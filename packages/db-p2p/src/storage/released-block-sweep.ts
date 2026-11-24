/**
 * The pass that actually takes the bytes off the disk. It reads {@link ReleasedBlockLedger} and, for
 * each entry, deletes everything this node holds for that block, then drops the entry.
 *
 * > **A block's bytes are deleted only after a release that confirmed at least the replication floor
 * > of other serving holders hold a current replica of it.**
 *
 * That sentence is why this class **derives nothing**. It does not look at the node's ring, its
 * partition or its owned-block set: a block that merely looks outside this node's current slice may be
 * one whose handoff rolled back (mid-shift the advertised partition is the *target* ring), and is still
 * being served. The ledger — written only by the two confirmed-release callbacks — is the one input.
 *
 * It runs when a release has just written entries, when the node's pressure reading is at `shedding`
 * or above, and once shortly after start-up, which is what finishes the deletes a crash interrupted
 * (`packages/db-p2p/docs/storage.md` §10). A run that hit its cap asks for the next one itself, so a
 * large shed is cleared without waiting on another trigger.
 */

import type { BlockId } from '@optimystic/db-core';
import type { Logger } from '../logger.js';
import { hasExhaustedAttempts, RELEASED_BLOCK_DELETE_ATTEMPTS, type ReleasedBlockEntry, type ReleasedBlockLedger } from './released-block-ledger.js';
import type { IReleasedBlockDeleter } from './storage-repo.js';

/**
 * How many entries one run acts on — deleted, kept or failed alike, since each costs one latch hold.
 * A node that released tens of thousands must not hold the event loop for one pass, and the ledger is
 * what makes stopping safe: the remainder is still recorded, and a run that stopped here asks for the
 * next one, which takes the next batch, oldest release first.
 */
export const DEFAULT_RELEASED_BLOCK_SWEEP_LIMIT = 256;

/** What one sweep run found and did. */
export interface ReleasedBlockSweepRun {
	/** Entries in the ledger when the run started, exhausted ones included. */
	readonly found: number;
	readonly deleted: number;
	/** Blocks written again since their release, so kept; their entries were dropped (see {@link IReleasedBlockDeleter}). */
	readonly kept: number;
	/** Deletes that threw this run. Each counted one attempt against its entry. */
	readonly failed: number;
	/** Entries passed over because they have used up {@link RELEASED_BLOCK_DELETE_ATTEMPTS}. */
	readonly exhausted: number;
	/** Entries still in the ledger when the run ended — what this run's cap, failures and exhaustions left. */
	readonly remaining: number;
}

/** A run that did nothing, which is what a stopped sweep reports. */
const NOTHING_SWEPT: ReleasedBlockSweepRun = { found: 0, deleted: 0, kept: 0, failed: 0, exhausted: 0, remaining: 0 };

export interface ReleasedBlockSweepDeps {
	readonly ledger: Pick<ReleasedBlockLedger, 'list' | 'remove' | 'noteFailure'>;
	/** `StorageRepo`: the latch hold, the written-again check and the delete, as one operation. */
	readonly storage: IReleasedBlockDeleter;
	/**
	 * `LocalBlobService.sweep` — the EXISTING piece sweep, asked once per run that deleted anything.
	 * Nothing new is built for the blob half of deleting: the holds are released by the blob reclaim
	 * pass and by the cohort reaction, and the piece sweep already removes the pieces no remaining hold
	 * needs. Absent on a node without a blob service.
	 */
	readonly sweepBlobPieces?: () => Promise<unknown>;
	/** Default {@link DEFAULT_RELEASED_BLOCK_SWEEP_LIMIT}. */
	readonly limit?: number;
	readonly log: Logger;
}

/**
 * Single-flight with one queued follow-on, the shape `BlobCacheBudget` uses: a sweep must never
 * overlap itself — two runs would present the same entry to two latch holds and the second would
 * delete a block the first had already removed and re-recorded nothing about — and a request arriving
 * during a run must not be dropped, because the thing that asked may be a release whose entries the
 * running pass had already listed past.
 */
export class ReleasedBlockSweep {
	private readonly deps: ReleasedBlockSweepDeps;
	private readonly limit: number;
	/** The run in flight, absent while none runs. */
	private running: Promise<ReleasedBlockSweepRun> | undefined;
	/** The one run promised to every call that arrived while `running` ran. */
	private queued: Promise<ReleasedBlockSweepRun> | undefined;
	private stopping = false;

	constructor(deps: ReleasedBlockSweepDeps) {
		this.deps = deps;
		this.limit = deps.limit ?? DEFAULT_RELEASED_BLOCK_SWEEP_LIMIT;
	}

	/**
	 * Run a sweep, or promise the single follow-on when one is already running. Rejects only if the
	 * ledger scan itself failed; a failing delete is counted against its entry, not thrown.
	 */
	sweep(): Promise<ReleasedBlockSweepRun> {
		if (this.running === undefined) {
			return this.start();
		}
		this.queued ??= this.startAfter(this.running);
		return this.queued;
	}

	/** `void sweep()` with a logged catch, for the call sites that must not wait: a release, a pressure sample, start-up. */
	request(): void {
		void this.sweep().catch((error: unknown) => this.deps.log('sweep:failed - %e', error));
	}

	/** Refuse further runs and wait for the one in flight, so no block is deleted after the node has stopped. */
	async stop(): Promise<void> {
		this.stopping = true;
		// The follow-on resolves after the run it waits on, so awaiting it awaits both.
		const inFlight = this.queued ?? this.running;
		await inFlight?.then(noop, noop);
	}

	/** Awaits the run in flight however it ended, then starts the follow-on; `queued` is cleared first so a call during the follow-on queues another. */
	private async startAfter(running: Promise<ReleasedBlockSweepRun>): Promise<ReleasedBlockSweepRun> {
		await running.then(noop, noop);
		this.queued = undefined;
		return this.start();
	}

	private start(): Promise<ReleasedBlockSweepRun> {
		if (this.stopping) {
			return Promise.resolve(NOTHING_SWEPT);
		}
		const run = this.runOnce().finally(() => {
			if (this.running === run) {
				this.running = undefined;
			}
		});
		this.running = run;
		return run;
	}

	// NOTE: chained runs delete back to back with no pause, and each delete is one latch hold and one
	// synced store write. Clearing a shed of tens of thousands of blocks is therefore a long stretch of
	// steady write I/O. Deliberate — the node wants its bytes back, and the per-run cap plus the awaits
	// inside each delete keep any one turn of the event loop short. If a large shed's sweep is ever seen
	// starving a node's own reads and commits, put a delay between CHAINED runs (not between the blocks
	// of one run, which would hold the ledger's entries open for longer to no benefit).
	//
	// NOTE: each run reads every ledger entry (`list` is a full scan with one store read per entry) and
	// then acts on at most `limit` of them, so a node holding tens of thousands of entries re-reads them
	// all once per run. The same tripwire `OwedBlobLedger.list` and `BlobCacheBudget.runOnce` carry. If
	// it shows up in a profile, give the ledger a bounded `list(limit)` rather than caching the scan —
	// an entry list this pass holds across its own deletes is one that can disagree with the store.
	private async runOnce(): Promise<ReleasedBlockSweepRun> {
		const entries = await this.deps.ledger.list();
		const tally = { deleted: 0, kept: 0, failed: 0, exhausted: 0 };
		let taken = 0;
		for (const entry of entries) {
			if (hasExhaustedAttempts(entry)) {
				tally.exhausted++;
				continue;
			}
			// Checked per entry rather than once at the top: a stop that arrives mid-run must not start
			// another block's delete, and the entries left are still recorded.
			if (this.stopping || taken >= this.limit) {
				break;
			}
			taken++;
			await this.takeOne(entry, tally);
		}
		if (tally.deleted > 0) {
			await this.sweepPieces();
		}
		const remaining = entries.length - tally.deleted - tally.kept;
		const run: ReleasedBlockSweepRun = { found: entries.length, ...tally, remaining };
		// One line per run, the empty ones included: `found=0` is the answer to "why is this node's disk
		// not getting any emptier" — nothing has been released — which a suppressed line would not give.
		this.deps.log('sweep:run found=%d deleted=%d kept=%d failed=%d exhausted=%d remaining=%d',
			run.found, run.deleted, run.kept, run.failed, run.exhausted, run.remaining);
		// A run that stopped at its cap leaves work behind, and the next trigger may never come: a node
		// that dropped below `shedding` by deleting these very blocks gets no further pressure request,
		// and nothing else asks until the next release. So the run asks for the next one itself.
		//
		// It terminates. Every entry a run acts on is either deleted, dropped, or counted one attempt
		// toward the bound past which it is passed over, so each chained run's actionable set is strictly
		// smaller than the last's.
		if (!this.stopping && actionableRemaining(run) > 0) {
			this.request();
		}
		return run;
	}

	/**
	 * Delete one entry's block and drop the entry, in that order — the ordering the whole ledger exists
	 * for: a crash between them leaves an entry for a block already (perhaps partly) deleted, which the
	 * next run's idempotent `deleteBlock` finishes.
	 *
	 * A block the condition kept has its entry dropped too, and nothing is deleted: the node accepted
	 * the block again, so it is not a released block any more. A later release of it records a fresh
	 * entry carrying the revision it then holds.
	 */
	private async takeOne(entry: ReleasedBlockEntry, tally: { deleted: number; kept: number; failed: number }): Promise<void> {
		try {
			const outcome = await this.deps.storage.deleteBlockIfNotAdvanced(entry.blockId, entry.releasedRev);
			await this.deps.ledger.remove(entry.blockId);
			if (outcome === 'deleted') {
				tally.deleted++;
				this.deps.log('sweep:deleted blockId=%s source=%s releasedAt=%d releasedRev=%s',
					entry.blockId, entry.source, entry.releasedAt, entry.releasedRev ?? 'none');
			} else {
				tally.kept++;
				this.deps.log('sweep:written-again blockId=%s source=%s releasedRev=%s', entry.blockId, entry.source, entry.releasedRev ?? 'none');
			}
		} catch (error) {
			// One block's storage fault must not end the run: the rest of the ledger is still deletable,
			// and this entry's attempt count is what stops it being retried for ever. A failure of the
			// ledger's own `remove`, AFTER the delete landed, is caught here too and leaves an entry whose
			// block is already gone; the next run's `deleteBlock` is a quiet no-op on it and tries the
			// remove again, so what that costs is a pass, never a byte.
			tally.failed++;
			const attempts = await this.noteFailure(entry.blockId);
			this.deps.log('sweep:delete-failed blockId=%s attempts=%d/%d - %e',
				entry.blockId, attempts, RELEASED_BLOCK_DELETE_ATTEMPTS, error);
		}
	}

	/** The attempt count after this failure, or 0 if even recording it failed — which must not mask the delete's error. */
	private async noteFailure(blockId: BlockId): Promise<number> {
		try {
			return await this.deps.ledger.noteFailure(blockId);
		} catch (error) {
			this.deps.log('sweep:attempt-unrecorded blockId=%s - %e', blockId, error);
			return 0;
		}
	}

	/** The piece sweep, whose failure is logged rather than thrown: the blocks are already deleted, and it runs again on the next trigger. */
	private async sweepPieces(): Promise<void> {
		try {
			await this.deps.sweepBlobPieces?.();
		} catch (error) {
			this.deps.log('sweep:pieces-failed - %e', error);
		}
	}
}

/**
 * Entries a later run could still act on: what this one left, less the ones that have used up their
 * attempts. An entry that exhausted its last attempt THIS run is still counted (it is in `failed`, not
 * yet in `exhausted`), so the chain pays one extra run that finds it exhausted and then stops.
 */
function actionableRemaining(run: ReleasedBlockSweepRun): number {
	return run.remaining - run.exhausted;
}

function noop(): void {
	// Waiting for a run to end, not for what it found.
}
