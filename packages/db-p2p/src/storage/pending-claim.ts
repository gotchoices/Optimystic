import type { ActionId, BlockId, PendRequest, Transform } from "@optimystic/db-core";

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
	/**
	 * The committed revision the record's update operations were computed against — the pend's
	 * `baseRevs[blockId]`, kept in `BlockMetadata.pendingBases`. Absent for a record whose pend
	 * carried no base for this block (inserted, deleted, or unknown to the author) and for a record
	 * written before the field existed; both read as "base unknown". Unlike an unknown `rev`, an
	 * unknown base is NOT the strongest kind of anything: it is simply nothing to compare, and each
	 * apply site decides what that means for it (`StorageRepo.internalCommit` falls back to the
	 * commit's own declaration; the read-driven promotion in `StorageRepo.get` declines).
	 */
	baseRev?: number;
}

/**
 * What {@link isReservationAgainst} reads of an incoming pend, for one block: the revision it
 * requests, and the committed base the block's update operations were computed against — built from
 * the pend by {@link reservationRequestFor}, so the rule reads exactly the base storage would keep.
 */
export interface ReservationRequest {
	rev?: number;
	baseRev?: number;
}

/**
 * Whether a rival's pending record is a RESERVATION against an incoming pend for the same block —
 * the one question both rival scans ask (`StorageRepo.pend` at apply,
 * `ClusterMember.validatePendOperations` at the promise vote).
 *
 * A pending record reserves the block for the revision it claims: it says "I am about to commit
 * this block at revision `rev`", and it holds that slot from pend-apply until its commit or cancel.
 * It stops reserving only once the incoming writer has BUILT ON it — read the block with that
 * change in it — because then admitting the newcomer cannot lose the change, whatever became of the
 * record's action. The rule, first match wins:
 *
 *  - Either side's revision unknown → reserves. A record predating revision recording keeps the
 *    old behaviour rather than silently admitting a rival, and a rev-less request cannot be placed
 *    past anything.
 *  - The request carries a usable base for the block ({@link usableBase}: a number below the
 *    requested revision) → reserves iff `claim.rev > baseRev`. A base at or past the claimed slot
 *    means the newcomer's operations were computed against a version of the block that already
 *    holds the record's change (it committed there, and this member merely missed the commit — the
 *    newcomer's own commit brings it current), or against a version past a slot the record lost.
 *    A base below it means the newcomer read the block without that change, and admitting it would
 *    let its commit apply over the stale base and sweep the record — the rival's change lost while
 *    the log names it.
 *  - Otherwise (no base: an inserted or deleted block, a sender that names none, or a malformed
 *    one) → reserves iff `claim.rev >= rev`. Revisions are allocated per COLLECTION and a writer
 *    pends at one past the collection revision it read, so a claim below the requested revision is
 *    one the collection has moved past, which is taken as having been built on. That inference is
 *    the one the base replaces: it is sound when the newcomer read the block from a member that
 *    held the record (`StorageRepo.get` promotes a record for any action the reader's context
 *    names, with the block floor, `BlockGets.floors`, as the second line), and false in exactly one
 *    shape, from four members up — a member that never received the rival's pend serving a
 *    floor-less handle while the rival's data-block commit is still in flight. It remains the rule
 *    for base-less requests, where there is nothing sharper to read.
 *
 * The base arm is never more permissive than the revision arm: an honest base is at most `rev - 1`,
 * so a claim at or below the base is also below the requested revision. It can only hold more,
 * which is why the safety argument of Theorem 1 does not weaken. It closes the four-member shape
 * wherever the members still holding the rival's record are enough to deny the newcomer a
 * super-majority — one member missing the pend leaves every other one holding it — and a member
 * that has meanwhile taken the rival's change refuses the newcomer's commit at the fork guard
 * (`StorageRepo.internalCommit`) instead. Liveness for the missed-commit
 * shape (`a-member-that-missed-a-commit-refuses-every-later-write`) is preserved: a writer that read
 * the block from a member that applied the rival's change declares at least that revision as its
 * base, and one served by the missed-commit member itself is served after that member promotes the
 * record, which it does whenever the record's stored base equals its latest.
 *
 * NOTE: holding more has two residuals, both liveness, never safety. (1) A newcomer that read the
 * block one change short — from a member that never held the rival's record, or one that holds it
 * and cannot promote it (a base-less record from an older sender, or one whose stored base the
 * member has not reached) — declares a base below the claim and is held until the rival commits or
 * that member comes current. Its retries do not re-read the block today, so it then re-pends on the
 * stale base and the fork guard refuses its commit: refused, never acknowledged over the rival
 * (backlog `bug-a-writer-held-by-a-change-it-never-saw-retries-on-its-stale-copy`). (2) A record
 * whose change no member will ever take used to be superseded as soon as the collection moved past
 * its slot, and now holds every newcomer until something sweeps it, which today nothing does: an
 * abandoned action whose data-block pend landed, whose log-tail pend did not, and whose cancel never
 * arrived, on a block no later write touched; or a BASE-LESS record (older sender) whose data-block
 * commit never ran anywhere, which no member can promote. Backlog
 * `debt-unpromotable-pending-records-need-a-sweep` owns abandoned records, and both stuck-reservation
 * lines name the block. Locally the member cannot tell (2) from the lost-update shape above: both
 * are a record claiming a slot past the block's latest, met by a newcomer whose base is that latest.
 * If (2) shows up in the field, the cure is that sweep, not a looser rule here.
 */
