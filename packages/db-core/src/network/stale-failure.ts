import type { BlockId } from "../index.js";
import type { ActionId, ActionRev } from "../collection/action.js";
import type { ExpiredFailure, RejectedFailure, ShortfallFailure, StaleFailure, WriteFailure } from "./struct.js";

/**
 * The single rule for "is this non-success retryable after a re-read?" Both write paths and the
 * transactor's aggregation call this — no consumer re-derives it.
 *
 * {@link StaleFailure.conflict} is authoritative when present. The `missing`/`pending` fallback
 * covers producers that have not been taught the field, including a remote peer on an older build
 * (the repo protocol is plain JSON, so an unset field simply arrives absent). An expiry
 * ({@link isExpiryFailure}), a promise shortfall ({@link isShortfallFailure}) and a validity
 * rejection ({@link isRejectedFailure}) are never a conflict, whatever else arrived beside them.
 */
export function isConflictFailure(failure: WriteFailure): boolean {
	if (isExpiryFailure(failure) || isShortfallFailure(failure) || isRejectedFailure(failure)) return false;
	return failure.conflict ?? Boolean(failure.missing?.length || failure.pending?.length);
}

/**
 * The single rule for "did the cohort refuse this write because the transaction had already expired
 * by the members' clocks?" ({@link ExpiredFailure}). Every write path stops on it rather than
 * retrying, since a retry's expiration comes from the same clock. Decided by the structured field,
 * never the reason text; a peer on a build that predates the field never sends it, and its refusal
 * reads as the shape it always had.
 */
export function isExpiryFailure(failure: WriteFailure): failure is ExpiredFailure {
	return failure.expired !== undefined;
}

/**
 * The single rule for "did the cohort refuse this pend because too few of its members answered the
 * promise round?" ({@link ShortfallFailure}). Every write path stops on it rather than retrying, since
 * every coordinator of the cohort meets the same silent members. Decided by the structured field,
 * never the reason text; a coordinator on a build that predates the field throws the shortfall
 * instead of returning it, which a writer sees as it always did.
 */
export function isShortfallFailure(failure: WriteFailure): failure is ShortfallFailure {
	return failure.shortfall !== undefined;
}

/**
 * The single rule for "did the cohort refuse this pend because the members that sank it judged the
 * transaction invalid?" ({@link RejectedFailure}). Every write path stops on it rather than retrying,
 * since re-sending the same content to the same checks is refused the same way. Decided by the
 * structured field, never the reason text; a coordinator on a build that predates the field throws the
 * rejection instead of returning it, which a writer sees as it always did.
 */
export function isRejectedFailure(failure: WriteFailure): failure is RejectedFailure {
	return failure.rejected !== undefined;
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
 * NOTE: comparing revisions across blocks is meaningful only within one collection, where every
 * candidate comes from the same revision counter. A batch (`IRepo.pendMany` / `commitMany`) spans
 * collections, and `CoordinatorRepo` still picks the highest across them, so its `staleAt` names the
 * block — and so the collection — of one loser among several counters. The multi-collection
 * coordinator, the only writer that sends a batch, therefore attributes a batched answer's number by
 * its block id ({@link staleAtOwner}): the collection owning `staleAt.blockId` gets the number, and
 * every other collection of the batch is treated as refused with no confirmed number. The other
 * collections' losses are understated by that, never overstated — a number is only ever compared
 * against the counter it came from.
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
 * The single rule for attributing a {@link StaleFailure.staleAt} that answered a request spanning
 * several collections: the one collection whose blocks include `staleAt.blockId`, or `undefined`
 * when no candidate owns it (a block none of them sent, or no number at all).
 *
 * A revision is a per-collection counter, so the number is meaningful only against the counter of
 * the collection that owns the block it names. A request for ONE collection needs no attribution —
 * its number is that collection's whatever block it names — so this is for the batched answer
 * (`IRepo.pendMany` / `commitMany`), where `CoordinatorRepo` reports one number, the highest across
 * the batch's collections ({@link highestStaleAt}), and only the owner of the named block may count
 * it as its own.
 */
export function staleAtOwner<Owner>(staleAt: StaleFailure['staleAt'], blocksByOwner: ReadonlyMap<Owner, readonly BlockId[]>): Owner | undefined {
	if (staleAt === undefined) {
		return undefined;
	}
	for (const [owner, blockIds] of blocksByOwner) {
		if (blockIds.includes(staleAt.blockId)) {
			return owner;
		}
	}
	return undefined;
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
 * who holds `rev` — that needs the revision index (see `IRevisionActionReader`). Nor would the
 * index settle what the writer actually needs to know there, which is whether the content now held
 * was BUILT FROM its revision; that is a separate question with its own answer
 * (`IBlockStorage.lineageOf`, asked by the writer through `ITransactor.getLineage` once its re-send
 * has been refused), not a widening of this one.
 *
 * Every revision-vs-action check calls this: the pend tier (`StorageRepo.pend`,
 * `ClusterMember.validatePendOperations`, `CoordinatorRepo.classifyStaleRejection`) and the commit
 * tier (`StorageRepo.commit`'s `alreadyDone` partition, `ClusterMember.validateCommitRevisions`).
 * Single-sourcing it is what makes "all the tiers agree" a fact rather than a comment.
 */
export function isOwnRevision(latest: ActionRev | undefined, rev: number | undefined, actionId: ActionId): boolean {
	return latest !== undefined && rev !== undefined && latest.rev === rev && latest.actionId === actionId;
}
