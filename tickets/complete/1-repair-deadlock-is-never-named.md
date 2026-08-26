----
description: A node that can never repair a stale copy of a record now says so in plain words — once per record, and once at startup — instead of silently declining forever. The review pass found the "can never" test was too loose and would have blamed the operator's machine count for a problem that fixes itself; that is corrected.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/internals.md, docs/transactions.md, packages/reference-peer/README.md
----

# A repair that can never converge now says so, once, in words

Nothing about the corroboration floor was relaxed. The change is legibility: the same declines
happen, and the ones that are provably permanent are now named.

## What shipped

### The rule underneath (unchanged, now pinned by a spec)

Read-repair adopts a peer's claimed revision only when a quorum of distinct corroborating cohort
peers agree on the same `(rev, actionId)`. Swept over `resolveClusterPolicy` +
`corroboratorCapacity` + `quorumSize`:

Every row assumes the block already has at least two cohort-peer holders besides the reader — see
`sole-holder` below for the case where it does not.

| machines | cohort size declared? | peers besides the reader | peers that must answer *that reader* | can repair (given ≥2 holders)? |
| --- | --- | --- | --- | --- |
| 2 | no (falls back to `clusterSize`, default 10) | 1 | 2 | **never** |
| 2 | yes (`assumedClusterSize: 2`, or honest `clusterSize: 2`) | 1 | 1 | yes, no margin |
| 3 | either | 2 | 2 | yes, **no margin** |
| 4+ | either | 3+ | 2 | yes, survives one unreachable peer — **only for a block ≥2 peers hold; a block held by exactly one cohort peer never repairs, at any machine count (`reason: 'sole-holder'`)** |

`quorum-restore.spec.ts` → *how many answering peers a repair needs, by deployment size* asserts
this as a count of machines rather than a restatement of the formula, so the arithmetic cannot drift
underneath the two log messages and the docs without a spec turning red.

### `cluster-fetch:repair-deadlock` (`CoordinatorRepo.reportRepairDeadlock`)

Fired from the `!selected` return in `queryClusterForLatest`, once per block, only when the decline
is provably permanent — **the cohort is too small to reach the quorum at all**, not merely that this
pass fell short. The test is explicit: compute what the quorum would demand if every cohort peer
answered and agreed (`requiredEvenIfAllAnswered`) and compare it to how many peers the cohort has.
Also excluded: an incomplete pass (any silent peer), and a cohort that unanimously answers "I hold
nothing". There is deliberately no "the claims disagreed" exemption — a cohort too small to reach
quorum stays too small whether or not its peers agree.

Payload: `cohortPeers`, `answered`, `claimants`, `required`, `requiredEvenIfAllAnswered`,
`repairCorroborationClusterSize`, `message`. The message says the word *permanent* and names **both**
readings of the same numbers, because the node cannot tell them apart from the inside: a deployment
that genuinely runs this few machines (configuration fixes it), or a cohort view shrunk below the
real deployment by a partition or routing influence (configuration does not).

The per-pass `cluster-fetch:no-quorum` line is untouched and still fires on every decline, so
nothing is hidden.

Suppression hangs off the existing `unsettledAheadClaims` entry, whose value type widened from
`number` to `AheadClaimState { rev?, deadlockReported? }`. Two lifetime mismatches are handled
explicitly at the site: `recordAheadClaim(blockId, undefined)` keeps a `deadlockReported`-only entry
instead of deleting, and a locally-missing block (which never reaches `recordAheadClaim`) has its
entry written by `reportRepairDeadlock` itself.

### `repair-fault-tolerance` (`resolveClusterPolicy`), renamed from `assumed-cluster-size-unset`

One line per node construction. The old line claimed three or more machines "can ignore this" —
wrong: three is the *minimum* that can ever repair, not a safe size, since the reader has exactly
two peers and needs both. The trigger also widened from "cohort size undeclared" to "undeclared
**or** resolved `repairCorroborationClusterSize` ≤ 3", because declaring `assumedClusterSize: 3`
does not conjure a third peer. Payload flags which arm fired (`cohortUndeclared`, `noRepairMargin`);
the message carries only the advice that applies, and stays one line when both fire.

