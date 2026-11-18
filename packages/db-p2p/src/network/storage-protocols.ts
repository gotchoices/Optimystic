/**
 * The protocols a peer that serves this network's storage is recognised by: its network-namespaced
 * `repo` and `cluster` protocols.
 *
 * Every site that names them builds them here: `RepoService` and `ClusterService` register them, their
 * clients dial them, the key network counts a remote peer as serving when its peerStore protocol list
 * names either (`membershipOf` in `libp2p-key-network.ts`), and the storage-claim filter keeps a
 * per-stream merge from putting either into a remote peer's record (`filterStorageClaimMerges` in
 * `network/storage-claim-filter.ts`), so that only the peer's own identify can. One place, so a
 * version bump of either protocol cannot leave membership reading the old id.
 *
 * Pure: reachable from the react-native entry through `libp2p-node-base.ts`.
 */

export const buildRepoProtocol = (protocolPrefix: string): string => `${protocolPrefix}/repo/1.0.0`;

export const buildClusterProtocol = (protocolPrefix: string): string => `${protocolPrefix}/cluster/1.0.0`;

export function storageServingProtocols(protocolPrefix: string): readonly [repo: string, cluster: string] {
	return [buildRepoProtocol(protocolPrefix), buildClusterProtocol(protocolPrefix)];
}
