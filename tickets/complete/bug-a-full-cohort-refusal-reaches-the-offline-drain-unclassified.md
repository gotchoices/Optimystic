description: When the machines responsible for a write have no space left, the offline write queue could not tell what went wrong and recorded the failure as unexplained. The refusal now has its own name, and a new guard makes the test suite fail if someone adds a write failure and forgets to name it.
architecture: docs/offline-sync.md
files: packages/db-core/src/transaction/commit-failure-class.ts, packages/db-core/src/offline/queue.ts, packages/db-core/src/offline/status.ts, packages/db-core/src/network/cohort-out-of-space-error.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/test/commit-failure-class.spec.ts, packages/db-core/test/offline-queue.spec.ts, packages/db-core/test/source-scan.ts, docs/offline-sync.md, docs/debugging.md
----

# A full cohort's refusal reaches the offline drain unclassified

## What shipped

**The refusal has a name.** `classifyCommitFailure` (`packages/db-core/src/transaction/commit-failure-class.ts`) gained a `cohort-out-of-space` arm carrying `CohortOutOfSpaceError`, so a write refused by cohort members with no storage left no longer falls through to `unknown`. The offline drain's `applyFailure` (`OfflineQueue.applyFailure` in `packages/db-core/src/offline/queue.ts`) queues such an entry `waitingFor: 'cohort'` and logs `offline:cohort-out-of-space` naming the full members, instead of incrementing `unclassifiedFailures` and logging `offline:unclassified-failure`. The counter `docs/offline-sync.md` promises is "zero in a correct deployment" — which the Quereus plugin surfaces as a health reading — therefore stays at zero when the only thing wrong is that the network is full.

No new `EntryWaitingFor` value: `'cohort'` already existed, and the error itself reaches the application as the entry's `lastError`. This follows the precedent `docs/offline-sync.md` already sets for a deferred restore ("`waitingFor: 'cohort'`, the closest existing value; the reason is in the log line").

**A guard so the next one cannot be missed.** `packages/db-core/test/commit-failure-class.spec.ts` scans the five write-path directories of db-core (`collection`, `collections`, `transaction`, `transactor`, `network`) for error classes they construct, and requires each to be either sorted by the classifier (`SORTED`, 16 entries) or excused with a written reason (`UNSORTED`, 8 entries). Set equality is asserted both ways, so a newly added class fails until someone decides about it, and a table entry for a class nobody constructs any more fails until it is pruned.

Documented in `docs/offline-sync.md` §Classifying an attempt's outcome (a table row and the paragraph arguing for a separate row rather than widening `cohort-unreachable`) and in `docs/debugging.md`'s `offline` log-channel row.

## Review findings

Read the `ticket(implement): bug-a-full-cohort-refusal-reaches-the-offline-drain-unclassified` diff first, before the handoff summary.

### Checked

- **The classified error really reaches the drain unwrapped.** Both raise sites hand it over by name rather than nesting it as a `cause`, which the classifier deliberately never walks: `AttemptCycle.recordRefusal` in `packages/db-core/src/collection/write-attempts.ts` throws it on the first out-of-space pend refusal (no attempt is spent), and on the coordinator path `pendRefusalError` builds it, `pendFailure` carries it whole, and `cleanFailureError` returns it (all in `packages/db-core/src/transaction/coordinator.ts`). So `applyFailure` sees a `CohortOutOfSpaceError`, which is what the new queue-level test now pins end to end.
- **"Changes no retry mechanics" holds, and it was worth checking** — an out-of-space cohort is *reachable*, so reusing the status an unreachable cohort uses could have meant re-submitting with no delay. It does not: `OfflineQueue.drain` awaits `untilWokenOrTimer()` after any submission that stays queued, whatever `waitingFor` says, and that is the jittered exponential backoff (`jitteredBackoffMs`, `packages/db-core/src/offline/wake.ts`); only a commit calls `resetBackoff`. No hot loop against full members.
- **What the application sees.** `lastError` is on the emitted `queued` status and `queuedStatusChanged` (`packages/db-core/src/offline/entry.ts`) compares it by identity, so an entry already waiting on `'cohort'` because the gate was closed still emits a fresh status when the out-of-space refusal arrives. The health counter loses a signal it should never have carried; the per-entry error is where the distinction lives.
- **Nothing else switches on `CommitFailureClass`.** The only consumers of the kind are `applyFailure`, `partiallyCommitted` and the spec's `summarize`; `packages/db-p2p/src/repo/coordinator-repo.ts` mentions the classifier in prose only, and the Quereus plugin never reads the kind. The new union arm breaks no exhaustive switch outside db-core.
- **The `UNSORTED` reasons, against the code** (the handoff asked for this). `PendRejectedError` is module-private to `coordinator.ts` and really never escapes — `pendCollection` throws it into `pendPhase`'s fan-out, which turns it into a `PendPhaseFailure`, and `cleanFailureError` then yields `CoordinatorStaleLossError` or a plain `Error`, as the reason claims. `SealedSegmentsError` is re-thrown at the top of `applyFailure` before any classification, as claimed. The two read-doubt entries are consistent with a decision the classifier already made elsewhere, with one conditional edge now recorded as a tripwire (below).
- **The guard was re-proved to fail, not taken on trust.** Removing `CohortOutOfSpaceError` from `SORTED` makes the accounting test fail naming it ("sort these in `classifyCommitFailure` or excuse them in UNSORTED"); the entry was restored and the file is byte-identical to HEAD (`git diff` on that spec is empty). So the scan is not a no-op that passes forever.
- **The implementer's tests, for ones that do not pay their way.** Nothing cut. The two detector self-tests overlap the `stale` assertion — which already fails if the matcher stops seeing a construction form that is in use — but they also cover forms no current class uses exclusively (arguments across lines, the one class not suffixed `Error`), and they are cheap. The `cases` table and `SORTED` asserting different things (which kind, versus merely "not `unknown`") is the right split; pinning kinds twice would double the edit on every rename.
- **Release notes.** `.release-notes.pending.md` has no open unreleased section (the newest was published and removed), so a note for this operator-visible change would have to invent the next version's heading. Left to the release pass, which is what creates that section.

