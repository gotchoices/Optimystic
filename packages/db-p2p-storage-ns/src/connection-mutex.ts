/**
 * Per-connection FIFO mutex for the shared SQLite handle.
 *
 * SQLite allows at most one open transaction per connection, so every mutating
 * operation on a shared connection (plain writes AND transaction bodies) must be
 * serialized or a concurrent `BEGIN` will nest and cross-rollback another
 * operation's still-open writes.
 *
 * This is deliberately NOT the global `Latches` keyed map from
 * `@optimystic/db-core` — that is process-wide and keyed by string. Here we want
 * one mutex bound to one connection instance, so the wrapper holds its own.
 *
 * The chain tail is kept non-rejecting: a failing task must not poison the queue
 * for the operations behind it, so `serialize` continues the chain regardless of
 * the prior task's outcome while still surfacing each task's own result/error to
 * its own caller.
 */
export class ConnectionMutex {
	private tail: Promise<unknown> = Promise.resolve();

	/**
	 * Queue `task` behind all previously-queued tasks and run it once they settle.
	 * Resolves/rejects with `task`'s own outcome; never rejects the shared tail.
	 */
	serialize<T>(task: () => Promise<T> | T): Promise<T> {
		// Run `task` whether the prior task fulfilled or rejected.
		const run = this.tail.then(task, task);
		// Advance the tail with a settled-either-way promise so a rejection here
		// does not reject the next task's `.then(task, task)` prematurely.
		this.tail = run.then(() => undefined, () => undefined);
		return run;
	}
}
