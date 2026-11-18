/**
 * The protocols a peer that serves this network's storage is recognised by: its network-namespaced
 * `repo` and `cluster` protocols, under the ids `RepoService` and `ClusterService` register.
 *
 * Two readers must agree on them. The key network counts a remote peer as serving when its peerStore
 * protocol list names either (`membershipOf` in `libp2p-key-network.ts`), and the storage-claim filter
 * keeps a per-stream merge from putting either into a remote peer's record
 * (`filterStorageClaimMerges` in `network/storage-claim-filter.ts`), so that only the peer's own
 * identify can. One function, so the two cannot name different ids.
 *
 * Pure: reachable from the react-native entry through `libp2p-node-base.ts`.
 */
export function storageServingProtocols(protocolPrefix: string): readonly [repo: string, cluster: string] {
	return [`${protocolPrefix}/repo/1.0.0`, `${protocolPrefix}/cluster/1.0.0`];
}
