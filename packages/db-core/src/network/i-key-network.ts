import type { PeerId } from "./types.js";
import type { ClusterPeers } from "../cluster/structs.js";
import type { RoutingKey } from "./routing-key.js";

/**
 * What a caller intends to do with the coordinator it is asking for.
 *
 * Two things differ. A READ goes to this node's own replica, ahead of any remote pick,
 * whenever this node is one of the key's responsible peers and its self-coordination guard
 * allows it: a remote coordinator answers from its own copy under the same read-repair
 * rules, so answering locally changes which cohort member answers, not what the answer
 * guarantees — and it costs no network hop. And when a node is isolated and the only
 * candidate left is itself, a read may still be answered from its own replica on evidence
 * that refuses a write: such a read is at worst STALE, and the layers below already say so
 * (a self-only cohort answers conclusively; an unreachable cohort comes back flagged
 * unavailable). A write coordinated alone can instead diverge from the rest of the network,
 * so it is held to the stricter bar.
 */
export type CoordinatorIntent = 'read' | 'write';

export type FindCoordinatorOptions = {
	/** Peers that have already been tried (and failed) */
	excludedPeers?: PeerId[];
	/**
	 * What the caller intends to do with the coordinator — see {@link CoordinatorIntent}. A
	 * caller that wants a second opinion after this node answered a read locally excludes this
	 * node. Defaults to `'write'` (the conservative behavior) when unset, so callers that don't
	 * set it are unchanged.
	 */
	intent?: CoordinatorIntent;
};


/**
 * Maps a block to the peers responsible for it.
 *
 * Every key is a {@link RoutingKey} minted by `routingKeyForBlock`. Implementations hash it into a ring
 * coordinate themselves, so a caller must never pre-hash: the writer and the servers agree on a
 * block's cohort only because both hand over the same bytes and exactly one hash is applied to them.
 */
export type IKeyNetwork = {
	/**
	 * Find a coordinator node responsible for a given key and establish connection
	 * @param key The block's routing key
	 * @returns Promise resolving to ID of coordinator node
	 */
	findCoordinator(key: RoutingKey, options?: Partial<FindCoordinatorOptions>): Promise<PeerId>;

	/**
	 * Find the peers in the cluster responsible for a given key
	 * @param key The block's routing key
	 * @returns Promise resolving to the peers in the cluster
	 */
	findCluster(key: RoutingKey): Promise<ClusterPeers>;

	/**
	 * Optionally cache a resolved coordinator for a key, so a follow-up operation
	 * (e.g. commit after pend) reuses the same peer. Implementations that don't
	 * cache coordinators simply omit this. `ttlMs` bounds how long the hint lives.
	 * @param key The routing key the coordinator was resolved for — the same key a later `findCoordinator` looks it up by
	 * @param peerId The coordinating peer
	 * @param ttlMs Optional time-to-live for the cached hint, in ms
	 */
	recordCoordinator?(key: RoutingKey, peerId: PeerId, ttlMs?: number): void;

	/**
	 * Optionally report that this node was configured with peers to join through and has not yet
	 * heard from all of them. While true, a `findCluster` answer naming nobody but this node is
	 * what the node would see whether or not those peers hold a block, so a repo must not treat
	 * its own lack of the block as proof the block was never created. Implementations with no
	 * such configuration omit this, which reads as "not awaiting".
	 */
	awaitingBootstrapContact?(): Promise<boolean>;
}
