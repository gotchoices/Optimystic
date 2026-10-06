/**
 * Matchmaking — arrival-push fan-out selection (db-core, pure).
 *
 * Decides which push-opted seekers a newly arrived provider is pushed to (`docs/matchmaking.md`
 * §Fairness — FCFS by `attachedAt`, fan-out bounded by `capacityBudget`). Every cohort member runs the
 * same selection over the same gossip-replicated records and then delivers only to the selected seekers
 * whose slot primary it is, so the cohort as a whole notifies about `capacityBudget` seekers rather than
 * that many per member.
 *
 * Pure: no clock, no I/O. The db-p2p cohort driver decodes the records, keeps the targets it is primary
 * for, coalesces, signs and delivers.
 */

import { matchesFilter } from "./capability-filter.js";
import type { LocalProviderRegistration, LocalSeekerRegistration } from "./query-eval.js";

/** A decoded seeker registration held at this cohort, considered as a push target. */
export type ArrivalPushCandidate = LocalSeekerRegistration;

/**
 * Seekers to notify about `provider`, longest-waiting first: of the push-opted seekers whose filter the
 * provider matches and that attached no later than it did, the first `capacityBudget` by `attachedAt`
 * (ties broken by `participantId`, so every member computes the same order). Generic so the caller gets
 * back its own richer candidate objects.
 *
 * The `attachedAt` rule exists for a member that receives the whole record set at once (catching up by
 * gossip, or pulling records in a rotation handoff): without it, that member would push every existing
 * provider to every seeker. A provider that attached before a seeker was answerable by that seeker's own
 * first query, and its safety poll still finds it.
 *
 * NOTE: accepted tradeoff — the ranking reads only replicated state, so a seeker already satisfied,
 * finished, or answering `unknown_seeker` to its own primary keeps holding a fan-out slot until its
 * record leaves the cohort (withdraw on finish, or its 10 s TTL), under-filling that arrival's fan-out;
 * members whose gossip views differ can also over- or under-fill by a few. Excluding them would mean
 * gossiping per-seeker push state; the seeker's safety poll covers what is missed. Revisit if push
 * under-fill shows up as seekers routinely falling back to the safety poll on a busy topic.
 */
export function selectArrivalPushTargets<S extends ArrivalPushCandidate>(
	provider: LocalProviderRegistration,
	seekers: readonly S[],
): S[] {
	const budget = provider.payload.capacityBudget;
	if (budget === 0) {
		return [];
	}
	return seekers
		.filter((s) => isPushTarget(provider, s))
		.sort(byLongestWaiting)
		.slice(0, budget);
}

/** True iff `seeker` holds a push binding, matches `provider`, and was waiting when it arrived. */
function isPushTarget(provider: LocalProviderRegistration, seeker: ArrivalPushCandidate): boolean {
	return seeker.payload.pushOnArrival === true
		&& seeker.payload.correlationId !== undefined
		&& matchesFilter(provider.payload, seeker.payload.filter)
		&& provider.attachedAt >= seeker.attachedAt;
}

/** Ascending `attachedAt`, then code-unit order of `participantId` (locale-independent, so members agree). */
function byLongestWaiting(a: ArrivalPushCandidate, b: ArrivalPushCandidate): number {
	if (a.attachedAt !== b.attachedAt) {
		return a.attachedAt - b.attachedAt;
	}
	return a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0;
}
