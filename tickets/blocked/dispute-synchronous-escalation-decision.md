description: Before we invest in building the "block the transaction and argue it out before committing" mechanism the design docs promise, we need a human to confirm that is still the direction we want — because the system already ships a different, coherent way of handling the same problem (commit optimistically, then durably reverse if proven wrong), and turning on the promised mechanism would slow down every transaction that hits any disagreement.
prereq:
files:
  - docs/right-is-right.md (§Current Implementation; §Open Design Questions; §Durable Invalidation; §Read-Dependency Cascade)
  - docs/correctness.md (Theorems 8, 10 — the cost model that assumes the unbuilt mechanism)
  - docs/architecture.md (§Status & Evolution — lists this as partially implemented)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (the commit path a synchronous block would have to change)
  - packages/db-p2p/src/dispute/dispute-service.ts (the post-commit dispute service; single round, unwired initiation)
----

# Decision needed: build synchronous block-then-escalate, or adopt the optimistic-reverse path as the design of record?

## Why this is in your inbox and not just built

The plan ticket `design-dispute-synchronous-escalation` asked for two things. The **cheap half** — an
honest set of "what actually ships today" notes on the correctness document — is being done now as a
separate implement ticket (`annotate-correctness-theorems-status`) and needs no decision from you.

The **expensive half** — actually building the mechanism the docs promise, where a validity
disagreement *blocks* a transaction from committing and triggers repeated, widening rounds of
independent arbitration until one side wins — is a large, multi-month change to the heart of the
consensus path. It is not something an implementer should be handed with the key direction still open,
and it is not something a planning agent should silently pick a direction on, because **the project
already contains a fully-designed, largely-built alternative that solves the same problem a different
way.** Which of these is the real target is a product/architecture call, not an engineering detail.

## The two coherent worlds

Both of these are internally consistent. They are not compatible defaults — you have to choose which
one is "the design," or deliberately choose to run both.

### World A — Synchronous block-then-escalate (what the docs currently promise)

A transaction that any cluster member rejects on validity **does not commit**. The dissenting members
elect a leader, who recruits independent arbitrators from across the network; if they split, the
argument escalates to a wider, freshly-sampled audience, and so on, until one side wins. Only then does
the transaction commit (if the approvers win) or fail (if the rejecters win). The transaction is
**invisible** to everyone the whole time.

- **Upside:** an invalid transaction is *never visible*, even briefly. This is the strong `f < N/2`
  guarantee the docs advertise (Theorems 8 and 10).
- **Cost:** every transaction that hits *any* validity disagreement pays multiple network round-trips
  before it can commit — a real latency and liveness regression on a path that is currently one round
  trip. It also means the dispute mechanism must be **on by default** to deliver the guarantee, which
  is the opposite of today's `disputeEnabled: false`.
- **Build size:** large. It changes the commit ordering in `cluster-coordinator.ts`, adds a real-time
  multi-round escalation loop (today the round counter is hard-wired to 0), and forces answers to the
  still-open questions in `right-is-right.md` §Open Design Questions (per-round fan-out; whether a
  round needs unanimity or a super-majority; how ejections are stored so a losing peer can't just
  rejoin; the rejoin path).

### World B — Optimistic commit, then durably reverse (what the code has largely been built toward)

A transaction commits at super-majority (as today), flagged if a minority disagreed. If it is later
*proven* invalid, a durable, audit-preserving reversal is appended to the log and its downstream
dependents are re-evaluated. Most of this machinery already exists in code
(`db-p2p/src/dispute/invalidation.ts`, `cascade.ts`, the `InvalidationEntry` log type, the client
notification path) and is unit-tested — though its end-to-end origination/emit wiring is still pending
(see `right-is-right.md` §Durable Invalidation "Wiring status").

- **Upside:** the fast path stays fast — one round trip, no blocking. Invalidity is corrected after the
  fact, with a verifiable certificate and a cascade that re-checks dependents.
- **Cost:** an invalid transaction *is briefly visible* before it is reversed. The guarantee is weaker
  than `f < N/2` — it is closer to "invalid commits are detectable and reversible," and a client can
  observe a value that later gets pulled back (mitigated by the invalidation notification + authoritative
  re-read).
- **Build size to finish:** much smaller — mostly wiring the already-built reversal/cascade into the
  composition root and the commit path, plus the honest-tolerance framing in the docs.

### World C — Both, split by *when* the disagreement is known

Use synchronous blocking **only** for disagreement that is visible at promise time (a member rejects
during the vote), and keep the durable-reverse path for invalidity **discovered after** commit (a later
dependent or audit proves an already-committed transaction wrong). These are not redundant — one guards
the pre-commit window, the other the post-commit window — and together they are arguably the most
complete design. But it is also the most work and the most surface area.

## The specific questions to answer

1. **Which world is the target** — A, B, or C? Equivalently: is "an invalid transaction must never be
   visible even briefly" a hard requirement, or is "briefly visible then verifiably reversed"
   acceptable for Optimystic's use cases?
2. **Default posture.** If any form of synchronous dispute ships, is it **on by default** (required for
   the guarantee to be real) or opt-in? Today it is off and, even when switched on, is never initiated
   in production. "Off by default" means the advertised guarantee is not the shipped guarantee — which
   is the whole reason this ticket exists.
3. **Cost-model reconciliation.** Correctness Theorems 8 and 10 (the O(log N) escalation cost model)
   describe World A. If you choose B, those theorems should be *downgraded* to describe the reversal
   guarantee, not left describing an unbuilt mechanism. If A or C, they become the spec to build to.
   (The interim honest annotation is happening now regardless.)
4. **Cascade termination, if A/C.** Geometric widening must terminate. Confirm the intended final
   outcome when widening reaches the whole network without resolution: reject the transaction, leave it
   pending until expiration, or degenerate to whole-network consensus (the "blockchain extreme" the docs
   mention). This shapes the liveness bound in Theorem 7.

## What happens after you decide

- **Choose B (adopt optimistic-reverse as design of record):** a follow-up plan ticket scopes finishing
  the reversal/cascade wiring and rewrites Theorems 8/10 and `right-is-right.md` to describe the reversal
  guarantee as *the* design, dropping the synchronous-blocking target. Smallest path.
- **Choose A or C (build synchronous blocking):** a follow-up **plan** ticket (not implement — the
  §Open Design Questions must be resolved first) designs the escalation loop, the block-before-commit
  commit-path change, the round/fan-out/termination rules, and the ejection-durability/rejoin policy,
  then decomposes into `prereq`-chained implement tickets sized to one agent run each. This is the
  multi-month path and should not start until the open questions above are settled.

Either way, the near-term honesty fix (`annotate-correctness-theorems-status`) lands independently, so
the docs stop over-claiming while this decision is pending.
