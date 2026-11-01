/**
 * The listener discipline every host-facing subscription of this package shares: an idempotent
 * unsubscribe, and delivery that lets no listener break another or the operation that reports to
 * them. Used by `TransactionBridge` for its durability reports and by `OfflineMode` for its status
 * and queue-state events.
 */

/** Add `listener` to `listeners`, returning an idempotent unsubscribe. */
export function addListener<L>(listeners: Set<L>, listener: L): () => void {
	listeners.add(listener);
	let unsubscribed = false;
	return () => {
		if (unsubscribed) return;
		unsubscribed = true;
		listeners.delete(listener);
	};
}

/**
 * Call every listener with `event`, in registration order. Over a snapshot, so a listener that
 * (un)subscribes while being called changes the next delivery, not this one; a listener that throws
 * is handed to `onThrow` (the caller logs it under its own namespace) and the next still runs.
 */
export function notifyListeners<E>(listeners: ReadonlySet<(event: E) => void>, event: E, onThrow: (error: unknown) => void): void {
	for (const listener of [...listeners]) {
		try {
			listener(event);
		} catch (error) {
			onThrow(error);
		}
	}
}
