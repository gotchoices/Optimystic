import type { StaleFailure } from "./struct.js";

/**
 * The single rule for "is this non-success retryable after a re-read?" Both write paths and the
 * transactor's aggregation call this — no consumer re-derives it.
 *
 * {@link StaleFailure.conflict} is authoritative when present. The `missing`/`pending` fallback
 * covers producers that have not been taught the field, including a remote peer on an older build
 * (the repo protocol is plain JSON, so an unset field simply arrives absent).
 */
export function isConflictFailure(failure: StaleFailure): boolean {
	return failure.conflict ?? Boolean(failure.missing?.length || failure.pending?.length);
}

/**
 * The single rule for picking one {@link StaleFailure.staleAt} out of several candidates.
 *
 * Highest `rev` wins: the losing writer's next request has to clear EVERY holder, so the largest
 * confirmed revision is the binding constraint and any smaller one understates it. Ties keep the
 * earlier candidate. Undefined entries (a block or batch with no confirmed number, or a peer that
 * predates the field) contribute nothing, and an all-undefined input yields undefined so callers
 * can omit the key rather than emit `staleAt: undefined`.
 *
 * Every site that has more than one candidate calls this — the producers scanning several blocks
 * (`StorageRepo.pend`/`.commit`, `CoordinatorRepo.classifyStaleRejection`) as well as
 * `NetworkTransactor` rebuilding one response from many per-batch ones. Uniformity is what makes
 * the transactor's aggregate meaningful: if a producer reported an arbitrary block instead of its
 * highest, taking the max across producers would still understate the constraint.
 *
 * NOTE: comparing revisions across blocks is only meaningful because one pend covers one
 * collection, so every candidate comes from the same revision counter. If a pend is ever allowed
 * to span collections, these numbers come from unrelated counters and selection must become
 * per-collection.
 */
export function highestStaleAt(candidates: readonly StaleFailure['staleAt'][]): StaleFailure['staleAt'] {
	let best: StaleFailure['staleAt'];
	for (const candidate of candidates) {
		if (candidate !== undefined && (best === undefined || candidate.rev > best.rev)) {
			best = candidate;
		}
	}
	return best;
}
