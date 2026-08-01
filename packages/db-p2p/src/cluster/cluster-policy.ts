import { DEFAULT_SUPER_MAJORITY_THRESHOLD, type ClusterConsensusConfig } from "@optimystic/db-core";

/**
 * Resolves the operator-facing cluster knobs (`clusterSize`, `clusterPolicy.*`) into the concrete
 * numbers the consensus and block-restoration paths run on.
 *
 * Extracted from `createLibp2pNodeBase` rather than left inline so the composition root's defaults
 * are assertable without booting a libp2p node — the layer a real deployment actually uses, and
 * therefore the layer where a default that relaxed the repair corroboration floor to a single voter
 * survived unnoticed (see `test/cluster-policy.spec.ts`).
 *
 * ## Why two size yardsticks, not one
 *
 * One operator field — `clusterPolicy.assumedClusterSize`, "the smallest cohort this deployment can
 * genuinely field" — feeds two consumers whose failure modes point in opposite directions, so its
 * *default* cannot serve both:
 *
 * - **Membership admission gate** (`cluster/cluster-repo.ts`, `admitMembership`) reads it only on its
 *   fallback path, when this node has no confident network-size estimate. Too small: a
 *   partition-induced downsize slips past while the node is unconfident. Too large: the node refuses
 *   legitimate writes — unavailability. It wants a *permissive* default, because an unconfigured
 *   two-node mesh must still be able to transact. It gets {@link minAbsoluteClusterSize} (2).
 * - **Repair corroboration floor** (`corroboratorCapacity` in `cluster/quorum-restore.ts`, called by
 *   `CoordinatorRepo.queryClusterForLatest` and `createReconcileBlock`) reads it on *every* repair,
 *   unconditionally. Too small: a shrunken — and always unauthenticated — cohort view buys a lone
 *   peer full trust. Too large: a block stays unrepaired, degraded rather than dead. It wants a
 *   *strict* default. It gets {@link ResolvedClusterPolicy.repairCorroborationClusterSize}, which
 *   falls back to `clusterSize` (the configured replication factor).
 *
 * A single explicit `clusterPolicy.assumedClusterSize` still sets BOTH — an operator declaring their
 * real cohort size means it for both consumers. Only the unconfigured case diverges.
 *
 * So a genuine two-node mesh needs exactly one setting to self-repair: either
 * `clusterPolicy.assumedClusterSize: 2` (which does not lower the replication factor) or an honest
 * `clusterSize: 2`. Writes and voting still work with zero configuration.
 *
 * ## Future
 *
 * Deriving the yardstick from observation (the largest peer group this node has ever seen for the
 * key) would remove the trade entirely and subsume both values. Filed as backlog
 * `feat-admission-floor-from-observed-cohort-high-water-mark`; do not build it here.
 */

/**
 * Absolute floor below which no cohort is safe, whatever the size references say. Named rather than
 * inlined because the admission gate's `assumedClusterSize` defaults to exactly this value — the two
 * must not drift.
 */
export const minAbsoluteClusterSize = 2;

/** The operator-facing subset of `NodeOptions` that the two size yardsticks are derived from. */
export interface ClusterPolicyOptions {
	/**
	 * Desired cluster size per key (default 10) — the replication factor / target cohort breadth.
	 * NOT a statement about how many peers actually exist.
	 */
	clusterSize?: number;
	clusterPolicy?: {
		allowDownsize?: boolean;
		/** Acceptable relative difference (e.g. 0.5 = +/-50%). */
		sizeTolerance?: number;
		/** Fraction of peers needed for super-majority (default {@link DEFAULT_SUPER_MAJORITY_THRESHOLD}). */
		superMajorityThreshold?: number;
		/**
		 * Opt in to transacting below the safe cluster-size floor when FRET has no confident
		 * network-size estimate. Default false (fail closed).
		 */
		allowUnvalidatedSmallCluster?: boolean;
		/**
		 * The smallest cohort this deployment can genuinely field — normally the number of nodes you
		 * actually run, capped at `clusterSize`. Sets both resolved yardsticks when declared; see the
		 * module doc for what each defaults to when it is not.
		 */
		assumedClusterSize?: number;
	};
}

/** Everything a node's consensus + restoration paths need, with every default already applied. */
export type ResolvedClusterPolicy = ClusterConsensusConfig & {
	/** Replication factor / target cohort breadth. Always concrete after resolution. */
	clusterSize: number;
	/**
	 * Yardstick the repair corroboration floor measures a (possibly shrunken, always unauthenticated)
	 * cohort view against — see `corroboratorCapacity` in `cluster/quorum-restore.ts`.
	 *
	 * Deliberately distinct from {@link ClusterConsensusConfig.assumedClusterSize}, which the
	 * membership admission gate reads: the two share an operator field but not a default, because
	 * over- and under-stating them cost opposite things. See the module doc.
	 */
	repairCorroborationClusterSize: number;
};

/**
 * Apply every cluster-policy default a node needs. Pure — same options in, same numbers out — so the
 * composition root's behavior is unit-testable (`test/cluster-policy.spec.ts`).
 */
export function resolveClusterPolicy(options: ClusterPolicyOptions): ResolvedClusterPolicy {
	// undefined here means "the operator said nothing", which is the only case where the two
	// yardsticks below diverge.
	//
	// NOTE: a declared value is passed through unvalidated. The admission gate floors a degenerate one
	// (0, negative, NaN, Infinity) itself — see `cluster-repo.admissionFloor` and its specs — but
	// `corroboratorCapacity` does not: NaN there makes every quorum comparison false, so repair
	// silently declines forever. Fail-safe, and unreachable through the reference-peer CLI (which
	// rejects non-positive integers). If another composition root starts accepting unvalidated config,
	// clamp here rather than in each consumer.
	const declaredCohortSize = options.clusterPolicy?.assumedClusterSize;
	const clusterSize = options.clusterSize ?? 10;

	return {
		superMajorityThreshold: options.clusterPolicy?.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD,
		simpleMajorityThreshold: 0.51,
		minAbsoluteClusterSize,
		allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
		clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5,
		// Fail closed by default (an undersized cluster with no confident network-size estimate is
		// rejected); embedders running knowingly-small meshes opt in through clusterPolicy.
		allowUnvalidatedSmallCluster: options.clusterPolicy?.allowUnvalidatedSmallCluster ?? false,
		partitionDetectionWindow: 60000,
		// Replication factor / target cohort breadth — what the coordinator aims for when selecting a
		// cohort. Deliberately NOT the membership admission gate's yardstick: it says nothing about how
		// many peers actually exist, so an unconfigured small mesh would refuse every write.
		clusterSize,
		// Membership admission gate, fallback path only (no confident network-size estimate). Defaults
		// permissive so a two- or three-node mesh transacts unconfigured; the cost of that default is
		// bounded to the gate, since the repair floor no longer reads this field.
		assumedClusterSize: declaredCohortSize ?? minAbsoluteClusterSize,
		// Repair corroboration floor, every repair. Defaults strict — to the replication factor — so an
		// unconfigured node cannot have its floor talked down to a single voter by a shrunken cohort
		// view. A genuinely small mesh declares its size (either field) to regain self-repair.
		repairCorroborationClusterSize: declaredCohortSize ?? clusterSize
	};
}
