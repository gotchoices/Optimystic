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
	 * commit's own declaration; the read-driven promotion in `StorageRepo.get` declines; the rival
	 * rule, {@link isReservationAgainst}, keeps the revision rule for it).
	 */
	baseRev?: number;
	/**
	 * The identity of the run of this node — `StorageRepo.runId`, one id per process
	 * (`PROCESS_RUN_ID` in `./storage-repo.js`) — that saved the record, kept in
	 * `BlockMetadata.pendingRuns`. Present only when all three deciding facts held at the save: the
	 * node applied the pend ALONE (the solo pend path, no consensus), for a writer running in the
	 * node's own process (`MessageOptions.localWriter`, which never travels on the wire), in that run.
	 * Absent for every other record — a remote writer's, a coordinated write's on a larger cohort, a
	 * record written before the field existed — and absence says nothing: such a record is judged by
	 * the slot rule alone. See {@link isAbandonedClaim}.
	 */
	localRun?: string;
	/**
	 * When this node stored the record, by its own wall clock (`BlockMetadata.pendingSince`). The
	 * record reserves its block only for a bounded span from this moment; past it the record has
	 * lapsed — see {@link hasLapsed}. Absent only for a record written before the field existed,
	 * which {@link hasLapsed} judges from the run's start instead.
	 */
	pendingSince?: number;
}

/**
 * What storage keeps for one pending record beside the record itself — a {@link PendingClaim} less
 * the action id the metadata maps are keyed by. The shape `IBlockStorage.savePendingTransaction`
 * takes and `BlockStorage.recordClaim` writes.
 *
 * `pendingSince` is REQUIRED here, unlike `rev`, `baseRev` and `localRun`, which are all absent for
 * legitimate records. There is exactly one production caller of `savePendingTransaction`
 * (`StorageRepo.pendUnderLatches`), so requiring it costs nothing and makes "a save path forgot to
 * stamp it" a compile error. That matters because {@link hasLapsed}'s fallback for an unstamped
 * record is in the LAPSING direction — the opposite of how `localRun`'s positive mark is read — so a
 * forgotten stamp would quietly stop a live record reserving its block one lease after the run
 * started, rather than quietly leaving it reserving.
 */
export type PendingClaimFields = Omit<PendingClaim, 'actionId' | 'pendingSince'> & { pendingSince: number };

/**
 * Whether a pending record is ABANDONED: its writer was a transactor in a process of this node that no
 * longer exists, so nothing can ever commit or cancel it. Decided from the claim alone, against the
 * identity of the node's current run: a claim stamped with a run (`localRun`) other than `currentRun`.
 *
 * The three facts the stamp stands for (see {@link PendingClaim.localRun}) are what make the verdict
 * safe without any guess about time. The writer ran in this node's process, and that process is over —
 * the run id is one per process, so a different run is a different process — so the writer is provably
 * gone; and the pend was applied here alone, so no other member holds a copy that a cohort decision
 * could still commit. A claim with no stamp is never abandoned under this rule, whatever its age; so an
 * unknown `currentRun` (a claims reader that does not say which run it is) judges nothing.
 *
 * Independent of {@link isReservationAgainst} on purpose: abandonment is a fact about the WRITER, the
 * slot rule a fact about the SLOT, and both rival scans (`StorageRepo.pend` at apply,
 * `ClusterMember.reservingRivals` at the vote) ask this first — an abandoned claim is not a reservation
 * however its slot compares — and the slot rule only of the rest. A claim stamped with the current run
 * is a live reservation of this run, judged by the slot rule like any other: two handles in one
 * process racing for one slot — through one `StorageRepo`, or through two over one store — must still
 * refuse each other, which is why the run is the process's and not the repo's.
 */
export function isAbandonedClaim(claim: PendingClaim, currentRun: string | undefined): boolean {
	return claim.localRun !== undefined && currentRun !== undefined && claim.localRun !== currentRun;
}

/**
 * What a reader must know to judge whether a pending record has lapsed — see {@link hasLapsed}.
 * Handed out by the repo that stored the records (`StorageRepo.pendLease`), because every value in
 * it is that node's own: its configured lease, its own run's start, and its own clock.
 */
