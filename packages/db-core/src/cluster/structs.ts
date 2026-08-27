import type { RepoMessage } from "../network/repo-protocol.js";

/**
 * One member's vote on a cluster transaction, in either the promise or the commit map.
 *
 * A discriminated union rather than one shape with optional fields, so each vote kind carries
 * exactly its own payload: a `conflict` without its `conflictWith` (or a stray `rejectReason` on an
 * `approve`) does not typecheck. Every variant's extra field is folded into the signed payload
 * ({@link clusterVoteSigningPayload}), so none of them can be altered in transit.
 */
export type Signature =
	| { type: 'approve'; signature: string }
	| { type: 'reject'; signature: string; rejectReason?: string }
	/**
	 * This member refuses the transaction *for now*: it holds a conflicting transaction that won
	 * the deterministic race (`resolveRace`). Retryable — NOT a validity judgement, and never
	 * counted toward the permanent-rejection threshold. `conflictWith` is the winning
	 * transaction's messageHash: structured, signed, and readable without parsing prose.
	 */
	| { type: 'conflict'; signature: string; conflictWith: string };

/**
 * The exact bytes a vote signature covers: `<hash>:<type>[:<extra>]`, where `extra` is the variant's
 * own payload — a reject's `rejectReason`, a conflict's `conflictWith`, nothing for an approve.
 * Folding the extra in is what makes it integrity-protected in transit rather than free-floating
 * prose.
 *
 * Producers and verifiers must both build the preimage here. It lives beside {@link Signature}
 * rather than in either consumer because a second copy that forgets a variant does not fail loudly:
 * it reports an honest vote as an invalid signature. (The dispute path once carried such a copy.)
 *
 * "Cluster" in the name distinguishes these consensus votes from the dispute subsystem's
 * arbitration votes, which have their own unrelated preimage (`dispute/invalidation.ts`).
 */
export function clusterVoteSigningPayload(hash: string, type: Signature['type'], extra?: string): Uint8Array {
	return new TextEncoder().encode(hash + ':' + type + (extra ? ':' + extra : ''));
}

/** Verifier-side {@link clusterVoteSigningPayload}: reads each variant's signed extra off the vote itself. */
export function clusterVoteVerificationPayload(hash: string, signature: Signature): Uint8Array {
	switch (signature.type) {
		case 'reject': return clusterVoteSigningPayload(hash, 'reject', signature.rejectReason);
		case 'conflict': return clusterVoteSigningPayload(hash, 'conflict', signature.conflictWith);
		default: return clusterVoteSigningPayload(hash, signature.type);
	}
}

export type ClusterPeers = {
	[id: string]: {
		multiaddrs: string[];
		/** Base64url-encoded public key (serialization-safe) */
		publicKey: string;
	};
};

export type ClusterRecord = {
	messageHash: string;	// Serves as a unique identifier for the clustered transaction record
	peers: ClusterPeers;
	/**
	 * Membership-binding version. Absent or `1` = legacy *unbound* record: the peer set is NOT covered by
	 * any hash (pre-binding history and its stored commit certs verify byte-identically to before). `2` =
	 * the sorted peer-id set (as {@link ClusterRecord.membershipDigest}) is folded into `messageHash`,
	 * `promiseHash`, and `commitHash`, so two different peer sets yield two different `messageHash`es.
	 * New coordinators always emit `2`. See `packages/db-core/src/cluster/membership.ts`.
	 */
	membershipVersion?: 1 | 2;
	/** Membership digest of {@link ClusterRecord.peers}; present iff `membershipVersion === 2`. base64url. */
	membershipDigest?: string;
	/**
	 * The transaction's operations and the block the coordinator selected the cohort by
	 * ({@link RepoMessage.coordinatingBlockIds}). There is deliberately NO top-level copy of the
	 * coordinating block ids on the record: `messageHash` covers `message` only, so a duplicate at
	 * this level would be outside every hash and any relaying peer could rewrite it — and the
	 * membership admission gate derives its own cohort view from exactly that id
	 * (`ClusterMember.deriveExpectedClusterView`). One source of truth, inside the hash.
	 */
	message: RepoMessage;
	promises: { [peerId: string]: Signature };
	commits: { [peerId: string]: Signature };
	/** Sender's recommended cluster size: min(estimated network size, configured cluster size) */
	suggestedClusterSize?: number;
	minRequiredSize?: number;
	/** Sender's current network size estimate */
	networkSizeHint?: number;
	/** Confidence in the network size estimate (0-1) */
	networkSizeConfidence?: number;
	/** Transaction proceeded despite minority rejections */
	disputed?: boolean;
	/** Evidence of the dispute: which peers rejected and why */
	disputeEvidence?: {
		rejectingPeers: string[];
		rejectReasons: { [peerId: string]: string };
	};
}

/**
 * Single source of truth for the default super-majority threshold — the fraction of a cluster's peers
 * that must promise before a transaction may proceed. Every component that falls back to a default when
 * config is absent (cluster member, coordinator policy, node composition root) references THIS constant,
 * so a member cannot silently default to a different threshold than the coordinator that commits. Explicit
 * caller-supplied thresholds are unaffected; this only unifies the *absent-config* default.
 * 0.75 = 3/4: chosen because the coordinator (which actually commits) already used it and the type documents it.
 */
