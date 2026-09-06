description: A client whose idea of "the current version" is wrong used to re-submit the same doomed write ten times over about twenty seconds before giving up; it now notices within a fraction of a second and stops with an error that names the disagreement. Review the detection rule and the new error class.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/test/collection.spec.ts, docs/debugging.md
difficulty: medium
----

# Review: sync stops early when it is provably re-requesting a taken revision

## What landed

`Collection.sync` retries a rejected write up to `maxAttempts` (default 10, ~21 s of exponential
backoff), refreshing its view between attempts. That is correct when the client is merely **behind**
— the refresh adopts the winner's revision and the next attempt asks for a higher number. It is
useless when the client's view is **wrong**: the refresh cannot move it (a collection never lowers
its held revision, and an equal or absent read leaves it unchanged), so every attempt re-requests
the identical taken number and the caller waits the full budget for a failure decided on attempt
one.

`StaleFailure.staleAt` — the confirmed revision a responder reported it already holds — was already
threaded through the retry loop but used only for diagnostics. It is now the evidence for a stop
rule.

### The rule

At the top of each loop iteration, **after** the abort check and **after** the deadline check, the
loop compares the revision the next attempt would request against the highest confirmed revision any
responder has reported. A *stalled observation* (a "strike") is recorded when all three hold:

- a confirmed `lastStaleAt` exists, and
- `getNextRev() <= lastStaleAt.rev`, and
- the failure just handled carried its own `staleAt` (the responder re-confirmed the number this
  round, rather than an older observation being left standing).

Two **consecutive** strikes throw `SyncRevisionStalledError`. The counter resets to 0 whenever the
refresh does move past `lastStaleAt.rev`, and on every successful transact alongside
`consecutiveFailures`. `maxStalledAttempts` (new `SyncOptions` field, default 2) is the budget.

`isConflictFailure` is untouched and remains the sole retryability rule. The new rule answers a
different question — *can the next attempt possibly differ from the one that just failed?* — and only
ever stops a loop that `isConflictFailure` had already decided to continue.

### Files changed

- `packages/db-core/src/collection/struct.ts` — `SyncOptions.maxStalledAttempts`;
  `SyncRevisionStalledError extends SyncRetryExhaustedError` with required `staleAt`, plus
  `requestedRev` and `heldRev`, and a replacement message that deliberately does **not** reuse the
  base class's "exhausted N retries" wording.
- `packages/db-core/src/collection/collection.ts` — `DefaultMaxStalledAttempts = 2`; the stall check
  and `collection:sync-stalled` debug line in `syncAttempts`; `lastStaleAt` accumulation switched
  from last-wins to `highestStaleAt`; the inline `newRev` expression replaced with `getNextRev()`.
- `packages/db-core/src/testing/test-transactor.ts` — `TestTransactor`'s own conflict answers now
  carry `staleAt` (pend's committed-conflict branch and commit's stale-revision branch), computed
  with `highestStaleAt` and skipping a revision held by the requesting action itself.
  `FlakyCommitTransactor` deliberately left alone — the degrade tests depend on it never setting
  `staleAt`.
- `packages/db-core/test/collection.spec.ts` — new `stalled revision view` suite (8 cases); two
  existing cases re-pointed.
- `docs/debugging.md` — `collection:sync-stalled` documented under § "Did the refresh itself fail to
  close the gap?"; the `collection` namespace row and three "all three lines" counts updated to four.

## Say this plainly: the write still does not land

This makes the failure **fast and correctly named**. It does **not** make a wedged write succeed.
The downstream consumer that motivated the promotion
(`sereus/tickets/blocked/forked-control-collection-sync-livelocks`) gets a ~21 s livelock converted
into a sub-second named error — which that ticket itself calls "a strictly better outcome" — but its
write still fails. Its real unblock is the refresh being able to read authoritative state, filed as
`backlog/feat-refresh-can-demand-a-revision-floor`. **Do not review this as if the downstream
scenario is fixed.**

Adopting the responder's revision was considered and rejected in the plan stage: `staleAt` is a bare
number, not content, and the member-side digest guard **abstains** rather than rejects when the
declared base revision is one it no longer holds (`db-p2p/src/cluster/cluster-repo.ts:1646-1739`), so
the overwrite would land silently. That reasoning is recorded in the `SyncRevisionStalledError` doc
comment.

## Behaviour changes a reviewer should weigh

- **`SyncRetryExhaustedError.staleAt` on the plain-exhaustion path now reports the HIGHEST confirmed
  revision, not the last one reported.** This is the change with the widest blast radius outside the
  new code path. It is an improvement (the next request has to clear every holder, so a later lower
  number understates the constraint), but it is a visible change to an existing error's payload.
- **A caller with `maxAttempts` and no `maxStalledAttempts` now fails sooner** under a responder that
  keeps confirming a revision. That is the whole point, but it is a default-behaviour change: set
  `maxStalledAttempts: maxAttempts` to restore the old budget exactly.
- **`maxStalledAttempts: 1`** is allowed and is the fastest failure, but is fully exposed to a single
  transiently-lagging read. Documented, not the default.

## What to test / validate