export interface ReservationLease {
	/** How long a record reserves its block, in milliseconds from the moment this node stored it. */
	leaseMs: number;
	/** When this run of the node started — the anchor for a record that carries no `pendingSince`. */
	runStartedAt: number;
	/** This node's wall-clock reading, in the same frame as {@link PendingClaim.pendingSince}. */
	now(): number;
}

/**
 * Whether a pending record has LAPSED: it has stood for far longer than any honest pend-to-commit
 * span, so it no longer reserves its block against another writer. It is NOT deleted, and its own
 * commit is still honoured — both halves of that sentence are load-bearing.
 *
 * **Why an age bound is the rule here.** Every locally-decidable signal is already in and does not
 * reach this population: the block-passed-the-slot test (`BlockStorage.sweepDeadClaims`), the
 * request-passed-the-slot test ({@link isReservationAgainst}), and the provably-dead-writer test
 * ({@link isAbandonedClaim}). What is left by construction is a record whose slot the collection has
 * not moved past, carrying no in-process mark — a coordinated write's record, a remote writer's
 * record pended through this node, a record whose owed cancel a restart forgot, or a record written
 * by a build that kept no claim at all. No comparison of revisions can retire any of them, and the
 * alternative (a cancel driven by a writer-liveness protocol) needs a writer identity that survives
 * the writer's own restart and a reachable writer, which the deployments that reported this — phones
 * behind circuit relays — cannot promise. So: an age bound.
 *
 * **Why lapsing is safe where deleting is not.** Deleting a record whose write is still in flight
 * makes that write's commit fail with a missing-pend error, which the cluster layer reads as this
 * node having diverged and repairs by copying the whole block from a peer — more expensive than the
 * leak. Lapsing destroys nothing, so a lease that fires too early costs only the RESERVATION: another
 * writer is admitted, and one of the two writes is then refused as stale and retried, the ordinary
 * lost-race path every client already handles (the case analysis is in docs/correctness.md, Theorem 1
 * Case 2). That asymmetry is what makes a merely generous bound good enough here, where a
 * deletion-based bound would have to be provably safe.
 *
 * Three branches, and no fourth:
 *
 *  - No `lease` → nothing has lapsed. A reader that cannot say the time judges nothing, exactly as a
 *    claims reader with no `currentRun` judges nothing abandoned.
 *  - `claim.pendingSince` present → lapsed once more than `leaseMs` has passed since it. Strictly
 *    greater, so a record stored exactly `leaseMs` ago still reserves.
 *  - `claim.pendingSince` absent → judged from `lease.runStartedAt` on the same terms. A record
 *    written before the field existed gets exactly one lease of grace from the earliest moment this
 *    run could have known of it. This is the one case where the fallback is in the lapsing direction
 *    on purpose: such a record usually carries no `rev` either, which both the other rules treat as
 *    the strongest possible claim and neither can ever retire, so the alternative is the permanent
 *    wedge this rule exists to remove.
 *
 * Separate from {@link isAbandonedClaim} and {@link isReservationAgainst} on purpose, and asked in
 * that order at both rival scans (`StorageRepo.pendUnderLatches` at apply,
 * `ClusterMember.reservingRivals` at the promise vote): abandonment is a fact about the WRITER,
 * lapsing a fact about the AGE, the slot rule a fact about the SLOT. Abandonment first, so a record
 * that is both is deleted rather than merely set aside.
 *
 * Read only where a record is asked to RESERVE. The commit-side readers — `StorageRepo.internalCommit`,
 * the read-driven promotion in `StorageRepo.get`, `ClusterMember.validateCommitBaseDeclarations` —
 * never ask, which is what keeps a lapse from costing the write: a lapsed record's own commit still
 * promotes it normally. The vote and the apply on one node read the same stored `pendingSince`
 * against the same clock, and time only moves forward, so the apply can only ever be MORE permissive
 * than the vote that preceded it — the existing invariant that the apply never refuses what the vote
 * approved still holds.
 *
 * Members need not agree on the verdict and briefly will not. Nothing is destroyed, so no member
 * removes state another relies on; each anchors the verdict to its OWN receipt of the same record,
 * so they reach it within the pend's propagation spread (milliseconds), not within clock skew; and
 * while they differ, a member that has not yet lapsed the record votes `held`, which a cohort of
 * four or more absorbs ({@link cohortCanMissAPend}) and which a smaller cohort resolves on the
 * writer's next retry.
 *
 * A node whose wall clock steps BACKWARDS delays every lapse, which is safe. One that steps FORWARDS
 * lapses early, which costs a lost race. Neither needs a mechanism.
 *
 * What this does NOT bound: a writer that keeps RE-PENDING the same action. A re-pend overwrites the
 * claim and so restarts its lease, which is correct — the writer is demonstrably alive — but means a
 * hostile or looping writer can hold a block indefinitely. That is true today without the lease and
 * belongs to the dispute subsystem, not here.
 */
