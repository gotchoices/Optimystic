import type { BlockId } from '../blocks/structs.js';

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
}

/** The gate that is always open: what a queue over a transactor with no cohort to lose uses. */
export const alwaysReachable: ICohortReachability = {
	reachable: () => Promise.resolve(true),
};
