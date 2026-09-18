import type { ActionId } from "@optimystic/db-core";

/**
 * One pending record on a block, with the revision its pend asked for.
 *
 * `rev` is the `PendRequest.rev` the record was written under (see
 * `IBlockStorage.savePendingTransaction`), kept in the block's metadata beside `latest`
 * (`BlockMetadata.pendingRevs`). Absent for a record that named no revision — an insert-only pend,
 * which no production caller sends — and for a record written before the revision was kept at all.
 * Both read as "unknown", and an unknown claim is treated as the strongest one (see
 * {@link isReservationAgainst}), so an old record can only refuse more than it should, never less.
 */
export interface PendingClaim {
	actionId: ActionId;
	rev?: number;
}

/**
 * Whether a rival's pending record is a RESERVATION against a pend requesting `requestedRev` of the
 * same block — the one question both rival scans ask (`StorageRepo.pend` at apply,
 * `ClusterMember.validatePendOperations` at the promise vote).
 *
 * A pending record reserves the block for the revision it claims: it says "I am about to commit
 * this block at revision `rev`", and it holds that slot from pend-apply until its commit or cancel.
 * Revisions are allocated per COLLECTION, and a writer pends at one past the collection revision it
 * read, so the requested revision says how far the collection had moved when the incoming writer
 * read it:
 *
 *  - `claim.rev >= requestedRev` — the record claims the slot the pend wants, or a later one. A live
 *    rival inside its pend-to-commit window looks exactly like this, and letting the pend through
 *    would admit two writers to one slot (the lost update the reservation exists to prevent). It
 *    reserves; the pend is refused and retries once the rival commits or cancels.
 *  - `claim.rev < requestedRev` — the collection has already moved PAST the slot this record claims.
 *    Whatever became of the record's action, it can no longer be a rival for the slot being
 *    requested: either it committed at its slot (the log names it, and the incoming writer built on
 *    it — a member holding this record merely missed that commit, and the incoming pend's own commit
 *    brings it current), or it lost that slot to another action and its record is dead. Either way
 *    the record is SUPERSEDED and does not reserve. Treating it as live was the wedge this predicate
 *    replaces: a member that missed one commit refused every later write to the block, from every
 *    writer, until something happened to read the block through it.
 *  - An unknown claim (no `rev` on either side) reserves, so a record predating revision recording
 *    keeps today's behaviour rather than silently admitting a rival.
 *
 * "The incoming writer built on it" is what makes admitting the pend safe, and it rests on the
 * read side, not on this predicate: every collection handle carries, in its read context, every
 * action the log has committed since the last checkpoint (`Log.getFrom` collects them all, and no
 * checkpoint is written today), and `StorageRepo.get` promotes a pending record for any of those
 * actions before it serves the block. So a read answered by a member that HOLDS the superseded
 * record is served at or past that slot. A block floor (`BlockGets.floors`) is the second line,
 * for a handle that walked the entry: a below-floor answer is re-asked once elsewhere.
 *
 * NOTE: that argument has one hole, open only above three members. A member that never received
 * the rival's pend (the promise bar is a super-majority, so from four members up one can miss it)
 * holds no record to promote, and while the rival's non-tail commit is still in flight it serves
 * the block one revision short. A handle with no floor for the block (a freshly opened one walks
 * no entries) accepts that answer, pends past the rival's slot, and the members that DO hold the
 * rival's record now approve where they used to hold; their commit then applies the newcomer's
 * transform over the same base the newcomer read (the fork guard passes) and sweeps the rival's
 * record, so the rival's change to that block is lost while the log names it. Three members are
 * not exposed (everyone holds every pend). The pend does not carry the base each block's transform
 * was computed against; when it does (backlog `bug-a-pended-transform-does-not-carry-its-base`),
 * the rule here becomes "superseded only if the incoming base is at or past the claim", which
 * closes the hole at the site that has the facts. Not a tripwire to wait on if a deployment runs
 * four or more members per cohort — that is the condition, and it is a lost update, not a wedge.
 */
export function isReservationAgainst(claim: PendingClaim, requestedRev: number | undefined): boolean {
	return claim.rev === undefined || requestedRev === undefined || claim.rev >= requestedRev;
}