export const DEFAULT_SUPER_MAJORITY_THRESHOLD = 0.75;

export interface ClusterConsensusConfig {
	/** Super-majority threshold for promises (default {@link DEFAULT_SUPER_MAJORITY_THRESHOLD} = 0.75 = 3/4) */
	superMajorityThreshold: number;
	/** Simple majority threshold for commits (default 0.51 = >50%) */
	simpleMajorityThreshold: number;
	/** Minimum absolute cluster size (default 3) */
	minAbsoluteClusterSize: number;
	/** Allow cluster to operate below configured size (default false) */
	allowClusterDownsize: boolean;
	/** Tolerance for cluster size variance as fraction (default 0.5 = 50%) */
	clusterSizeTolerance: number;
	/**
	 * Configured full cluster size — the replication factor / target cohort breadth. This is what the
	 * coordinator aims for when selecting a cohort. It is NOT a statement about how many peers exist,
	 * and nothing may use it as a security yardstick; see {@link ClusterConsensusConfig.assumedClusterSize}.
	 * The coordinator supplies this as a required `clusterSize` via `ClusterConsensusConfig & { clusterSize: number }`.
	 */
	clusterSize?: number;
	/**
	 * The smallest cohort the operator asserts this deployment can genuinely field — typically
	 * `min(clusterSize, number of nodes actually run)`. Read ONLY when a node cannot independently
	 * measure a cohort (no derivation capability wired, or no confident network-size estimate), where
	 * it stands in for the measured estimate in the membership admission floor.
	 *
	 * Undefined means "unknown": the admission gate then cannot tell a downsize from a legitimately
	 * small cluster and preserves legacy approve behavior. Composition roots should supply a concrete
	 * value; `libp2p-node-base` defaults it to `minAbsoluteClusterSize`.
	 */
	assumedClusterSize?: number;
	/**
	 * Fraction of the member's OWN confident cluster-size estimate a declared peer set must meet to be
	 * admitted for voting (default 0.75). Below `⌈membershipAdmissionFraction · K_est⌉` a declared set is
	 * treated as an unjustified self-shrink and the member declines to approve. Distinct from
	 * {@link superMajorityThreshold} (the vote-counting threshold) — this gates *which set* may be voted on.
	 */
	membershipAdmissionFraction?: number;
	/** Window for detecting partition in milliseconds (default 60000 = 1 min) */
	partitionDetectionWindow: number;
	/** Enable dispute escalation protocol (default false) */
	disputeEnabled?: boolean;
	/** Timeout for dispute arbitration in milliseconds (default 60000) */
	disputeArbitrationTimeoutMs?: number;
	/**
	 * Hard horizon on an invalidation cascade: maximum number of recursive re-evaluation rounds
	 * (dependency-graph depth) before the cascade stops and escalates the affected collection(s)
	 * for operator full re-sync (default 32). Bounds unbounded automatic reversal.
	 */
	maxCascadeDepth?: number;
	/**
	 * Hard horizon on an invalidation cascade: maximum number of transactions (including the root)
	 * the cascade may invalidate before it stops and escalates for operator full re-sync
	 * (default 1000). On overflow the already-applied invalidations stand; the remainder is flagged,
	 * never silently dropped.
	 */
	maxCascadeTransactions?: number;
	/** Initial scheduled-retry interval for failed commit broadcasts, ms (default 250) */
	commitBroadcastRetryInitialMs?: number;
	/** Backoff factor for commit-broadcast scheduled retries (default 2) */
	commitBroadcastRetryBackoffFactor?: number;
	/** Max scheduled-retry interval, ms (default 8000) */
	commitBroadcastRetryMaxIntervalMs?: number;
	/** Max scheduled retry attempts before giving up (default 5) */
	commitBroadcastRetryMaxAttempts?: number;
	/** Immediate in-line retries per failed peer inside the broadcast (default 1) */
	commitBroadcastImmediateRetries?: number;
	/**
	 * Immediate in-line retries per peer while collecting promises (default 1).
	 * The promise phase rides the same libp2p stream the commit broadcast does;
	 * a circuit-relay ("limited") connection can reset that stream once a
	 * per-circuit cap is hit, surfacing to the coordinator as a StreamResetError.
	 * Unlike the commit broadcast there is no follow-up scheduled retry, so a
	 * single reset here would otherwise drop the peer and sink super-majority.
	 */
	promiseImmediateRetries?: number;
	/** Read-repair behavior: 'off' (only fetch on missing — legacy), 'lazy' (fetch when local age > window), 'paranoid' (always verify against cluster on read). Default 'lazy'. */
	readRepairMode?: 'off' | 'lazy' | 'paranoid';
	/** For 'lazy' mode: read-repair triggers when (now - localEntry.lastSeenCommitMs) > this. Default 10000. */
	readRepairWindowMs?: number;
	/** Per-read probability of triggering read-repair in 'lazy' mode even within the window (0..1). Default 0 (no random check). */
	readRepairSampleRate?: number;
	/**
	 * When FRET has no confident network-size estimate, allow an undersized cluster
	 * (peerCount < minAbsoluteClusterSize) to proceed anyway. Default false: with no
	 * confident estimate an undersized cluster is REJECTED. Turn on only for
	 * single-node / local dev where you knowingly run below the safe floor.
	 */
	allowUnvalidatedSmallCluster?: boolean;
}
