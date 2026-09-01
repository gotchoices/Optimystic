/**
 * The deterministic arbiter between two conflicting cluster transactions: which of two writes to a
 * shared block wins. Every function here is a total function of its arguments, with no member state
 * and no effect beyond a debug log — `resolveRace` runs on the vote path, where a throw would cost
 * the member its vote entirely — so the ordering rule can be read and tested on its own (see
 * `test/race-resolution.spec.ts`). The stateful scan that consults them (`findConflict`, which sweeps stale
 * reservations and clears a losing transaction) stays on `ClusterMember` in `cluster-repo.ts`.
 */
import type { ClusterRecord, RepoMessage } from "@optimystic/db-core";
import { clampPriority } from "@optimystic/db-core";
import { getActionId, getAffectedBlockIds } from "./record-operations.js";
import { createLogger } from "../logger.js";

// Same sub-namespace `cluster-repo.ts` logs under: these functions moved out of `ClusterMember`, and
// their emitted tags (and the `debug` namespace they land in) must stay byte-identical, because
// several specs capture by namespace and tag substring.
const log = createLogger('cluster-member')

/** Number of *approve* promise votes on a record — the count the commit rule uses. */
export function approvalCount(record: ClusterRecord): number {
	return Object.values(record.promises).filter(s => s.type === 'approve').length;
}

/**
 * Resolve a race between two conflicting transactions. Total and deterministic, so every honest
 * member computes the identical winner (the Theorem 1 Case-2 premise). Order:
 *   1. more *approve* promise signatures wins  (progress monotonicity — see safety note below);
 *   2. equal approval counts → higher aged priority wins  (fairness — see {@link recordPriority});
 *   3. still tied → higher message hash wins.
 *
 * The count is APPROVALS, not `promises` keys. `promises` is the vote map — a reject occupies a key
 * there exactly as an approve does — so counting keys would treat a rejection as progress, letting a
 * record that can never commit outrank (and therefore block, via the reservation scan `findConflict`
 * in `cluster-repo.ts`) a fresh rival for the whole staleness window. Approvals is also the count
 * the invariant below actually needs: the commit rule is `approvedPromises >= superMajority`,
 * which never looks at rejections.
 *
 * Approval count is FIRST so this comparison never displaces a transaction that is further along.
 * That restores the pre-priority safety invariant: a member commits purely on promise supermajority
 * (`handleCommitNeeded` signs whenever `approvedPromises >= superMajority`; the commit path has NO
 * conflict re-check), so `resolveRace` is the ONLY arbiter among concurrently-pending conflicts.
 * With approvals-first, once transaction X holds a promise supermajority every conflicting rival Y has
 * strictly fewer approvals — Y can only match X's count by getting the intersecting quorum member to
 * approve it, but that member already holds X at supermajority and `resolveRace(X, Y)` returns
 * `keep-existing` on X's higher count, so it never does. By quorum intersection any Y-supermajority
 * overlaps X's in ≥1 honest member, and that member rejects Y. One winner (docs/correctness.md
 * Theorem 9). Priority-first would break this: it could displace an already-quorum-reached X for a
 * higher-priority Y with fewer approvals, letting BOTH commit (split brain) — the regression fixed by
 * ticket occ-priority-first-breaks-promise-monotonicity.
 *
 * Priority is now a tie-break that runs only at EQUAL approval counts, which is exactly the
 * concurrent-starvation case aging targets (two fresh rivals, 0 promises each, otherwise coin-flipping
 * on the hash). Priority still breaks those ties deterministically, so aging still solves the stated
 * fairness problem in its common case. It only orders two *concurrently-pending* conflicts; it does NOT
 * defer a fresh pend for an absent aged transaction (that residual — sequential sub-window starvation —
 * is the deferred feat-occ-priority-reservation).
 *
 * NOTE: residual-fairness tripwire. Under approvals-first an aged transaction can still lose to a fresh
 * rival that has *legitimately* gathered even one more approval — that is not the pure-coin-flip
 * starvation aging targets (equal counts, priority wins), it is the monotonicity behaviour we WANT (a
 * more-progressed rival is never displaced). If deeper fairness against a genuinely-more-progressed
 * rival is ever needed, it belongs to feat-occ-priority-reservation (reserve/defer at pend time), NOT
 * to this race tie-break.
 *
 * NOTE: Byzantine self-assert is a fairness DoS, not a safety hole. A coordinator can stamp
 * priority == MaxPriority on every transaction; recordPriority clamps to the cap so it cannot
 * exceed it, and priority never influences validity/operationsHash/stale-read checks — and now sits
 * below the approval count, so it can only break equal-count ties it might have ~50% won anyway,
 * degrading to at-worst-status-quo fairness (the same graceful-degradation class as spam under
 * honest-majority). Binding priority to provable age is out of scope (feat-occ-priority-reservation).
 *
 * NOTE: keep priority a self-contained additive message field + this one comparison key so it
 * composes with — does not block — a future HLC/crdt-sync redesign of this same path
 * (design-hot-log-tail-sharding-guidance).
 */
