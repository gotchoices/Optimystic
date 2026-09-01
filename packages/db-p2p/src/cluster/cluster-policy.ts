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
		/**
		 * What a validator-configured member does with a pend that carries no `validation` payload
		 * (nothing to re-execute — the single-collection `Collection.sync` shape): 'accept' (default)
		 * admits it unchecked; 'reject' fails closed, knowingly refusing `Collection.sync` writes.
		 * See `ClusterConsensusConfig.unvalidatablePendPolicy`.
		 */
		unvalidatablePendPolicy?: 'accept' | 'reject';
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
 * is the `repair-fault-tolerance` advisory below, which lives here because this is the only place
 * that knows the resolution produced a combination with no repair margin — or none at all.
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

	// ## What the advisory actually claims, and why the trigger is what it is
	//
	// The rule it states is measurable, not rhetorical: sweep `corroboratorCapacity` and `quorumSize`
	// over real cohort sizes and every configuration lands on the same requirement — **2 cohort peers
	// BESIDES the reader must answer that reader and agree on the same (rev, actionId)**, relaxed to 1
	// only for a cohort DECLARED smaller than three. Two consequences follow, and both are worth
	// saying out loud because both surprised people in the field:
	//
	//  - Fewer than three machines, undeclared, can never repair at all: the floor of two never
	//    relaxes, because `repairCorroborationClusterSize` falls back to `clusterSize` (default 10).
	//  - Exactly three machines is the MINIMUM that can ever repair, not a size at which repair is
	//    safe. The reader has exactly two peers and needs both, so a single peer unreachable FROM THAT
	//    READER — perfectly healthy and reachable from everybody else — leaves that reader's copy
	//    permanently unrepairable. Four machines is the first size with any margin.
	//
	// Both of those are claims about MACHINES, and the advisory used to stop there — which made it
	// wrong in the operator's favour, because a machine count is only half the requirement. The peers
	// that answer must also HOLD the block, and two of them must. A block only ONE cohort peer holds
	// cannot be repaired at any deployment size whatsoever: the sole holder cannot second itself, and
	// the two mechanisms that would give a second peer a copy (read-repair and reconcile) both consume
	// this same decision. So an operator at four-plus machines reading "the first size with any margin"
	// could believe they were covered while a block written when the deployment was smaller stayed
	// stranded at one copy forever. The advisory now says so; the per-block half is
	// `cluster-fetch:repair-deadlock` with `reason: 'sole-holder'` (`CoordinatorRepo`), and the
	// behavioural fix — replicating owned blocks once the cohort grows — is separate work.
	//
	// So the trigger is a union of two conditions, not one:
	//
	//  - **undeclared** (the original case): the operator has asserted nothing, so a deployment
	//    smaller than three would be silently unrepairable. Conditional wording ("if you run fewer
	//    than N machines"), never a fault — this fires off configuration, not an observed cohort, so a
	//    correctly-provisioned large deployment sees it too.
	//  - **resolved cohort <= CORROBORATION_FLOOR + 1**, whether declared or not. Declaring
	//    `assumedClusterSize: 3` does not conjure a third peer; it has exactly the same zero tolerance
	//    as an undeclared three. The earlier "a declaration is an explicit assertion we cannot
	//    contradict" reasoning holds for whether the NUMBER is honest — it does not hold for the
	//    fragility implied by the number itself, which is arithmetic.
	//
	// Still one line per node construction (`resolveClusterPolicy` runs once), never per repair: a
	// per-attempt warn on a busy node is noise that gets filtered, which defeats the point. The
	// per-repair half of this — naming a decline that is provably permanent — lives at the repair site
	// instead (`CoordinatorRepo.reportRepairDeadlock`, `cluster-fetch:repair-deadlock`), where the
	// actual cohort is known.
	//
	// NOTE: an operator who declares an assumedClusterSize LARGER than the cohort they actually run is
	// equally unable to repair and still gets no fault — this function has no observed cohort to
	// contradict the declaration with, and the undeclared arm's conditional wording is the closest it
	// can honestly get. If `feat-admission-floor-from-observed-cohort-high-water-mark` ever lands
	// (deriving the yardstick from observation), that check becomes cheap and belongs here.
	const minimumSelfHealingDeployment = CORROBORATION_FLOOR + 1;
	const cohortUndeclared = declaredCohortSize === undefined && clusterSize > minAbsoluteClusterSize;
	const noRepairMargin = repairCorroborationClusterSize <= minimumSelfHealingDeployment;
	if (cohortUndeclared || noRepairMargin) {
		// How many peers besides the reader must answer and agree, at the resolved size. Two once the
		// cohort is three or larger; one for a cohort declared at two, which is the only size whose
		// floor relaxes. Never below one — a claim nobody made is never accepted.
		const requiredAnsweringPeers = Math.max(1, Math.min(CORROBORATION_FLOOR, repairCorroborationClusterSize - 1));
		const availablePeers = Math.max(0, repairCorroborationClusterSize - 1);
		const rule =
			`Block repair (read-repair and reconcile) converges only when ${CORROBORATION_FLOOR} cohort peers ` +
			`BESIDES the reader answer that reader and agree on the same (rev, actionId); that requirement drops ` +
			`to 1 only for a cohort that DECLARES it is smaller than ${minimumSelfHealingDeployment}. ` +
			`${minimumSelfHealingDeployment} machines is therefore the MINIMUM that can repair at all, not a safe ` +
			`size — at exactly ${minimumSelfHealingDeployment} the reader has two peers and needs both, so one ` +
			`peer unreachable from that reader (healthy and reachable from everyone else) leaves that reader's ` +
			`copy permanently unrepairable. ${minimumSelfHealingDeployment + 1} machines is the first size with ` +
			`any margin.`;
		// Every number above counts MACHINES. Saying only that overstates the guarantee, because repair
		// also needs the answering peers to actually HOLD the block — which is a property of the block,
		// not of the deployment, and which no machine count can supply.
		//
		// NOTE: accepted tradeoff — the caveat rides the EXISTING trigger (cohort size undeclared, or
		// repairCorroborationClusterSize <= 3) rather than firing for every deployment. A correctly-
		// declared large deployment is arguably the operator most likely to believe a machine count
		// covers them, and never sees this paragraph at startup; they learn it from the per-block
		// `cluster-fetch:repair-deadlock` line with reason=sole-holder instead. Weighed and kept: a
		// startup advisory that fires on every correctly-configured node forever is one operators
		// filter, which costs more than it buys. Revisit if the per-block line proves too late to be
		// useful — i.e. if field reports show operators hitting stranded founding data without ever
		// having read a repair-deadlock line.
		const holdersCaveat =
			` All of that counts MACHINES, and machines are only half the requirement: the peers that answer ` +
			`must also HOLD the block, and ${CORROBORATION_FLOOR} of them must. A block that only ONE cohort ` +
			`peer holds can never be repaired at ANY deployment size — the sole holder cannot second itself — ` +
			`so every size claim above is about a block at least ${CORROBORATION_FLOOR} peers already hold. ` +
			`The usual way to fall outside that: data written while the deployment (or that block's cohort) ` +
			`was smaller keeps the number of copies it was written with, and GROWING THE DEPLOYMENT DOES NOT ` +
			`COPY IT — so founding data can stay stranded however many machines you later run. That case is ` +
			`reported once per affected block as cluster-fetch:repair-deadlock with reason=sole-holder, and its ` +
			`remedy is another cohort peer holding it (commit a new revision of the block), never more machines.`;
		const undeclaredAdvice = cohortUndeclared
			? ` No clusterPolicy.assumedClusterSize declared, so the floor is measured against ` +
			`repairCorroborationClusterSize=${repairCorroborationClusterSize} and never relaxes: if you actually ` +
			`run fewer than ${minimumSelfHealingDeployment} machines, every repair declines, permanently. Set ` +
			`clusterPolicy.assumedClusterSize to your real cohort size; it does not lower ` +
			`clusterSize=${clusterSize} (the replication factor). Larger deployments can ignore this.`
			: '';
		const noMarginAdvice = noRepairMargin
			? ` This node resolved repairCorroborationClusterSize=${repairCorroborationClusterSize}, which leaves ` +
			`repair with NO fault tolerance: the reader has ${availablePeers} cohort peer(s) and needs ` +
			`${requiredAnsweringPeers} of them to answer, so losing one is not survivable. Run at least ` +
			`${minimumSelfHealingDeployment + 1} machines if repair must survive an unreachable peer.`
			: '';
		log('repair-fault-tolerance', {
			clusterSize,
			repairCorroborationClusterSize,
			corroborationFloor: CORROBORATION_FLOOR,
			declaredCohortSize,
			cohortUndeclared,
			noRepairMargin,
			requiredAnsweringPeers,
			minimumSelfHealingDeployment,
			message: rule + undeclaredAdvice + noMarginAdvice + holdersCaveat
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
		// Pass through undefined (ClusterMember defaults it to 'accept') so an operator who said
		// nothing gets the historical behaviour.
		unvalidatablePendPolicy: options.clusterPolicy?.unvalidatablePendPolicy,
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
