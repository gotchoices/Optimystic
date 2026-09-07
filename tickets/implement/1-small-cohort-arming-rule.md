----
description: A group of one or two machines is a normal way to run this system, and two safety behaviours written for bigger groups need one shared rule there — when a machine may stop re-asking its partner about a record on every read, and when it must keep asking — so that a correctly configured small group is never noisier than a misconfigured one.
prereq:
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`fetchBlockFromCluster` — the `local-current` arm and the `!corroborated` branch; `reportRepairDeadlock`; `queryClusterForLatest`)
  - packages/db-p2p/src/cluster/quorum-restore.ts (read-only reference — `corroboratorCapacity`, `selectQuorumRev`; no changes expected)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`resolveClusterPolicy` — the `repair-fault-tolerance` advisory message)
  - packages/db-p2p/src/cluster/certified-claims.ts (read-only reference)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (regression guard — must keep passing)
  - packages/db-p2p/test/coordinator-repo-commit-freshness.spec.ts (helpers the new spec can reuse)
  - docs/transactions.md (§ Lazy read-repair window, § What a repair pass will and will not accept)
  - docs/internals.md, docs/architecture.md, packages/db-p2p/docs/cluster.md (small-cohort guidance)
difficulty: hard
----

# One arming rule for small cohorts, and a settled trust posture for a cohort of two

Design output of `plan/1-small-cadres-are-a-first-class-topology`, designed jointly with
`plan/2-bug-a-cohort-that-cannot-corroborate-re-asks-on-every-read` (absorbed here — its
measurement and analysis are incorporated below; do not look for it on the board). Background: a
group of one or two machines is a supported production topology (maintainer decision 2026-09-06,
recorded in `docs/architecture.md`), and the ordinary path is a user starting with one machine and
adding a second as a backup.

## The rule, stated once

**Mark a record "freshness-checked" (arming the lazy read-repair window) exactly when re-asking
the cohort sooner than one window could not teach this node anything the next consult would not.**
Every exit of `fetchBlockFromCluster` is an application of that one sentence:

| exit | arms? | why |
| --- | --- | --- |
| solo-self (cohort is exactly this node) | yes (already ships) | no one to ask; a cohort that grows is seen within one window |
| empty cohort (routing failure) | no (already ships) | routing can recover any moment; production cannot even reach this branch |
| corroborated, local current (`cluster-fetch:local-current`) | **yes — unchanged, now including a single-voter corroboration** | see "The cohort-of-two decision" below |
| corroborated ahead, converged or not | yes (already ships) | the cohort answered; the doubt memo, not the window, carries honesty |
| nothing corroborated, decline **provably permanent** (`cohort-too-small`) | **yes — NEW, this ticket** | the cohort cannot field the quorum even if every member answered and agreed; repeating the identical hopeless check teaches nothing |
| nothing corroborated, any other reason (transient silence, `sole-holder`, plain shortfall) | no — unchanged | a silent peer can recover, a non-holder can gain a copy, a shortfall can fill; re-asking can genuinely learn |

## The cohort-of-two decision (the tripped revisit condition at `local-current`)

The accepted-tradeoff NOTE at the `local-current` arm asked, if two-member cohorts ever became
supported, to "stop re-arming the window on a corroboration that came from a single voter". They
are now supported — and the remedy the NOTE proposed is **rejected**, for three reasons that must
survive into the rewritten NOTE:

1. **Re-asking the sole partner sooner learns nothing.** The repeat consult reaches the same one
   peer, and a lying peer repeats the lie. This is the same justification the solo-self exit arms
   under — not "the partner is trusted", but "a faster cadence cannot produce new evidence".
2. **Not arming punishes only the honest.** An honest partner corroborating "you are current" is
   also a single voter, so refusing to arm makes every healthy two-machine group pay one network
   round trip per read, forever, while buying zero protection against a dishonest partner. The
   naive remedy is strictly harmful.