## How to validate

```
yarn lint && yarn build && yarn test          # from repo root
```

Targeted, with names visible:

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  test/quorum-restore.spec.ts test/cluster-policy.spec.ts test/coordinator-repo-read-repair.spec.ts \
  --reporter spec
```

By hand:

- Two nodes, no `clusterPolicy.assumedClusterSize`, `DEBUG=optimystic:db-p2p:*`, read a block one
  node holds at a newer revision: expect `cluster-fetch:no-quorum` every read and exactly one
  `cluster-fetch:repair-deadlock`.
- Three nodes, one of them missing the block: expect `cluster-fetch:no-quorum` and **no** deadlock
  line — that cohort can still reach quorum once the lagging node catches up.
- Boot with `clusterPolicy: { assumedClusterSize: 16 }` — expect no startup advisory;
  `assumedClusterSize: 3` — expect one, with `cohortUndeclared: false`, `noRepairMargin: true`.

## Review findings

Read the implement diff (`ef396ff`) before the handoff summary, then swept the arithmetic, the log
sites, the specs, and every doc the change touched or should have touched.

### Major — fixed in this pass

- **The deadlock test was too loose and would have blamed the wrong thing.** The condition shipped
  as "every peer answered and there were still fewer claimants than this pass's quorum". That fires
  whenever some peer simply does not hold the block *yet* — a transient state its own repair or the
  next commit clears. Concretely, the implement pass's own headline spec asserted a deadlock line
  for **three machines with one claimant**, a cohort that the size table in the same diff says
  repairs fine; the emitted message was internally contradictory ("requires 2 agreeing peers and
  this node's whole cohort holds only 2") and told the operator to change a machine count that was
  never the problem — the exact misdiagnosis this ticket exists to end. Fixed by asking the
  decisive question instead: `quorumSize(cohortPeers, …)` — what the quorum would demand if every
  cohort peer answered and agreed — and firing only when the cohort cannot meet even that. The
  provably-permanent shape reduces to the field case (one peer besides the reader, size undeclared),
  which now has direct coverage.
- **Consequently the "claims disagreed" guard was not merely unreachable (as the handoff noted) but
  wrong in principle** — disagreement does not make a too-small cohort repairable — so it was
  removed rather than kept as intent. The silence and empty-cohort guards are kept and documented
  for what they now are: silence does not change the arithmetic, but a node that could not ask
  everyone should not make a permanent claim.
- **Specs rewritten around the corrected condition.** The old headline case is now a
  *stays-quiet* regression test ("the cohort could still supply the quorum — a peer just does not
  hold the block yet"), which fails against the shipped implementation. A shared `makeReader` helper
  replaces eight near-identical 25-line setups; the suppression tests (repeat passes, cleared
  ahead-claim, locally-missing block) moved onto the two-node shape so they exercise a decline that
  is genuinely permanent. 8 specs, all green.

### Minor — fixed in this pass

- `docs/internals.md` and `docs/transactions.md` described the old, too-loose condition (including
  the removed disagreement exemption). Rewritten to state the best-case test, the exclusions, and
  the two readings of the message.
- `packages/reference-peer/README.md` claimed **any** mesh smaller than `--cluster-size` "needs
  either this flag or an honest `--cluster-size` to repair a damaged block at all". That was already
  wrong before this ticket and contradicts the size table the same diff added — a three-node mesh
  under `--cluster-size 10` repairs unconfigured. Scoped to the two-machine case it actually
  strands, and the closing summary line with it.
- `tickets/fix/1-two-node-index-divergence-guard-never-fires.md` told its reader to grep node
  startup logs for `assumed-cluster-size-unset`, a tag this ticket renamed out of existence. The
  handoff flagged it and left it; a live debugging ticket pointing at a tag that no longer exists is
  a misdirection this change caused, so it is corrected in place — both names given, since field
  logs may predate the rename, plus the new per-block line.
- Message wording: `answered` is always equal to `cohortPeers` inside the guard, so the sentence no
  longer prints both.

### Tripwires — parked, not ticketed

- `NOTE:` at the suppression site in `reportRepairDeadlock`: the line is suppressed per *block*,
  while the condition is a property of the *cohort* — so a node in this state that reads N distinct
  blocks emits N lines. Deliberate (the operator wants to know which blocks are stuck, and N is
  bounded by blocks actually read; 1821 lines for one block was the defect). If it ever becomes the
  noisy line again, add a node-level once-flag keyed on `(cohortPeers, requiredEvenIfAllAnswered)`.
- `NOTE:` carried over on `reportRepairDeadlock`: the reader-facing `BlockPossiblyStaleError` still
  implies a retry might help even when the coordinator knows the repair cannot converge. Fine today
  (the read is flagged, not mis-reported); becomes work if operators start acting on that advice.
- `NOTE:` carried over on `resolveClusterPolicy`'s advisory: an operator who declares an
  `assumedClusterSize` **larger** than the cohort they actually run is equally unable to repair and
  still gets no fault, because that function has no observed cohort to contradict the declaration
  with. Cheap to check if `feat-admission-floor-from-observed-cohort-high-water-mark` lands.

### Evidence appended to an existing ticket — no new ticket filed

- `backlog/debt-freshness-state-scattered-across-coordinator-repo` already claims this site. Added a
  third-instance arm rather than filing separately: `coordinator-repo.ts` re-measured at **1341
  lines** (`wc -l`, up from the 1194 recorded there), the new per-block fact had nowhere natural to
  live and was hung off the existing claim entry with two lifetime carve-outs at the call sites, and
  the classification the review pass had to correct reads exactly the loose values that ticket is
  about. Nothing about the extraction's shape changes.

### Checked and clean — nothing found

- **Arm B (`repair-fault-tolerance`) arithmetic.** Swept `requiredAnsweringPeers` / `availablePeers`
  across resolved sizes 1, 2, 3, 10, 16 by hand against `quorumSize` + `corroboratorCapacity`; every
  message matches. The trigger, the payload flags, and the both-arms-in-one-line behavior are all
  specced. No changes needed.
- **Suppression lifetimes.** `recordAheadClaim` preserves the bit when it clears `rev`;
  `flagUnconfirmedCurrency` drops the whole entry on convergence, which correctly re-arms the line
  for a new episode. A `deadlockReported`-only entry on a block that stays missing is held until LRU
  eviction — bounded, and each entry is one small record.
- **Type safety and cleanup.** No `any`, no new resources, no throw paths introduced;
  `reportRepairDeadlock` is pure arithmetic plus a debug log, and carries the same (pre-existing)
  exposure as the `cluster-fetch:no-quorum` line directly above it.
- **Stale references to the renamed tag.** Grepped the whole tree; the only live hits were
  `docs/internals.md` (a deliberate "renamed successor to…" note, kept) and the fix ticket above.
- **Pre-existing failures.** None. The implement handoff recorded one unexplained intermittent
  `1 failing` under the `min` reporter that it could not reproduce or name. It did not reproduce
  here either: `yarn test` from the root is green end to end, exit 0, `0 failing` (db-p2p 1897
  passing, 44 pending; whole tree green). Nothing was skipped or loosened, and nothing was written
  to `tickets/.pre-existing-error.md` — there is no failure to report.
- **`yarn test:integration` — not run.** Its wall-clock exceeds the runner's idle limit; deferred to
  CI or a human, as the implement ticket also deferred it. Nothing in this change is
  timing-dependent.

### Out of scope by design (from the original ticket's *Not this ticket*)

Relaxing the corroboration floor in any form; the real convergence fix (commit-cert verification,
backlog `debt-read-repair-commit-cert-verification`, whose own prerequisite is unbuilt); carrying
the deadlock condition into `BlockPossiblyStaleError` / `GetBlockResult`.
