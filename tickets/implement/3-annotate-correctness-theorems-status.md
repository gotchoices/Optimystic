description: The correctness document reads like a description of the running system, but several of its Byzantine-fault and dispute guarantees describe a mechanism that is not built yet. Annotate each affected theorem with a plain "what is promised vs. what actually ships today" note so no reader mistakes the target for the current reality.
prereq:
files:
  - docs/correctness.md (Theorems 1, 2, 7, 8, 8b, 10; §7.1, §7.2; §8 composition list; §1.5)
  - docs/right-is-right.md (§Current Implementation — reconcile honesty)
  - docs/architecture.md (§Status & Evolution; §Implementation / Doc Sync Status — the target-vs-current annotation pattern to mirror)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (executeTransaction:299-332 — commits on super-majority, sets record.disputed)
  - packages/db-p2p/src/dispute/dispute-service.ts (initiateDispute:137 — no production caller; single round=0)
  - packages/db-p2p/src/dispute/types.ts (DEFAULT_DISPUTE_CONFIG.disputeEnabled = false, :124)
  - packages/db-p2p/src/libp2p-node-base.ts (:1042 DisputeService only built when disputeEnabled; :605 superMajorityThreshold default 0.67)
difficulty: easy
----

# Annotate correctness.md theorems with target-vs-current status

`docs/correctness.md` is written as a set of theorems describing "the properties Optimystic
guarantees." For most theorems that is accurate. But the Byzantine-fault-tolerance and dispute
theorems describe a **synchronous, cascading, escalating** dispute mechanism that **is not
implemented** — the shipping behaviour is materially weaker. A reader (or a formal-verification
effort) who takes those theorems at face value will over-read the system's guarantees.

This ticket is the **cheap, honest, short-term** half of the parent design ticket
`design-dispute-synchronous-escalation`. It does **not** build anything — it annotates the docs so
the formal claims are not read as descriptions of the shipping system, the same way
`docs/architecture.md` §Status & Evolution and §Implementation / Doc Sync Status already flag
target-vs-current. It is independent of the strategic build decision (parked in
`tickets/blocked/dispute-synchronous-escalation-decision.md`) and should land regardless of how that
decision goes.

## The gap, stated plainly (this is the ground truth to annotate to)

Verified against the code at HEAD:

- **Commit happens despite disagreement.** On a promise phase where a minority rejects but an
  approving super-majority is reached (default `superMajorityThreshold = 0.67`,
  `libp2p-node-base.ts:605`), `ClusterCoordinator.executeTransaction` **commits the transaction
  anyway** and merely sets `record.disputed = true` with evidence
  (`cluster-coordinator.ts:299-332`). Nothing is blocked. There is no pre-commit escalation.
- **Disputes are off by default.** `DEFAULT_DISPUTE_CONFIG.disputeEnabled = false`
  (`dispute/types.ts:124`). The composition root only constructs a `DisputeService` at all when
  `disputeEnabled` is set (`libp2p-node-base.ts:1042`).
- **Even when enabled, disputes are never initiated in production.** `initiateDispute`
  (`dispute-service.ts:137`) has **no production caller** — it is invoked only from tests. The
  libp2p protocol handler (`dispute/service.ts`) wires only the *receiving* side
  (`handleChallenge`, `handleResolution`). No cluster-member commit path triggers a dispute. So the
  post-commit dispute path, even switched on, does not run end-to-end.
- **No cascade even if initiated.** `initiateDispute` selects **one** arbitrator ring
  (`round` is hard-coded `0`), collects votes **once**, and resolves. There is no recursion, no
  geometric widening. (The dispersed-sampling primitive from the `arbitrator-independent-sampling`
  prereq supports a `round` parameter, but nothing drives it past 0.)
- **Reversal is unwired too.** `revalidate` and `onInvalidation` are optional and not supplied at
  the composition root, so even a `challenger-wins` resolution originates no durable
  `InvalidationEntry` end-to-end (see `right-is-right.md` §Durable Invalidation "Wiring status").

**Net:** the guarantee the code actually delivers today is *"a validity disagreement is **detectable**
(the record carries a `disputed` flag and rejection evidence) within a cluster that has an honest
super-majority of ≥⌈0.67·K⌉ approvals."* That is **strictly weaker** than the advertised `f < N/2`
Byzantine tolerance: a Byzantine minority up to ~33% of a cluster can drive an invalid transaction to
commit, flagged but not blocked, and (by default) never arbitrated.

## What to write

Mirror the existing precedent. Two patterns already in the repo:

1. `correctness.md` **Theorem 3** already carries a `> **This is weaker than … — read this first.**`
   blockquote that names the gap, the honest guarantee, and the backlog item tracking the stronger
   mode. Reuse that exact shape for the BFT/dispute theorems.
2. `architecture.md` §Status & Evolution states target-vs-current in prose and points at authoritative
   source files. Keep that voice: **current behaviour is authoritative; the theorem states a target.**

Add annotations (do **not** delete the theorems — they remain the target design):

- **Top-of-document banner.** A short note under the intro (near line 3-6) stating that §5 (Byzantine
  Fault Tolerance) and the dispute-convergence/termination theorems describe a **target** mechanism
  that is **partially implemented**, and that per-theorem status notes flag the gaps. Cross-link
  `architecture.md` §Status & Evolution and `tickets/blocked/dispute-synchronous-escalation-decision.md`.