3. **The residual threat is a withholding attack, and no consult cadence or proof rule touches
   it.** A commit proof certifies "revision R was committed"; nothing can certify "no revision
   after R exists". A sole partner that withholds a newer revision is indistinguishable, from
   inside the group, from that revision never existing. Two bounds keep this narrow: a two-member
   cohort commit requires **both** members' signatures (super-majority ceil(2 × 0.66) = 2 and
   majority > 1 both resolve to 2 of 2 — `ClusterMember.hasMajority`, `cluster-repo.ts:932`), so
   a revision the reader never heard of can exist only when the reader lost its own storage and is
   restoring, or when the commit happened under a different cohort shape (the partner alone during
   a partition — which mints a single-signer proof the partner can present, or withhold). State
   this plainly in the docs: a user adding a rented cloud pod gets integrity guarantees against a
   lying partner (fabricated revisions and content need proofs or corroboration the liar cannot
   supply) but **not** freshness guarantees against a withholding one.

What we buy instead of a cadence change is **observability**: the `cluster-fetch:local-current`
line gains a `voters` field (the corroborating supporter count, or a certified/single-voter
marker), so "this node's currency rests on one peer's word" is visible in logs without re-deriving
it. `queryClusterForLatest` currently drops `selected.supporters` on the floor when building its
return value — thread the count through `ClusterLatestQuery`.

## Certified claims: what they already settle (established, not speculative)

Proofs ride on latest-query replies (`libp2p-node-base.ts` `clusterLatestCallback`, via
`servableProof` / `latestClaimFromArchive`), the reader verifies them itself (`certifyClaim`), and
a certified claim short-circuits distinct-peer corroboration entirely (`selectQuorumRev`). Two
consequences worth pinning in tests because they carry most of the small-cohort story:

- **An undeclared two-machine group with proof-carrying data does not deadlock and does not
  loop.** The partner's certified claim is selected regardless of `corroboratorCapacity`; at an
  equal revision the pass lands in the `local-current` arm and arms the window. The steady-state
  read of an undeclared two-machine group is already quiet today wherever proofs exist.
- **The re-ask-forever loop (below) is therefore a property of proof-less claims only** — legacy
  data written before proofs shipped, or a peer that lost its proof store. The certified path is
  the zero-configuration answer for everything else.

## The provably-permanent decline (absorbed from the sibling bug ticket)

Measured (sibling ticket, `repro: verified`): an undeclared two-machine group whose partner
answers a proof-less claim at the reader's own revision runs the consult on **every read** — 6
peer queries across three reads inside one 10 s window, versus 0 with `clusterSize: 2` declared —
because the corroboration floor stays 2 (capacity measured against the default
`repairCorroborationClusterSize` = 10) and one partner can never meet it. The code already proves
the hopelessness — `reportRepairDeadlock` distinguishes `cohort-too-small` (permanent: the cohort
cannot field the quorum even with every member answering and agreeing) from `sole-holder` (a copy
is missing, not a machine) — but computes the verdict for a log line and throws it away.

Fix, at the root:

- Split the verdict computation out of `reportRepairDeadlock`'s say-once logging: compute the
  reason (pure, every pass), log it under the existing once-per-episode suppression, and **return
  it**.
- Thread the verdict into `queryClusterForLatest`'s return value and, in `fetchBlockFromCluster`'s
  `!corroborated` branch, call `markBlocksSeen` when — and only when — the reason is
  `cohort-too-small`.
- Everything else about that branch is unchanged: the `unsettled-claim` currency verdict still
  travels up when a peer claims ahead (the window damps repair *effort*, never honesty — reads
  inside the window still carry the doubt marker), `sole-holder` and silent passes still re-ask,
  and the say-once log suppression is untouched.

Note `reportRepairDeadlock`'s guards are part of the verdict: a pass with any silent peer proves
nothing (do not arm), and a pass with zero claims is an agreed absence, not a deadlock (do not
arm — see edge cases).

## The joint outcome (the collision table, resolved)

