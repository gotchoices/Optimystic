import type { BlockId } from '../blocks/structs.js';
import type { Collection } from '../collection/collection.js';

/**
 * Whether the cohorts responsible for these blocks can be reached now — the gate of
 * docs/offline-sync.md §When to submit. db-p2p implements it over the key network (stage 6);
 * absent, the queue treats the cohort as always reachable ({@link alwaysReachable}), which is right
 * for `TestTransactor`, the local transactor and the in-process mesh. Asked with each collection's
 * header id and its last known log tail id, so an implementation resolves cohorts from routing keys
 * alone and never needs the network to answer whether the network can be reached.
 */
export interface ICohortReachability {
	reachable(blockIds: readonly BlockId[]): Promise<boolean>;
	/** Optionally call `listener` when reachability may have improved — a machine connected or was
	 *  identified. A hint, not an answer: the listener asks `reachable` again. Returns an idempotent
	 *  unsubscribe. Absent → nothing wakes the asker but its own timer. */
	onChange?(listener: () => void): () => void;
}

/** The gate that is always open: what a queue over a transactor with no cohort to lose uses. */
export const alwaysReachable: ICohortReachability = {
	reachable: () => Promise.resolve(true),
};

/** What a gate is asked with for one collection: its header id and its last known log tail id
 * (`Collection.knownLogTailId`), when it knows one. The offline queue asks with these for every
 * collection the head entry still has to commit, and the Quereus plugin's live-read degrade for the
 * tree it is about to refresh, so the two ask one gate the same question. */
export function gateBlockIds(collection: Collection<any>): BlockId[] {
	const tailId = collection.knownLogTailId();
	return tailId === undefined ? [collection.id] : [collection.id, tailId];
}
