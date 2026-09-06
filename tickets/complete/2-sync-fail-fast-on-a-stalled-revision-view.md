description: A client whose idea of "the current version" is wrong used to re-submit the same doomed write ten times over about twenty seconds before giving up; it now notices within a fraction of a second and stops with an error that names the disagreement. Reviewed, corrected and completed.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/test/collection.spec.ts, packages/db-core/docs/collections.md, packages/db-core/docs/transactor.md, docs/internals.md, docs/debugging.md
----

# Complete: sync stops early when it is provably re-requesting a taken revision

## What shipped

`Collection.sync` retries a rejected write up to `maxAttempts` (default 10, ~21 s of exponential
backoff), refreshing its view between attempts. That budget is worth spending only while the refresh
can change the next attempt. When the client's revision view is *wrong* rather than merely *behind*,
the refresh moves it nowhere and every attempt re-sends the identical, already-refused request.

Sync now detects that and stops with `SyncRevisionStalledError` (a subclass of
`SyncRetryExhaustedError`, so existing `catch` sites keep working) carrying `staleAt`,
`requestedRev` and `heldRev`, plus a message that deliberately avoids the base class's "exhausted N
retries" wording. Budget: `SyncOptions.maxStalledAttempts`, default 2; set it to `maxAttempts` to
restore the previous whole-budget behaviour exactly.

**This makes the failure fast and correctly named. It does not make a wedged write succeed.** Sync
never adopts the responder's revision to get past it: `staleAt` is a bare number, not content, and
the member-side digest guard *abstains* rather than rejects when the declared base revision is one it
no longer holds (`db-p2p/src/cluster/cluster-repo.ts:1646-1739`), so the overwrite would land
silently. Reconciliation stays with `backlog/more-design/6.5-partition-healing` and
`backlog/feat-refresh-can-demand-a-revision-floor`.

### The rule as shipped (corrected during review)

At the top of each iteration, after the abort check and after the deadline check, a *strike* is
recorded only when **all** of these hold:

- a confirmed `lastStaleAt` exists, and
- `getNextRev() <= lastStaleAt.rev`, and
- **the refresh moved the collection's revision nowhere** — `getNextRev()` unchanged since the
  previous iteration, and
- the failure just handled carried its own `staleAt`.

`maxStalledAttempts` consecutive strikes throw. The counter resets whenever the revision moves *at
all*, and on every successful transact alongside `consecutiveFailures`.

`isConflictFailure` is untouched and remains the sole retryability rule. The new rule answers a
different question — *can the next attempt possibly differ from the one that just failed?* — and
only ever ends a loop that rule had already decided to continue.

Other behaviour changes worth knowing: `SyncRetryExhaustedError.staleAt` on the plain-exhaustion
path now reports the **highest** confirmed revision rather than the last one reported (the next
request must clear every holder, so a later lower number understates the constraint), and a caller
with `maxAttempts` and no `maxStalledAttempts` fails sooner under a responder that keeps confirming
a revision.

---

## Review findings

### Checked

Read the implement diff (`5088f4de`) before the handoff summary. Covered: the stall rule's logic
against `advanceContext`'s actual monotonicity contract; error class shape and message
construction; `staleAt` last-wins → highest-wins blast radius across every consumer; the
`TestTransactor` harness change against its production counterpart `StorageRepo`; the whole new
test suite plus the four re-pointed cases; every doc that mentions `staleAt`,
`SyncRetryExhaustedError` or the sync retry contract, including ones the change did not touch;
resource cleanup (latch release on the new throw path — asserted by an existing case); abort and
deadline precedence; file sizes.

### Major — one filed

