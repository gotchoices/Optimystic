description: A write could be reported as failed ("torn") although its row was saved, because a competing write that came right after it had been built on top of it; an application that resubmitted then stored the row twice. The writer now asks the storage machines whether what they hold was built from its write and reports it saved when it was; when it reports failure, the error now says whether resubmitting is safe. A second way a "failed" row showed up later — the failed write's staged changes riding along with the writer's next call — is closed too.
architecture: docs/correctness.md
files:
  - packages/db-core/src/collection/collection.ts (`completeOwnEntry`, `settleUnfinished`, `dischargeOwnPendings`, `lineageOfOwnEntry`, `throwTorn`; `actAndSync` / `unstage`; `lastChance` on `refreshInFlight` / `updateInternal` / `syncAttempts`)
  - packages/db-core/src/collection/struct.ts (`TornActionError.final`, `TornActionReason` wording)
  - packages/db-core/src/network/lineage.ts (`judgeCohortLineage`, the cohort folding rule)
  - packages/db-core/src/network/struct.ts (`BlockGets.lineageOf`, `GetBlockResult.lineage`, `BlockLineage`, `ActionLineage`)
  - packages/db-core/src/transactor/transactor.ts (`ITransactor.getLineage`, optional), packages/db-core/src/transactor/network-transactor.ts (`getLineage`, `cohortLineage`)
  - packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collections/diary/diary.ts (`replace` / `append` go through `actAndSync`)
  - packages/db-core/src/transaction/coordinator.ts (`refreshBetweenAttempts` takes `lastChance`)
  - packages/db-core/src/testing/test-transactor.ts (`TestTransactor.getLineage`, `DelegatingTransactor` forwards it, `CommitLandsButReportsStale` takes an `afterLanding` rival)
  - packages/db-p2p/src/storage/struct.ts (`BlockMetadata.lineageFloor`), packages/db-p2p/src/storage/i-block-storage.ts (`setLatest(latest, builtOnPrior, latch)`, `lineageOf`), packages/db-p2p/src/storage/block-storage.ts (floor maintenance in `setLatest`, `recover`, `saveForwardRevision`; `lineageOf`)
  - packages/db-p2p/src/storage/storage-repo.ts (`get` answers `lineageOf`; `internalCommit` passes the derivation into `setLatest`), packages/db-p2p/src/repo/coordinator-repo.ts (`get` forwards `lineageOf` on its refreshed re-read)
  - packages/db-core/test/cohort-lineage.spec.ts, packages/db-core/test/superseded-own-entry.spec.ts, packages/db-core/test/network-transactor.spec.ts (`getLineage`), packages/db-p2p/test/block-lineage.spec.ts, packages/db-p2p/test/superseded-own-write-is-saved.spec.ts
  - docs/internals.md ("The writer's retry finishes its own half-landed action"), docs/correctness.md ("Commit durability reporting"), packages/db-p2p/docs/storage.md (Block Metadata)
difficulty: hard
----

# Summary

A write's log entry lands before its data blocks. When the commit is reported failed, the writer's retry finds its own entry and re-sends the write at its own revision to finish it. Storage refuses that re-send as soon as any block has moved past the revision, which every later commit to the collection does to the log tail. The refusal said only that a rival came after, not whether the rival built on the write (row saved) or over it (row lost), and the writer threw `TornActionError` either way.

The implementation (commit `7e481361`) adds per-member evidence and a cohort rule:

- Each storage node keeps a **lineage floor** in the block's metadata: the lowest revision from which every later revision record was produced on this node by applying an update-only transform to the content before it. Replicas, forward tombstones, insert-carrying commits and a block's first revision each move it up to themselves. `IBlockStorage.lineageOf` answers `contains | excludes | behind | unknown` from the floor plus the revision index, so a member that took a later revision as a replica answers `unknown` in both directions (the fork member never vouches, the restored-past member never denies).
- `StorageRepo.get` answers the question when asked (`BlockGets.lineageOf`), `NetworkTransactor.getLineage` asks every cohort member directly with no context, and `judgeCohortLineage` folds the answers: `contains` needs a strict majority of holders (an `unknown` member counts when it holds the same latest revision under the same action as a voucher), `excludes` needs one prover and every member accounted for, `behind` needs every member, anything else is `unknown`.
- `Collection.settleUnfinished` runs on a refusal with a confirmed rival or on the round that spends the last of the retry budget (`lastChance`, threaded from both write paths): it confirms the cancel of the write's pending records first, then asks lineage, then answers exactly one of saved, torn and `final: true`, or torn and `final: false`.
- `Tree.replace` and `Diary.append` now stage and flush under one latch hold (`Collection.actAndSync`) and unstage exactly what they staged when the flush throws. That closes the "reported torn, appeared one write later" route, which the implementer measured to be the staged actions riding along with the next `replace`, not a pending-record promotion.

# Behaviour changes to know about

- A failed `Tree.replace` / `Diary.append` leaves nothing staged, for every failure kind. `Collection.act` + `sync` keep the old contract.
- `IBlockStorage.setLatest` gained a required `builtOnPrior` argument.
- `TornActionError` gained `final` and its message text changed. `rival-holds-revision` no longer means "nothing can land this write".
- One cancel consensus round plus one `get` per cohort member per block are added on the settle path only.

# Known gaps carried forward (documented in the code and docs, not re-filed)

