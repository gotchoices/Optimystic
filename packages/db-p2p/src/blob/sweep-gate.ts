/**
 * An asynchronous shared/exclusive gate between the piece sweep and the work that can make a piece
 * live: storing one piece, and changing one record, each a shared holder. Writer-preferring: once
 * an exclusive holder waits, new shared holders wait behind it, so a sweep is never starved by a
 * steady stream of puts. When an exclusive holder releases, the shared holders that queued during
 * it run before the next exclusive one.
 *
 * Holds are never nested: a shared holder never calls `shared` or `exclusive` again, since it would
 * wait on an exclusive holder that waits on it. Each shared holder awaits nothing but its own store
 * call, which is what bounds how long a sweep waits.
 */
export class SweepGate {
	private sharedHolders = 0;
	private exclusiveHeld = false;
	private readonly sharedWaiters: Array<() => void> = [];
	private readonly exclusiveWaiters: Array<() => void> = [];

	/** Runs `fn` while no exclusive holder runs; waits while one runs or waits. */
	async shared<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquireShared();
		try {
			return await fn();
		} finally {
			this.releaseShared();
		}
	}

	/** Waits for every running shared holder to finish, blocks new ones, runs `fn`. One at a time. */
	async exclusive<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquireExclusive();
		try {
			return await fn();
		} finally {
			this.releaseExclusive();
		}
	}

	private acquireShared(): Promise<void> {
		if (!this.exclusiveHeld && this.exclusiveWaiters.length === 0) {
			this.sharedHolders++;
			return Promise.resolve();
		}
		return new Promise(resolve => this.sharedWaiters.push(resolve));
	}

	private acquireExclusive(): Promise<void> {
		if (!this.exclusiveHeld && this.sharedHolders === 0 && this.exclusiveWaiters.length === 0) {
			this.exclusiveHeld = true;
			return Promise.resolve();
		}
		return new Promise(resolve => this.exclusiveWaiters.push(resolve));
	}

	private releaseShared(): void {
		this.sharedHolders--;
		if (this.sharedHolders === 0) {
			this.grantExclusive();
		}
	}

	private releaseExclusive(): void {
		this.exclusiveHeld = false;
		if (this.sharedWaiters.length > 0) {
			this.grantShared();
		} else {
			this.grantExclusive();
		}
	}

	private grantShared(): void {
		const waiting = this.sharedWaiters.splice(0);
		this.sharedHolders += waiting.length;
		for (const grant of waiting) {
			grant();
		}
	}

	private grantExclusive(): void {
		const next = this.exclusiveWaiters.shift();
		if (next !== undefined) {
			this.exclusiveHeld = true;
			next();
		}
	}
}
