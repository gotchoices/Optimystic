import { LruMap, type ActionId, type BlockId } from "@optimystic/db-core";

/**
 * What one block's pending-conflict refusals have added up to, for ONE unchanged set of holders.
 *
 * A block is reserved by an unresolved pending action for the span between that action's pend and
 * its commit or cancel, and while the reservation stands every OTHER writer's pend for the block is
 * refused. That is the healthy optimistic-concurrency loss. The unhealthy case has the identical
 * per-refusal shape and differs only in repetition: the same holder refusing DISTINCT later actions
 * without end, because the holder is never going to commit or cancel (see
 * {@link StuckReservationTracker}).
 *
 * Counted per (block, holders) rather than per block: a holder that changes is the healthy cycle —
 * the previous reservation resolved and another writer took the block — so a new holder starts a new
 * count and gets its own chance to speak.
 */
interface StuckReservationWatch {
	/** The rival action ids the refusals in this episode named, sorted so the comparison is stable. */
	holders: readonly ActionId[];
	/**
	 * Distinct action ids these holders have refused. Distinct ACTIONS, not refusals: one writer
	 * retrying is one writer, because a sync reuses a single action id across all of its retry
	 * attempts (`Collection.syncInternal` mints the id once and `syncAttempts` reuses it for every
	 * attempt of that cycle). Emptied at the
	 * moment the episode is reported — the count is in the line, and nothing reads the ids again —
	 * so the set is bounded by {@link STUCK_RESERVATION_DISTINCT_ACTIONS}.
	 */
	refused: Set<ActionId>;
	/** True once this episode has been named; suppresses every later refusal against these holders. */
	reported: boolean;
}

/**
 * How many DISTINCT later actions one unchanged holder must refuse on a block before the refusals are
 * named as a stuck reservation rather than as an ordinary lost race.
 *
 * **Why a count of distinct actions and not something else.** Elapsed time answers the wrong question
 * — a slow writer is not a stuck one, and a holder legitimately keeps its reservation for as long as
 * its own commit takes. A raw refusal count answers the wrong question too: a single writer retrying
 * a lost race produces a run of refusals under ONE action id (see {@link StuckReservationWatch.refused}).
 * What no healthy holder can produce is an unbounded stream of *different* writers all losing to it,
 * because a healthy holder's reservation lasts one pend-to-commit window.
 *
 * **Why 8.** The bound to clear is how many distinct actions can honestly be refused inside one such
 * window. Measured on the in-process mesh, in the healthy-contention arm of
 * `test/stuck-reservation-named.spec.ts`: a holder that pends, is raced by other writers, and then
 * commits refuses **2** distinct actions per episode — the two rivals — and the count resets on every
 * holder change. `concurrent-diary-append-acknowledgement.spec.ts` races three writers at one diary
 * and cannot exceed that either, for the same reason: at most (writers - 1) rivals can lose to one
 * winner. 8 is four times the measured healthy figure, and it is a floor a genuinely stuck block
 * clears trivially (the field instance refused hundreds).
 *
 * **The bound stated exactly.** It is distinct SYNC CYCLES, not distinct writers: one writer that
 * exhausts a sync's retry budget and is re-driven by its caller mints a fresh id for the next cycle,
 * so it can contribute more than one. That does not widen the window much — a cycle only ends in
 * exhaustion after `DefaultMaxAttempts` (10) attempts of backoff, roughly 21s (see the exhaustion
 * NOTE in `Collection.syncAttempts`), so a lone writer needs a holder to keep the block for upwards
 * of two and a half minutes before it reaches 8 by itself, which is not a healthy holder.
 *
 * **What the margin does NOT cover, stated honestly.** A block with more than 8 distinct writers
 * racing it inside a single pend-to-commit round trip could reach 8 with a perfectly healthy holder.
 * That is a diagnostic false positive on a log line and nothing else — this counter never refuses,
 * expires, or deletes anything (see {@link StuckReservationTracker}) — and the remedy if
 * a deployment ever hits it is to raise this number, not to add a control path. Raising it costs
 * detection latency on low-traffic blocks, which need this many distinct write ATTEMPTS before the
 * condition can be named at all.
 */
export const STUCK_RESERVATION_DISTINCT_ACTIONS = 8;

