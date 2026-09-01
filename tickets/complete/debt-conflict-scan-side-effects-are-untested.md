description: A cluster node's bookkeeping pass for competing writes had behaviours no test covered; they now have tests that fail if the behaviour is broken, and the pass's hardcoded two-second timeout became an injectable clock so the tests do not have to sleep.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/docs/cluster.md

# Complete: reservation-scan side effects are covered, with an injectable clock

## What the work is

`ClusterMember.findConflict` is the pass a cluster node runs before voting on a write. It walks the
table of writes it currently holds open (`activeTransactions`) and, per entry: skips the record
against itself, drops entries nobody has touched for two seconds, then decides the contest against
any still-live overlapping entry and clears the loser before continuing the walk. Three of those
behaviours had no test. All three do now.

## Source, as it stands

`packages/db-p2p/src/cluster/cluster-repo.ts`:

- `CONFLICT_STALE_THRESHOLD_MS = 2000` is exported, replacing a function-local literal, so a test
  advances past it without restating the number.
- `ClusterMemberComponents.now?: () => number` is threaded as the final positional constructor
  parameter and the final `clusterMember()` factory argument, stored as `private readonly now`,
  defaulting to `Date.now`.
- Exactly three clock reads use it: the `lastUpdate` stamp in the `shouldPersist` branch, the `now`
  in `findConflict`, and the `lastUpdate` in `persistParticipantState`. The stamp and the comparison
  move together; converting only one would put them on different time bases and nothing would ever
  look stale.
- The sweep, the `continue`, and the (unreachable) self-skip guard each carry a comment saying why
  they are where they are.

`packages/db-p2p/test/cluster-repo.spec.ts` — three tests in `describe('conflict detection')`, all
built on a local `makeClockedMember()` helper:

- `sweeps an abandoned reservation before deciding the race, not after`
- `keeps scanning after clearing one loser, and is still blocked by a second live rival`
- `re-stamps a re-delivered reservation on the injected clock, keeping it out of the sweep`

`packages/db-p2p/docs/cluster.md` — the `findConflict` sample and the abandonment prose now match the
code.

## Review findings

**Implement diff read first, before the handoff summary.** Everything below is disposition of what
that read turned up.

### Independently re-verified (not taken on the handoff's word)

- **Mutation checks, re-run from scratch — all three isolate cleanly.** Moving the sweep below
  `resolveRace` fails only test 1; `continue` → `break` fails only test 2; stamping `lastUpdate` on
  the wall clock fails test 3 (and, incidentally, test 1 — see below). Each mutation was applied to
  the real source, run, and reverted; the source is byte-identical to the implement commit apart from
  the one comment change noted under *Fixed inline*.
- **Clock wiring.** Every `ClusterMember` construction in the repo goes through the `clusterMember()`
  factory except `supermajority-coupling.spec.ts`, which passes ten positional arguments; appending
  `now` at position seventeen cannot affect it.
- **No mixed time bases outside the three converted sites.** `recoverTransactions` restores the
  persisted `state.lastUpdate` (it does not re-stamp), and `handleExpiration` spreads the existing
  state, so neither reintroduces a wall-clock stamp behind an injected comparison. The other eight
  `Date.now()` reads never touch `lastUpdate`.
- **The self-skip guard really is unreachable.** Re-traced `getTransactionPhase` →
  `!record.promises[ourId]`, the `shouldPersist` write, `recoverTransactions`, `handleExpiration`,
  and the `mergeRecords` redelivery path. The handoff's refutation holds; the guard stays as
  defensive code with that reasoning at the site.

### Fixed inline (minor)

- **Half of the source change was unpinned.** Tests 1 and 2 only exercise the *comparison* side of
  the clock; both still pass if the `lastUpdate` **stamp** reverts to a raw `Date.now()`, because a
  reservation stamped once at seed time looks equally stale on either clock. Added test 3, which
  re-delivers a held reservation *after* advancing the clock: a stamp on the wrong clock lands behind
  the comparison and the entry is swept when it must not be. It fails by a 2001 ms margin under that
  mutation. (Test 1 also fails under it, but only by whatever wall-clock milliseconds elapsed during
  setup — a one-to-five millisecond margin, which is detection by accident, not by design.)
- **Test 2 had a real-time flake window.** It ran on the wall clock, so a stall of
  `CONFLICT_STALE_THRESHOLD_MS` between seeding its two reservations and the incoming record's
  arrival would sweep the very rivals the assertion depends on, and the test would pass vacuously
  green. It now takes a *frozen* injected clock — ages pinned at zero — which is also how the test
  states that nothing here is about staleness.