| two-machine group | corroboration outcome | rule applied | result |
| --- | --- | --- | --- |
| declared (`assumedClusterSize: 2`) | floor relaxes to 1; partner corroborates | `local-current` arms (unchanged) | quiet — one consult per window |
| undeclared, claims carry proofs | certified selection, no quorum needed | `local-current` / converged arms (unchanged) | quiet — one consult per window |
| undeclared, proof-less claims | floor stays 2, provably unmeetable | `cohort-too-small` arms (NEW) | quiet — one consult per window, deadlock logged once |
| any shape, partner silent | no evidence | no arming (unchanged) | consults each read, reads flagged — correct fail-closed |

The declared, correctly configured group is never worse off than the undeclared one, which was the
constraint that forced the joint design.

## How a two-machine group gets its size reference (recommendation — docs, not code)

The size reference stays **declared, never observed**: the observed cohort view comes from
unauthenticated peer routing, so an attacker with routing influence could talk the safety floor
down. That is settled and this ticket does not reopen it. But "declared" need not mean "typed by
an operator": *adding a backup is an authenticated, application-level membership operation* — the
host application knows exactly how many machines the user has enrolled, because it performed the
enrollment. The recommendation, to be stated in `packages/db-p2p/docs/cluster.md` (and echoed
where `assumedClusterSize` is documented):

> A host application that manages cadre membership should derive
> `clusterPolicy.assumedClusterSize` from its own membership records — the number of machines
> actually enrolled — and pass it at node construction. This is a declaration from authenticated
> application state, not an observation of the network, so it keeps the property the declared
> field exists for. An end user should never see or edit this number.

Two qualifications to carry into the docs:

- **The largest consumer cannot pass it yet.** `gotchoices/sereus#2`: `CadreNode` hardcodes
  `clusterSize: 3` and builds `clusterPolicy` inline without exposing `assumedClusterSize` or
  `allowUnvalidatedSmallCluster`. The recommendation is inert downstream until that seam exists —
  say so where the recommendation is written, and note that the hardcoded 3 is the shape a
  downstream author produces when docs imply three is the real minimum. (Answering that issue is
  a human action once this lands; do not post from this ticket.)
- **The declaration is lower-stakes than it used to be.** With certified claims and the
  `cohort-too-small` arming above, an undeclared two-machine group transacts, reads quietly, and
  self-repairs proof-carrying data with zero configuration. What the declaration still buys is
  repair of proof-less/legacy data (the relaxed uncertified floor) and the admission-gate
  yardstick.

The learned high-water-mark alternative stays in
`backlog/feat-admission-floor-from-observed-cohort-high-water-mark` (an arm has been appended
there relating it to this recommendation); do not build any part of it here.

## Edge cases & interactions

- **Solo cohort must not regress.** `coordinator-repo-solo-read-repair-window.spec.ts` (7 cases)
  must keep passing untouched: solo exit arms, empty-cohort exit does not.
- **Doubt survives arming.** When `cohort-too-small` arms the window while a peer claims a
  revision ahead (undeclared reader genuinely behind a proof-less partner), reads inside the
  window must still carry `unconfirmedAheadRev` — pin that arming did not erase or suppress the
  memo. This is the invariant `fix/currency-doubt-cleared-by-a-partial-answer` (landed) protects;
  do not re-break it from a new direction.
- **A pass with silent peers never arms via the deadlock verdict**, whatever the arithmetic says —
  the guard in `reportRepairDeadlock` is load-bearing for the new consumer, not just for the log.
  Pin it: undeclared two-machine group, partner times out → consult on every read, reads flagged.
- **`sole-holder` keeps re-asking.** Partner answered "I hold nothing", reader holds the block:
  claims from the reader's perspective may be zero (agreed absence — no deadlock, no arming) or
  the mirror case where the partner is the lone claimant. Neither arms. This means a two-machine
  group serving founding data the partner has not yet received consults on every read until the
  cohort-growth push (`replicate-owned-blocks-when-the-cohort-grows`, landed) delivers the copy —
  bounded by the push, not the window. Pin the current behaviour with a test and leave it: the
  partner gaining a copy or a newer revision is exactly what re-asking can learn. (The
  freshness-extraction backlog ticket owns the wider five-sites concern; expect its next
  measurement to record this pass.)
