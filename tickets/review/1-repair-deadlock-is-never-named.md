description: A node that runs too few machines to ever repair a stale copy of a record now says so in plain words — once per record, and once at startup — instead of silently declining forever. The startup advice was also wrong about how many machines you need; it has been corrected.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/internals.md, docs/transactions.md, packages/reference-peer/README.md
difficulty: medium

# Review: a repair that can never converge now says so, once, in words

Implemented from `implement/1-repair-deadlock-is-never-named`. Nothing was relaxed about the
corroboration floor — the whole change is **legibility**: the same declines happen, they are now
*named* when they are provably permanent.

## What the code does now

### The rule this all rests on (unchanged, now pinned by a test)

Read-repair accepts a peer's claimed revision only when a quorum of distinct corroborating cohort
peers agree on the same `(rev, actionId)`. Swept over `resolveClusterPolicy` +
`corroboratorCapacity` + `quorumSize`, that comes out as:

| machines | cohort size declared? | peers besides the reader | peers that must answer *that reader* | can repair? |
| --- | --- | --- | --- | --- |
| 2 | no (falls back to `clusterSize`, default 10) | 1 | 2 | **never** |
| 2 | yes (`assumedClusterSize: 2`, or honest `clusterSize: 2`) | 1 | 1 | yes, no margin |
| 3 | either | 2 | 2 | yes, **no margin** |
| 4+ | either | 3+ | 2 | yes, survives one unreachable peer |

New spec `quorum-restore.spec.ts` → *how many answering peers a repair needs, by deployment size*
asserts this as a count of machines, not as a restatement of the formula, so the arithmetic cannot
drift underneath the two log messages and the docs without a spec turning red.

### Arm A — `cluster-fetch:repair-deadlock` (`CoordinatorRepo.reportRepairDeadlock`)

Fired from the `!selected` return in `queryClusterForLatest`, **once per block**, only when the
decline is provably permanent: no peer was silent, at least one peer claimed the block, the
claimants all agree, and there are still fewer of them than the quorum needs. Payload carries
`cohortPeers`, `answered`, `claimants`, `required`, `repairCorroborationClusterSize`, and a
`message` that says the word *permanent* and names the remedy.

Deliberately excluded, and specced as such: any pass with a silent peer (a silent peer may come
back, and a reader cannot tell an unreachable peer from a withholding one), a decline where the
voters showed up and disagreed, and a cohort that unanimously answers "I hold nothing". Those keep
the existing per-pass `cluster-fetch:no-quorum` line, which is untouched and still fires on every
decline.

Suppression hangs off the existing `unsettledAheadClaims` entry as the ticket asked — its value
type widened from `number` to `AheadClaimState { rev?, deadlockReported? }`. Two lifetime
mismatches had to be handled explicitly, both commented at the site:

- `recordAheadClaim(blockId, undefined)` used to `delete` the entry. It now keeps a
  `deadlockReported`-only entry, otherwise a block whose cohort claims nothing *ahead* of the
  reader would re-announce on every pass.
- A block **missing** locally never reaches `recordAheadClaim` at all (that call is gated on
  `!isMissing`), and missing blocks bypass the read-repair window — which is exactly the case the
  field logs were dominated by. `reportRepairDeadlock` therefore writes the entry itself. That
  entry is inert for a missing block (`flagUnconfirmedCurrency` returns early without a `rev`).

A `NOTE:` at the site points at the deferred reader-facing error (`BlockPossiblyStaleError` still
implies a retry might help, which is wrong advice for a deadlocked repair).

### Arm B — `repair-fault-tolerance` (`resolveClusterPolicy`), renamed from `assumed-cluster-size-unset`

Still one line per node construction. Two corrections:

- **The claim was wrong.** It said three or more machines "can ignore this". Three is the *minimum*
  that can ever repair, not a safe size — the reader has exactly two peers and needs both, so one
  peer unreachable *from that reader* (healthy and reachable from everyone else) leaves that
  reader's copy unrepairable. The message now states the real requirement and that four machines is
  the first size with any margin.
- **The trigger was too narrow.** It now fires when the cohort size is undeclared **or** the
  resolved `repairCorroborationClusterSize` is three or fewer — declaring `assumedClusterSize: 3`
  does not conjure a third peer. Payload flags which arm fired (`cohortUndeclared`,
  `noRepairMargin`) and the message carries only the advice that applies; when both fire it is
  still one line.

Renamed because the old tag no longer describes when it fires.

## How to validate

```
yarn lint && yarn build && yarn test          # from repo root — all green, exit 0
```

Targeted, with names visible:

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  test/quorum-restore.spec.ts test/cluster-policy.spec.ts test/coordinator-repo-read-repair.spec.ts \
  --reporter spec
