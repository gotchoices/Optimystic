import type { VTime } from './types.js';
import { CohortMembership } from './cohort-membership.js';

/**
 * Network-partition split/heal over a cohort membership, modeled against `docs/cohort-topic.md`
 * §Partition heal and §Failure modes (Network partition healing). A partition cuts a cohort into
 * two disjoint memberships that each serve their side independently; on heal the two sides merge
 * and — because the slot assignment is a pure function of `(participantId, cohortEpoch, members)`
 * and the merged member set reproduces the pre-split set — both sides re-derive the *same*
 * deterministic primary in ~one gossip round. Subscribers detect the move via `primary_moved`.
 */

/** An injected partition: members in `sideA` are isolated from the rest between `atMs` and `healMs`. */
export interface PartitionSpec {
	readonly atMs: VTime;
	readonly healMs: VTime;
	readonly sideA: ReadonlySet<string>;
}

/** Split a membership into `[sideA, sideB]` by the partition cut. */
export function splitMembership(
	membership: CohortMembership,
	sideA: ReadonlySet<string>
): [CohortMembership, CohortMembership] {
	return membership.split((id) => sideA.has(id));
}

/** Heal: merge the two sides back into one membership (its epoch matches the pre-split set). */
export function healMembership(a: CohortMembership, b: CohortMembership): CohortMembership {
	return CohortMembership.merge(a, b);
}

/** Per-participant convergence record across one split → heal cycle. */
export interface PartitionConvergence {
	readonly preEpoch: string;
	readonly healedEpoch: string;
	readonly sideAPrimary: string;
	readonly sideBPrimary: string;
	readonly healedPrimary: string;
	/** True when the healed assignment reproduces the pre-split primary (both sides converge). */
	readonly converged: boolean;
}

/**
 * Convergence oracle for one participant across a split→heal of `pre` into `(a, b)`: the healed
 * (merged) membership's primary equals the pre-split primary, so the two sides — which generally
 * disagreed while partitioned — agree again after heal.
 */
export function checkConvergence(
	pre: CohortMembership,
	a: CohortMembership,
	b: CohortMembership,
	participantId: string
): PartitionConvergence {
	const healed = healMembership(a, b);
	const healedPrimary = healed.assign(participantId).primary;
	return {
		preEpoch: pre.epoch,
		healedEpoch: healed.epoch,
		sideAPrimary: a.assign(participantId).primary,
		sideBPrimary: b.assign(participantId).primary,
		healedPrimary,
		converged: healed.epoch === pre.epoch && healedPrimary === pre.assign(participantId).primary
	};
}