- **Duplicated member wiring across the new tests** is now one `makeClockedMember()` helper carrying
  the epoch-sharing requirement in its own doc comment, at the point a test author reads it.
- **`packages/db-p2p/docs/cluster.md` was stale in exactly the place this change matters.** Its
  `findConflict` sample omitted the staleness sweep altogether — the very step whose *position* this
  ticket makes a pinned invariant — and omitted the `continue`. It also still showed
  `operationsConflict` and `resolveRace` as private methods, though they are module functions in
  `race-resolution.ts`. Sample and prose corrected; the prose now names
  `CONFLICT_STALE_THRESHOLD_MS` and the injectable clock instead of saying "2-second".
- **Pre-existing timer leak in the same file**, flagged by the implementer as out of scope: two tests
  under `describe('threshold-based promise resolution')` built local members and never disposed them.
  Both now go through a `makeThresholdMember()` factory with an `afterEach` disposal, which also
  removes the duplicated wiring. Net fewer lines.
- **The partial-injection tripwire was recorded but not tagged.** It lived as plain prose in the
  `ClusterMemberComponents.now` doc comment; it now carries the greppable `NOTE:` tag, and states the
  consequence explicitly — an injected clock must share an epoch with real time, because
  `message.expiration` and the timeouts are not injected.

### Recorded as tripwires, not tickets

- **The injected clock reaches only `lastUpdate`.** Eight `Date.now()` reads stay on real time by
  design, so no test can yet drive `message.expiration`, the periodic expiry sweep, or the
  executed-transaction TTL without sleeping. Conditional by nature — it becomes work only if a test
  needs those paths — so it is parked as the `NOTE:` on `ClusterMemberComponents.now`, at the seam a
  caller reads before injecting, together with what to do about it.

### Found, weighed, deliberately not actioned

- **`cluster-repo.ts` is 2471 lines** (`wc -l packages/db-p2p/src/cluster/cluster-repo.ts`). Large,
  but this diff added roughly thirty lines to it and did not create the condition; the split is
  already in motion (the pure race decisions were extracted into `race-resolution.ts`). Filing a
  file-split ticket as the output of a tests-only ticket would be scope creep, and no open ticket
  claims the site. Recorded here so the next reviewer has the measurement rather than a re-count.
- **The sweep's persistence side effect is still unasserted.** `clearTransaction` deletes the swept
  entry's persisted state fire-and-forget; the tests assert the resulting vote, not the deletion.
  Left alone deliberately: `recoverTransactions` restores the *old* `lastUpdate`, so a surviving
  persisted entry is swept again on the next scan rather than blocking anything. It is tidiness, not
  a correctness cliff, and an assertion on a fire-and-forget promise would buy a timing-sensitive
  test for it.
- **`others as [KeyPair, KeyPair]` in the two five-peer tests** is a cast that outruns what the type
  system knows, two lines below the `{ length: 4 }` that guarantees it. Contained and locally
  obvious; not worth the churn.
- **A sweep only ever runs when a rival arrives** — nothing else releases a stale-but-unexpired
  reservation, since `queueExpiredTransactions` checks `message.expiration` only. Checked and it is
  correct by construction: a reservation matters exactly when a rival arrives to be blocked by it.
- **No coverage beyond two held reservations.** The `continue` is pinned at N=2; a three-way overlap
  is not covered. The walk has no per-entry state, so a third entry exercises no new code path.

### Empty categories

- **No major findings, so no new `fix/`, `plan/`, or `backlog/` tickets were filed.** The diff is a
  test-and-seam change with no behaviour change outside the clock indirection, and every defect the
  read turned up was small enough to fix in this pass.
- **No `blocked/` items.** Nothing here needs a human decision or an out-of-repo dependency.
- **No accepted-tradeoff `NOTE:` was found at any site under review**, so nothing was re-filed
  against a decision already made.

## Validation

- `yarn lint` (repo root, `eslint .`) — exit 0. The implement handoff reported "no lint script on
  this package", which is true of the package but the root has one; it was not run then, and it is
  clean now.
- `yarn typecheck` (all workspaces) — exit 0.
- `yarn workspace @optimystic/db-p2p build` — exit 0.
- `yarn workspace @optimystic/db-p2p test` — **2492 passing, 49 pending, 0 failing** (2491 before,
  plus the added test). No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not
  written.
