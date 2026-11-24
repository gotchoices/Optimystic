description: When the machines responsible for a write have no space left, the offline write queue cannot tell what went wrong — it records the failure as unexplained and counts it on a health number that is documented as staying at zero in a healthy deployment.
architecture: docs/offline-sync.md
files: packages/db-core/src/transaction/commit-failure-class.ts, packages/db-core/src/offline/queue.ts, packages/db-core/src/network/cohort-out-of-space-error.ts, packages/db-core/test/commit-failure-class.spec.ts, docs/offline-sync.md
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Nothing is lost or mis-stored — the queue keeps the write and retries it — so a maintainer may reasonably accept a noisy counter and an extra log line per attempt until someone actually runs a full cohort behind an offline queue, rather than spend a decision on what the drain should do with this class.
----

# A full cohort's refusal reaches the offline drain unclassified

## The one place every write failure is sorted

`classifyCommitFailure` in `packages/db-core/src/transaction/commit-failure-class.ts` is the single place a failed write is sorted into what the caller should do about it, so that no caller reads an error message to decide. Its `unknown` arm is the catch-all, and the offline queue treats it as a signal in its own right: `applyFailure` in `packages/db-core/src/offline/queue.ts` increments `unclassifiedFailures`, logs `offline:unclassified-failure`, and retries. `docs/offline-sync.md` states what that counter means — it "is zero in a correct deployment" — and the Quereus plugin surfaces it as a health reading for the same reason.

## What is missing

`CohortOutOfSpaceError` (`packages/db-core/src/network/cohort-out-of-space-error.ts`) is new and has no arm, so it falls to `unknown`. It is reachable from the drain: a queued entry's pend meets a cohort whose members have no room, the write path raises that class by name (`AttemptCycle.recordRefusal`, `cleanFailureError`), and `applyFailure` sorts it.

The consequences are all diagnostic, and all in the direction of hiding a known condition behind an "unknown" label:

- the health counter documented as zero in a correct deployment rises, once per attempt, for a condition that is an operational fact about the network rather than a defect of the deployment;
- an operator reading `offline:unclassified-failure` is told the classifier could not name the failure, when the failure is in fact named precisely;
- the entry reports `waitingFor: 'backoff'` rather than `'cohort'`, which is the status that means "waiting for the machines to be ready".

Nothing is mis-stored: the write was never accepted by anyone, and the drain's `unknown` behaviour — keep the entry under its own identity and retry — is safe. What is wrong is the reporting.

## Two things to settle, and the second is the one that pays

**The arm.** Give the class a home in `CommitFailureClass`. The reading already noted at the error's own doc site is that `cohort-unreachable` is the near fit — nothing was stored, and what clears it is the cohort rather than the writer — but its documented meaning today is "too few of the cohort *answered*", and a full cohort answered clearly. So this is a decision about what the drain should do, not a rename: either widen `cohort-unreachable`'s meaning to "the cohort cannot take this write right now, for a reason that clears on the cohort's side" and say so in `docs/offline-sync.md`'s classification table, or add a class of its own beside it. Either way `waitingFor` should stop saying `backoff`.

**The guard that keeps this from recurring.** This is the second time the shape has come up — `PeersIncompleteError` carries a `phase` the classifier deliberately does not sort on, and now a whole error class has been added to the write path with no arm here. Both were found by reading, not by a failing check. What would catch the next one is a test that enumerates the error classes a write path can raise and asserts each sorts to something other than `unknown`, with an explicit allow-list for the ones a human has decided to leave unsorted (and a comment saying why, at each). `packages/db-core/test/commit-failure-class.spec.ts` is where it belongs. That is the arm of this ticket worth doing even if the mapping above is argued over: it converts "someone must remember" into "the suite says so".

## Promoted to fix (garden, 2026-11-24)

Pulled into this release: the out-of-space refusal it concerns was added by `3.5-a-full-cohort-member-refuses-a-pend` and is not yet released, so the release should ship that refusal with this corrected rather than leave it for a later one.
