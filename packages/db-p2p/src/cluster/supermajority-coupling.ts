import { DEFAULT_SUPER_MAJORITY_THRESHOLD } from "@optimystic/db-core";

/** A component that exposes the super-majority threshold it actually runs on. */
export interface HasEffectiveSuperMajorityThreshold {
	readonly effectiveSuperMajorityThreshold: number;
}

/**
 * Fail-fast coupling check for a live node's consensus wiring.
 *
 * The cluster **member** (what accepts a super-majority of promises as sufficient for a commit) and the
 * **coordinator** (what declares a transaction committed once it has that super-majority) MUST run the
 * SAME `superMajorityThreshold`. If they disagree, the coordinator can declare a transaction final on a
 * super-majority the member never accepts as final — a silent phase-disagreement that only surfaces
 * mid-consensus, far too late.
 *
 * On a live node both are fed from a single resolved `consensusConfig`, so this check normally passes. It
 * exists to catch *future* drift — divergent fallback defaults, a mis-threaded `clusterPolicy`, a
 * per-deployment config that reaches only one side — by throwing at construction with both values and
 * their provenance, rather than letting the node come up mismatched.
 *
 * @throws Error naming both resolved thresholds and where they come from, if they are not equal.
 */
export function assertSuperMajorityCoupling(
	member: HasEffectiveSuperMajorityThreshold,
	coordinator: HasEffectiveSuperMajorityThreshold
): void {
	const memberThreshold = member.effectiveSuperMajorityThreshold;
	const coordinatorThreshold = coordinator.effectiveSuperMajorityThreshold;
	if (memberThreshold !== coordinatorThreshold) {
		throw new Error(
			`Super-majority threshold mismatch at node startup: cluster member resolved ${memberThreshold} but coordinator resolved ${coordinatorThreshold}. ` +
			`Both derive from consensusConfig.superMajorityThreshold (options.clusterPolicy?.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD=${DEFAULT_SUPER_MAJORITY_THRESHOLD}); ` +
			`they must be equal or the coordinator would declare transactions committed on a super-majority the member rejects as final.`
		);
	}
}