export function hasLapsed(claim: PendingClaim, lease: ReservationLease | undefined): boolean {
	if (lease === undefined) {
		return false;
	}
	// NOTE: a lapsed record's bytes are never deleted by this rule, so a block that is never written
	// again keeps them until something else resolves the slot (a commit, a cancel, the dead-claim
	// sweep). The accepted cost of never destroying state on a presumption; if leaked pending records
	// ever show up as a storage cost, the cure is a sweep that can enumerate the blocks holding them,
	// which raw storage cannot do today.
	// NOTE: the fallback below lapses an unstamped record, which is the OPPOSITE direction from how
	// `localRun`'s positive mark is read — deliberately. Such a record was written before the field
	// existed and usually carries no `rev` either, which the other two rules treat as the strongest
	// possible claim and neither can retire, so reading "no stamp" as "never lapses" would keep
	// exactly the permanent wedge this rule exists to remove. It is a one-time upgrade population.
	// NOTE: a node that restarts more often than its lease re-anchors that grace on every run, so an
	// unstamped record never lapses there. Same one-time population, on a node that never stays up for
	// one lease; no mechanism.
	const since = claim.pendingSince ?? lease.runStartedAt;
	return lease.now() - since > lease.leaseMs;
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
 * It stops reserving once the incoming writer has BUILT ON it — read the block with that change in
 * it — because then admitting the newcomer cannot lose the change, whatever became of the record's
 * action. The rule, first match wins:
 *
 *  - Either side's revision unknown → reserves. A record predating revision recording keeps the
 *    old behaviour rather than silently admitting a rival, and a rev-less request cannot be placed
 *    past anything.
 *  - The record carries a base AND the request carries a usable one ({@link usableBase}: a number
 *    below the requested revision) → reserves iff `claim.rev > baseRev`. A base at or past the
 *    claimed slot means the newcomer's operations were computed against a version of the block that
 *    already holds the record's change (it committed there, and this member merely missed the
 *    commit — the newcomer's own commit brings it current), or against a version past a slot the
 *    record lost. A base below it means the newcomer read the block without that change, and
 *    admitting it would let its commit apply over the stale base and sweep the record — the rival's
 *    change lost while the log names it.
 *  - Otherwise → reserves iff `claim.rev >= rev` (the revision rule). Revisions are allocated per
 *    COLLECTION and a writer pends at one past the collection revision it read, so a claim below the
 *    requested revision is one the collection has moved past, which is taken as having been built
 *    on. That is sound when the newcomer read the block from a member that held the record
 *    (`StorageRepo.get` promotes a record for any action the reader's context names, with the block
 *    floor, `BlockGets.floors`, as the second line), and false in exactly one shape: a member that
 *    never received the rival's pend — possible only where the promise quorum can leave a member
 *    out, see {@link cohortCanMissAPend} — serving a floor-less handle while the rival's data-block
 *    commit is still in flight. It stays the rule for a request with no usable base (an inserted or
 *    deleted block, a sender that names none, or a malformed base), and for a record with no stored
 *    base (an inserted or deleted block, or a record written by a release that did not keep bases).
 *    A base-less record keeps clearing the moment the collection moves past its slot, as it always
 *    did: judged by the newcomer's base, one whose commit ran nowhere could never clear, since no
 *    member can promote it (the read-driven promotion declines a record with no base), and a node
 *    upgraded over its own leftovers would wedge on them. The price: a rival that DELETES the block
 *    keeps no base either, so the missed-pend shape below stays open for a rival delete, exactly as
 *    it was before the base arm existed.
 *
 * The base arm is never more permissive than the revision arm: an honest base is at most `rev - 1`,
 * so a claim at or below the base is also below the requested revision. It can only hold more,
 * which is why the safety argument of Theorem 1 does not weaken. It closes the missed-pend shape
 * wherever the members still holding the rival's record are enough to deny the newcomer a
 * super-majority — one member missing the pend leaves every other one holding it — and a member
 * that has meanwhile taken the rival's change refuses the newcomer's commit at the fork guard
 * (`StorageRepo.internalCommit`) instead. Liveness for the missed-commit
 * shape (`a-member-that-missed-a-commit-refuses-every-later-write`) is preserved: a writer that read
 * the block from a member that applied the rival's change declares at least that revision as its
 * base, and one served by the missed-commit member itself is served after that member promotes the
 * record, which it does whenever the record's stored base equals its latest.
 *
 * WHERE the base is read is the callers' decision, and deliberately narrow: only the promise vote
 * reads it, and only for a cohort whose quorum can leave a member out ({@link cohortCanMissAPend});
 * the apply-time scan in `StorageRepo.pend`, and the vote in every smaller cohort, pass no base. So
 * the apply never refuses what the vote approved. Holding more costs liveness in two shapes, and the
 * narrowing keeps both off cohorts that need unanimity (two and three members at the default
 * threshold), where one member's hold sinks the pend: (1) a newcomer that read the block one change
 * short is held until the rival commits, and its retries do not re-read the block today, so it then
 * re-pends on the stale base and the fork guard refuses its commit — refused, never acknowledged over
 * the rival (backlog `bug-a-writer-held-by-a-change-it-never-saw-retries-on-its-stale-copy`); (2) a
 * record whose change no member will ever take — an abandoned action whose data-block pend landed,
 * whose log-tail pend did not, and whose cancel never arrived — used to be superseded as soon as the
 * collection moved past its slot, and under the base arm holds every newcomer instead.
 *
 * NOTE: from four members up, residual (2) holds the block while the stray record stands on enough
 * members to deny a super-majority (a writer that crashed after its data-block pend, before any
 * cancel); a stray record on one member alone is outvoted, and that member's own apply (revision
 * rule) then admits the newcomer, whose commit sweeps the record. Locally the member cannot tell the
 * crashed writer's record from the missed-pend shape: both are a record claiming a slot past the
 * block's latest, met by a newcomer whose base is that latest. The cure arrived as the LEASE
 * ({@link hasLapsed}): a record that has stood past its lease stops reserving at both rival scans,
 * so the hold is bounded by the lease rather than permanent, and the rule here stays as strict as
 * safety wants it. Both stuck-reservation lines still name such a block while the lease runs.
 */
export function isReservationAgainst(claim: PendingClaim, request: ReservationRequest): boolean {
	if (claim.rev === undefined || request.rev === undefined) {
		return true;
	}
	const base = claim.baseRev === undefined ? undefined : usableBase(request);
	return base === undefined ? claim.rev >= request.rev : claim.rev > base;
}

/**
 * Whether a cohort of `peerCount` members, promising at `superMajorityThreshold`, can reach its
 * promise super-majority without one of its members — so a member can miss a pend the rest of the
 * cohort stored, and later serve the block one change short. That is the only shape the base arm of
 * {@link isReservationAgainst} closes, and it is also exactly where one member's hold cannot sink a
 * pend by itself. Below it (two and three members at the default 0.75) every member's approval is
 * needed, so the base arm could only add holds that no lost update justifies. The promise vote
 * reads the incoming base only when this is true.
 */
export function cohortCanMissAPend(peerCount: number, superMajorityThreshold: number): boolean {
	return Math.ceil(peerCount * superMajorityThreshold) < peerCount;
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
