import { DEFAULT_SUPER_MAJORITY_THRESHOLD, type ClusterConsensusConfig } from "@optimystic/db-core";
import { createLogger } from "../logger.js";
import { CORROBORATION_FLOOR } from "./quorum-restore.js";

const log = createLogger('cluster-policy');

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

/**
 * Default replication factor / target cohort breadth when the operator declares no `clusterSize`.
 *
 * Exported (and re-exported from the package root) rather than left inline because a caller that
 * must construct a `Libp2pKeyPeerNetwork` for a node it did not build has to state a cluster size —
 * the constructor no longer supplies one — and the only defensible answer is "whatever a node built
 * here would have resolved to". Repeating the literal is how the two drifted last time.
 */
export const DEFAULT_CLUSTER_SIZE = 10;

/**
 * The operator-facing cluster knobs. `NodeOptions` (`libp2p-node-base.ts`) intersects this rather
 * than restating it, so a knob added here is one `resolveClusterPolicy` is guaranteed to see — a
 * second declaration would compile fine and be silently dropped.
 */
export interface ClusterPolicyOptions {
	/**
	 * Desired cluster size per key (default 10) — the replication factor / target cohort breadth
	 * the coordinator aims for. NOT a statement about how many peers actually exist, so the
	 * membership admission gate is never measured against it (see `cluster/cluster-repo.ts`).
	 *
	 * The read-repair/reconcile corroboration floor DOES fall back to it when
	 * `clusterPolicy.assumedClusterSize` is absent — the strict direction, so an unconfigured node
	 * cannot have its floor talked down by a shrunken cohort view. A deployment that genuinely runs
	 * fewer peers than this should declare `clusterPolicy.assumedClusterSize`.
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
		 * network-size estimate — the membership-admission and coordinator small-cluster gates both
		 * fail closed without it. Default false. Turn on only for single-node / local dev meshes that
		 * knowingly run undersized.
		 */
		allowUnvalidatedSmallCluster?: boolean;
		/**
		 * The smallest cohort this deployment can genuinely field — normally the number of nodes you
		 * actually run, capped at `clusterSize`. Two consumers read it: the membership admission gate,
		 * on its fallback path when the node has no confident network-size estimate; and the
		 * read-repair/reconcile corroboration floor (`corroboratorCapacity`), unconditionally.
		 *
		 * Declaring it sets BOTH. Leaving it unset does NOT — see the module doc for why the two
		 * defaults point in opposite directions. A large deployment should still set this to its real
		 * cohort size, otherwise the admission gate cannot police a partition-induced downsize while
		 * its size estimate is unconfident; a genuine two-node mesh needs it (or an honest
		 * `clusterSize: 2`) to self-repair.
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
 * Apply every cluster-policy default a node needs. Same options in, same numbers out, so the
 * composition root's behavior is unit-testable (`test/cluster-policy.spec.ts`). Its one side effect
 * is the `assumed-cluster-size-unset` advisory below, which lives here because this is the only place
 * that knows the resolution produced a self-defeating combination.
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
	const clusterSize = options.clusterSize ?? DEFAULT_CLUSTER_SIZE;
	const repairCorroborationClusterSize = declaredCohortSize ?? clusterSize;

	// Called once per node (resolveClusterPolicy runs once at construction), so this fires once per
	// node startup, not per repair — a per-attempt warn on a busy node would be noise that gets
	// filtered, defeating the point. Fires purely off configuration (not an observed cohort), so a
	// deployment that genuinely runs `clusterSize` machines sees it too; worded as a conditional
	// ("if you run fewer than N machines") rather than a fault for exactly that reason.
	//
	// The machine count in the message is CORROBORATION_FLOOR + 1, NOT repairCorroborationClusterSize:
	// `corroboratorCapacity` caps only the FLOOR of two (`quorum-restore.ts`), so a cohort with two
	// peers besides the reader meets it whatever the declared size. What an undeclared size costs is
	// the relaxation below two, which is only reachable when repairCorroborationClusterSize <= 2.
	// NOTE: only the UNDECLARED case warns. An operator who declares an assumedClusterSize larger than
	// the cohort they actually run is equally unable to repair and gets no warning — deliberate, since
	// a declaration is an explicit assertion and this function has no observed cohort to contradict it
	// with. If `feat-admission-floor-from-observed-cohort-high-water-mark` ever lands (deriving the
	// yardstick from observation), that warning becomes cheap and worth adding here.
	if (declaredCohortSize === undefined && clusterSize > minAbsoluteClusterSize) {
		const minimumSelfHealingDeployment = CORROBORATION_FLOOR + 1;
		log('assumed-cluster-size-unset', {
			clusterSize,
			repairCorroborationClusterSize,
			corroborationFloor: CORROBORATION_FLOOR,
			minimumSelfHealingDeployment,
			message:
				`No clusterPolicy.assumedClusterSize declared: block repair (read-repair and reconcile) requires ` +
				`${CORROBORATION_FLOOR} distinct corroborating peers other than the reader, and that floor is ` +
				`relaxed only for a cohort that DECLARES it is smaller — with ` +
				`repairCorroborationClusterSize=${repairCorroborationClusterSize} it never relaxes. So a deployment ` +
				`that actually runs fewer than ${minimumSelfHealingDeployment} machines can never supply the floor ` +
				`and every repair declines, permanently. If you run fewer than ${minimumSelfHealingDeployment} ` +
				`machines, set clusterPolicy.assumedClusterSize to your real cohort size; it does not lower ` +
				`clusterSize=${clusterSize} (the replication factor). Larger deployments can ignore this.`
		});
	}

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
		repairCorroborationClusterSize
	};
}
