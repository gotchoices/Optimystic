import type { PeerId } from "./types.js";
import type { ClusterPeers } from "../cluster/structs.js";

export type FindCoordinatorOptions = {
	/** Peers that have already been tried (and failed) */
	excludedPeers?: PeerId[];
};


export type IKeyNetwork = {
	/**
	 * Find a coordinator node responsible for a given key and establish connection
	 * @param key The key to find coordinator for
	 * @returns Promise resolving to ID of coordinator node
	 */
	findCoordinator(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId>;

	/**
	 * Find the peers in the cluster responsible for a given key
	 * @param key The key to find peers for
	 * @returns Promise resolving to the peers in the cluster
	 */
	findCluster(key: Uint8Array): Promise<ClusterPeers>;

	/**
	 * Optionally cache a resolved coordinator for a key, so a follow-up operation
	 * (e.g. commit after pend) reuses the same peer. Implementations that don't
	 * cache coordinators simply omit this. `ttlMs` bounds how long the hint lives.
	 * @param key The key the coordinator was resolved for
	 * @param peerId The coordinating peer
	 * @param ttlMs Optional time-to-live for the cached hint, in ms
	 */
	recordCoordinator?(key: Uint8Array, peerId: PeerId, ttlMs?: number): void;
}