```

Behavioral checks worth making by hand:

- Boot a node with no `clusterPolicy.assumedClusterSize` and `DEBUG=optimystic:db-p2p:cluster-policy`.
  Expect exactly one `repair-fault-tolerance` line naming both the undeclared remedy and, for
  `clusterSize <= 3`, the no-margin warning.
- Boot with `clusterPolicy: { assumedClusterSize: 16 }` — expect **no** advisory at all.
- Boot with `clusterPolicy: { assumedClusterSize: 3 }` — expect the advisory, with
  `cohortUndeclared: false` and `noRepairMargin: true`.
- Three-node mesh, one node holding a stale block, `DEBUG=optimystic:db-p2p:coordinator-repo`, read
  that block repeatedly: expect `cluster-fetch:no-quorum` on every read and exactly one
  `cluster-fetch:repair-deadlock`. Kill one peer's reachability so it goes silent instead of
  answering: expect no deadlock line at all.

## Known gaps — treat the tests as a floor

- **`yarn test:integration` was not run.** Its wall-clock exceeds the runner's idle limit; deferred
  to CI or a human, per the ticket.
- **One unexplained intermittent failure.** A single `yarn workspace @optimystic/db-p2p test` run
  mid-ticket reported `1895 passing, 1 failing` under the `min` reporter, which prints no test
  name. Three subsequent full runs (`yarn test` from the root, twice; the db-p2p suite alone,
  twice) were clean at 1896 passing, exit 0, so I could not reproduce it or identify the test.
  Recorded here rather than in `tickets/.pre-existing-error.md` because that file wants a test name
  and path I do not have. If the reviewer's run reproduces it under `--reporter spec`, capture the
  name — it may well be unrelated to this diff (nothing in this change is timing-dependent).
- **The deadlock condition's disagreement guard is currently unreachable.** With today's
  `quorumSize`, "claims below the required count" implies exactly one claim, so the "two claims
  disagree" arm can never be the reason a deadlock is suppressed. Kept and commented anyway: it
  encodes the intent rather than the current arithmetic. The corresponding spec (*stays quiet when
  the decline was a genuine disagreement between claims*) therefore passes via the
  enough-voters guard, not the distinct-pairs guard — real behavior, weaker coverage than it looks.
- **Suppression is per-block and per-episode, not per-node.** A node with 10 000 deadlocked blocks
  emits 10 000 deadlock lines (one each) rather than one. Better than 1821 lines for one block, but
  not the smallest possible output. Also, the LRU cap of 1000 means an eviction lets a block say it
  a second time.
- **A `deadlockReported`-only entry is never explicitly cleared** — a missing block that later
  arrives at a revision at or above the claim clears the whole entry via `flagUnconfirmedCurrency`,
  but a missing block that simply stays missing holds its entry until LRU eviction. Bounded and
  harmless; noted so nobody reads it as a leak.
- **`assumed-cluster-size-unset` is referenced by a sibling ticket.**
  `tickets/fix/1-two-node-index-divergence-guard-never-fires.md` tells its reader to grep node
  startup logs for that tag. The tag no longer exists — it is `repair-fault-tolerance`. I did not
  edit another stage's ticket; flagging it so someone can.
- **Not attempted, by design** (all from the ticket's *Not this ticket*): relaxing the
  corroboration floor in any form; the real convergence fix (commit-cert verification, backlog
  `debt-read-repair-commit-cert-verification`, whose own prerequisite is unbuilt); carrying the
  deadlock into `BlockPossiblyStaleError` / `GetBlockResult`.

## Review findings

- The `unsettledAheadClaims` suppression home the ticket suggested does not fit cleanly for the two
  cases above (a cleared ahead-claim, and a locally-missing block). Rather than adding a fourth
  per-block map, the entry's value type was widened and both mismatches handled explicitly at the
  site — see the comments on `AheadClaimState`, `recordAheadClaim`, and the tail of
  `reportRepairDeadlock`. Judge whether that is the right trade against backlog
  `debt-freshness-state-scattered-across-coordinator-repo`.
- Tripwire parked as a `NOTE:` on `reportRepairDeadlock` in
  `packages/db-p2p/src/repo/coordinator-repo.ts`: the reader-facing error still tells callers a
  retry might help even when the coordinator knows the repair is deadlocked as configured. Fine
  today (the read is flagged, not mis-reported); becomes work if operators start acting on that
  error's retry advice.
- Tripwire parked as a `NOTE:` in the doc comment on `resolveClusterPolicy`'s advisory block: an
  operator who declares an `assumedClusterSize` **larger** than the cohort they actually run is
  equally unable to repair and still gets no fault, because this function has no observed cohort to
  contradict the declaration with. Becomes cheap to check if
  `feat-admission-floor-from-observed-cohort-high-water-mark` ever lands.
- The stale `assumed-cluster-size-unset` reference in `tickets/fix/1-two-node-index-divergence-guard-never-fires.md`
  (see Known gaps) — not fixed here because it belongs to another stage.
