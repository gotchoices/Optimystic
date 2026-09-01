description: A cluster node's bookkeeping pass for competing writes had two behaviours no test covered; both now have a test that fails if the behaviour is broken, and the pass's hardcoded timeout became an injectable clock so the test does not have to sleep for two seconds.
files: packages/db-p2p/src/cluster/cluster-repo.ts (CONFLICT_STALE_THRESHOLD_MS ~245; ClusterMemberComponents.now ~214; clusterMember factory ~241; constructor ~352/355; lastUpdate write ~626; findConflict ~2210-2270; persistParticipantState ~2405), packages/db-p2p/test/cluster-repo.spec.ts (two new tests in describe 'conflict detection' ~763-880)
difficulty: medium

# Review: reservation-scan side effects now have tests, plus an injectable clock

## What landed

`ClusterMember.findConflict` is the pass a cluster node runs before voting on a write: it walks the
table of writes it currently holds open (`activeTransactions`) and, per entry, skips the record
against itself, sweeps entries nobody has touched in 2 seconds, then decides the contest against any
still-live overlapping entry and clears the loser before continuing the walk. Two of those steps had
no test. Both do now.

**Source changes** (`packages/db-p2p/src/cluster/cluster-repo.ts`):

- New exported `CONFLICT_STALE_THRESHOLD_MS = 2000`, replacing the function-local `staleThresholdMs`.
  Exported so the test advances past it without restating the number.
- New optional `now?: () => number` on `ClusterMemberComponents`, threaded as the final positional
  constructor parameter and the final `clusterMember()` factory argument, stored as
  `private readonly now`, defaulting to `Date.now`.
- Exactly three `Date.now()` reads converted to `this.now()`: the `lastUpdate` stamp in the
  `shouldPersist` branch (~626), the `now` in `findConflict` (~2212), and the `lastUpdate` in
  `persistParticipantState` (~2405). Both the stamp and the comparison move together — converting
  only the read would put them on different time bases and nothing would ever look stale. The other
  eight `Date.now()` reads in the file are untouched by design (listed under *Known gaps*).
- Comment-only: the sweep and the `continue` each got a comment saying why they are where they are,
  and the self-skip guard got a comment recording that it is unreachable defensive code.

**Test changes** (`packages/db-p2p/test/cluster-repo.spec.ts`, both inside `describe('conflict detection')`):

- `sweeps an abandoned reservation before deciding the race, not after`
- `keeps scanning after clearing one loser, and is still blocked by a second live rival`

## Validation performed

- `yarn workspace @optimystic/db-p2p build` — exit 0.
- `yarn workspace @optimystic/db-p2p test` — **2491 passing, 49 pending, 0 failing**. No
  pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
- **Mutation-checked both tests, and reverted both mutations.** Each test fails on exactly the
  mutation it targets and only that one:
  - Moving the staleness sweep to *after* the `resolveRace` decision → the first test fails
    (`expected conflict, got approve` becomes `expected approve, got conflict`); the second passes.
  - Swapping `continue` for `break` in the race's accept-incoming branch → the second test fails
    (`a second live rival must still block D, got approve`); the first passes.
