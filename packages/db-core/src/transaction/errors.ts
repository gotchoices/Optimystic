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