export function isReservationAgainst(claim: PendingClaim, request: ReservationRequest): boolean {
	if (claim.rev === undefined || request.rev === undefined) {
		return true;
	}
	const base = usableBase(request);
	return base === undefined ? claim.rev >= request.rev : claim.rev > base;
}

/**
 * `request.baseRev` when {@link isReservationAgainst} can read it: a number strictly below the
 * requested revision. Anything else — absent, not a number (untrusted wire data), or at or past
 * `rev`, which no honest writer sends since its base is a revision it read and it pends past what it
 * read — is `undefined`, and the rule falls back to the requested revision alone.
 */
export function usableBase(request: ReservationRequest): number | undefined {
	const { rev, baseRev } = request;
	return typeof baseRev === 'number' && rev !== undefined && baseRev < rev ? baseRev : undefined;
}

/**
 * The {@link ReservationRequest} `pend` makes of `blockId`, whose transform within the pend is
 * `transform`: the pend's revision, and the base {@link declaredBaseFor} keeps for the block — so a
 * base on an inserted or deleted block, or a malformed one, is read by the rule exactly as storage
 * keeps it: not at all. `ignoredBase` carries a base the pend named for the block that the rule does
 * not read (malformed, not below the revision, or on a base-independent transform), for the caller's
 * log line; no producer sends one.
 */
export function reservationRequestFor(
	pend: Pick<PendRequest, 'rev' | 'baseRevs'>, blockId: BlockId, transform: Transform
): { request: ReservationRequest; ignoredBase?: unknown } {
	const request: ReservationRequest = { rev: pend.rev };
	const baseRev = declaredBaseFor(pend.baseRevs, blockId, transform);
	if (baseRev !== undefined) {
		request.baseRev = baseRev;
	}
	const named: unknown = pend.baseRevs?.[blockId];
	return named !== undefined && usableBase(request) === undefined ? { request, ignoredBase: named } : { request };
}

/**
 * Whether `transform`'s result does not depend on the block's prior content: an insert replaces the
 * block wholesale and a delete materializes to nothing (delete-last-wins in `applyTransform`), so
 * neither can fork on a different base, and no base is ever named for them (`Tracker.stagedBaseRevs`
 * names update-only blocks alone). Every base check keys on this, on the member's OWN pended
 * transform (or the incoming pend's own transform, at the rival scans), never on what a request
 * declares.
 */
export function isBaseIndependent(transform: Transform): boolean {
	return Boolean(transform.insert) || Boolean(transform.delete);
}

/**
 * The base a pend declares for `blockId`, as storage will keep it: `baseRevs[blockId]` when it is a
 * number and the block's transform is update-only, else nothing. Untrusted wire data with no ingress
 * schema (the posture `validateCommitOperations` takes toward `blockDigests`): a malformed or surplus
 * entry is ignored for that id, never thrown on; an entry for an inserted or deleted block — which no
 * producer sends — is dropped, so a base-independent record can never read as base-dependent later.
 *
 * NOTE: the base is stored AS TOLD, and the pend never refuses on it — not when it is behind this
 * member's latest, and not when it is ahead. A member has no grounds to second-guess the author's
 * claim about the author's own computation (the client is what makes an honest claim correct:
 * `Tracker` pins the base at the first staged update and re-stages over a moved one). Refusing here
 * would also be the wrong tier: a member holding a torn or abandoned HIGHER revision would cast a
 * reject that, at three members, fails every honest retry — the writer re-reads the majority's
 * revision and declares it again — whereas the same mismatch at commit time is one member's refusal
 * (`StorageRepo.internalCommit`), heals by reconcile, and the cohort still commits on majority
 * durability.
 */
export function declaredBaseFor(baseRevs: PendRequest['baseRevs'], blockId: BlockId, transform: Transform): number | undefined {
	if (isBaseIndependent(transform)) {
		return undefined;
	}
	const declared = baseRevs?.[blockId];
	return typeof declared === 'number' ? declared : undefined;
}
