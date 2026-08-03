import type { PeerId } from "./types.js";
import type { ClusterPeers } from "../cluster/structs.js";

/**
 * What a caller intends to do with the coordinator it is asking for.
 *
 * The distinction matters only when a node is isolated and the only candidate left is
 * itself. A read served from this node's own replica is at worst STALE — and the layers
 * below already say so (a self-only cohort answers conclusively; an unreachable cohort
 * comes back flagged unavailable). A write coordinated alone can instead diverge from the
 * rest of the network, so it is held to the stricter bar.
 */
export type CoordinatorIntent = 'read' | 'write';

export type FindCoordinatorOptions = {
	/** Peers that have already been tried (and failed) */
	excludedPeers?: PeerId[];
	/**
	 * What the caller intends to do with the coordinator. A read may fall back to this
	 * node's own replica when the network is unreachable; a write may not do so on the
	 * strength of the same evidence. Defaults to `'write'` (the conservative behavior)
	 * when unset, so callers that don't set it are unchanged.
	 */
	intent?: CoordinatorIntent;
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