Run `yarn workspace @optimystic/db-core test`. The suite to read is
`packages/db-core/test/collection.spec.ts` → `bounded sync retry` → `stalled revision view`, plus the
adjacent `staleAt on exhaustion` block.

Concrete cases exercised:

- **Stall trips.** Always-`staleAt` transactor at rev 42, `maxAttempts: 10` → rejects with
  `SyncRevisionStalledError` after **exactly 2** commit attempts (the transactor's own counter is
  asserted, not just the error). Still `instanceof SyncRetryExhaustedError`. `requestedRev`,
  `heldRev`, `staleAt` and the message are all asserted, including that the message does **not**
  contain "exhausted".
- **`heldRev` on a collection that has committed.** First commit lands (rev 1), everything after is
  refused at a confirmed rev 42 → `heldRev: 1`, `requestedRev: 2`.
- **One stalled refresh does not trip.** Fail the first commit with a `staleAt`, then delegate → sync
  succeeds and the action is in the log.
- **`maxStalledAttempts: 1`** trips after 1 commit attempt.
- **Abort mid-stall** still yields `AbortError` (abort check stays first).
- **Deadline and stall both true** → plain `SyncRetryExhaustedError` (deadline check stays first).
  Uses `rand: () => 0` for a deterministic 40 ms sleep against a 5 ms deadline.
- **Real contention does not trip it.** Two handles on one id against the real `TestTransactor`: the
  loser's refresh adopts the winner and its next request clears the confirmed revision, so no strike
  is ever recorded. This is the case the rule must not mistake for a wedged view.
- **Debug line.** `collection:sync-stalled` is asserted to fire on **every** strike (2 lines, not 1),
  with `heldRev=none requestedRev=1 staleBlock=hot-block staleRev=42 strike=1 of=2` / `strike=2 of=2`
  and a `tag=`.

Re-pointed existing cases (neither weakened nor skipped):

- `surfaces the reported revision on the error and names it in the message` — now passes
  `maxStalledAttempts: 3` (== `maxAttempts`), keeps every original assertion verbatim, and gains an
  assertion that all 3 commit attempts really were spent. This doubles as the "escape hatch restores
  the full budget" test.
- `keeps the last reported revision when a later failure reports none` — unchanged assertions, plus
  a new one that it is *not* a `SyncRevisionStalledError` (only attempt 1 confirmed a revision, so no
  second consecutive strike accrues).
- `produces today's message verbatim when no responder reported a revision` — now explicitly runs
  under the **default** `maxStalledAttempts`, since no confirmed revision means no stall is
  detectable; the exact-message assertion is untouched.
- New: `keeps the HIGHEST reported revision when a later responder reports a lower one` — pins the
  last-wins → highest-wins change.

### Validation run

All green, from a clean tree:

- `yarn workspace @optimystic/db-core test` — **1603 passing**
- `yarn workspace @optimystic/db-p2p test` — **2581 passing, 49 pending**
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **708 passing, 13 pending** (+ smoke)
- `yarn workspace @optimystic/demo test` — **12 passing**
- Builds: `db-core`, `db-p2p`, `quereus-plugin-optimystic` — all succeed
- Typechecks: `db-p2p`, `quereus-plugin-optimystic` — clean
- `yarn lint` and `yarn lint:docs` — clean

No pre-existing failures were encountered, so `tickets/.pre-existing-error.md` was not written.

## Known gaps — treat these as the starting point, not the finish line

- **`TestTransactor` now emits `staleAt` on its conflict answers.** The ticket marked this
  "preferred, drop it if it perturbs other specs". It perturbed nothing (all four workspaces green),
  but it is a change to a harness shared by db-core, db-p2p, demo and the Quereus plugin, and its
  blast radius is wider than the tests that assert it. Worth a second look, particularly the
  own-action exclusion (`revisionActions.get(latestRev) !== actionId`) — it mirrors
  `isOwnRevision`'s `===`-only rule by hand rather than calling it, because the shape available at
  those two sites is a `latestRev`/`actionId` pair rather than an `ActionRev`.
- **The two-strike constant is a judgement call, not a measurement.** Two absorbs exactly one round
  of transient read lag. Nothing measures how often a legitimate loser reads a lagging view for two
  consecutive rounds; if that turns out to happen under real contention, the symptom is a spurious
  `SyncRevisionStalledError` and the fix is raising the default.
- **No test covers a stall arriving mid-multi-batch sync** (forward progress, then a wedge). The
  reset on successful transact is asserted only indirectly, by the pre-existing
  `should complete a healthy multi-batch sync under a tiny maxAttempts` staying green.
- **The `lastFailureConfirmedStaleAt` flag is subtle.** A responder that stops reporting `staleAt`
  mid-loop freezes the strike counter rather than resetting it — deliberate (the budget stays bounded
  by `maxAttempts`), and covered by the re-pointed `keeps the last reported revision` case, but it is
  the branch most likely to be misread.
- **`TransactionCoordinator`'s own retry loop is untouched**, per the ticket's out-of-scope list. It
  carries `staleAt` too and has the same shape of problem. Not filed — the ticket explicitly parked
  it.

## Tripwires parked during implementation

None. The stall check reuses the existing `log.enabled` gating and adds nothing per-iteration beyond
one integer comparison, so there was no conditional-cost concern to record at a code site.
