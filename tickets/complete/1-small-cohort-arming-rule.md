description: A group of one or two machines now follows one shared rule for when a machine may stop re-asking its partner about a record on every read; the rule was built, reviewed, and the review corrected an operator warning that claimed more than the code delivers.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`ClusterLatestQuery.deadlock` + `.corroboration`; `classifyRepairDeadlock` split out of `reportRepairDeadlock`; arming in the `!corroborated` branch; accepted-tradeoff NOTE at `cluster-fetch:local-current`; review added `RepairDeclinePass`, a tripwire NOTE, and the reachability note on the deadlock precedence)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`repair-fault-tolerance` advisory: certified/damping caveat, rescoped by the review)
  - packages/db-p2p/test/coordinator-repo-small-cohort-arming.spec.ts (10 cases — 9 from implement, 1 added by the review)
  - packages/db-p2p/test/cluster-policy.spec.ts (review added the advisory-caveat assertions)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (untouched regression guard, still passing)
  - docs/transactions.md, docs/internals.md, docs/architecture.md, docs/optimystic.md, packages/db-p2p/docs/cluster.md
----

# Complete: one arming rule for small cohorts

Design from the two small-cadre plan tickets, implemented as `implement/1-small-cohort-arming-rule`
(commit `3bd7ba1d`), reviewed here. Everything in the implement TODO landed; the review fixed four
minor findings inline and filed no new tickets.

## What shipped

**The rule.** A repair pass marks a block freshness-checked (arming the lazy read-repair window)
exactly when re-asking the cohort sooner than one window could not teach this node anything the next
consult would not.

1. **`cohort-too-small` now arms.** `reportRepairDeadlock` was split: `classifyRepairDeadlock` is the
   pure per-pass verdict (`cohort-too-small` / `sole-holder` / undefined; any silent peer or zero
   claims → no verdict), and the reporter keeps the once-per-episode log suppression while
   *returning* the verdict every pass. The verdict threads through `ClusterLatestQuery.deadlock` into
   `fetchBlockFromCluster`'s `!corroborated` branch, which calls `markBlocksSeen` only for
   `cohort-too-small`. This damps the measured re-ask-forever loop of an undeclared two-machine
   cohort (6 peer queries across three reads in one 10 s window) to one consult per window.
2. **Single-voter corroboration at `local-current` keeps arming — now visibly.** The tripped REVISIT
   NOTE became a settled accepted-tradeoff NOTE (a faster cadence produces no new evidence; not
   arming punishes only the honest; the residual threat is withholding, which no cadence touches).
   `queryClusterForLatest` now returns `corroboration: { voters, certified? }` and the
   `cluster-fetch:local-current` line carries `voters` / `certified`.

**Docs.** transactions.md carries the rule and its bounds; cluster.md the membership-derived
`assumedClusterSize` recommendation with the `gotchoices/sereus#2` caveat and the honest trust
posture of size two (fabrication caught, withholding not); internals.md, architecture.md and
optimystic.md match. The `repair-fault-tolerance` startup advisory names the certified exemption and
the damping.

## Review findings

### What was checked

Read the implement diff before the handoff summary. Then: every exit of `fetchBlockFromCluster`
against the stated rule; the reachable state space of `classifyRepairDeadlock` (derived by hand from
`quorumSize` / `corroboratorCapacity`); every consumer of the new `deadlock` and `corroboration`
fields; the call-site count for `reportRepairDeadlock`; the lifetime and bounds of the two per-block
maps; the interaction of arming with the doubt memo, the `unavailable` absence flag, and the
`isMissing` bypass in `get`; the five changed docs plus `cluster-policy.spec.ts`'s existing
assertions; and the numeric claims in the new prose (`ceil(2 × 0.75) = 2`, `ClusterMember.hasMajority`
as `count > total / 2`) against the code.

Verified by derivation, and now recorded at the site: `cohort-too-small` is reachable *only* with
exactly one non-self cohort peer and a resolved size of three or more — and in every such pass
`sole-holder` is simultaneously true. The reason precedence is therefore load-bearing on every
arming pass, not a rare tie-break. Arming is correctly keyed on the reason that means "no cadence can
help".

### Correctness — no defects found

The arming gate is sound: the silent-peer and zero-claims guards live in the verdict (not just the
log), so no pass with an incomplete view can arm; the verdict is recomputed every pass so an expired
window re-arms; `sole-holder` never arms; and the doubt memo is untouched by arming (pinned). The
certified-equivocation decline cannot reach the arming branch at all — equivocation needs two
claimants, and `cohort-too-small` needs exactly one cohort peer.

### Minor — fixed in this pass

