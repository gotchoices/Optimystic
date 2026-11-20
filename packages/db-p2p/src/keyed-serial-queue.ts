/**
 * Serializes operations by key, so each read-compare-write for one key is atomic against the others
 * for the same key (`IKVStore` has no compare-and-set). Three stores need exactly this and had three
 * copies of it: the under-replication ledger, the blob record store, and the owed-blob ledger.
 *
 * Per-instance rather than db-core's `Latches`: `block-latch.ts` documents that `Latches.acquire(`
 * has exactly one call site in this package, and one node's one store needs no more than a chain of
 * its own. So a queue guarantees nothing between two instances over the same storage.
 */
export class KeyedSerialQueue {
	private readonly queues = new Map<string, Promise<unknown>>();

	/**
	 * Run `operation` after every earlier operation for `key`, whatever their outcome. The queue
	 * entry is dropped once nothing waits behind it, so the map holds only keys with work in flight.
	 */
	async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const run = previous.then(operation);
		const tail = run.then(settled, settled);
		this.queues.set(key, tail);
		try {
			return await run;
		} finally {
			if (this.queues.get(key) === tail) this.queues.delete(key);
		}
	}

	/** Observability: keys with work in flight. */
	get pending(): number {
		return this.queues.size;
	}
}

function settled(): void {
	// A settled link of the chain: the next operation runs whatever this one did.
}
