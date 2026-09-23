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
 *
 * NOTE: from three members up, a member that is neither of the two racing coordinators still votes for
 * whichever record reached it FIRST, and its own approval re-inflates that record to two against the
 * newcomer's one — so comparison 1 decides again and the tie-breaks below it are bypassed one layer
 * out. Each coordinator's own member now votes before its record fans out
 * (`ClusterCoordinator.prevoteLocalPromise`), which is what makes the two coordinators' members agree;
 * a third member's vote is what can still split them. Observed as `round 1: both lost` at four and five
 * members in `test/transaction-node-count-sweep.spec.ts` (at three, where the cohort needs every
 * promise, whether it shows depends on delivery order, and that sweep does not see it). Both writers
 * then re-drive and the retry loop's jittered backoff separates them, so this costs a round, not
 * correctness. Do NOT close it by relaxing "first arrival wins that member's vote": a member cannot
 * retract an approval it has already signed, and letting a member that approved a write which went on
 * to reach super-majority also approve its rival is exactly the split brain the approvals-first order
 * above exists to prevent. Closing it needs something structurally different — a member that can hold
 * its vote back until it has seen both rivals, or a rival that carries proof of how far it has got.
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
 * A validated multi-collection pend carries it on `pend.validation.transaction.priority`; a pend
 * without a transaction — the single-collection (`Collection.sync`) path, and a coordinator built
 * with `pendValidation: 'none'` (the Quereus adapter's legacy multi-tree commit) — carries it as
 * top-level `pend.priority`; a record with neither — an unversioned coordinator's transaction, or a
 * non-pend operation — is priority 0
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
 * Whether two messages must serialize against each other: true when they touch a common block, are
 * not the same action, and neither is cancel-only. The same-action escape is what lets a commit
 * follow its own pend — both name every block the action writes, so a bare overlap test would have
 * each transaction blocking its own next phase. Gates whether {@link resolveRace} runs at all.
 *
 * A cancel-only message commutes with every message of a different action, so it never conflicts.
 * Cancelling action X only deletes X's pending records on the named blocks (`StorageRepo.cancel`); it
 * never moves a block's revision, so it reorders nobody's history:
 *   - a commit of Y never reads X's pending record (that was checked at Y's pend);
 *   - a pend of Y is refused by storage and by `validatePendOperations` while X's record stands, in
 *     either arrival order — the worst outcome is a retry of Y, never a wrong result;
 *   - an invalidation writes compensating revisions and does not touch pending records.
 * Counting the cancel as a rival was actively harmful: on a two-member cohort a single conflict vote
 * makes super-majority unreachable, so a refused writer's cancel knocked out the WINNER's commit after
 * its log tail had landed, and the winner tore. It also let a pend or commit abort a cancel's own
 * reservation, leaving the refused pending records standing longer.
 *
 * A commit-only message competes with nothing but an invalidation. A commit is only ever sent for an
 * action whose pend already WON its slot (the race above ran at the pend, and storage holds that
 * pend's record); the commit only promotes that record, so there is no contest left for it to lose:
 *   - a pend of Y: storage and `validatePendOperations` refuse it while X's record stands and Y has
 *     not built on it (`isReservationAgainst`: Y asks for X's slot or an earlier one, or — at the vote
 *     of a cohort that can leave a member out — the base Y declares for the block is below X's slot),
 *     and refuse it as stale once X has committed
 *     there — the worst outcome is a retry of Y. A Y that built on X (it read the block, and
 *     `StorageRepo.get` promotes X's record for a reader whose log names X) lands after X: Y's pend
 *     declares X's revision as its base, and a member X has not reached yet refuses Y as behind (the
 *     fork guard in `StorageRepo.internalCommit`) and reconciles, rather than applying Y over the older
 *     base. That guard reads the base Y's pend carried for the block (`PendRequest.baseRevs`, stored
 *     with the record) and falls back to the base Y's commit declared. A Y that read the block WITHOUT
 *     X's change — from four members up, from a member that never received X's pend — declares the
 *     pre-X base, and every member still holding X's record holds it at the vote, however far past
 *     X's slot Y asks (that shape needs a member outside X's promise quorum, which is exactly where
 *     the vote reads Y's base — `cohortCanMissAPend`). What neither closes is a Y from a sender that names no base at all (an older build;
 *     accepted as the residual, see docs/internals.md "An update-only transform is applied only to
 *     the base its author read"). Counting the commit as a rival never closed any of these: it only
 *     fired while X's commit was still in its own promise round at a member, and when the race went
 *     Y's way it tore X instead;
 *   - a commit of Y: `StorageRepo.commit` never looks at another action's pending record; its own
 *     stale and fork checks, and `validateCommitRevisions` at the vote, order the two under the block
 *     latch.
 * Counting either as a rival was the same tear as the cancel's, one step later: on a two-member cohort
 * a writer whose log tail had just landed had its data-block commit knocked out by the NEXT writer's
 * pend (which had read, and was building on, exactly that commit), so the next writer's revision
 * landed over a member that never took the first one, and the first writer tore. An invalidation
 * still serializes against a commit: it writes compensating revisions to the same blocks.
 */
export function operationsConflict(ops1: RepoMessage['operations'], ops2: RepoMessage['operations']): boolean {
	// Check if one is a commit for the same action as a pend - these don't conflict
	const actionId1 = getActionId(ops1);
	const actionId2 = getActionId(ops2);
	if (actionId1 && actionId2 && actionId1 === actionId2) {
		// Same action - commit is resolving the pend, not conflicting
		return false;
	}

	if (isCancelOnly(ops1) || isCancelOnly(ops2)) {
		return false;
	}

	if ((isCommitOnly(ops1) && !invalidates(ops2)) || (isCommitOnly(ops2) && !invalidates(ops1))) {
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

/**
 * Every operation is a cancel. Stated over the whole list, although a `RepoMessage` carries one
 * operation in practice, so a mixed message stays conservative and keeps conflicting.
 */
function isCancelOnly(operations: RepoMessage['operations']): boolean {
	return operations.length > 0 && operations.every(operation => 'cancel' in operation);
}

/** Every operation is a commit — conservative on a mixed list, like {@link isCancelOnly}. */
function isCommitOnly(operations: RepoMessage['operations']): boolean {
	return operations.length > 0 && operations.every(operation => 'commit' in operation);
}

function invalidates(operations: RepoMessage['operations']): boolean {
	return operations.some(operation => 'invalidate' in operation);
}