- **The advisory overstated its own softener.** `cluster-policy.ts` told operators "a provably
  permanent decline no longer consults on every read". `sole-holder` is equally permanent by the
  code's own definition and deliberately still consults on every read — and the very next paragraph
  of the same advisory is about `sole-holder`. Rescoped to name `reason=cohort-too-small`, to say
  "for each block this node HOLDS", and to name the two shapes that stay loud. Pinned by a new
  `cluster-policy.spec.ts` case (which also closes the implement handoff's "caveat text is not
  pinned" gap), including a negative assertion so the over-broad sentence cannot come back.
- **Missing-block arming was unpinned.** Arming stamps a block this node holds nothing of, and is
  inert only because `get` triggers on `isMissing` before it consults the window. Added a case to
  `coordinator-repo-small-cohort-arming.spec.ts`: the unheld block still consults on all three reads
  and still flags `claimed-elsewhere`. Without it, a future "unify the two triggers" edit could turn
  the stamp into a suppressed acquisition, and the block would read as an authoritative absent for a
  whole window while a peer claims it exists.
- **The same scope limit was missing from the docs.** transactions.md's new arming paragraph said
  "once per window instead of once per read" without noting the stamp only damps blocks this node
  holds. Added.
- **Duplicated parameter type.** `reportRepairDeadlock` and `classifyRepairDeadlock` each declared
  the same seven-field inline object with duplicated field docs. Extracted as `RepairDeclinePass`,
  documented once.

### Major — none filed, and why

No finding rose to a major. The one architectural concern worth a home already has an owner, so it
was appended as evidence rather than filed fresh (site-claim grep over the board found it):
`backlog/debt-freshness-state-scattered-across-coordinator-repo` gained a thirteenth measurement —
`coordinator-repo.ts` is **2635 lines** (`wc -l`), up from 2503 — with two structural notes. The
encouraging one: the pure/logging split this ticket made is exactly the shape that ticket's extracted
collaborator wants. The other: `markBlocksSeen` is now called at four exits of
`fetchBlockFromCluster` and deliberately skipped at two more, all six applying one rule that lives
only in prose repeated at each site, with nothing forcing a seventh exit added later to say which
side it falls on. The fix is to make the arming decision part of each exit's returned verdict — the
same "required, not optional" discipline `AbsenceVerdict` and `CurrencyVerdict` already use.

### Tripwires — one recorded

`certified: true` with `voters: 1` on `cluster-fetch:local-current` does not distinguish a
multi-signer cohort proof from a solo cohort's self-signed receipt — a distinction selection itself
makes (`RevClaim.certifiedSignerCount`) but `QuorumRev` does not carry out. Fine while the flag is
read as "proof-backed, not peer-backed". Parked as a `NOTE:` on the `ClusterLatestQuery.corroboration`
field doc, with the fix if it ever matters (carry the signer count on `QuorumRev`). Not a ticket.

### Accepted tradeoffs — respected, none re-filed

The new accepted-tradeoff `NOTE:` at `cluster-fetch:local-current` (single-voter arming) states its
revisit condition as "a cadence-independent freshness signal exists to arm against". It has not
tripped, and the review did not re-open it. The `sole-holder` narrow-window `NOTE:` and the
advisory's ride-the-existing-trigger `NOTE:` were likewise checked and left alone.

### Out of scope, noticed and left alone

`resolveClusterPolicy` returns a hardcoded `simpleMajorityThreshold: 0.51`, so the
`simpleMajorityThreshold` config knob `CoordinatorRepo` plumbs into it is inert. Pre-existing, well
outside this diff, and it does not affect the arming rule (the derivation above assumes the fixed
0.51 and says so). Not chased here.

### Validation

- `yarn workspace @optimystic/db-p2p typecheck` — clean.
- `yarn workspace @optimystic/db-p2p test` — **2592 passing, 49 pending, 0 failing** (2590 before the
  review's two new cases).
- `yarn lint` — clean. `yarn lint:docs` — 45 documents, 74 anchored citations, 585 file mentions,
  327 links, all resolve.
- Repo-wide `yarn test` (after `yarn workspace @optimystic/db-p2p build`, which the stale-build guard
  requires) — green.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Known gaps carried forward (unchanged by the review)

- **Certified row tested at steady state only** (equal-revision certified claim → `local-current`); a
  certified claim *ahead* converging is covered by pre-existing read-repair/certified specs.
- **Two phones over a relay is unit-shaped only.** The silent-partner cases stand in for a relay
  outage; end-to-end React Native validation is blocked on the `WebSocket.bufferedAmount` polyfill
  gap (`gotchoices/sereus#11`, tracked on the RN checklist in `packages/db-p2p/readme.md`). No new
  code path assumes the partner is dialable on demand.
- **Growing 1 → 2 and shrinking 2 → 1** were validated by argument plus the unit shapes
  (holds-nothing, silent, solo suite), not by a mesh-level test of the cohort-growth push interplay.
- **Human action outstanding:** answering `gotchoices/sereus#2` (the hardcoded `clusterSize: 3` seam
  in Sereus's `CadreNode`) so the membership-derived `assumedClusterSize` recommendation has a
  configuration seam to land in. The implement ticket forbade posting from the ticket, and the review
  did not post either.
