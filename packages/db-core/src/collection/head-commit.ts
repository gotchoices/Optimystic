import type { CommitResult, WriteDurability } from "../network/struct.js";
import type { CollectionId, HeadCommitOptions } from "./struct.js";
import type { EntryId } from "./segments.js";
import type { RefreshReport } from "./collection.js";
import { AttemptCycle, retainedAttempt } from "./write-attempts.js";
import type { StagedAttempt } from "./write-attempts.js";

/**
 * One collection's head commit — the commit of its oldest sealed segment as one log entry
 * (docs/offline-sync.md §One entry, one network transaction) — exposed one step at a time, so a
 * driver outside the collection can run the steps in the order it needs. `Collection.openHeadCommit`
 * creates one, as a closure over the collection's private state, having taken the collection latch,
 * checked the segment is committable, marked the action in flight and set the head entry for the
 * cycle; the handle holds that latch until {@link close}, except between {@link release} and
 * {@link retake}. Two drivers exist: {@link driveHeadCommit}, the one-collection loop behind
 * `Collection.commitHead`, and the coordinator's per-entry commit over several collections, which
 * has to run each step on every collection it wrote in lock-step — build every attempt, release
 * every latch, one pend-all-then-commit round, retake every latch, apply one outcome each — which
 * is only possible with the steps callable from outside.
 *
 * The step order a driver keeps: {@link refresh} (the cycle opens with one, and one follows every
 * refused attempt); then per attempt {@link stage}, the write-ahead hook with the staged attempt,
 * {@link release}, {@link send} (or the coordinator's own round), {@link retake} in a `finally`,
 * then {@link fold} followed by {@link replay} on success, or {@link refused} on a refusal. Every
 * step but {@link send} runs under the latch, and the handle throws as a defect when one is called
 * with the latch released, after {@link close}, or ({@link retake}) while it is already held.
 *
 * Two handles on two collections are opened in SORTED collection-id order by any driver that opens
 * more than one — the order `TransactionCoordinator.commitOnce` acquires the same latches in —
 * since a multi-collection commit over the same collections would otherwise deadlock against it.
 * The handle does no sorting of its own; it is one collection's.
 */
export interface HeadCommitHandle {
	readonly collectionId: CollectionId;
	/** The collection handle's tag (`Collection.instanceTag`), for the cycle's log lines. */
	readonly instanceTag: string;
	/** The sealed segment this handle commits — the head when it was opened, and asserted still
	 * the head by every step that touches it. */
	readonly entryId: EntryId;
	/** The refresh between attempts, run under the latch this handle holds: `Collection.updateInternal`
	 * with the write's own report, so an entry an earlier attempt stored is finished and consumed as
	 * the head (`Collection.consumeHead`). Same contract as `Collection.refreshInFlight`, minus the
	 * latch. */
	refresh(report: RefreshReport, lastChance: boolean, tailFloor?: number): Promise<void>;
	/** The revision the next attempt requests, and the one the collection holds, for the cycle's
	 * stall accounting (`AttemptCycle.beforeAttempt`). */
	nextRev(): number;
	heldRev(): number | undefined;
	/** Re-check the head is still committable (a refresh may have refused it meanwhile — the
	 * recorded refusal is thrown), then build the attempt at {@link nextRev} on the head tracker,
	 * reused while the revision and the bases under it are unchanged (`Collection.headTrackerFor`). */
	stage(): Promise<StagedAttempt>;
	/** Send one attempt through this collection's own transactor source — the one-collection
	 * path's pend-and-commit, under the cycle's aged retry `priority`. The coordinator never calls
	 * it: its round goes through its own phases. Made with the latch released. */
	send(staged: StagedAttempt, priority: number): Promise<CommitResult>;
	/** Release the latch for the network round trip and set `Collection.headInFlight`, so a refresh
	 * that walks into this commit's entry meanwhile defers, and `dropSealed` of the head refuses. */
	release(): void;
	/** Retake the latch and clear `Collection.headInFlight`. Never throws for a refusal: the caller
	 * re-checks through {@link stage} or {@link refused}, so a send error is not masked. */
	retake(): Promise<void>;
	/** A committed attempt's local treatment, first half, synchronous: remove the head segment
	 * (asserted still first), bump the segment version, fold the attempt's transforms into the
	 * cache and adopt its revision (`Collection.foldOwnCommit`). */
	fold(staged: StagedAttempt): void;
	/** Second half: replay the remaining sealed segments and the open segment over the committed
	 * state that now holds the head. Always after {@link fold} — the order `Collection.updateInternal`
	 * requires. Two calls rather than one because the coordinator's success path folds every
	 * participant in one await-free pass before replaying any, the event-loop atomicity its
	 * existing success fold promises (`TransactionCoordinator.commitOnceLatched`). */
	replay(): Promise<void>;
	/** A refused attempt: re-check the head's recorded refusal (thrown), then retain the attempt
	 * (`Collection.retainInFlightAttempt`) so the next refresh can finish it. */
	refused(staged: StagedAttempt): void;
	/** End the cycle: clear the head entry, dispose the in-flight mark, release the latch if held.
	 * Idempotent, and tolerant of a latch left released (a driver that threw between
	 * {@link release} and {@link retake} without retaking): it then clears the marks latch-free
	 * rather than block on a latch inside a cleanup. Every exit of a driver passes through it. */
	close(): void;
}

