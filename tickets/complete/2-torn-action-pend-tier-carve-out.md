description: A machine whose write half-succeeded and retried was being refused by its own already-saved work, forever; the storage-layer checks that compare revision numbers now recognize when the holder is the retrying machine itself.
files:
  - packages/db-core/src/network/stale-failure.ts (new `isOwnRevision` — the single rule, added at review)
  - packages/db-p2p/src/storage/storage-repo.ts (pend — `satisfied` set, own-action branch, filtered save fan-out; commit — `alreadyDone` partition)
  - packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMember.validatePendOperations and .validateCommitRevisions)
  - packages/db-p2p/src/repo/coordinator-repo.ts (CoordinatorRepo.classifyStaleRejection — per-block exclusion)
  - packages/db-p2p/test/cluster-pend-staleness.spec.ts (5 vote cases)
  - packages/db-p2p/test/storage-repo.spec.ts (describe "pend — own already-committed block (torn-action retry)", 3 cases)
  - packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts (2 cases)
  - docs/internals.md, docs/repository.md (updated at review)
----

# Complete: torn-action pend-tier own-action carve-out (db-p2p)

Part 1 of 3 of the torn-action series. Parts 2 (`torn-action-own-entry-consumption`) and 3
(`torn-action-cleanup-and-mesh-validation`) remain in `implement/` and are independent of this one.

## What was wrong

A write transaction touching several blocks is committed one group at a time, so it can end up
with SOME blocks durably committed and the rest refused — a **torn action**. The retry reuses the
same action id (minted once, outside the retry loop, in `Collection.syncInternal`). Every
commit-tier check already asked "who holds the revision I want?" and treated "me" as an idempotent
no-op. The pend tier never asked — it compared revision numbers only — so the retry's pend was
refused by the writer's own already-committed half on every attempt until the retry budget ran out
(`SyncRetryExhaustedError`, zero entries landed).

## What shipped

One rule, now single-sourced as `isOwnRevision(latest, rev, actionId)` in
`packages/db-core/src/network/stale-failure.ts`: **the holder is us when `latest.rev === rev` AND
`latest.actionId === actionId`.** Five checks call it — `StorageRepo.pend`, `StorageRepo.commit`'s
`alreadyDone` partition, `ClusterMember.validatePendOperations`,
`ClusterMember.validateCommitRevisions`, and `CoordinatorRepo.classifyStaleRejection`. Rival
behavior and its signed reject prose are untouched.

- **`StorageRepo.pend`** — such a block is *satisfied*, not merely non-stale: it joins a
  `satisfied` set and `continue`s, skipping both the stale/`missing` collection and the
  pending-action listing, and is filtered out of the `savePendingTransaction` fan-out. It still
  appears in the returned `blockIds` so `cancel` covers it. The per-block loop was reordered
  (revision read now precedes the pending listing) to make the skip possible; both are reads.
- **`ClusterMember.validatePendOperations`** — the promise-round stale vote reads the whole
  `latest` (an `ActionRev`) instead of just `latest.rev`, and approves on the own-action match.
- **`CoordinatorRepo.classifyStaleRejection`** — per-block exclusion inside the `highestStaleAt`
  map: our own block at exactly the requested revision maps to `undefined` rather than a confirmed
  loss.

Only `===` is carved out. Never `latest.rev > rev`: the follow-on commit would take
`StorageRepo.commit`'s `missedCommits` branch and refuse anyway, so approving would just defer the
refusal a round trip.

**Why a satisfied block must NOT get a pending record** (the load-bearing subtlety):
`StorageRepo.commit`'s `alreadyDone` arm skips `internalCommit`, the only thing that promotes (and
thereby removes) a pending record. A pending saved for an already-committed block would never
clear and would sit as a permanent durable reservation that the rival-pending checks refuse every
future writer against — strictly worse than the wedge being fixed. Asserted directly
(`listPendingTransactions()` yields nothing after the re-pend) and now also stated in
`docs/repository.md` under Invariant P.

## Validation