- **Theorem 1 (Consensus Safety), Case 3** — the "Byzantine-majority cluster → minority triggers a
  dispute → escalation ejects the losing side" argument is **target**. Current: a Byzantine cluster
  super-majority commits with only a `disputed` flag; there is no pre-commit dispute that ejects it.
  Note that Cases 1 and 2 (sequential / concurrent honest race resolution) **are** current.
- **Theorem 2 (Partition Safety)** — largely **current** now: the membership admission gate and
  membership binding landed (prereqs `cluster-membership-admission-gate`,
  `bind-cluster-membership-into-signed-record`). Keep, but flag that the one clause invoking *dispute
  escalation* to recruit a wider honest majority is target (same gap as Theorem 1 Case 3).
- **Theorem 7 (Termination), clause 2 "Dispute termination"** — **target**. Multi-round escalation
  with per-round timeouts and fresh dispersed samples does not exist (round is always 0, and disputes
  are not initiated in production).
- **Theorem 8 (Dispute Convergence, O(log N) rounds)** — **target / not implemented**. Single round,
  no widening, unwired initiation. This is the theorem most at risk of being over-read.
- **Theorem 8b (Invalidation-Cascade Termination)** — **partial**. The cascade primitive and
  reversal machinery exist in code (`db-p2p/src/dispute/cascade.ts`, `invalidation.ts`) and are
  unit-tested, but the end-to-end origination/emit wiring is not in place (see `right-is-right.md`
  §Durable Invalidation "Wiring status" and §Client Notification "Wiring status"). Flag as
  built-but-not-live, not as fully current.
- **Theorem 10 (Adaptive Byzantine Tolerance) — the central one.** Tiers 1-2 (fast path + honest
  super-majority override with the minority flagged) are **current**. Tiers 3-4 (honest-minority
  triggers dispute; cascading escalation) and the entire **cost-model table** are **target /
  unbuilt**. State plainly that today the effective tolerance is *Byzantine-**detectable** under an
  honest cluster super-majority*, not the `f < N/2` the theorem's headline claims. This is edge case
  #4 (cost-model reconciliation, the "downgrade" arm) and edge case #5 (honest-super-majority vs
  advertised tolerance) from the parent ticket.
- **§7.1 Sybil** — the dispersed-arbitrator-sampling bullet: the *sampling function* is current
  (prereq landed), but it is only exercised inside the unwired single-round dispute path — note that.
- **§7.2 Partition Duration / Healing** — the "forked → invalidation cascade" reconciliation is the
  same partial (built-not-live) status as Theorem 8b.
- **§8 Composition of Guarantees, item 6** ("Byzantine validators are detected and ejected, with
  validation cost proportional to the fraction encountered") — soften to reflect *detected/flagged*
  (current) vs *ejected via escalation* (target).
- **§1.5 Global Honest Majority** — a one-line pointer that the `f < N/2` tolerance is the target the
  full dispute mechanism is designed to reach; the currently-shipping subset provides the weaker
  honest-cluster-super-majority detection described in the Theorem 10 status note.

Also reconcile `right-is-right.md` §Current Implementation: its "Current Behavior: Async Dispute"
paragraph says disputes "run asynchronously — the transaction commits first, then the minority can
challenge." That is accurate about the *design intent of the code* but omits that initiation is
unwired in production and off by default. Add one sentence making that explicit so the two docs agree.

## Edge cases & interactions

- **Do not contradict already-honest docs.** `architecture.md` §Status & Evolution already lists
  "cascading dispute escalation with synchronous blocking" as partially implemented, and Theorem 3 /
  §Durable Invalidation wiring-status notes are already honest. The new annotations must be
  *consistent* with those — same tolerance numbers, same "authoritative source is the code" framing —
  not a second, differently-worded account.
- **Numbers must match the code, not the prose.** The default `superMajorityThreshold` is `0.67` at
  the composition root (`libp2p-node-base.ts:605`) but `0.75` in the test/mesh harness and in several
  Theorem statements. Quote both and cite the source; do not silently pick one.
- **Prereq-landed vs target.** The two prereqs (membership admission gate, dispersed arbitrator
  sampling) genuinely landed — annotations must not describe *those* as unbuilt. Only the escalation
  loop, pre-commit blocking, dispute initiation, and reversal wiring are the gaps.
- **Formal-verification section (§9).** It references model-checking the dispute escalation state
  machine. Add a note that §9 targets the design, not the current code, so a reader planning a TLA+
  effort knows the escalation phases are not yet in the implementation.
- **Reversibility.** Doc-only change; no code, no tests. The "interaction" risk is purely
  cross-document consistency — verify by re-reading the three docs together after editing.

## TODO

- Read `architecture.md` §Status & Evolution and the Theorem 3 blockquote in `correctness.md` to lock
  the annotation voice and format before writing.
- Add the top-of-document status banner to `correctness.md`.
- Add per-theorem status notes to Theorems 1 (Case 3), 2 (escalation clause), 7 (clause 2), 8, 8b, 10
  (+ cost-model table), and to §7.1, §7.2, §8 item 6, §1.5, §9.
- Reconcile `right-is-right.md` §Current Implementation "Async Dispute" paragraph with the
  off-by-default + unwired-initiation reality.
- Re-read all three docs end-to-end for cross-document consistency (tolerance numbers, source-file
  citations, no claim that a landed prereq is unbuilt).
- No build/test run required (doc-only); note that explicitly in the review handoff.