- **Growing 1 → 2 while blocks exist.** Solo-written blocks carry single-signer proofs
  (`mint-solo-cohort-commit-proof`, landed). After the partner joins: reader's consult sees the
  partner either silent (no arm), holding nothing (no arm, above), or claiming with the pushed
  proof (certified, arms). No founding data is stranded differently than today.
- **Shrinking 2 → 1.** Partner decommissioned: while it lingers in the routing view it reads as
  silent (no arming — consult per read, flagged), and once it leaves the view the solo exit arms.
  Same as today; no new rule fires. The permanently-unrepairable-if-behind case is the high-water
  ticket's problem, not this one's.
- **Two phones over a relay.** From `CoordinatorRepo`'s seat a relay-only partner is
  indistinguishable from a directly-dialled one — it either answers within
  `LATEST_QUERY_TIMEOUT_MS` or lands in `silent`. Confirm no new code path assumes the partner is
  dialable on demand; the silent-partner tests above are the relay-outage shape. End-to-end RN
  validation of this shape is **not currently possible** (React Native `WebSocket.bufferedAmount`
  polyfill gap, `gotchoices/sereus#11`, tracked on the RN checklist in
  `packages/db-p2p/readme.md`) — design for it, do not attempt to validate it there.
- **A partner that lies.** State in docs (transactions.md, cluster.md) exactly what size two does
  and does not protect: fabrication of revisions/content is caught (proofs, corroboration,
  both-signatures commits); withholding is not detectable and is bounded only by the two-signature
  commit rule (the reader co-signed everything committed while the pair was whole).
- **`paranoid` mode is unaffected** — it consults every read by policy; the arming rule only
  drives `lazy`. Sample-rate reads (`readRepairSampleRate`) still force occasional consults
  through an armed window, unchanged.
- **Say-once deadlock logging vs every-pass arming.** The log stays once per episode per reason;
  the arming must happen on *every* qualifying pass (the window expires and the next pass must
  re-arm). Splitting verdict from logging is what makes both true — test the second window
  explicitly: read at +11 s runs exactly one more consult and re-arms.

## TODO

Phase 1 — code
- Split `reportRepairDeadlock` into pure verdict + say-once logging; return the reason.
- Thread the verdict and the corroborating-voter count through `queryClusterForLatest`'s result.
- Arm the window on `cohort-too-small` in the `!corroborated` branch of `fetchBlockFromCluster`.
- Add `voters` to the `cluster-fetch:local-current` log line.
- Rewrite the tripped NOTE at the `local-current` arm as the settled design decision (the three
  reasons above, pointer to this ticket's slug), removing the REVISIT-TRIPPED block.

Phase 2 — tests (adversarial surface above; reuse the stub helpers from
`coordinator-repo-commit-freshness.spec.ts`)
- The four-row joint-outcome table, each row as a case (declared / undeclared+certified /
  undeclared+proofless / silent partner), asserting consult counts inside and across windows.
- Doubt-survives-arming; silent-pass-never-arms; sole-holder and agreed-absence keep re-asking;
  second-window re-arm; solo regression suite untouched.

Phase 3 — docs
- `docs/transactions.md`: update § Lazy read-repair window (new arming row) and the repair-pass
  bullet — replace the "reconciling that with a second machine arriving by a user action is open
  work" sentence with the settled rule and the joint-outcome summary.
- `packages/db-p2p/docs/cluster.md` (+ echo in `docs/architecture.md` / `docs/optimystic.md` where
  small cadres are discussed): the membership-derived `assumedClusterSize` recommendation, the
  sereus#2 caveat, and the honest statement of what size two protects against.
- `cluster/cluster-policy.ts` `repair-fault-tolerance` advisory: add that claims carrying verified
  commit proofs repair at any size, so the permanent-decline warning applies to proof-less data —
  and that the re-ask loop is now damped to one consult per window either way.
- `docs/internals.md`: log-line index — `cluster-fetch:local-current` gains `voters`; note the
  deadlock reasons' new arming consequence if the size table mentions them.

Phase 4 — validation
- `yarn workspace @optimystic/db-p2p typecheck && yarn workspace @optimystic/db-p2p test` in the
  foreground; then repo-wide `yarn test` and `yarn lint:docs`.
