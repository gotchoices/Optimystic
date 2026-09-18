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
 */
export function isReservationAgainst(claim: PendingClaim, requestedRev: number | undefined): boolean {
	return claim.rev === undefined || requestedRev === undefined || claim.rev >= requestedRev;
}
