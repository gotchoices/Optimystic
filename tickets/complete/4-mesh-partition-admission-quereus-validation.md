description: A safety check that stops a network split from letting two halves of a cluster both accept the same write is now covered by tests, and the review pass closed several accuracy gaps in the tests and the docs around it.
files:
  - packages/db-p2p/test/mesh-partition-admission.spec.ts (7 cases; review corrected 3 things in it)
  - packages/db-p2p/test/coordinator-repo-cancel-solo-cohort.spec.ts (new in review, 3 cases)
  - packages/db-p2p/src/repo/coordinator-repo.ts (cancel() solo short-circuit + review tripwire NOTE)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts (solo-cancel regression case)
  - packages/quereus-plugin-optimystic/test/mesh-node-harness.ts (comment only)
  - packages/db-p2p/README.md (solo-mode section, corrected in review)
  - docs/correctness.md (Theorem 2 status, caveat added in review)
----

# Mesh partition admission gate — validated and reviewed

## What landed

A mesh-tier spec that drives the real coordinator + cluster-member stack over a five-node mesh,
splits its cluster views three-to-two, and asserts what the **membership admission gate**
(`ClusterMember.admitMembership`) does on each side. The gate is the mechanism that stops a
coordinator on the losing side of a network split from shrinking a block's responsible peer set down
to its own side and getting that set rubber-stamped — which is what would let both sides commit the
same block independently.

Seven cases: the minority side refuses and commits nowhere; a member whose own topology derivation
*throws* fails closed the same way; a confidently-measured majority is admitted (which is the
designed behavior, not a leak — see below); the commit path is pinned to its current, known-buggy
behavior; a partition that collapses confidence on both sides halts both; the "the record must list
me as a member" rule holds even with the small-cluster escape hatch open; and an unpartitioned
control writes and reads back.

One production fix rode along: `CoordinatorRepo.cancel` had no solo-cohort short-circuit where
`pend` and `commit` both did, so a single-node deployment could pend and commit but never cancel.
The short-circuit is decided per block id, because one cancel can span blocks whose cohorts are
different sizes.

## Why "the majority side is admitted" is correct

The safety property is that the *minority* side cannot also commit while the majority proceeds. It
is not that every partition must halt. A side that still holds a confidently-measured super-majority
of the true cohort is meant to keep working; the spec asserts both halves of that (minority refused,
majority admitted).

## Review findings

**Checked:** the implement-stage diff and the prior commit that actually carries the spec and the
`cancel` fix (the handoff attributes both to this ticket; the code landed in `19ed93c`, this ticket's
own commit `a75a824` is the harness comment); every arithmetic claim in the spec's header and case
comments against `cluster-policy.ts` and `cluster-repo.ts`; the `cancel` short-circuit's behavior for
single-block, all-solo, mixed and all-multi-peer cancels; test coverage against happy path, error
paths, and the interaction the implementer flagged as untested; documentation touching solo-node
behavior and the admission gate; lint, build, typecheck, and both package suites.

**Minor — fixed in this pass:**

- The spec cited ticket slug `commit-records-carry-no-coordinating-block` in two places. No such
  ticket exists; the filed one is `commit-and-cancel-records-omit-the-coordinating-block`. Corrected
  both, so the reader who follows the pin actually finds the ticket.
- "A confident majority is admitted on the pend path" asserted only that the call did not throw.
  `pend` reports a lost optimistic-concurrency race and a stale revision as a *returned*
  `success: false`, so that assertion would have passed on a pend that admitted nothing. It now
  asserts `success === true` as well.
- The spec's local-state reader passed `{ skipClusterFetch: true } as any` to `StorageRepo.get`.
  That option is read only by `CoordinatorRepo.get`; on a `StorageRepo` it is dead. Copied from the
  mesh harness, where it is equally dead. Removed, and the comment now states the real reason the
  read cannot be contaminated (it bypasses the coordinator entirely).
- `packages/db-p2p/README.md`'s solo-node section still said only `pend`/`commit` short-circuit to
  local storage. Stale the moment the `cancel` fix landed. Updated, including the per-block-vs-once
  distinction.
- `docs/correctness.md` Theorem 2 described the admission gate without recording that it is armed on
  the pend path only. Added as caveat (3) in that theorem's status block, pointing at the filed fix
  ticket and at the spec case that pins it.

**Minor — test gap closed in this pass:**

- The `cancel` fix's entire justification is that the decision is made per block id rather than once
  for the first block, and nothing tested that. The mesh harness cannot: it gives every key the same
  `responsibilityK`, so one coordinator never sees two blocks with differently sized cohorts. Added
  `packages/db-p2p/test/coordinator-repo-cancel-solo-cohort.spec.ts`, which stubs the key network so
  cohorts vary by block key, and pins three shapes — all-solo (nobody is dialled, local storage
  cancels once for the whole action), mixed solo + multi-peer (the multi-peer block still reaches the
  cluster path; deciding once from the first block would have silently cancelled a replicated block
  locally and told no one), and all-multi-peer (unchanged from before the short-circuit existed).

**Major — none filed.** The one major defect in this area is the commit/cancel path carrying no
coordinating block id, and it was already filed as
`tickets/fix/1-commit-and-cancel-records-omit-the-coordinating-block`. Re-verifying it against the
code turned up that the ticket's own "Correction to the originating handoff" section measures against
`ClusterMember`'s bare constructor fallbacks rather than against `resolveClusterPolicy`, which is what
a real node is assembled from. On a real node `assumedClusterSize` is never unset, so the ticket's
"admits essentially anything" branch is unreachable in production; the live weakness is a fallback
floor of 2, which is nominal gating rather than none. Appended to that ticket as a second correction
rather than filed separately — same root cause, same code site.

**Tripwire — recorded, not filed:** `cancel`'s short-circuit calls `getClusterSize`, which is a
second cohort lookup for a key that `executeClusterTransaction` is about to look up again, so a
cancel over N blocks now costs 2N lookups instead of N. `pend` and `commit` pay the same double
lookup but only once each, since they consult only the first block. Fine while cancels span a handful
of blocks. Parked as a `NOTE:` at the site in `coordinator-repo.ts`, with the cheaper remedy named
(have `executeClusterTransaction` return or own the cohort it already fetched) so nobody reaches for
a cache first.

**Evidence appended, not re-filed:** `coordinator-repo.ts` is now 1451 lines (`wc -l`), up from the
1341 recorded when the existing size ticket
`tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md` was last measured. Added
as a fourth measurement on that ticket, noting that this round's growth is the solo-cohort
short-circuit acquiring its third inline copy rather than more freshness state.

**Deliberately left alone:** the commit-path case that asserts a *rejection* stays pinned to the
current buggy behavior. That is the right way to hold a filed defect from its test — the spec's own
comment says what must change there when the fix lands, and the fix ticket says so from its side too.

**Pre-existing failures:** none. No test was skipped, disabled, or loosened.

## Validation run

- `npx eslint` over every touched source file — clean.
- `yarn build`, `yarn typecheck` — clean.
- `yarn workspace @optimystic/db-p2p test` — **1942 passing, 44 pending, 0 failing** (37s). Up three
  from the implementer's 1939: the new cancel spec.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **656 passing, 13 pending, 0
  failing** (3m), plus its smoke check.
