/**
 * How a cluster member folds the storage verdicts of a batch's several operations into the one
 * verdict it retains for the record — the verdict the coordinating node reads off its own member and
 * every other member reports on `ClusterRecord.applyOutcomes`. A one-operation record folds to its
 * one verdict unchanged. See `RepoMessage.operations` for what a batch is.
 */
import type { CommitRequest, CommitResult, CommitSuccess, PendResult, PendSuccess, WriteFailure } from "@optimystic/db-core";
import { isConflictFailure, mergeDurability } from "@optimystic/db-core";

/** One commit operation's post-reconcile durable verdict, and whether a refusal had the behind shape. */
export interface CommitOperationVerdict {
	readonly commit: CommitRequest;
	readonly verdict: CommitResult;
	/** True when the apply ran a behind branch (missing pend, missing base): the refusal is eligible
	 *  for another reconcile, where an ahead-shaped one never is. */
	readonly behind: boolean;
}

/** What a member retains for a commit record: each operation's verdict, and their fold. */
export interface RetainedCommitVerdicts {
	readonly operations: readonly CommitOperationVerdict[];
	readonly folded: CommitResult;
}

/**
 * The record's pend verdict: a success only when every operation's storage pend succeeded, carrying
 * the union of their blocks and every pending action they found. Otherwise the first conflict-shaped
 * refusal, else the first refusal. Conflict first because it is the verdict that changes the writer's
 * answer: `CoordinatorRepo.pendThroughCluster` returns a local conflict and tolerates a local
 * bare-reason fault, so a fault folded ahead of a conflict would answer success over a refusal. An
 * expiry arrives only as a whole-record vote, never from one operation's storage pend, so the fold
 * needs no arm for it.
 */
export function foldPendResults(results: readonly PendResult[]): PendResult {
	const refusals = results.filter((result): result is WriteFailure => !result.success);
	if (refusals.length > 0) {
		return refusals.find(isConflictFailure) ?? refusals[0]!;
	}
	const successes = results as readonly PendSuccess[];
	if (successes.length === 1) {
		return successes[0]!;
	}
	return {
		success: true,
		blockIds: [...new Set(successes.flatMap(success => success.blockIds))],
		pending: successes.flatMap(success => success.pending),
		durability: mergeDurability(successes.map(success => success.durability))
	};
}

/** Retain a commit record's per-operation verdicts with their fold ({@link foldCommitResults}). */
export function retainedCommitVerdicts(operations: readonly CommitOperationVerdict[]): RetainedCommitVerdicts {
	return { operations, folded: foldCommitResults(operations.map(operation => operation.verdict)) };
}

/** Whether a commit operation's retained verdict is a refusal another reconcile may still turn. */
export function isBehindRefusal(operation: CommitOperationVerdict): boolean {
	return !operation.verdict.success && operation.behind;
}

/**
 * The record's commit verdict: a success only when every operation's durable verdict is one — the
 * member holds every collection's revision — and otherwise the first refusal. `CoordinatorRepo` folds
 * its own in-order applies of a batch the same way.
 */
export function foldCommitResults(verdicts: readonly CommitResult[]): CommitResult {
	const refusal = verdicts.find((verdict): verdict is WriteFailure => !verdict.success);
	if (refusal !== undefined) {
		return refusal;
	}
	const successes = verdicts as readonly CommitSuccess[];
	if (successes.length === 1) {
		return successes[0]!;
	}
	return { ...successes[0]!, durability: mergeDurability(successes.map(success => success.durability)) };
}