### Found and fixed in this pass

- **The filed symptom had no test at the layer it was filed from** — the gap the handoff flagged and asked a reviewer to weigh. The classifier case proves the sort; only reading `applyFailure` proved the counter is left alone, and nothing would have caught a future edit that named the class and counted it anyway. Added one case to `packages/db-core/test/offline-queue.spec.ts` ("a cohort with no room left leaves the entry queued waiting for the cohort, NOT counted unclassified"), which drives a real write through the real round trip and asserts `unclassifiedFailures` stays 0, the entry's `lastError` is the refusal, and the write commits once the members have room. Its double needed the shared half of `RefusesPendsAsShortfall`, so rather than copy that class, the refusing-pend behaviour was factored into a `RefusesPends` base and both refusals are now one `refusal()` override each (`packages/db-core/src/testing/test-transactor.ts`).
- **`EntryWaitingFor`'s doc comment was left stale by the change** — and it is the one type the Quereus plugin reads, so its wording is what a plugin author believes. It said `'cohort'` means "the reachability gate said no, or the last attempt could not reach it"; a full cohort was reached and answered. It now names the third cause and says `lastError` is what tells them apart (`packages/db-core/src/offline/status.ts`).
- **`docs/debugging.md`'s `offline` row did not list the new log line.** That row enumerates every `offline:*` line, so a reader grepping for `offline:cohort-out-of-space` would have found nothing explaining it. Added beside `offline:unclassified-failure`, saying explicitly that it is not counted unclassified.
- **`packages/db-core/test/source-scan.ts`'s doc comment names its consumers** and still listed two; this change made it three. Added `commit-failure-class`.

### Tripwire recorded (no ticket)

- **A read doubt still raises the counter this ticket was filed about.** `BlockUnavailableError` with a non-reachability reason, and `BlockPossiblyStaleError` (excused in `UNSORTED` as a read's answer), sort as `unknown`, so if either ever escapes a write's refresh the drain counts an unclassified failure for a condition that may be transient rather than a deployment fault — the same shape as this ticket's own bug. It is conditional, not a present defect: the handling is conservative and correct either way, and the only cost is the counter and the log name. Recorded as a `NOTE:` at the `BlockUnavailableError` arm in `classifyCommitFailure`, naming the signal to watch for (`offline:unclassified-failure` seen naming one of them) and the fix if it trips (give read doubts their own class). Not a ticket: it is fine now, and nothing has been seen to trip it.

### Considered and declined

- **Trimming the five-line comment on the new `applyFailure` case.** It restates `docs/offline-sync.md` §Classifying an attempt's outcome, which is the kind of duplication worth removing — but the duplicated sentence (reusing `'cohort'` changes no retry mechanics) is exactly what someone editing that switch needs in front of them, and it is the claim this review had to go and verify. Left as written; the file's style is comment-heavy throughout.
- **Giving out-of-space its own `EntryWaitingFor` value**, so the queue-wide state distinguishes "full" from "unreachable". It would change a shape the plugin reads for a distinction `lastError` already carries, and the repo's own precedent for a new wait reason goes the other way (the deferred-restore entry reuses `'cohort'`).
- **Widening the guard's scan** past the five write-path directories, or into db-p2p. Both limits are argued in the spec's doc comment and the arguments hold: a wider db-core scan drags blob, queue-internal and wire error classes into the allow-list, and db-core's tests cannot import db-p2p without breaking the package layering `no-fret-import.spec.ts` enforces.

### Nothing found in these categories

- **No correctness defect in the implement diff.** The arm, the drain transition, the doc rows and the guard all do what they claim; the findings above are a missing test, three stale documents and one conditional note.
- **No ticket filed.** Nothing met the filing bar: the only latent concern is conditional (the tripwire), and everything else was small enough to fix in this pass.
- **No pre-existing failures.** Every suite run below was green, so `tickets/.pre-existing-error.md` was not written.

## Validation

All run after the review's own fixes were in, from the repository root unless noted:

- `yarn lint` — clean. `yarn lint:docs` — 49 documents, 910 anchored citations, all resolve.
- `yarn build`, then `yarn typecheck` — clean.
- `yarn workspace @optimystic/db-core test` — 2135 passing.
- `yarn workspace @optimystic/db-p2p test` — 3936 passing.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 1458 passing (plus the `test:smoke` script, `quereus@5.6.1`).
- `yarn test:integration` in `packages/db-p2p` — 60 passing, 2 pending (the two documented `unimplemented:real-tier` cases). In `packages/quereus-plugin-optimystic` — 1466 passing, 8 pending. Run because the ticket's subject is a cohort refusal, though nothing in the diff moves packets.
- The guard's negative case, by hand: `CohortOutOfSpaceError` removed from `SORTED` → the accounting test fails naming it; restored, with no diff left behind.
