description: When a machine decides whether an earlier, still-unfinished write blocks a new write to the same block, it now compares against the version the new write was actually built on, so a write built on an older copy waits instead of silently overwriting the earlier change; a member can also refuse, at vote time, a commit whose declared version disagrees with what it was handed at pend.
prereq: bug-a-pended-transform-does-not-carry-its-base
files: packages/db-p2p/src/storage/pending-claim.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/race-resolution.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/pending-claim.spec.ts, packages/db-p2p/test/cluster-pend-held-vote.spec.ts, packages/db-p2p/test/cluster-commit-digest.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/member-missed-commit-heals-at-commit.spec.ts, docs/correctness.md, docs/repository.md
difficulty: medium
repro: static
----

# A rival pend is superseded only by a writer that built on it

Third of three tickets split from the plan ticket `bug-a-pended-transform-does-not-carry-its-base`. The second ticket put each block's base on the pend (`PendRequest.baseRevs`) and in storage (`PendingClaim.baseRev`). This ticket uses it at the two sites that decide whether a pending record still reserves a block, and at the vote.

## The shape this closes

A pending record is a reservation for the revision it was pended at (`BlockMetadata.pendingRevs`). Both rival scans, `StorageRepo.pend` at apply and `ClusterMember.validatePendOperations` at the promise vote, read one rule, `isReservationAgainst` in `packages/db-p2p/src/storage/pending-claim.ts`: a record claiming a revision *below* the one the incoming pend requests is superseded and does not reserve. The inference behind that is "the collection moved past that slot, so the newcomer must have read the block after that change landed". The `NOTE:` at that function names the one shape where the inference is false: from four members up, one member can miss the rival's pend entirely (the promise bar is a super-majority); if it answers a fresh handle's read while the rival's data-block commit is still in flight, it serves the block one change short; the handle has no floor for the block and accepts it; the newcomer pends past the rival's slot; the members holding the rival's record approve where they used to hold; at commit their content matches the newcomer's declared base, the transform applies over the stale base, and the sweep deletes the rival's record as dead. The rival's change is gone while the log says it happened. Three-member cohorts are not exposed. Inferred from code, not reproduced.

With the base on the pend the scan has the discriminator it lacked: a record is superseded only when the newcomer's declared base for that block is **at or past** the record's claimed revision, because that is what "built on it" means.

## The rule

```ts
/** `request` is the incoming pend's revision and, when it carries one for this block, the
 *  committed base its update operations were computed against. */
isReservationAgainst(claim: PendingClaim, request: { rev?: number; baseRev?: number }): boolean
```

- `claim.rev` unknown → reserves (unchanged: an unknown claim is the strongest kind).
- `request.baseRev` is a number below `request.rev` → reserves iff `claim.rev > request.baseRev`. Superseded iff the newcomer's base is at or past the claimed slot.
- `request.baseRev` absent, or not below `request.rev` (impossible for an honest writer; ignore it and log) → today's rule on `request.rev`.

The new rule is never more permissive than the old one: an honest base is at most `rev - 1`, so "claim at or below base" implies "claim below rev". It can only hold more, never admit more, which is why Theorem 1's safety argument does not weaken. The liveness fix of `a-member-that-missed-a-commit-refuses-every-later-write` is preserved in every shape it was measured on: a writer that read the block from a member that had applied the rival's change declares that revision as its base, and the missed-commit member's record claims exactly that revision, so it is superseded. A writer served by the missed-commit member itself is served **after** that member's read-driven promotion of the rival's record (the second ticket promotes when the stored base equals the member's latest, which it does in that shape), so it too declares the post-rival revision.

Both scan sites pass the per-block base: `StorageRepo.pend` from `request.baseRevs?.[blockId]`, and `validatePendOperations` through `reservingRivals` from `pendRequest.baseRevs?.[blockId]`. `CoordinatorRepo.corroborateHeldBlocks` also reads claims to name a wedged block; it is diagnostic enrichment and must not become a gate, so it may keep the request-revision rule or take the base, but say which.

## Vote-time use of the stored base

