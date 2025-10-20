import type { Multiaddr } from "@multiformats/multiaddr";
import type { RepoMessage } from "../network/repo-protocol.js";

export type Signature = {
	type: 'approve' | 'reject';
	signature: string;
	rejectReason?: string;
}

export type ClusterPeers = {
	[id: string]: {
		multiaddrs: Multiaddr[];
		publicKey: Uint8Array;
	};
};

export type ClusterRecord = {
	messageHash: string;	// Serves as a unique identifier for the clustered transaction record
	peers: ClusterPeers;
	message: RepoMessage;
	coordinatingBlockIds?: string[];
	promises: { [peerId: string]: Signature };
	commits: { [peerId: string]: Signature };
	/** Sender's recommended cluster size: min(estimated network size, configured cluster size) */
	suggestedClusterSize?: number;
	minRequiredSize?: number;
	/** Sender's current network size estimate */
	networkSizeHint?: number;
	/** Confidence in the network size estimate (0-1) */
	networkSizeConfidence?: number;
}

export interface ClusterConsensusConfig {
	/** Super-majority threshold for promises (default 0.75 = 3/4) */
	superMajorityThreshold: number;
	/** Simple majority threshold for commits (default 0.51 = >50%) */
	simpleMajorityThreshold: number;
	/** Minimum absolute cluster size (default 3) */
	minAbsoluteClusterSize: number;
	/** Allow cluster to operate below configured size (default false) */
	allowClusterDownsize: boolean;
	/** Tolerance for cluster size variance as fraction (default 0.5 = 50%) */
	clusterSizeTolerance: number;
	/** Window for detecting partition in milliseconds (default 60000 = 1 min) */
	partitionDetectionWindow: number;
}
