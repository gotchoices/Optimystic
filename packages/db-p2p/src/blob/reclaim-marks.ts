/**
 * The grace-period rule a reclaim pass applies to a blob it found listed nowhere (docs/blobs.md
 * §Lifetime), and the bounds of the option that sets the period.
 *
 * Pure: no clock and no store. The pass reads the mark a previous pass left and its own start time;
 * this module turns that pair into a decision, so the rule can be read and tested without building a
 * node, and so the pass and the node factory share one copy of the bounds.
 *
 * A **mark** is the start time of the first counting pass that found a blob listed nowhere:
 * `BlobRecord.unreferencedSince` for a `responsible` hold, `OwedBlobEntry.unlistedSince` for an owed
 * entry's own scope. It is what makes the two-pass rule survive a restart.
 */

/** 7 days (docs/blobs.md §Lifetime). */
export const DEFAULT_RECLAIM_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Below this a pass could release on two passes too close together to cover a reference being copied from one row to another. */
export const MIN_RECLAIM_GRACE_MS = 60 * 60 * 1000;

/** `mark`: leave the start time behind and keep the blob. `keep`: the period has not run out. `release`: it has. */
export type MarkDecision = 'mark' | 'keep' | 'release';

/**
 * What to do about a blob a counting pass found listed nowhere. `mark` covers both the first such
 * pass and a mark that lies after `startedAt` — the wall clock having gone back, where restarting the
 * period from now is the direction that keeps the blob.
 */
// NOTE: accepted tradeoff — the grace period is measured on this host's wall clock, so a clock set
// forward shortens the real time between the two passes. Wall-clock time is the only clock that
// survives a restart, which the mark must; a monotonic clock would reset the period on every restart
// and so never reclaim on a machine that restarts often. Revisit if hosts with unreliable clocks are
// reported.
export function judgeMark(mark: number | undefined, startedAt: number, graceMs: number): MarkDecision {
	if (mark === undefined || mark > startedAt) {
		return 'mark';
	}
	return startedAt - mark >= graceMs ? 'release' : 'keep';
}

/**
 * `NodeOptions.blobs`'s `reclaimGraceMs`, or the default.
 *
 * Refuses rather than clamping, as `resolveBlobCacheBudgetBytes` in `libp2p-node-base.ts` does and
 * for the same reason: a host that mistyped the grace period should be told, not quietly given a node
 * that deletes sooner than it meant.
 *
 * @throws RangeError naming the option for a value that is not finite or is below {@link MIN_RECLAIM_GRACE_MS}.
 */
export function resolveReclaimGraceMs(declared: number | undefined): number {
	if (declared === undefined) {
		return DEFAULT_RECLAIM_GRACE_MS;
	}
	if (!Number.isFinite(declared) || declared < MIN_RECLAIM_GRACE_MS) {
		throw new RangeError(`blobs.reclaimGraceMs must be a finite number of milliseconds at or above ${MIN_RECLAIM_GRACE_MS}, got ${declared}`);
	}
	return declared;
}