/** Whether two sorted holder lists name the same reservation — i.e. whether a refusal continues an
 *  existing episode or starts a new one. Both sides come from the same sort, so this is a plain
 *  element-wise comparison; a block normally has exactly one holder, since a member's own pend refuses
 *  a second one (`ClusterMember.validatePendOperations`). */
function sameHolders(a: readonly ActionId[], b: readonly ActionId[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The stuck-reservation wording: written for an operator reading logs, in the same register as
 * `cohortTooSmallMessage` and `soleHolderMessage` in `coordinator-repo.ts` — what is stuck, what will
 * and will not clear it, and what to do next.
 *
 * The claim is deliberately about the RESERVATION, not about the writer's intent: this node cannot
 * see whether the holding process is alive, only that it has held the block across enough unrelated
 * later actions that no retry is going to win. So the line says what is provable (the block accepts
 * no writes while this record stands, and nothing on the node removes it) and points at the one check
 * that settles the rest.
 */
export function stuckReservationMessage(holders: readonly ActionId[], refusedActions: number): string {
	const held = holders.join(', ');
	return `This block is WEDGED BEHIND A PENDING WRITE THAT IS NOT COMPLETING, and retrying will never ` +
		`clear it: action(s) ${held} reserved the block and have now refused ${refusedActions} DISTINCT, ` +
		`unrelated later actions. Each of those refusals on its own looks exactly like an ordinary ` +
		`optimistic-concurrency loss, which is normal and healthy — the repetition is what is not. A ` +
		`healthy rival holds a block only for its own pend-to-commit window and then releases it by ` +
		`committing or cancelling; a reservation that keeps refusing NEW writers is holding the block ` +
		`against every writer on every machine, and each of them loses again identically. EXACTLY TWO ` +
		`THINGS CLEAR IT: a cancel for action(s) ${held} on this block (route it through the cohort so ` +
		`every member drops the record), or that same action's own commit landing. Nothing on the node ` +
		`expires it — there is no sweep for abandoned pending records — so until one of those two happens ` +
		`the block takes NO writes while continuing to serve reads and to look healthy in every other ` +
		`respect. The usual cause is a writer that went away between a failed or half-applied commit and ` +
		`the cancel it owed, so check whether whatever ran ${held} still exists before cancelling on its ` +
		`behalf. This line is a diagnosis and nothing more: this node does not expire, refuse, or delete ` +
		`the record on the strength of it.`;
}

/**
 * One episode that just crossed the threshold — what the caller logs, verbatim, under its own tag.
 * The ids an operator needs to grep for and to cancel are kept as data beside the prose so a log
 * search finds the block and the action without parsing English.
 */
export interface StuckReservationEpisode {
	blockId: BlockId;
	holdingActionIds: readonly ActionId[];
	distinctRefusedActions: number;
	message: string;
}

/**
 * Count pending-conflict refusals against the holder(s) of each block they name, and say ONCE — in
 * words, at the moment it becomes provable — when a block is wedged behind a reservation that is not
 * going to clear.
 *
 * **Why this needs saying at all.** Every individual refusal is indistinguishable from an ordinary
 * lost race, which is a normal and healthy event, so the logs of a permanently wedged block read
 * exactly like the logs of a busy one. Finding the difference otherwise means noticing that the SAME
 * rival action id keeps appearing across unrelated writers for as long as the process lives — a
 * pattern nothing points at, and one that cost a downstream project several tickets and weeks to
 * re-derive from raw traces. The node has the fact in hand at every refusal; this makes it sayable.
 *
 * **The signal, and the two things that are NOT the signal.** The discriminator is repetition
 * against an unchanged holder — see {@link STUCK_RESERVATION_DISTINCT_ACTIONS} for why distinct
 * refused actions is the right counter and for the measured threshold. Two cheaper-looking tests
 * were tried and do not work: the members' in-memory reservation table
 * (`ClusterMember.activeTransactions`) clears the moment a rival's pend reaches consensus, so a
 * perfectly healthy rival inside its pend-to-commit window is absent from it too and absence there
 * says nothing; and "the block already passed this pending record's revision" catches a different
 * orphan class entirely — in the verified instance the wedged block sat at revision 1 while the
 * orphaned record was for revision 2, still nominally promotable. (That second class is now handled
 * at its own site — a record the incoming writer has built on no longer refuses at all, see
 * `isReservationAgainst` — so what reaches this counter is a holder whose change the block has not
 * taken: one whose slot every later writer still wants, or one past the base every later writer
 * declares, such as an abandoned action's record on a block no later write touched.)
 *
 * **Never a control path.** This classifies and reports; it never refuses, expires, or deletes
 * anything. Deciding when a durable pending record may be removed is precisely the hard problem
 * backlog `debt-unpromotable-pending-records-need-a-sweep` exists for — deleting a live reservation
 * is worse than the leak — and a counter accurate enough for a log line is not evidence enough to
 * destroy state.
 *
 * **Two instances, two vantage points.** The coordinator keeps one (`CoordinatorRepo.noteStuckReservation`),
 * fed by cohort-wide `held`-answered refusals whose holder its OWN storage corroborates, and every
 * member keeps one (`ClusterMember.validatePendOperations`), fed by its own `held` votes — so a
 * reservation only remote members hold is named by those members, where the record actually lives,
 * rather than going unnamed at a coordinator that cannot see it.
 *
 * LRU-bounded: an eviction under more than `capacity` conflicted blocks loses an episode's say-once
 * flag, so the line can repeat once for that block — bounded duplication, far cheaper than the
 * unbounded silence it replaces.
 */
export class StuckReservationTracker {
	private readonly watches: LruMap<string, StuckReservationWatch>;

	constructor(capacity = 1000) {
		this.watches = new LruMap<string, StuckReservationWatch>(capacity);
	}

	/**
	 * Count one refusal of `refusedActionId` against the rival holder(s) of each block in `rivalsByBlock`.
	 * Returns the highest distinct-refusal count any of these blocks has now reached — for a
	 * classification line to carry, saturating at the threshold once an episode has been reported,
	 * since the ids are dropped at that point — and every episode that crossed the threshold on this
	 * refusal, which the caller must log.
	 */
	note(rivalsByBlock: ReadonlyMap<BlockId, readonly ActionId[]>, refusedActionId: ActionId): { highest: number; named: StuckReservationEpisode[] } {
		let highest = 0;
		const named: StuckReservationEpisode[] = [];
		for (const [blockId, rivals] of rivalsByBlock) {
			const holders = [...new Set(rivals)].sort();
			const prior = this.watches.get(blockId);
			// A different holder set is a DIFFERENT episode — the block changed hands, which is the
			// healthy cycle — so the count starts over and the new holder gets its own chance to speak.
			const watch: StuckReservationWatch = prior !== undefined && sameHolders(prior.holders, holders)
				? prior
				: { holders, refused: new Set<ActionId>(), reported: false };
			if (watch !== prior) this.watches.set(blockId, watch);
			if (watch.reported) {
				highest = Math.max(highest, STUCK_RESERVATION_DISTINCT_ACTIONS);
				continue;
			}
			watch.refused.add(refusedActionId);
			highest = Math.max(highest, watch.refused.size);
			if (watch.refused.size < STUCK_RESERVATION_DISTINCT_ACTIONS) continue;
			named.push({
				blockId,
				holdingActionIds: holders,
				distinctRefusedActions: watch.refused.size,
				message: stuckReservationMessage(holders, watch.refused.size)
			});
			watch.reported = true;
			// Said once per episode: from here the flag alone suppresses, and the ids have done their
			// work (their count is in the line above), so drop them rather than growing a set for the
			// unbounded remainder of a permanent condition.
			watch.refused.clear();
		}
		return { highest, named };
	}

	/**
	 * Forget any episode recorded for these blocks, optionally only when `holderActionId` is one of
	 * the actions that episode named. Called from the events the message names as the cures — a write
	 * the block accepted, a cancel for the holding action — and it is LRU hygiene rather than
	 * behaviour: a later wedge is named by a DIFFERENT holder, which {@link note}'s holder comparison
	 * already treats as a new episode whether the old entry is still there or not. Kept because a
	 * settled episode holding an LRU slot can only evict a live one.
	 */
	forget(blockIds: readonly BlockId[], holderActionId?: ActionId): void {
		for (const blockId of blockIds) {
			if (holderActionId !== undefined && !this.watches.peek(blockId)?.holders.includes(holderActionId)) continue;
			this.watches.delete(blockId);
		}
	}
}
