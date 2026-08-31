description: A machine whose write half-succeeded and retried was being refused by its own already-saved work, forever; the three storage-layer checks that compare revision numbers now recognize when the holder is the retrying machine itself.
files:
  - packages/db-p2p/src/storage/storage-repo.ts (pend — `satisfied` set at ~line 497, own-action branch at ~518, filtered save fan-out at ~604)
  - packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMember.validatePendOperations — self-exclusion at ~line 1263)
  - packages/db-p2p/src/repo/coordinator-repo.ts (CoordinatorRepo.classifyStaleRejection — per-block exclusion at ~line 1476)
  - packages/db-p2p/test/cluster-pend-staleness.spec.ts (new — 5 vote cases)
  - packages/db-p2p/test/storage-repo.spec.ts (new describe "pend — own already-committed block (torn-action retry)", ~line 295)
  - packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts (2 new cases + mock gained `latestActionId` / `actionIdByBlock`)
difficulty: medium
----

# Review: torn-action pend-tier own-action carve-out (db-p2p)

Part 1 of 3 of the torn-action series. Parts 2 (`torn-action-own-entry-consumption`, db-core)
and 3 (`torn-action-cleanup-and-mesh-validation`) are still in `implement/` and are independent
of this one.

## What was wrong, in plain terms

A write transaction can touch several blocks and is committed one group at a time, so it can end
up with SOME blocks durably committed and the rest refused — a **torn action**. The retry reuses
the same action id (minted once, outside the retry loop, in
`Collection.syncInternal`). Every commit-tier check already asks "who holds the revision I want?"
and treats "me" as an idempotent no-op. The pend tier never asked — it compared revision numbers
only — so the retry's pend was refused by the writer's own already-committed half, on every
attempt, until the retry budget ran out (`SyncRetryExhaustedError`, zero entries landed).

## What changed

Three sites, one rule: **when `latest.rev === request.rev` AND `latest.actionId ===
request.actionId`, the holder is us — not a rival.** Gated on action-id equality everywhere, so
rival behavior and its signed reject prose are untouched.

- **`StorageRepo.pend`** — such a block is *satisfied*, not merely non-stale. It is added to a
  `satisfied` set and `continue`s, skipping both the stale/`missing` collection and the
  pending-action listing. The per-block loop was reordered (revision read now precedes the
  pending listing) to make that skip possible; both are reads, so nothing else changes. Satisfied
  blocks are then filtered out of the `savePendingTransaction` fan-out but STILL appear in the
  returned `blockIds` so `cancel` covers them.
- **`ClusterMember.validatePendOperations`** — the promise-round stale vote now reads the whole
  `latest` (an `ActionRev`) instead of just `latest.rev`, and approves on the own-action match.
- **`CoordinatorRepo.classifyStaleRejection`** — per-block exclusion inside the `highestStaleAt`
  map: our own block at exactly the requested revision maps to `undefined` rather than a
  confirmed loss.

Only `===` is carved out. Never `latest.rev > request.rev`: the follow-on commit would take
`StorageRepo.commit`'s `missedCommits` branch and refuse anyway, so approving would just defer
the refusal a round trip. No `IRevisionActionReader` at the pend tier — `latest.actionId` off the
same read already answers the `===` case.

## The non-obvious part a reviewer should push on

**Why a satisfied block must NOT get a pending record.** `StorageRepo.commit`'s `alreadyDone` arm
`continue`s past `internalCommit`, and `internalCommit` is the only thing that promotes (and
thereby removes) a pending record. A pending saved for an already-committed block would never be
cleared and would sit as a permanent durable reservation that the rival-pending checks (pend's own
`listPendingTransactions` scan, and `validatePendOperations`'s pending-rival vote) refuse every
future writer against — a strictly worse wedge than the one being fixed. This is asserted
directly (`listPendingTransactions()` must yield nothing after the re-pend), and the reasoning is
commented at the fan-out.

Downstream consequences that were checked and are believed benign — worth an independent look:
- `previewCommitDigest` returns `undefined` for a block with no pending, and the cluster's
  content-digest check explicitly abstains on `undefined`. So a satisfied block simply isn't
  digest-checked at that member.
- `StorageRepo.commit` routes the satisfied block to `alreadyDone` (not `toCommit`), so nothing
  downstream looks for the missing pending transform.
- Ordering within the pend loop: for a *stale* block, pendings are still collected exactly as
  before; only satisfied blocks skip.

## Validation performed

- `yarn workspace @optimystic/db-p2p test` — **2389 passing, 0 failing, 49 pending** (9 of those
  passing cases are new here: 5 cluster + 2 storage + 2 coordinator).
- `yarn lint`, `yarn build`, `yarn typecheck` from the repo root — all clean.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` was not written.

### Tests added (and which ones actually reproduce the bug)

Written first and confirmed **red before the fix**:
- `cluster-pend-staleness.spec.ts` → "approves a re-pend of a block THIS action already committed
  at the requested rev" — observed `expected 'reject' to equal 'approve'` pre-fix, matching the
  vote-tier repro recorded on the source ticket.
- `storage-repo.spec.ts` → "accepts a re-pend of the SAME action at the revision it already
  committed, recording no pending" — observed `success: false` pre-fix.

Guard cases (green both before and after — they pin behavior that must NOT change): rival at the
same rev with the reject prose asserted verbatim, own action already *past* the rev, lagging
member, never-saw-the-block, and the storage rival re-pend still producing `missing`.

The coordinator pair: "does not confirm a loss against THIS action's own already-committed
revision" is a real pre/post case (pre-fix it would have returned a `StaleFailure` instead of
rethrowing) — **it was verified by inspection of the one-line change, not by running it red**;
"still confirms a rival on ANOTHER block" is a guard that passes either way.

## Known gaps / where this is thin

- **`classifyStaleRejection` is mirrored, not driven.** With the two upstream pend-tier sites
  fixed, the own-action shape should never reach the coordinator classifier at all. Its carve-out
  exists so all three checks agree, and its test drives the classifier directly through mocked
  reject verdicts rather than through a genuine torn action.
- **No end-to-end torn-action test here.** Nothing in this ticket exercises a real
  half-committed multi-block write recovering across a live mesh; that is owned by
  `torn-action-cleanup-and-mesh-validation` (part 3). The duplicate-entry arm — a retry
  re-appending an entry it already landed — is owned by `torn-action-own-entry-consumption`
  (part 2) and is **not** addressed here. This part only stops the pend tier from refusing the
  retry outright.
- **Concurrency around the carve-out is untested.** The pend loop's pre-existing race comment
  ("a concurrent commit could complete between the checks and the save") now also applies to the
  satisfied decision: a commit landing our own rev between `getLatest()` and the fan-out would
  leave a pending we then never clear via promotion. That window existed before in the mirrored
  direction and commit is still the final arbiter, but nobody has tested it.
- **`packages/db-p2p/src/cluster/cluster-repo.ts` textual conflict** with
  `tickets/fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed`, which edits a
  different arm of the same `validatePendOperations` method. Whoever lands second resolves it;
  the changes are logically independent.
- The `latestRev` local kept inside `validatePendOperations` after the restructure exists only to
  feed the log object and the reason string; it reads slightly redundantly next to `latest.rev`.
  Cosmetic.
