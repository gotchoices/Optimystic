import type { ActionId, ActionRev } from "../collection/action.js";
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

/**
 * The single rule for "is the action holding this revision OUR OWN?" — true only when `latest`
 * names exactly the revision being requested AND the same action requesting it.
 *
 * A write touching several blocks is committed one group at a time, so it can end up with some
 * blocks durable and the rest refused (a *torn action*). The retry reuses the same `actionId`, so
 * every revision check meets the writer's own durable half and must treat it as a no-op rather
 * than as a rival's win — otherwise the writer is refused by its own committed work, forever.
 *
 * Deliberately `===` only. At `latest.rev > rev` this returns false even for our own action: the
 * follow-on commit is refused as stale anyway (`StorageRepo.commit`'s `missedCommits` branch), so
 * approving would only defer the refusal by a round trip, and `latest` alone can no longer name
 * who holds `rev` — that needs the revision index (see `IRevisionActionReader`).
 *
 * Every revision-vs-action check calls this: the pend tier (`StorageRepo.pend`,
 * `ClusterMember.validatePendOperations`, `CoordinatorRepo.classifyStaleRejection`) and the commit
 * tier (`StorageRepo.commit`'s `alreadyDone` partition, `ClusterMember.validateCommitRevisions`).
 * Single-sourcing it is what makes "all the tiers agree" a fact rather than a comment.
 */
export function isOwnRevision(latest: ActionRev | undefined, rev: number | undefined, actionId: ActionId): boolean {
	return latest !== undefined && rev !== undefined && latest.rev === rev && latest.actionId === actionId;
}