- `yarn test` (whole monorepo, all workspaces): **0 failing**. db-p2p 2390 passing / 49 pending
  (was 2389 before this review's added case); db-core 1449 passing; the remaining nine workspaces
  green.
- `yarn lint`, `yarn build`, `yarn typecheck` from the repo root — all clean.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` was not written.

## Review findings

Read the implement diff (`7d34258a`) before the handoff summary. Ran lint, build, typecheck, and
the full monorepo test suite — all green.

### Verified — claims the handoff asked a reviewer to push on

All four held, and two more that would have silently defeated the fix were checked because the
handoff did not mention them:

- **No pending record for a satisfied block.** Confirmed: `commit`'s `alreadyDone` arm `continue`s
  before both the missing-pends scan and `internalCommit`. Also confirmed `cancel` is genuinely
  inert on a satisfied block — `BlockStorage.deletePendingTransaction` is a bare delete with no
  metadata read-modify-write, so it cannot clobber the committed metadata blob. That is a stronger
  guarantee than the handoff's "no-op" claim.
- **Digest check abstains.** `previewCommitDigest` returns `undefined` with no pending
  (`storage-repo.ts:1035`) and the cluster's content-digest check `continue`s on `undefined`
  (`cluster-repo.ts:1543`). Additionally: `blockDigests` is computed client-side from the tracker
  (`collection.ts:834`), not from local pendings, so a satisfied block still carries a declaration
  and members that are *behind* still check it. The abstention is confined to members that already
  hold the revision — exactly the members with nothing to check.
- **`commit` routes satisfied blocks to `alreadyDone`, not `toCommit`.** Confirmed by reading the
  partition; nothing downstream looks for the absent pending transform.
- **Loop reorder is behavior-neutral.** It swaps two reads *within* one block's iteration; the
  cross-block sequence of revision reads is unchanged, and stale blocks still collect pendings
  exactly as before.
- **Retained apply verdicts cannot serve the pre-fix failure back to a retry.**
  `getExecutedPendResult` is keyed by `messageHash`, not `actionId`, so a retry is re-judged.
- **The coordinator's new fall-through is safe.** With `classifyStaleRejection` now returning
  `undefined` for our own block, control reaches `classifyPendingConflictRejection` more often;
  that method already filters `actionId !== request.actionId` out of `pendings`
  (`coordinator-repo.ts:1545`), so it cannot manufacture a conflict against ourselves.
- **The premise.** `Collection.syncInternal` mints `actionId` once outside the retry loop and
  recomputes `newRev` per attempt (`collection.ts:801-841`), as the ticket states.

### Fixed in this pass (minor)

- **The rule was hand-inlined at five sites.** The handoff's own prose ("mirrored so all three
  pend-tier checks agree") was doing work that code should do. Extracted `isOwnRevision` into
  `db-core/src/network/stale-failure.ts` alongside `isConflictFailure` / `highestStaleAt` — the
  established home for "the single rule for X" — and routed all five checks through it, including
  the two commit-tier sites that already carried the same predicate by hand. No behavior change.
- **Comment bloat at the three new sites.** ~30 lines of near-duplicate prose restating the same
  rationale; the reasoning now lives once on `isOwnRevision` and each site carries one or two
  lines of local context. The `latestRev` local the handoff flagged as cosmetically redundant is
  gone with it.
- **Docs were out of date and said the opposite of the new behavior.** `docs/internals.md`'s "a
  pend rejection is returned only when local storage confirms a revision loss" bullet stated the
  rule as `latest.rev >= request.rev` flat, which is now false; added the own-action exclusion
  bullet naming `isOwnRevision` and all five call sites. `docs/repository.md`'s **Invariant P**
  named `pend` only as a *reporter* of stranded pending records — the carve-out makes `pend` a
  site that must not *create* one, so the obligation is now written down there.
- **Test gap: the mixed case, which is the whole point of the fix, was untested.** Both storage
  tests used a single fully-satisfied block, so the `satisfied` filter on the save fan-out was
  never exercised against a block that still needs a pending. Added
  "re-pends a partially-committed action: committed half satisfied, refused half still pended" —
  commit block-1, re-pend `{block-1, block-2}` under the same action, assert block-1 has no
  reservation while block-2 is pended, both ride in `blockIds`, and the follow-on commit carries
  the whole action to success with block-2 at rev 1 and its pending cleared. Red without the fix
  (the pend is refused outright), green with it.

### Filed as a new ticket (major)

- **`backlog/bug-pend-can-strand-a-permanent-write-block`** — `StorageRepo.pend` reads the block's
  revision *outside* the write latch and saves the pending record *inside* it. A commit landing in
  that gap leaves a pending record that no commit can promote (the block is then `alreadyDone`)
  and no `cancel` will remove (the write succeeded, so `cancel` never runs). That node then
  reports the leftover record as a rival to every future writer of the block — the permanent local
  wedge `docs/repository.md` describes under Invariant P.

  **Pre-existing, not introduced here**: the check-then-act split predates this diff, which only
  added a third outcome to the same unlatched decision. Filed at the boundary-invariant rung
  rather than as a point patch — the durable fix is for `BlockStorage.savePendingTransaction`
  (already latched, already reading metadata) to refuse a pend at a revision the block has already
  taken, so no caller can create an unpromotable record. `repro: static`; confirming it needs an
  injected delay between `pend`'s revision read and its save.

  This is also the concrete, reachable form of the handoff's "concurrency around the carve-out is
  untested" gap, which is why that gap is not carried forward separately.

### Recorded as a tripwire, not a ticket

- **A rev-less pend can never match the carve-out.** `isOwnRevision` requires a defined `rev`, so
  a torn action retried with `request.rev === undefined` (an insert-only claim) is still refused
  by its own insert. Unreachable today — both production pend callers, `TransactorSource.transact`
  and the multi-collection coordinator, pass a required `rev: number`; only the wire type makes
  the field optional. Parked as a `NOTE:` at the carve-out in `StorageRepo.pend`, saying to match
  on `latest.actionId` alone if a rev-less write path ever appears.

### Observed and deliberately not filed

- **The cluster test harness is duplicated across 12 spec files** (`canonicalJson`, `makeKeyPair`,
  `computeMessageHash`, `makeClusterPeers`, `MockPeerNetwork`); the new
  `cluster-pend-staleness.spec.ts` copies it from `cluster-commit-staleness.spec.ts` as the twelfth.
  Pre-existing and inert, and self-contained spec files are a defensible convention — a maintainer
  could reasonably keep it. Not this diff's to change, and not worth a ticket on its own evidence.

### Carried forward from the handoff, unchanged

- **`classifyStaleRejection` is mirrored, not driven.** With the two upstream pend-tier sites
  fixed, the own-action shape should never reach the coordinator classifier; its carve-out exists
  so all the checks agree, and its test drives the classifier through mocked reject verdicts rather
  than a genuine torn action. Correct as designed — noted so nobody reads its test as end-to-end
  evidence.
- **No end-to-end torn-action test here.** A real half-committed multi-block write recovering
  across a live mesh is owned by `torn-action-cleanup-and-mesh-validation` (part 3). The
  duplicate-entry arm — a retry re-appending an entry it already landed — is owned by
  `torn-action-own-entry-consumption` (part 2). This part only stops the pend tier from refusing
  the retry outright.
- **Textual conflict with `tickets/fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed`**,
  which edits a different arm of `validatePendOperations`. This review's refactor touched that
  method again, so the conflict is slightly larger than the handoff described; the changes remain
  logically independent and whoever lands second resolves it.

### Checked and clean

- **Error handling / resource cleanup**: no new throw sites, no new latch acquisitions, no
  lifetime changes; the fan-out's one-latch-per-branch discipline is preserved because the filter
  runs before `withBlockWriteLatch`.
- **Type safety**: `isOwnRevision` takes `ActionRev | undefined` and `number | undefined`, so
  every caller's absent-`latest` and absent-`rev` cases are handled inside the rule rather than at
  each site.
- **Source hygiene**: no file grew materially — `storage-repo.ts` 1386→1387, `cluster-repo.ts`
  2471→2464, `coordinator-repo.ts` 1840→1838. None is near a size that would warrant a
  split on this diff's evidence.
- **Performance**: no new storage reads on any path; the pend loop performs strictly fewer reads
  for a satisfied block (it skips `listPendingTransactions`) and the same number otherwise.
