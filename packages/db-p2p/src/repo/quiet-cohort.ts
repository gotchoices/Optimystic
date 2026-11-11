import type { ConnectedCohort } from "@optimystic/db-core";
import { cohortCanMissAPend } from "../storage/pending-claim.js";

/**
 * Recorded on a read-repair freshness stamp (`FreshnessStamp.quiet` in `./coordinator-repo.ts`) by a
 * consult that heard from every other member of the block's cohort and found nothing ahead of this
 * node's copy: the cohort as `IKeyNetwork.connectedCohort` reported it just before that consult
 * started. While the same members stay connected on the same connection runs, no commit to the block
 * can have happened without this node's promise, so a consult would only answer "nothing newer" again
 * (docs/transactions.md § Lazy read-repair window).
 */
export type QuietCohort = ConnectedCohort;

/**
 * Whether a cohort of `memberCount` members, promising at `superMajorityThreshold`, needs every
 * member's promise for every commit: two or three members at the default 0.75. Only in such a cohort
 * does "this node was connected to every member throughout" prove it promised every commit since. The
 * stamp-time half of {@link quietCohortHolds}, asked by the consult that records a quiet cohort.
 */
export function cohortCommitsNeedEveryMember(memberCount: number, superMajorityThreshold: number): boolean {
	return memberCount >= 2 && !cohortCanMissAPend(memberCount, superMajorityThreshold);
}

/**
 * The quiet cohort a consult of `consulted` may record, from the `snapshot` taken just before it
 * started: the snapshot itself when it names exactly the consulted members and every commit among
 * them needs every member's promise; otherwise `undefined`. A cohort that changed between the
 * consult's own lookup and the snapshot records nothing. What only the consult knows — that nobody
 * was silent and nothing is ahead — is the caller's to establish.
 */
export function quietCohortFor(snapshot: ConnectedCohort | undefined, consulted: readonly string[], superMajorityThreshold: number): QuietCohort | undefined {
	if (snapshot === undefined || !cohortCommitsNeedEveryMember(snapshot.members.length, superMajorityThreshold)) return undefined;
	const consultedSet = new Set(consulted);
	if (consultedSet.size !== snapshot.members.length || !snapshot.members.every(id => consultedSet.has(id))) return undefined;
	return snapshot;
}

/**
 * Whether a stamp's quiet cohort still vouches for the block now, `ageMs` after the consult that
 * recorded it: the cohort `connectedCohort` reports `now` is the same members on the same connection
 * runs, every commit among them still needs every member's promise, the age is within
 * `quietWindowMs`, and this node holds no pending record for the block (`pendingHeld`). Pure; the
 * caller supplies the fresh snapshot and the pending check.
 */
export function quietCohortHolds(
	recorded: QuietCohort,
	now: ConnectedCohort | undefined,
	ageMs: number,
	quietWindowMs: number,
	superMajorityThreshold: number,
	pendingHeld: boolean
): boolean {
	return now !== undefined
		&& !pendingHeld
		&& ageMs <= quietWindowMs
		&& cohortCommitsNeedEveryMember(recorded.members.length, superMajorityThreshold)
		&& sameConnections(recorded, now);
}

/** Equal members in the same order (both are sorted) and the same run per member. */
function sameConnections(a: ConnectedCohort, b: ConnectedCohort): boolean {
	if (a.members.length !== b.members.length || a.members.some((id, i) => id !== b.members[i])) return false;
	const peers = Object.keys(a.runs);
	return peers.length === Object.keys(b.runs).length && peers.every(id => a.runs[id] === b.runs[id]);
}