/**
 * The one-collection driver: the attempt cycle behind `Collection.commitHead`, with the
 * {@link AttemptCycle} accounting a sync's attempts use. The cycle opens with a refresh (like
 * `Collection.updateAndSync`), which — the action being marked in flight, and `options.resume`
 * seeded when the caller recorded an earlier attempt — finishes or recognises an entry an earlier
 * cycle under the same action id left in the log, and consumes the head instead of committing a
 * second copy. Then attempts until the head is committed: the pre-attempt checks, the attempt built
 * on the head tracker, the write-ahead hook (`options.recordAttempt`, awaited under the latch, so a
 * throw aborts before anything is sent), the latch released around the one network `await` and
 * retaken whatever becomes of it, and the outcome applied under the retaken latch — fold then
 * replay on a commit, or the refusal retained and the refresh-until-settled loop on a refusal.
 *
 * The head's recorded refusal is re-checked at the two points a refresh may have refused it:
 * building the attempt ({@link HeadCommitHandle.stage}) and right after a refused send
 * ({@link HeadCommitHandle.refused}), each of which throws it in place of a retry. The refusal is
 * re-checked after the cycle's pre-attempt checks rather than before them, so a cycle that is both
 * aborted (or past its deadline) and refused reports the abort; the previous in-line loop checked
 * the refusal first, and nothing observable depends on which wins.
 *
 * Does not close the handle: the caller that opened it does, in a `finally`.
 *
 * @returns what `Collection.sync` returns: who holds the commit, or `undefined` when the opening
 * refresh established the write was already saved under `options.actionId` without re-sending
 * (the status-read fallback of `Collection.completeOwnEntry`).
 * @throws the head's recorded refusal, an `ActionRefusedError`; whatever `options.recordAttempt`
 * throws, before anything is sent; otherwise what `Collection.sync` throws. */
export async function driveHeadCommit(handle: HeadCommitHandle, options: HeadCommitOptions): Promise<WriteDurability | undefined> {
	const cycle = new AttemptCycle(handle.collectionId, handle.instanceTag, options);
	const refresh = (report: RefreshReport, lastChance: boolean, tailFloor: number | undefined) =>
		handle.refresh(report, lastChance, tailFloor);
	let saved = await cycle.refreshUntilSettled(refresh);
	while (!saved) {
		cycle.beforeAttempt(handle.nextRev(), handle.heldRev());
		const staged = await handle.stage();
		await options.recordAttempt?.(retainedAttempt(staged, options.actionId));
		const attempt = await sendUnlatched(handle, staged, cycle.priority());
		if (attempt.success) {
			cycle.recordCommit(attempt.durability);
			handle.fold(staged);
			await handle.replay();
			saved = true;
		} else {
			// Re-checked before the refusal is counted: a reader's refresh while the latch was
			// released may have adopted the rival this attempt lost to and refused the head in its
			// replay, and that refusal, not another attempt, is then the cycle's answer.
			handle.refused(staged);
			cycle.recordRefusal(attempt);
			saved = await cycle.refreshUntilSettled(refresh);
		}
	}
	return cycle.durability;
}

/** The one network round trip, made with the latch released and retaken before anything else runs
 * — on a throw too, so the handle is never closed over a latch it does not hold. */
async function sendUnlatched(handle: HeadCommitHandle, staged: StagedAttempt, priority: number): Promise<CommitResult> {
	handle.release();
	try {
		return await handle.send(staged, priority);
	} finally {
		await handle.retake();
	}
}