**The strike rule struck on partial forward progress, contradicting its own premise.** *(Fixed
inline — see below. Recorded here because it was the review's substantive finding, not a nit.)*

**`TransactionCoordinator`'s retry loop has the same defect and cannot be fixed at the loop.** Filed
as `backlog/debt-multi-collection-retry-cannot-see-the-taken-revision`. The implement ticket parked
this as out-of-scope, which was right for that ticket; it is a currently-reachable defect in a
shipped path, so it is a ticket rather than a tripwire. Filed at the type, not the instance: the
number *is* available at the pend refusal (`PendRejectedError`, `coordinator.ts:33-45`) but that
class folds it into prose, and `CoordinatorStaleLossError` (`transaction/errors.ts:78-91`) — the
error the loop catches — carries only `failedCollections` and a free-text `reason`. So the fact is
destroyed at one seam before the loop could use it, and the fix is to let it survive and give both
loops one shared predicate, matching how `isConflictFailure` / `highestStaleAt` / `isOwnRevision`
are already single-sourced. Site-claim grep over all open stages found nothing claiming it;
`6.5-partition-healing` is adjacent but is about making the write land, not about the retry budget.

### Minor — fixed in this pass

**1. The strike condition did not match the invariant it documents.** The code's comment claimed
"the refresh that was supposed to fix that demonstrably did not [move the collection]", but the
check only tested `requestedRev <= lastStaleAt.rev` — *did not move far enough*, which is a strictly
weaker claim. `advanceContext` adopts any revision `>= current` (`collection.ts:357-367`), so a
client reading a replica that lags the confirmed holder climbs one revision at a time while staying
below it. Every one of those rounds is a genuinely different request that may yet win, and every one
of them scored a strike — a spurious `SyncRevisionStalledError` on a sync that was making progress.
The codebase already knows partial refreshes are real: `reportShortfall` /
`collection:context-short-of-tail` exists to report exactly them.

Fixed by requiring both halves: the requested revision is at or below a confirmed one **and** it is
unchanged since the previous iteration. Because the revision can only ever advance, "unchanged" is
exactly "moved nowhere", so the check now tests the invariant it always claimed to. Two regression
tests added (`does not strike while the refresh is still climbing…`, `counts strikes consecutively…`);
both were confirmed to **fail** against the pre-fix condition and pass after.

Worth noting for whoever reads the tests: the first draft of them simulated a rising revision on a
collection that had never committed a header, and `CollectionHeaderVanishedError` fired — correctly.
The tests now commit for real first, and the harness class says why.

**2. `TestTransactor`'s new `staleAt` diverged from `StorageRepo` in both directions.** The change
was justified as "so a caller reading the shared harness sees the real shape", so the divergence
defeated its own purpose. Two gaps: the pend site had no `rev !== undefined` guard, so a rev-less
insert collision reported a revision `StorageRepo.pend:602-607` deliberately withholds
(over-report); and both sites approximated `isOwnRevision` by comparing action ids alone, ignoring
the `latest.rev === rev` half, so our own durable half of a torn action at a *higher* revision was
skipped where production reports it (under-report). Both now call `isOwnRevision` through a small
`latestActionRev(blockState)` helper — the harness equivalent of `IBlockStorage.getLatest()` — so
the rule is single-sourced rather than restated. All four workspaces stay green.

**3. Documentation drift across four files, including ones the change did not touch.**

- `packages/db-core/docs/transactor.md` and `docs/internals.md` both asserted "nothing branches
  retry decisions on `staleAt`" — flatly false after this change, and precisely the text a future
  implementer would read to decide whether they may use the field. Both rewritten to keep the real
  invariant (`isConflictFailure` remains the sole retryability rule; nothing re-derives it from
  `staleAt`) while naming the one consumer that branches, and on what different question.
- `docs/internals.md`'s revision-monotonicity section still described the old outcome ("every retry
  repeats the same doomed request, burning the whole retry budget and surfacing as a
  contention-shaped `SyncRetryExhaustedError`"). Replaced with a bullet explaining that
  monotonicity is what makes the wedge *detectable*, and what resets the count. Its "all three
  lines" handle-tag count also updated to four.
- `packages/db-core/docs/collections.md`'s bounded-retry bullet listed the `SyncOptions` fields and
  named `SyncRetryExhaustedError` as the only stop. Extended with `maxStalledAttempts`, the new
  error, the escape hatch, the highest-wins rule, and the explicit "does not make the write land".
- `docs/debugging.md` (which the change *did* update, thoroughly and well) needed its description of
  the strike condition brought in line with the corrected rule.
- `stale-failure.ts`'s cross-collection `NOTE` now says why it became load-bearing: a candidate from
  an unrelated revision counter would no longer merely muddy a diagnostic, it would fail a sync.

### Checked and deliberately left alone

- **"No test covers a stall arriving mid-multi-batch sync" (handoff gap 3) is not a gap.** A second
  loop iteration after a *successful* transact is unreachable today: the success branch empties
  `pending` under the collection latch and resets the tracker, which the loop's own `NOTE`
  (`collection.ts`, success branch) already states. `consecutiveStalls = 0` there is defensive and
  consistent with its three sibling resets. The pre-existing "healthy multi-batch sync" test is many
  separate `sync()` calls, each starting with a fresh counter — it never exercised this either. No
  test written for an unreachable branch.
- **The duplicated `getNextRev()`** (`requestedRev` at the stall check, `newRev` at the commit)
  reads as a DRY violation but is not one worth collapsing: they are two independent reads of a live
  accessor, each correct at its own point. Merging them would create an ordering dependency where
  none exists today, so a future edit inserting an awaited refresh between them would silently
  commit at a stale revision instead of self-healing.
- **`maxStalledAttempts <= 0`** behaves as 1 (the counter is incremented before the comparison).
  Consistent with `maxAttempts`, which is equally unvalidated; not worth a guard.
- **Reassigning `this.message` after `super()`** in `SyncRevisionStalledError` is safe here: V8
  formats `.stack` lazily on first access, nothing reads it inside the constructor, and both `name`
  and `message` are set before any access.
- **`collection.ts` size**: 1215 lines (`wc -l`). Mid-pack for this repo — the four largest source
  files are 3817, 3238, 2503 and 2488 lines (`find packages/*/src -name '*.ts' | xargs wc -l | sort
  -rn`). No size-debt finding.
- **The `lastFailureConfirmedStaleAt` flag** (a responder that stops reporting `staleAt` freezes the
  strike counter rather than resetting it) is deliberate, bounded by `maxAttempts`, and covered by
  the re-pointed `keeps the last reported revision when a later failure reports none` case. Correct
  as written.
- No accepted-tradeoff `NOTE:` exists at any site touched; the `NOTE`s in this loop concern tracker
  pin residue, digest hashing cost, backoff, and replay order, none of which this change affects.

### Tripwires parked

One, at `DefaultMaxStalledAttempts` (`collection.ts`): the constant 2 is a judgement call, not a
measurement — nothing counts how often a legitimate loser reads a view that moves nowhere for two
consecutive rounds. The correction above narrows the exposure considerably (a client making any
forward progress is now excluded outright), so the remaining risk is genuinely conditional: if a
spurious `SyncRevisionStalledError` ever appears under real contention, raise the default.

## Validation

All green, full sweep after every edit:

- `yarn workspace @optimystic/db-core test` — **1605 passing** (1603 before, +2 regression tests)
- `yarn workspace @optimystic/db-p2p test` — **2581 passing, 49 pending**
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **708 passing, 13 pending** (+ smoke)
- `yarn workspace @optimystic/demo test` — **12 passing**
- Builds: `db-core`, `db-p2p`, `quereus-plugin-optimystic` — all succeed
- Typechecks: `db-p2p`, `quereus-plugin-optimystic` — clean
- `yarn lint` and `yarn lint:docs` — clean (45 documents, 313 links, all resolve)

No pre-existing failures encountered, so `tickets/.pre-existing-error.md` was not written.

## Follow-on filed

- `backlog/debt-multi-collection-retry-cannot-see-the-taken-revision` — the multi-collection retry
  loop has the same shape of problem, and the confirmed revision is destroyed at a single seam
  before it can reach that loop.
