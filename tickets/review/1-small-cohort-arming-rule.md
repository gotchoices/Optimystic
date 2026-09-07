description: A group of one or two machines now follows one shared rule for when a machine may stop re-asking its partner about a record on every read — implemented, tested, and documented; this review pass checks the rule was applied at every exit and that arming never hides doubt.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (ClusterLatestQuery gains `deadlock` + `corroboration`; `classifyRepairDeadlock` split out of `reportRepairDeadlock`; arming in the `!corroborated` branch; rewritten accepted-tradeoff NOTE + `voters` at `cluster-fetch:local-current`)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`repair-fault-tolerance` advisory gains the certified/damping caveat)
  - packages/db-p2p/test/coordinator-repo-small-cohort-arming.spec.ts (NEW — 9 cases)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (untouched, still passing — regression guard)
  - docs/transactions.md, docs/internals.md, docs/architecture.md, docs/optimystic.md, packages/db-p2p/docs/cluster.md (settled-rule docs; the open-work references to `plan/1-small-cadres-are-a-first-class-topology` are all replaced)
----

# Review: one arming rule for small cohorts

Implementation of `implement/1-small-cohort-arming-rule` (design output of the two small-cadre plan
tickets). Everything in the ticket's TODO landed; nothing was descoped.

## What was built

**The rule:** a repair pass marks a block freshness-checked (arming the lazy read-repair window)
exactly when re-asking the cohort sooner than one window could not teach this node anything the next
consult would not. Two changes apply it:

1. **`cohort-too-small` now arms.** `reportRepairDeadlock` was split: `classifyRepairDeadlock` is
   the pure per-pass verdict (`cohort-too-small` / `sole-holder` / undefined, guards included — any
   silent peer or zero claims → no verdict), and the reporter logs under the existing
   once-per-episode suppression while **returning** the verdict every pass. The verdict threads
   through `ClusterLatestQuery.deadlock` into `fetchBlockFromCluster`'s `!corroborated` branch,
   which calls `markBlocksSeen` when — and only when — the reason is `cohort-too-small`. This damps
   the measured re-ask-forever loop of an undeclared two-machine cohort (was: 6 peer queries across
   three reads in one 10 s window) to one consult per window.
2. **Single-voter corroboration at `local-current` keeps arming — now visibly.** The tripped
   REVISIT NOTE at that arm was rewritten as a settled accepted-tradeoff NOTE (three reasons: a
   faster cadence produces no new evidence; not arming punishes only the honest; the residual
   threat is withholding, which no cadence touches). What was bought instead is observability:
   `queryClusterForLatest` now returns `corroboration: { voters, certified? }` (previously
   `selected.supporters` was dropped), and the `cluster-fetch:local-current` line carries
   `voters` and `certified: true`.

Docs: transactions.md gained the arming paragraph and the settled trust posture of size two
(fabrication caught, withholding not); cluster.md carries the membership-derived
`assumedClusterSize` recommendation with the `gotchoices/sereus#2` caveat; internals.md,
architecture.md, optimystic.md updated to match; the cluster-policy startup advisory now says the
permanent-decline warnings apply to proof-less data and that the loop is damped.

## How to validate

- `yarn workspace @optimystic/db-p2p typecheck && yarn workspace @optimystic/db-p2p test` — 2590
  passing, 49 pending, 0 failing (includes the 9 new cases and the untouched 7-case solo suite).
- Repo-wide `yarn test` (after `yarn workspace @optimystic/db-p2p build` — the stale-build guard
  fires otherwise) and `yarn lint:docs` — both green.
- The new spec `coordinator-repo-small-cohort-arming.spec.ts` is the joint-outcome table made
  executable: declared-two / undeclared-certified / undeclared-proofless / silent-partner rows,
  plus doubt-survives-arming, second-window re-arm without a second deadlock line, sole-holder and
  agreed-absence keep re-asking, and the declared-pair-partner-holds-nothing (founding data) shape.

## Adversarial surface worth a reviewer's attention

- **Doubt survives arming** is the invariant most worth attacking: `fetchBlockFromCluster` arms via
  the deadlock verdict while the currency verdict independently carries `unsettled-claim`; the spec
  pins `unconfirmedAheadRev` on suppressed in-window reads. If you can construct an exit where
  arming and doubt-erasure travel together, that is a real bug
  (`fix/currency-doubt-cleared-by-a-partial-answer` history).
- **The silent-peer guard is load-bearing for arming**, not just logging — it lives in
  `classifyRepairDeadlock` and is pinned for both declared and undeclared shapes. Check no other
  caller of `reportRepairDeadlock` exists that could act on a verdict computed off a partial view
  (there is only the one call site today).
- **Missing-block inertness:** the new arming also stamps a locally-missing block (cohort-too-small
  with the reader holding nothing), which is inert only because `get` bypasses the window on
  `isMissing`. That bypass is pinned by the existing solo-window spec ('does not suppress reads of
  a block this node does not hold') but not by a new cohort-too-small-specific case.

## Known gaps (honest)

- **Certified row tested at steady state only** (equal-revision certified claim → `local-current`).
  A certified claim *ahead* converging is covered by pre-existing read-repair/certified specs, not
  re-tested here.
- **Two-phones-over-relay is unit-shaped only.** The silent-partner cases are the relay-outage
  stand-in; end-to-end RN validation is currently impossible (React Native
  `WebSocket.bufferedAmount` polyfill gap, `gotchoices/sereus#11`, tracked on the RN checklist in
  `packages/db-p2p/readme.md`). No new code path assumes the partner is dialable on demand.
- **Growing 1 → 2 / shrinking 2 → 1** were validated by argument plus the unit shapes
  (holds-nothing, silent, solo suite), not by a mesh-level end-to-end test of the cohort-growth
  push interplay.
- **The advisory's new caveat text is not pinned** — `cluster-policy.spec.ts` assertions still pass
  (one phrase changed: "every repair declines" → "every proof-less repair declines"), but no new
  assertion covers the `certifiedCaveat` sentences.
- **One ticket figure corrected:** the ticket's "super-majority ceil(2 × 0.66)" is actually
  ceil(2 × 0.75) at the default threshold (`DEFAULT_SUPER_MAJORITY_THRESHOLD = 0.75`); both resolve
  to 2-of-2, so the design claim stands. Docs use 0.75.
- **Human action outstanding, deliberately not done here:** answering `gotchoices/sereus#2` (the
  hardcoded `clusterSize: 3` seam) once this lands — the ticket forbade posting from this ticket.