- `final: false` is the conservative answer whenever lineage cannot be established: a transactor or wrapper without `getLineage`, a member that cannot be reached, fewer than a majority vouching, a content fork, a cancel that could not be confirmed, and a write given up on a deadline. None is a wrong answer.
- A write whose last budgeted attempt lands its tail while the commit is reported failed escapes as `SyncRetryExhaustedError`, never settled; that exit is already tracked in `backlog/bug-a-refused-write-can-leave-its-log-entry-behind`.
- The pend-tier carve-out that would let a superseded-but-contained own tail still land its data block is not done; recorded as an arm on the same backlog ticket.
- Single-node transactor wrappers (the quereus plugin's local mode, `reference-peer`'s `LocalTransactor`) do not offer `getLineage`; a write cannot tear on them because their commit is one atomic `StorageRepo.commit`.

## Review findings

**Provenance check of `block-storage.ts` (the file restored from a backup).** Read the whole file against the ticket's design rather than the diff. Every site that writes `meta.latest` maintains the floor: `setLatest` (through `nextLineageFloor` with the new `builtOnPrior` argument), `recover` (redoes what each lost `setLatest` would have recorded, insert-aware), and `saveForwardRevision` (replica and tombstone, floor = that revision). `saveForwardRevision`'s early return for a revision at or below the held one touches nothing, which is right. The pend-seed metadata write has no `latest` and no floor, which is right. `lineageOf` answers `unknown` for the fork member (index names the write, floor above it) and `unknown` for the restored-past member (no index entry, floor above it); both are pinned in `block-lineage.spec.ts` and asserted per member in the mesh spec. Nothing was lost in the restore.

**Mutation checks, completed independently.** (a) `lineageOf` answering from the index alone: 4 storage cases and 2 mesh cases fail. (b) `judgeCohortLineage` not counting same-latest `unknown` members: 2 cohort cases and 2 mesh cases fail (db-core rebuilt so the mesh spec saw the mutant). Both reverted by reverse edit; `git status` was clean afterwards and the specs pass again.

**Correctness of the evidence.** The floor's claim ("every record above it was derived here from the content before it") rests on `internalCommit`'s fork guard refusing a commit whose declared base is not the local latest; confirmed that guard is on the only production `setLatest` caller. Skipped revision numbers are handled correctly: a revision built here on rev 1 with rev 2 absent from the index answers `excludes` for rev 2, which is the truth. Revision index entries are never pruned (only materializations are), so an absent index entry above the floor is real absence. The lineage `get` is a JSON message with the whole `BlockGets` object, so `lineageOf` and `lineage` cross the wire; the served side routes to `CoordinatorRepo.get`, which forwards the request to local storage on both the direct path and the post-consult re-read. A consult on a member missing the block may install a replica before answering, which can only move an answer toward `unknown` or toward a true `contains` at the write's own revision, never toward a false one.

**Cohort rule.** Checked the contradiction, majority, accounted-for, and empty-cohort branches by hand against the spec; the strict-majority bar matches the commit acknowledgement bar in `docs/correctness.md`. A `behind` member with a vouching majority is reported as unconfirmed in the durability, which is consistent with how a commit reports it.

**Collection layer.** `lastChance` is computed consistently in both write paths (the refresh that would be followed by an over-budget throw is the last), and both paths rethrow the settled error rather than a generic one. The in-flight mark is cleared on every exit of `syncInternal`, so a torn write does not make the caller's next `replace` re-settle it; the mesh spec's resubmit case confirms it. `actAndSync` mirrors `updateAndSync`'s order under one latch hold; `unstage` restores earlier transforms verbatim when the revision has not moved (an invented collection keeps its header) and replays otherwise. A failed attempt never touches the live tracker (each attempt works on a snapshot tracker), so the verbatim restore is sound.

**Suites and lint.** db-core 1801 passing; db-p2p 2992 passing, 63 pending, 0 failing (`tickets/.logs/a-write-reported-torn-can-already-be-saved.review.db-p2p.test.log`); quereus plugin 987 passing, 13 pending (`tickets/.logs/a-write-reported-torn-can-already-be-saved.review.plugin.test.log`); `yarn typecheck` clean; eslint clean on every changed source and spec; `yarn lint:docs` 46 documents, all citations resolve. No pre-existing failures surfaced.

**Docs.** `docs/internals.md`, `docs/correctness.md` and `packages/db-p2p/docs/storage.md` describe the landed mechanism accurately. Grepped the tree for the retired wording ("nothing can land this write", "do not hold that revision", `tornFromRefusal`): none remains outside the archived ticket text.

**Minor findings, fixed inline.**
- `Tree.replace`'s doc comment overclaimed that resubmitting is safe for every error except a non-final `TornActionError`. A `SyncRetryExhaustedError` from the last budgeted attempt or a deadline is not settled and is no promise either way. Reworded to say so and point at `Collection.syncAttempts`.

**Tripwires recorded as `NOTE:` at the site.**
- `Collection.unstage` matches staged actions by identity. A `filterConflict` hook that returns a replacement instance would leave the replacement staged. No collection installs such a hook today (`Tree` and `Diary` install none), so this is conditional; the note says to match on a per-call token if one ever does.
- `Collection.completeOwnEntry` settles a rival-confirmed refusal at once even with retry budget left; the lineage question is asked only once, so a transiently silent member yields `final: false`. The note says to spend the remaining rounds re-asking if unsettled outcomes show up often under contention.

**Major findings.** None. The one real latent exit (a write whose last budgeted attempt lands its tail escapes unsettled) is already tracked in `backlog/bug-a-refused-write-can-leave-its-log-entry-behind`, whose `files:` names that exit; not re-filed.

**Considered and declined to change.** The `transforms-not-held` branch of `completeOwnEntry` now asks lineage about the log tail too (no retained attempt means no known tail id), so a tail cohort that cannot vouch makes the answer not-final rather than saved. That branch is reachable only on a forked lineage and errs conservative; left as is.
