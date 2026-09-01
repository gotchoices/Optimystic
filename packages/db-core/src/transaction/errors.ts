import type { CollectionId } from "../collection/index.js";

/**
 * Thrown by {@link TransactionCoordinator.commit} when a multi-collection commit
 * fails AFTER at least one collection has already DURABLY committed through the
 * distributed consensus path (GATHER/PEND/COMMIT).
 *
 * ## Why this exists (and why we can't just "roll back")
 *
 * The COMMIT phase commits each collection's pended blocks independently (see
 * `commitPhase`). A per-collection commit can *permanently* fail — e.g. a racing
 * transaction advanced that collection's log tail between PEND and COMMIT (a stale
 * loss) — while the other collections commit successfully. Those durable commits
 * are per-collection and there is no cross-collection undo, so a failure on one
 * collection cannot un-commit the ones that already landed.
 *
 * Uniformly restoring every collection's pre-commit local state (as a clean
 * rollback would) is exactly wrong here: for a collection that DID durably commit
 * it would re-stage its already-durable actions as still-pending, making local
 * tracker memory disagree with cluster storage. Instead the coordinator gives the
 * committed collections the success-path local treatment (fold to cache + reset)
 * and only reverts the failed/never-committed collections, then surfaces THIS error
 * naming both sets so the caller knows reconciliation is required and does NOT
 * falsely report a clean rollback.
 *
 * This is the session-mode / distributed-consensus analog of the plugin's legacy
 * `PartialCommitError` (single-node, per-tree `sync()`).
 *
 * ## The design decision is settled (not "still open")
 *
 * The default multi-collection guarantee is formally **atomicity of intent + eventual,
 * reported visibility**, NOT all-or-nothing — see `docs/correctness.md` **Theorem 3** and
 * `docs/transactions.md` (§ "Session-mode (distributed) commit is not atomic across
 * collections"). This error IS that guarantee's reporting surface, not a placeholder for a
 * stronger one. Genuine cross-collection all-or-nothing is a future opt-in strong mode
 * (backlog `feat-cross-collection-atomic-commit`).
 *
 * ## Reconcile contract for the catcher
 *
 * A caller receiving this error MUST NOT blindly retry the whole transaction and MUST NOT
 * treat it as a clean abort: `committedCollections` are durable and cannot be rolled back,
 * so a whole-transaction retry would double-apply them. Reconcile the named committed set
 * against `failedCollections` (re-drive only the failed collections, or repair the split).
 */
export class CoordinatorPartialCommitError extends Error {
	constructor(
		/** Collections durably committed via consensus before the failure (NOT rolled back). */
		public readonly committedCollections: readonly CollectionId[],
		/** Collections that never committed this attempt (local state reverted for retry). */
		public readonly failedCollections: readonly CollectionId[],
		/** The underlying commit-phase failure that aborted the commit. */
		public readonly reason?: unknown,
	) {
		super(
			`Multi-collection commit was not atomic: ${committedCollections.length} collection(s) ` +
			`durably committed via distributed consensus before the commit failed and CANNOT be ` +
			`rolled back — reconciliation is required. ` +
			`Committed (durable, now out of sync with the failed collections): [${committedCollections.join(', ')}]. ` +
			`Failed (never committed; local state reverted for retry): [${failedCollections.join(', ')}]. ` +
			`Underlying failure: ${reason instanceof Error ? reason.message : String(reason)}`
		);
		this.name = 'CoordinatorPartialCommitError';
	}
}

/**
 * Thrown by {@link TransactionCoordinator.commit} when a multi-collection commit failed as a
 * CLEAN stale loss — an optimistic-concurrency conflict (a racing transaction advanced a log tail)
 * in which NOTHING durably committed, so every participating collection's local tracker was
 * restored to its pre-append state and the transaction is safe to re-drive.
 *
 * This is the retryable counterpart to {@link CoordinatorPartialCommitError}: a partial landing
 * cannot be blindly retried (it would double-apply the durable half), but a clean loss can. The
 * coordinator's built-in backoff+jitter retry catches this internally and re-drives after re-reading
 * fresh revisions; it only escapes to the caller once the retry budget (`maxAttempts` / `deadlineMs`)
 * is exhausted, at which point it signals "gave up after a clean loss" rather than a partial split.
 */
export class CoordinatorStaleLossError extends Error {
	constructor(
		/** Collections that lost the race this attempt (all had their local state reverted for retry). */
		public readonly failedCollections: readonly CollectionId[],
		/** The underlying stale/conflict reason surfaced by the failed pend/commit phase. */
		public readonly reason?: string,
	) {
		super(
			`Multi-collection commit failed on a clean stale loss (no collection durably committed) ` +
			`for [${failedCollections.join(', ')}]` + (reason ? ` — ${reason}` : '')
		);
		this.name = 'CoordinatorStaleLossError';
	}
}

/**
 * Thrown by {@link TransactionCoordinator.applyActions} and {@link TransactionCoordinator.commit}
 * (and returned as a failure result by {@link TransactionCoordinator.execute}) when a second
 * transaction stamp is opened while the coordinator already tracks an open stamp.
 *
 * ## Why the coordinator refuses instead of isolating
 *
 * The coordinator's registered collections hold exactly ONE staged state — one set of tracker
 * transforms and one pending action queue per collection, shared by every open stamp. Two stamps
 * staging through one coordinator therefore read each other's uncommitted rows, and committing
 * either stamp writes the OTHER's staged actions into its own durable log entry (a commit builds
 * each log entry from the collection's whole pending queue, and the pended transforms carry no
 * stamp tag to filter by). There is no correct commit for that configuration, so the coordinator
 * enforces at most one open stamp at a time.
 *
 * ## Recovery
 *
 * Commit or roll back the open stamp first. A CLEAN commit failure deliberately keeps its stamp
 * open so `rollback(stampId)` remains a complete recovery — which means an abandoned failed
 * commit holds the coordinator against new stamps until someone rolls it back.
 *
 * Callers that genuinely need concurrent writers must give each writer its own `Collection`
 * instances — its own bridge and coordinator (see docs/transactions.md, "One writer at a time on
 * the shared TransactionBridge"). Two configurations stay the caller's contract to avoid because
 * this guard cannot see them: two coordinators sharing the same collection instances, and two
 * writers that stage only via `Tree.stage` / `Collection.act` (which open no stamp at all).
 *
 * A stamp opens at its first {@link TransactionCoordinator.applyActions} call. On the Quereus
 * path that is the pre-stage-barrier call the bridge makes at the first STATEMENT — so a second
 * bridge sharing this coordinator fails at its first statement, not at BEGIN.
 */
export class CoordinatorConcurrentStampError extends Error {
	constructor(
		/** The stamp already open on this coordinator. */
		public readonly openStampId: string,
		/** The stamp that was refused. */
		public readonly rejectedStampId: string,
	) {
		super(
			`Transaction stamp ${rejectedStampId} refused: this coordinator already tracks open stamp ` +
			`${openStampId}, and its collections hold only one staged state, so two concurrent stamps ` +
			`cannot be kept apart. Commit or roll back stamp ${openStampId} first — a failed commit ` +
			`keeps its stamp open until it is rolled back. Concurrent writers each need their own ` +
			`Collection instances (own bridge/coordinator per writer). A stamp opens at its first ` +
			`applied statement (the pre-stage applyActions barrier), not at BEGIN.`
		);
		this.name = 'CoordinatorConcurrentStampError';
	}
}
