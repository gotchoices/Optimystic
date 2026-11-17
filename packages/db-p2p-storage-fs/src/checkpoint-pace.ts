/**
 * How far one running checkpoint's tree syncs have got, and the commits waiting for their share of
 * them while the checkpoint is behind (see `FileWriteLog.commit`).
 *
 * A commit made while the checkpoint is behind is charged, after its append, the syncs its record
 * costs, and waits until that many more have completed. Charges accumulate in append order on one
 * cursor, so two commits waiting at once wait for two shares, not for one between them: the writers
 * together are held to the rate the checkpoint completes syncs. The cursor is fractional and only
 * the target is rounded up, so many small records share one sync rather than each paying a whole one.
 */
export class CheckpointPace {
	/** Paths whose sync has completed (a file deleted since the seal counts as completed). */
	private synced = 0;
	/** The sync count the commits charged so far are waiting for, before rounding. */
	private charged = 0;
	private reported = false;
	/** Waiting commits, in charge order, so their targets never decrease. */
	private readonly waiting: { readonly target: number; readonly resolve: () => void }[] = [];

	constructor(
		/** Files and directories the sealed segment covers: the syncs this checkpoint makes. */
		readonly paths: number,
		/** Bytes of records in the sealed segment. */
		readonly sealedBytes: number,
	) { }

	/** Syncs completed and syncs this checkpoint makes, for the behind line. */
	get progress(): { readonly synced: number; readonly paths: number } {
		return { synced: this.synced, paths: this.paths };
	}

	/** One more path synced: release every commit whose share that completes. */
	completeOne(): void {
		this.synced += 1;
		while (this.waiting.length > 0 && this.waiting[0]!.target <= this.synced) {
			this.waiting.shift()!.resolve();
		}
	}

	/** The checkpoint's sync phase is over, done or failed: release every commit still waiting. */
	end(): void {
		for (const { resolve } of this.waiting.splice(0)) resolve();
	}

	/**
	 * Charge a commit made while the checkpoint is behind, and return the wait for its share, or
	 * `undefined` when that share has already completed. The share is the larger of two:
	 *
	 * - **What its bytes cost**: `recordBytes` times the sealed segment's paths per byte. At this rate
	 *   the writers are held to the pace the disk makes the tree durable.
	 * - **What finishing in time takes**: `recordBytes` times the syncs no commit has been charged yet,
	 *   divided by the bytes the current log has left before it reaches twice `checkpointBytes`. This
	 *   binds only when the checkpoint made little progress before it fell behind — writes that kept
	 *   the queue busy, so its syncs kept giving way — and it is what keeps the current log, and so the
	 *   next sealed segment, near twice `checkpointBytes` rather than growing by about that much with
	 *   every checkpoint. A record that would take the log past that point is charged every sync left.
	 *
	 * `logBytes` is the current log's size with this record in it.
	 */
	charge(recordBytes: number, logBytes: number, checkpointBytes: number): Promise<void> | undefined {
		const start = Math.max(this.charged, this.synced);
		const uncharged = Math.max(0, this.paths - start);
		const ownCost = recordBytes * this.paths / this.sealedBytes;
		const bytesLeft = 2 * checkpointBytes - (logBytes - recordBytes);
		const finishInTime = bytesLeft > recordBytes ? recordBytes * uncharged / bytesLeft : uncharged;
		this.charged = Math.min(this.paths, start + Math.max(ownCost, finishInTime));
		const target = Math.ceil(this.charged);
		if (target <= this.synced) return undefined;
		return new Promise<void>(resolve => this.waiting.push({ target, resolve }));
	}

	/** True the first time it is asked: the behind episode is said once per checkpoint. */
	firstToWait(): boolean {
		const first = !this.reported;
		this.reported = true;
		return first;
	}
}
