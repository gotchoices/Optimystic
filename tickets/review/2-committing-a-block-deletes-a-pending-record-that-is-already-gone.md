description: Every commit spent one extra storage operation deleting its own pending record, which the commit had already moved to the committed store. That delete is now skipped on both the normal commit path and crash recovery; rival records are still cleaned up exactly as before.
files:
  - packages/db-p2p/src/storage/block-storage.ts (`setLatest` ~line 310, `recover` ~343, `sweepDeadClaims` ~237, `recordClaim` ~215)
  - packages/db-p2p/test/block-storage.spec.ts (describe 'BlockStorage pending claims — a record claims the slot it was pended at', ~line 1841)
repro: verified
----

# What changed

Background: when a cohort member promises a pend, it stores a pending record plus a "claim" (the revision the record was pended at, in `BlockMetadata.pendingRevs`, keyed by action id). Whenever `latest` advances, `sweepDeadClaims` deletes every pending record whose claim is at or below the new latest, because that record can never be promoted.

On commit (`StorageRepo.internalCommit`: `saveRevision` → `promotePendingTransaction` → `setLatest`), promotion atomically **moves** the committing action's record from pending to committed but leaves its claim behind. `setLatest`'s sweep then found that claim and issued a raw `deletePendingTransaction` for a record that was already gone: one wasted raw-storage op per commit. `recover` (which redoes a lost `setLatest` after a crash between promote and setLatest) did the same once per recovered action. Sereus measured this at +11 raw ops per solo insert and +8 per solo launch.

The fix, in `packages/db-p2p/src/storage/block-storage.ts`:

- `setLatest` calls `BlockStorage.recordClaim(meta, latest.actionId, undefined)` before the sweep. The claim is dropped in the metadata write that `setLatest` already makes, so no extra write.
- `recover` collects the action id of each revision its probe loop accepts (`recoveredIds`) and drops each one's claim before the sweep. This is safe because the loop only accepts an action that has a committed record, and promotion is an atomic move (pinned by the raw-storage conformance test "promotePendingTransaction moves pending → committed atomically", `packages/db-p2p/src/testing/raw-storage-conformance.ts:363`).

Unchanged: rivals at or below the new latest are still swept; pend still writes the claim (metadata) before the record; `pendingRevs` stays absent when empty. The other sweep caller, `saveForwardRevision`, already dropped the landing action's claim and keeps its explicit Invariant-P delete, because a forward write never went through promotion.

# Tests (all in the pending-claims describe of `block-storage.spec.ts`)

The describe now uses `DeleteRecordingStorage`, a `MemoryRawStorage` subclass that records every raw `deletePendingTransaction`. Tests clear the recording after setup, because `saveReplica` makes its own (legitimate) Invariant-P delete.

- **Extended** 'setLatest sweeps a rival record…': the deletes are exactly `['a-loser']`, with none for the winner.
- **Extended** 'recover sweeps the claims the lost setLatest owed': the deletes are exactly `['a-loser']`.
- **New** 'a solo commit deletes no pending record: promotion already moved its own': no deletes, the record is committed and no longer pending, and `pendingRevs` is absent.
- **New** 'recover after lost setLatests deletes no pending record for any recovered action': two stacked lost `setLatest`s (revisions 2 and 3). No deletes, `latest` advances to 3, and both claims are dropped. This covers the loop collecting more than one id.

Checked against the pre-fix `block-storage.ts` (HEAD's version swapped in, then restored): all four assertions fail with the committing action's id in the delete list, so they pin this change.

Results with the change: `yarn typecheck` is clean. `block-storage`, `pending-claim`, `member-missed-commit-heals-at-commit` and `storage-repo` specs have 203 passing. The full `yarn test` in `packages/db-p2p` has 3018 passing, 63 pending and 1 failing; that failure is the pre-existing flake below.

# Known gaps and things for the reviewer to check

- **The full suite's one failure is a pre-existing flake**, written up in `tickets/.pre-existing-error.md`. `concurrent-two-member-writes-do-not-tear.spec.ts` intermittently reports a `TornActionError` (a log entry landed at rev N while a rival had already committed one of the action's other blocks at N+1). It failed 2 of 18 loaded parallel runs with HEAD's `block-storage.ts`, and 1 of 12 plus the one full-suite run with this change. It passes in isolation.
- **Residual risk in `recover`, parked as a `NOTE:` at the site.** `StorageRepo.pend` only checks `latest`. If an action is re-pended while its lost `setLatest` is still owed, the block ends up with both a pending and a committed record for that action. The old code's sweep would have deleted that stray pending record. The new code drops its claim and leaves the record, and readers treat a claim-less pending record as the strongest reservation. It is not reachable through one lost `setLatest`: `StorageRepo.commit` calls `recover` only when the committing action's own pending record is absent, and if the re-pended action commits normally, its record is promoted as usual. Reaching it takes a second lost `setLatest` above the first. The NOTE names the fix if that ever becomes reachable: delete the recovered actions' records in `recover`, where the extra op costs almost nothing because recover is rare. A reviewer could reasonably decide to keep the delete in `recover` anyway, since sereus's savings are all on the commit path.
- The downstream figures (solo insert about 88 ops, solo launch about 80) are sereus's numbers. This repo has no solo-strand op-count spec to confirm them, so they were not measured here.