`validateCommitDigests` in `ClusterMember` compares the commit's declared digest against a preview. Add, per declared block, one more check that needs no preview: when the commit's `blockDigests[id].baseRev` is a number and this member's pending claim for the action carries a base that differs, vote reject with reason `base-declaration-disagrees`. The second ticket refuses the same shape at apply; a signed reject one round earlier turns a member's refusal-and-reconcile into a clean verdict, and it names the same shape (a stale record from an earlier attempt of a retried action meeting the retry's commit). An honest writer after the first ticket never trips it. A member that holds no record, or a record with no base, abstains.

Deliberately **not** added: a pend-vote reject when the declared base is ahead of or behind this member's latest. The second ticket records why at the pend site (a member holding a torn higher revision would fail every honest retry at three members, where the apply-time refusal heals by reconcile instead).

## Edge cases & interactions

- **Insert-carrying incoming pend**: no base for that block; today's rule applies. An insert over a block that already exists is refused by the stale check's insert branch before the rival scan matters.
- **Delete-only incoming transform**: no base (the producer never declares one); today's rule.
- **Self-exclusion** (a redelivered pend for the same action) and the `policy: 'r'` arm returning rival transforms: unchanged.
- **Base-less rival record** (pre-upgrade sender) against a newcomer with a base: the record's claim is known; the base rule applies to the *newcomer's* base, so the comparison works. Base-less *newcomer* against any record: today's rule.
- **A newcomer legitimately held** because it read a behind member whose promotion declined (a base-less rival record, the second ticket's accepted residual): the hold clears when the rival's commit reaches that member by reconcile or read-repair, or when the newcomer's retry is served by a current member. `noteStuckReservation` still names the block if it never clears. Record as a tripwire at `isReservationAgainst`, replacing the current NOTE: the residual is now "a fresh handle repeatedly served by a member that holds a base-less record it cannot promote".
- **Two-member cohorts**: every member holds every pend; the base rule changes nothing there except the retried-attempt shape the vote-time reject names.
- **`reservingRivals` degraded paths** (a repo without `listPendingClaims`, or a read that fails) keep refusing on every rival, as today.
- **Malformed base on the wire** (not a number, or not below `rev`): fall back to today's rule for that block and log; never throw on the vote path.

## Key tests

- `pending-claim.spec.ts`: the rule table above, including the malformed-base fallback and the "never more permissive" property as a small generated check (for every claim, rev and honest base below rev, new-reserves implies old-reserves or equal).
- `storage-repo.spec.ts`: two repos; a record claiming revision 5 on a block; a pend at revision 6 declaring base 4 is refused as held; the same pend declaring base 5 is admitted; a pend at revision 6 with no base is admitted (today's rule, pinned as such).
- `cluster-pend-held-vote.spec.ts`: the same three shapes as `held` and approve verdicts through `validatePendOperations`.
- `cluster-commit-digest.spec.ts`: a commit whose declared base disagrees with the stored base draws a signed `base-declaration-disagrees` reject; agreement, no record, and a base-less record abstain.
- `member-missed-commit-heals-at-commit.spec.ts` and the three-machine mesh specs stay green (the liveness fix is preserved).
- The four-member confirmation the plan ticket asked for: a `createProductionShapedMesh(4)` spec that delays one rival's data-block commit, opens a fresh handle whose read routes to the member that missed the pend, and checks that the newcomer is held rather than landing over the rival's change, and that both changes are present on every member afterwards. The harness (`packages/db-p2p/test/util/node-count-mesh.ts`, `mesh-harness.ts`) offers `setUnreachable`, `transactorDrivenBy` with `onRoute`, and `recording`, but no obvious way to hold a commit between its tail and data-block stages. If it cannot be built within the ticket, do not stub it: pin the rule at the storage and vote tiers as above, file `backlog/debt-four-member-superseded-record-mesh-spec` describing exactly what the harness lacks, and say so in the handoff.

## TODO

- `isReservationAgainst` with the new signature and the rule table; rewrite its doc comment and replace the `NOTE:` with the tripwire above.
- `StorageRepo.pend` and `ClusterMember.reservingRivals` pass the per-block base; decide and document `corroborateHeldBlocks`.
- `validateCommitDigests`: the `base-declaration-disagrees` reject; log line.
- Tests as listed; run `yarn workspace @optimystic/db-p2p test` in the foreground, `yarn typecheck`, `yarn lint:docs`.
- Docs: `docs/correctness.md` §2 "Pend refusal reporting", Theorem 1 Case 2 (the two shapes named there are now closed; say how), Theorem 9 (the superseded rule now rests on the declared base, with the read-side promotion as the second line rather than the first); `docs/repository.md` "A pending record claims a slot, and reserves the block only for that slot"; the doc comment on `operationsConflict` in `race-resolution.ts`; the rival-branch comment in `validatePendOperations`. Grep `carry-its-base` across `packages/` and `docs/` and leave no pointer at a backlog ticket that no longer exists.
- Handoff: state whether the four-member spec was built or filed, and the negative-control result for the rule (with the base comparison removed, exactly the held-vs-admitted tests fail).