- No `lint` script exists on this package (`yarn workspace @optimystic/db-p2p lint` → "Couldn't find
  a script named lint"), so none was run.

## Use cases a reviewer should exercise

**The behaviour under test, in plain terms.** Two writers try to change the same data at once. The
node holding both requests must (a) not let a request whose writer walked away keep blocking a live
one, and (b) not admit a request just because it beat *one* of the reservations it overlaps.

**Test 1 — the sweep runs before the contest.** Five peers, so four approvals commit. Reservation A
holds `block-shared` with three approvals — one short, so it stays in the table rather than
committing and clearing itself. The injected clock then jumps `CONFLICT_STALE_THRESHOLD_MS + 1`.
Incoming D contests the same block with zero approvals. On the merits D loses to A outright, so the
assertion that D gets `approve` can only hold if A was swept *before* the contest was decided.

**Test 2 — the walk continues past a cleared loser.** `activeTransactions` is a `Map`, so the scan
runs in insertion order; the loser is seeded first deliberately. A holds `block-a` with 1 approval; C
holds `block-c` with 2 approvals and `MaxPriority`. D touches both blocks with 2 approvals at
priority 0. D beats A on approval count (A is cleared, the walk continues), then ties C on approvals
and loses the priority tie-break. The assertion is that D's vote is `conflict` **naming C's
messageHash** — under a `break` the walk stops at A and D comes back with a clean `approve`.

**Setup assertions are load-bearing, not decoration.** Both tests assert that A's and C's own votes
came back `approve` and that neither reached commit. Without those, a miscounted threshold would
clear the rival out of the table and the test would pass vacuously against an empty scan.

## Findings from implementation

**The self-skip guard is unreachable — no test added.** The ticket asked to confirm or refute this.
Refuted (it is unreachable), traced through every path:

- `getTransactionPhase` calls `findConflict` only inside `if (!record.promises[ourId])`.
- Every write into `activeTransactions` already carries our vote. The `shouldPersist` set (~623) runs
  after the phase loop recorded it; `recoverTransactions` (~2432) restores exactly what that branch
  persisted; `handleExpiration` (~2308) re-sets an existing entry with our reject vote added.
- A redelivery at a known messageHash is merged with the held record *before* the phase is computed
  (`processUpdate` → `mergeRecords`), and `detectEquivocation` keeps the first-seen signature, so our
  vote survives the merge and the `!record.promises[ourId]` branch is not taken.

Left in place as defensive code, with that reasoning recorded as a comment at the guard.

**The mutation described in the ticket is slightly wider than the one the test pins.** The ticket
phrases the danger as "moving the staleness check below `operationsConflict`". Moving it *inside*
that branch but still above `resolveRace` is behaviourally identical, and the test correctly still
passes there — verified by trying that variant first. The property the test actually pins is the one
that matters: **the sweep must run before `resolveRace` decides.** Read the test's name that way.

**Tripwire — the injected clock governs only the reservation's `lastUpdate`.** Someone injecting a
clock and expecting it to also govern `message.expiration`, the promise/resolution timeouts, or the
executed-transaction TTL will be surprised. Parked as a sentence in the JSDoc on
`ClusterMemberComponents.now`, at the seam a caller reads before using it. Not filed as a ticket.

## Known gaps — treat the tests as a floor

- **Eight `Date.now()` reads in this file remain real-time** by explicit ticket scope: the expiration
  guard (~791), `executedAt` (~1791), `appliedInvalidations` (~2084), `setupTimeouts` (~2193/2197),
  `queueExpiredTransactions` (~2346), `recoverTransactions` (~2434), and the executed-marker
  repopulate (~2456). Consequence: a test cannot yet age a record past its `message.expiration`, nor
  drive the periodic expiry sweep, on the injected clock. Sweeping all of them is a separate change.
- **The injected clock must share an epoch with real time.** Both new tests seed from a real
  `Date.now()` for that reason, with a comment. A clock starting near zero would make every record
  look long expired via the un-injected `message.expiration` check and the tests would fail
  confusingly rather than informatively. Nothing enforces this — it is a convention a comment carries.
- **No test covers the `persistParticipantState` → `recoverTransactions` round-trip under an injected
  clock.** The default (`Date.now`) path is covered by the existing `MemoryTransactionStateStore`
  specs, which are green, and behaviour there is byte-identical to before. The injected-clock
  interaction with restore is untested.
- **The two tests build their own `ClusterMember`** rather than using the suite's shared instance
  (test 1 must, for the clock; test 2 does for symmetry), and each disposes in a `finally`. Note that
  several *pre-existing* tests in this file — the `threshold-based promise resolution` block — build
  local members and never dispose them, leaking timer handles. Pre-existing, untouched, and out of
  this ticket's scope.
- **Neither test exercises more than two held reservations.** The `continue` is pinned at N=2; a
  three-way overlap is not covered.
- **No coverage of the sweep interacting with `clearTransaction`'s persistence side effects** — the
  tests assert the vote, not that the swept entry's persisted state was deleted.