export function resolveRace(existing: ClusterRecord, incoming: ClusterRecord): 'keep-existing' | 'accept-incoming' {
	// 1. Transaction with more APPROVALS wins — never displace a more-progressed rival (safety, see
	// above). Counting `promises` keys instead would count reject votes as progress: a record holding
	// one rejection would outrank an untouched rival and reserve its blocks for the whole staleness
	// window, and the commit rule this ordering protects (`approvedPromises >= superMajority`) never
	// looks at rejections anyway.
	const existingCount = approvalCount(existing);
	const incomingCount = approvalCount(incoming);
	if (existingCount !== incomingCount) {
		return existingCount > incomingCount ? 'keep-existing' : 'accept-incoming';
	}

	// 2. Equal approval counts → higher aged priority wins (fairness tie-break).
	const existingPriority = recordPriority(existing);
	const incomingPriority = recordPriority(incoming);
	if (existingPriority !== incomingPriority) {
		return existingPriority > incomingPriority ? 'keep-existing' : 'accept-incoming';
	}

	// 3. Tie-breaker: higher message hash wins (deterministic).
	return existing.messageHash > incoming.messageHash ? 'keep-existing' : 'accept-incoming';
}

/**
 * Aged advisory priority carried by a record's pend operation, clamped to [0, MaxPriority].
 * The multi-collection path carries it on `pend.validation.transaction.priority`; the single-collection
 * (`Collection.sync`) path carries it as top-level `pend.priority`; a record with neither — a
 * legacy/unversioned coordinator's transaction, or a non-pend operation — is priority 0
 * (backward compatible: such transactions simply never age). Both carriers live inside the signed
 * `message`, so priority is integrity-protected in transit; clamping here bounds a self-asserted
 * out-of-range value to the cap.
 *
 * NOTE: `message` is fixed for a transaction's whole lifecycle (promises/commits accrue in the
 * separate `promises`/`commits` maps, never in `message`), so a transaction keeps its rank through
 * the commit phase — there is no "priority drops to 0 at commit" asymmetry. resolveRace is only
 * consulted at the promise decision (`findConflict` in `cluster-repo.ts`), i.e. between two
 * still-open conflicting transactions, which is exactly the concurrent-contention case priority
 * is meant to order.
 */
export function recordPriority(record: ClusterRecord): number {
	for (const op of record.message.operations) {
		if ('pend' in op) {
			// Every hop optional: `validation` arrives off the wire inside a signed message whose
			// hash binds its bytes, not its shape, so a malformed pair must yield priority 0 (what
			// clampPriority already does for a missing or Byzantine number) rather than throw out
			// of the vote path — the lost vote this fail-closed pass exists to prevent.
			return clampPriority(op.pend.validation?.transaction?.priority ?? op.pend.priority);
		}
	}
	return 0;
}

/**
 * Whether two messages must serialize against each other: true when they touch a common block AND
 * are not the same action. The same-action escape is what lets a commit follow its own pend — both
 * name every block the action writes, so a bare overlap test would have each transaction blocking
 * its own next phase. Gates whether {@link resolveRace} runs at all.
 */
export function operationsConflict(ops1: RepoMessage['operations'], ops2: RepoMessage['operations']): boolean {
	// Check if one is a commit for the same action as a pend - these don't conflict
	const actionId1 = getActionId(ops1);
	const actionId2 = getActionId(ops2);
	if (actionId1 && actionId2 && actionId1 === actionId2) {
		// Same action - commit is resolving the pend, not conflicting
		return false;
	}

	const blocks1 = new Set(getAffectedBlockIds(ops1));
	const blocks2 = new Set(getAffectedBlockIds(ops2));

	for (const block of Array.from(blocks1)) {
		if (blocks2.has(block)) {
			log('cluster-member:conflict-detected', {
				blocks1: Array.from(blocks1),
				blocks2: Array.from(blocks2),
				conflictingBlock: block
			});
			return true;
		}
	}

	return false;
}
