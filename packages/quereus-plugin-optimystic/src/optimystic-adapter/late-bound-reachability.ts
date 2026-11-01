import type { BlockId, ICohortReachability } from '@optimystic/db-core';
import { alwaysReachable } from '@optimystic/db-core';
import { addListener, notifyListeners } from './listeners.js';
import { createLogger } from '../logger.js';

const log = createLogger('cohort-reachability');

/**
 * The one reachability gate a `CollectionFactory` hands out per transactor key
 * (`CollectionFactory.getCohortReachability`), standing in for whichever gate is registered for that
 * key now ({@link bind}) and for the always-open gate until one is. A table takes its gate when it
 * initializes, which can be before the gate is registered, so both halves are late-bound:
 * {@link reachable} asks the bound gate on every call, and {@link onChange}'s listeners hear the bound
 * gate's wakes, the subscription moving to each gate bound later. `onChange` is always present, so a
 * listener that subscribed before any gate was bound still hears the one bound after it.
 */
export class LateBoundCohortReachability implements ICohortReachability {
	private target: ICohortReachability = alwaysReachable;
	private targetBound = false;
	private readonly listeners = new Set<() => void>();
	/** The bound gate's unsubscribe, held while this has listeners and the bound gate has `onChange`. */
	private releaseTarget: (() => void) | undefined;

	/** Whether a gate was bound; until one is, this is the always-open gate. */
	get bound(): boolean {
		return this.targetBound;
	}

	reachable(blockIds: readonly BlockId[]): Promise<boolean> {
		return this.target.reachable(blockIds);
	}

	/** Call `listener` whenever the bound gate signals; the first listener subscribes to it and the last
	 * unsubscribe releases it. Returns an idempotent unsubscribe. */
	onChange(listener: () => void): () => void {
		const unsubscribe = addListener(this.listeners, listener);
		this.subscribeTarget();
		return () => {
			unsubscribe();
			if (this.listeners.size === 0) this.unsubscribeTarget();
		};
	}

	/** Stand in for `target` from now on, moving the wake subscription off the gate bound before. */
	bind(target: ICohortReachability): void {
		this.unsubscribeTarget();
		this.target = target;
		this.targetBound = true;
		this.subscribeTarget();
	}

	private readonly wake = (): void => {
		notifyListeners<void>(this.listeners, undefined, error => log('reachability:wake-listener-threw: %o', error));
	};

	private subscribeTarget(): void {
		if (this.releaseTarget !== undefined || this.listeners.size === 0) return;
		this.releaseTarget = this.target.onChange?.(this.wake);
	}

	private unsubscribeTarget(): void {
		this.releaseTarget?.();
		this.releaseTarget = undefined;
	}
}
