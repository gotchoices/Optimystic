# Partition Healing via Deterministic Application Rules

## The Underlying Problem: "The Globe Didn't Exist"

A network partition is not, at heart, a data-consistency problem. It is a *reality-construction* problem. During a partition, there is no globe — there are two (or more) disjoint regions, each locally consistent with itself, each unaware that the other exists. When the partitions merge, the reconstructed globe may contain mutually incompatible histories: transactions that "happened" in both regions but whose combination violates an invariant that exists only in the union.

The canonical illustration: an account starts with $100. A partition separates Alice and Bob into different regions. In partition A, Alice withdraws $80; balance is $20, locally correct. In partition B, Bob withdraws $50; balance is $50, locally correct. Both partitions have valid local histories. At merge, $130 has been withdrawn from an account that held $100. No amount of CRDT machinery erases the fact that for the duration of the partition, both regions saw consistent local histories whose combination is globally impossible.

The question this document addresses: how should Optimystic's CRDT-synchronized transaction log (see [crdt-sync.md](crdt-sync.md)) handle these partitioned realities on merge — in a principled, deterministic, application-configurable way?

The answer proposed here: **application logic declares the rules for normal operation, and separately declares the rules for what should happen when normal operation fails.** Both sets of rules are first-class, signed, deterministic, part of the transaction, and replayed identically by every node.

## The Three Honest Choices

There are exactly three stances a distributed system can take toward the "globe didn't exist" problem:

**1. Refuse local progress until quorum (CP).** Every transaction requires global coordination. During a partition, the minority partition blocks. This is today's Optimystic behavior ([correctness.md](correctness.md) §Theorem 2, §6.1). It is simple, safe, and sometimes the wrong choice — a chat app that stops working during a partition is worse than one that accepts messages locally and reconciles on merge.

**2. Allow local progress; reconcile at merge (AP with application compensation).** Transactions commit locally during partitions. On merge, divergent histories are reconciled by rules the application supplies. This is the stance most real-world distributed systems take implicitly: banks reverse, airlines bump, retailers oversell and apologize. Making these rules first-class in the database is what this document proposes.

**3. Restrict operations to a conflict-free subset (I-confluent).** The application only performs operations provably safe to merge without coordination (add to a set, increment with no max, append to a log). This is the pure CRDT stance. It is correct but expressive-limited; many natural operations (anything with a lower bound, a uniqueness constraint, or a max cardinality) fall outside.

A mature system lets the application choose among these **per invariant**. The same collection might enforce *no negative balance* via (1) or (3) while enforcing *unique handle* via (2) with a human-arbitration reconcile. No single stance fits everything; picking one globally is the source of much distributed-systems dogma.

## The Two-Tier Rule Model

Every transaction under CRDT sync carries two kinds of rules, of which only the first exists today:

```typescript
type CrdtTransaction = {
  // Tier 1 — Intent (today's transaction plus HLC; see crdt-sync.md)
  stamp: TransactionStamp;
  statements: string[];
  reads: ReadDependency[];
  writes: BlockOperation[];
  hlc: HybridLogicalClock;
  id: string;

  // Tier 2 — Invariants and reconciliation (new)
  invariants: InvariantSpec[];
  reconcile: ReconcileSpec;
};
```

The division:

* **Tier 1 — Intent.** What the transaction *wants* to do. This is today's transaction plus HLC, with the CRDT sync machinery from [crdt-sync.md](crdt-sync.md).
* **Tier 2 — Invariants and reconcile.** What the application says *should be true* and what it *does* when it isn't. The reconcile function is itself pure, deterministic, and transactional — its output is another CRDT transaction that commits through the same pipeline.

Both tiers are data. Both are part of the signed transaction. Both replay identically on every node. The system's job is to run them deterministically; the application's job is to write them correctly.

## Invariant Specification

```typescript
type InvariantSpec = {
  // Stable ID so reconcile can reference it.
  id: string;

  // Names blocks whose state affects this invariant — used to scope reconcile input.
  scope: BlockId[];

  // Deterministic predicate over post-replay state. Evaluated after replay merges every
  // tx with overlapping scope. False => this tx is flagged as violated in the merged timeline.
  predicate: DeterministicPredicate;

  // Classification that drives reconcile treatment.
  kind: 'compensatable' | 'reservation-required' | 'externally-visible';

  // Relative priority among invariants on the same scope (lower = higher priority).
  // Determines reconcile order when multiple invariants violate simultaneously.
  priority: number;
};
```

Three kinds:

* **`compensatable`** — when violated, the reconcile function can emit a compensating transaction that restores the invariant. The violation and its compensation are both in the log; the system continues.
* **`reservation-required`** — cannot be safely compensated after the fact. Requires the escrow primitive (below) to prevent violation in the first place. A partition that prevents reservation blocks the operation. This is CP semantics, opted into per-invariant.
* **`externally-visible`** — may be compensated internally, but external parties have seen the pre-compensation state (notifications sent, webhooks fired, UI displayed). Reconcile must emit both the compensating transaction *and* the external-facing correction (an apology email, a reversal webhook).

An invariant is evaluated at every replay, at every HLC where it is in scope. If every replay produces the same state, every replay evaluates the predicate identically. Determinism is inherited from deterministic replay.

## The Reconcile Function

```typescript
type ReconcileSpec = {
  // Engine ID — typically same as tx engine (QuereusEngine, ActionsEngine).
  engineId: string;

  // Statements to execute when any invariant on this tx is violated.
  // The engine receives: (thisTx, concurrentTxs, mergedState, violatedInvariants)
  // and produces a compensating CrdtTransaction (or flags for review).
  statements: string[];

  // Stability level at which this tx's side effects are authorized to fire.
  //   'on-hlc'     — local tentative; fire immediately (fast, revokable)
  //   'on-stable'  — fire after stability horizon past this tx (safe default)
  //   'on-reviewed' — fire only after explicit review (for reservation-required
  //                   invariants where compensation itself has external cost)
  effectGate: 'on-hlc' | 'on-stable' | 'on-reviewed';
};

type ReconcileInput = {
  thisTx: CrdtTransaction;
  concurrentTxs: CrdtTransaction[];   // every tx with overlapping scope, HLC-sorted
  mergedState: StateSnapshot;         // state after applying this tx + concurrents, pre-reconcile
  violatedInvariants: InvariantSpec[];
};

type ReconcileOutput =
  | { kind: 'compensate'; compensatingTx: CrdtTransaction }
  | { kind: 'flag-for-review'; reviewTx: CrdtTransaction }
  | { kind: 'accept'; note: string };   // invariant violated but app says "live with it"
```

The reconcile function runs during replay when a transaction's invariants evaluate false against the merged state. Its output is one or more transactions added to the CRDT log at a higher HLC.

Properties reconcile **must** satisfy for replay to converge:

1. **Deterministic.** Same inputs → same output, every time, on every node. No clocks, no randomness, no external reads. The engine runs the reconcile under the same determinism guards as regular transactions.
2. **Idempotent when applied.** If the reconcile has already produced a compensating tx on one node, replaying on another node over the same concurrent set produces the same compensation. This follows from determinism given pure inputs.
3. **Convergent.** If a reconcile output itself violates an invariant, it will be reconciled in turn, and so on. Termination must be guaranteed. The simplest discipline: reconcile output operations cannot themselves trigger the same invariant (a reverse transfer cannot overdraft the account it is refunding). More complex reconciles require explicit termination bounds.

Because reconcile output is just another CRDT transaction, it is content-addressed, signed by the peer that computed it, verifiable by anyone, and durably logged. The "who compensated when and why" audit trail is automatic and visible at the protocol layer rather than buried in application logs.

### Key framing

A clean way to think about it: **tier 1 is the replay function; tier 2 is the reconcile function. Both are pure, deterministic, run on every node, and produce data (transactions) that lands in the same CRDT log.** Reconcile is not a special escape hatch — it is a transaction producer that happens to be triggered by invariant violations rather than by client API calls. Every tool that works on transactions (audit, replay, dispute, Byzantine detection) works unchanged on reconcile-emitted transactions.

## Reservation and Escrow: Invariants That Cannot Be Compensated

Not every invariant admits compensation. "Don't send the missile" has no reverse transaction. "Pay the vendor their contractually-owed $1000" can be compensated (reverse the payment) but only at substantial social cost — and some contracts prohibit it.

For these invariants, the honest answer is: **local progress is not permitted.** The invariant is declared `kind: 'reservation-required'`, and the system uses an *escrow* primitive:

1. At transaction BEGIN, the system acquires a reservation on the resources the invariant protects (e.g., $1000 earmarked for this vendor payment).
2. The reservation itself is a CRDT entry, created at the issuing node's HLC, replicated cluster-wide.
3. Reservations aggregate like a bounded counter — the total reserved cannot exceed the available budget, *and this aggregate is verified at the log-tail cluster using today's strong-consensus machinery.*
4. Only when the reservation is held can the transaction proceed. The actual resource movement is a later CRDT-sync transaction that consumes the reservation by ID.
5. During a partition, a minority partition cannot reach the log-tail cluster to reserve, therefore cannot execute. CP behavior, deliberately scoped.

The escrow primitive is a deliberate return to today's strong-consistency mechanism, *but only for invariants that require it.* The rest of the collection continues in CRDT sync mode. This is the "hybrid" consistency posture hinted at in [crdt-sync.md](crdt-sync.md) §"Tunable per-collection."

## I-Confluence Classification

The I-Confluence literature (Bailis et al.) gives a rough taxonomy for which invariants need coordination:

| Invariant shape | I-confluent? | Recommended approach |
|----------------|--------------|----------------------|
| `value ≥ 0` (lower bound) | No | Escrow or `compensatable` (overdraft fee / reverse) |
| `value ≤ max` (upper bound) | No | Escrow for hard limits; compensatable for soft limits |
| `unique(key)` | No | Deterministic winner (earlier HLC); flag-for-review if undecidable |
| Append-only | Yes | Merge is union; no reconcile needed |
| Set cardinality bounds | No | Typically reservation |
| Foreign key | Yes, if parent-before-child via HLC | Otherwise reconcile cascade |
| Monotonically increasing | Yes | Merge is max |
| Referential cascade | Depends | Reconcile cascade with explicit rules |

An application author uses this table to classify each invariant and pick the right primitive. The system enforces the classification — you cannot declare an invariant `compensatable` and have no reconcile rule, and you cannot declare one `reservation-required` without integrating the escrow path.

A small investment in this classification up-front tends to be worth the ambiguity it removes: every invariant has a documented, enforced strategy.

## Cascading Compensation

A compensated transaction may have descendants — later transactions that read its writes and built on them. When reconcile reverses the first transaction, the descendants are built on a history that didn't happen.

Two regimes are possible:

**Conservative: descendants wait for stability.** A transaction cannot have visible descendants until it is stable. This is the safe default and aligns with the outbox pattern from [crdt-sync.md](crdt-sync.md) §"External effects and the outbox." Reconcile can freely revise transactions that have not yet been built upon. Throughput impact is bounded by stability latency — typically sub-second intra-cluster.

**Aggressive: recursive compensation.** Descendants may proceed against tentative state. If the ancestor is compensated, the descendants are compensated in turn, recursively, in HLC order. This supports strict local-first operation (every node always has a coherent tentative state) at the cost of potentially larger compensation cascades on merge.

The regime is a per-collection or per-invariant choice. Most invariants tolerate conservative; the ones that don't — interactive chat, collaborative text, live dashboards — prefer aggressive. For aggressive mode, the reconcile function's output must be defined recursively: "compensation for this transaction *and* its dependent descendants," not just the single tx. Engines can automate this for simple cases (reverse-writes-cascade) and expose the rest to application authors.

Both regimes preserve convergence — every node replays identically and arrives at the same reconciled state — but they differ in how much visible churn the application sees on merge. Conservative optimizes for user-facing stability; aggressive optimizes for local responsiveness.

## External Effects Revisited

[crdt-sync.md](crdt-sync.md) introduced the outbox tied to the stability horizon. Under the two-tier model, each transaction's `effectGate` is part of its reconcile spec, not a separate concept:

* **`effectGate: 'on-hlc'`** — fire as soon as the transaction is locally applied. Revocable: if the transaction is later compensated, the external system must support inverse effects (email a correction, reverse a charge). Only appropriate for truly reversible external systems.
* **`effectGate: 'on-stable'`** — default. Fire when past the stability horizon *and* the transaction's invariants are satisfied in the stable replayed state. No revocation needed for partition-healing cases, since stable transactions survive merges.
* **`effectGate: 'on-reviewed'`** — for transactions whose external effects are not safely revocable *and* whose invariants cannot be pre-escrowed (rare — typically high-value or legally-binding operations). Effects fire only after explicit review, either automatic (time passes without dispute) or manual.

The gate is part of the transaction's signed content. Effect dispatchers honor it deterministically. A partition cannot cause `on-stable` effects to fire before stability — the dispatcher is locally bound to the HLC watermark. A partition also cannot cause `on-reviewed` effects to fire without the review record being present in the log.

## Worked Examples

### Example 1: Bank account with `balance ≥ 0`

Initial balance $100. Partition separates Alice and Bob. Alice withdraws $80 in partition A, Bob withdraws $50 in partition B. Total after merge: $-30 if both stand.

Invariant: `balance(account) ≥ 0`.

**Reservation mode** (`kind: 'reservation-required'`). The balance block carries both a balance and a reservation counter. Withdrawals reserve against the balance at the log-tail cluster synchronously — today's strong-consistency path, exactly for this operation. The actual withdrawal is a later CRDT-sync transaction that consumes the reservation. Partitioned nodes cannot reserve; they cannot withdraw. Alice and Bob's withdrawals contend only one can succeed during the partition; the other is rejected at the reservation step with "account funds unavailable — try again later."

**Compensation mode** (`kind: 'compensatable'`). Both withdrawals commit locally. On merge, replay in HLC order gives `balance = 100 - 80 - 50 = -30`. Invariant violated. Reconcile runs with `thisTx = Bob's withdrawal` (the later-HLC transaction that broke the invariant), `concurrentTxs = [Alice's, Bob's]`, and `violatedInvariants = [non-negative-balance]`. A sensible reconcile:

```sql
-- Pseudocode (engine-native statements)
-- Admit withdrawals in HLC order as long as balance stays ≥ 0.
-- Emit compensating tx for any that would push negative.
WITH ordered AS (
  SELECT tx_id, amount, hlc FROM :concurrent_txs ORDER BY hlc ASC
),
running AS (
  SELECT tx_id, amount,
         SUM(amount) OVER (ORDER BY hlc) AS total_withdrawn
  FROM ordered
),
winners AS (SELECT tx_id FROM running WHERE total_withdrawn <= 100),
losers  AS (SELECT tx_id FROM running WHERE total_withdrawn > 100)
INSERT INTO __compensations(for_tx, reason)
  SELECT tx_id, 'insufficient-funds-post-merge' FROM losers;
-- The compensating tx reverses the withdrawal and schedules a notification.
```

Result: Alice's $80 (earlier HLC) stands; Bob's $50 is reversed; Bob gets a notification `effectGate: 'on-stable'` explaining the partition, apology, and a reversal confirmation. The notification fires only after the reconcile itself is stable — partitions don't produce phantom notifications.

The application chooses the mode per-account. A checking account uses reservation. A pocket-money app uses compensation with "you spent it in two places at once; sorry, here's your money back." Same database; different invariant declaration.

### Example 2: Seat reservation for an event

Invariant: `count(seats_reserved_for(event)) ≤ capacity(event)`, kind: `compensatable`.

Reconcile (per-event, per-HLC batch):

1. Collect all reservation transactions for the event across concurrent partitions, HLC-sorted.
2. Admit the first N up to capacity.
3. For losing reservations, emit a compensating transaction that cancels the reservation and notifies the user (`effectGate: 'on-stable'`).

Determinism falls out of HLC ordering. Different reconcile policies are legitimate — first-HLC, priority-by-user-tier, lottery keyed to a deterministic hash of tx IDs. The application picks; the system enforces.

### Example 3: Collaborative text editing

Invariant: none explicit; every transaction is an RGA/text-CRDT operation that is structurally conflict-free.

No reconcile needed — this is the I-confluent case. Transactions merge. Most chat, note-taking, and collaborative-editing workloads fall here, which is why CRDT sync is already a good fit for them without any reconcile machinery.

### Example 4: Unique handle

Invariant: `unique(handle) for user`, kind: `compensatable` (or `reservation-required` if uniqueness is legally significant).

Two users claim `@alice` in separate partitions. On merge, invariant violated.

Reconcile: earlier HLC keeps `@alice`; later HLC is rewritten to `@alice2`. Both users get notifications explaining the conflict. The reconcile is deterministic (HLC total-order), convergent (the compensating tx doesn't itself create a handle collision), and application-sensible.

Alternatively the app chooses `flag-for-review`: the compensating tx puts both users in a `handle-conflict` state and surfaces the conflict in the UI. Determinism still holds — the reconcile output is deterministic: "both users are in conflict state." The human resolution is a later transaction signed by a reviewer.

### Example 5 (exercise for the reader)

Toy bank with three invariants on the same account:
* (a) `balance ≥ 0`
* (b) audit log immutable (append-only)
* (c) notifications sent on every withdrawal

Initial balance $100. Alice withdraws $80 in partition A, Bob withdraws $50 in partition B. Merge.

Write out the resulting state under three reconcile regimes: (i) no reconcile; (ii) reconcile-reverse-later-HLC; (iii) reconcile-proportional-reduction. For invariant (c), decide when notifications fire under each regime.

The exercise tends to surface a useful finding: the *right* reconcile differs per invariant within the same transaction. Invariant (b) (append-only audit log) is I-confluent — no reconcile. Invariant (a) (balance) wants compensation or escrow. Invariant (c) (notifications) needs an outbox with `effectGate: 'on-stable'` so that compensated-away withdrawals don't emit user-facing notifications. This reinforces a design principle: *reconcile is per-invariant, not per-transaction.*

## How Optimystic Surfaces This

The current collection API already has a `filterConflict` hook (referenced in [architecture.md](architecture.md) and [internals.md](internals.md)) for merging concurrent updates. This is the natural surface for the reconcile primitive. The evolution:

* **Today.** `filterConflict(mine, theirs) → resolved`. Pairwise, ad-hoc, runs at client retry time. Lives in application code that every replica must have.
* **Target.** Full `InvariantSpec` plus `ReconcileSpec` declarations on the collection handler. Evaluated during replay, not only on client retry. Part of the signed transaction (or of the collection schema, which is schema-hashed) so every replaying node applies the same rule.

Engine integration:

* **ActionsEngine.** JSON-encoded invariant predicates and reconcile actions. Small pure functions over JSON state. Straightforward.
* **QuereusEngine.** SQL `CHECK` constraints as invariants — already declarative and deterministic. Reconcile as a parameterized SQL procedure receiving `:this_tx`, `:concurrent_txs`, `:merged_state`, `:violated_invariants` as parameters and emitting compensating SQL. The determinism guards already in place (no `RANDOM()`, no `now()`) carry over.

Application-facing API shape:

```typescript
collection.declareInvariant({
  id: 'balance-non-negative',
  scope: [accountBlockId],
  predicate: (state) => state.balance >= 0,
  kind: 'compensatable',
  priority: 0,
});

collection.declareReconcile({
  for: 'balance-non-negative',
  engineId: 'quereus@0.5.3',
  statements: [ /* deterministic SQL */ ],
  effectGate: 'on-stable',
});
```

The declarations live with the schema; their hash is part of the schema hash; replay requires every validator to have the same declarations — [correctness.md](correctness.md) §Theorem 4 continues to hold with reconcile folded into the schema-hash domain.

## Audit Trail and Observability

Every reconcile execution produces a new CRDT transaction. These transactions are first-class in the log, signed by the peer that produced them, with a content hash that any node can verify. Consequences:

* **Auditability.** "Why did this account balance change?" — the log shows the original transaction, the concurrent transactions, and the reconcile tx, all signed and timestamped. No separate compensation journal is needed.
* **Replayability.** The full history can be re-replayed from any checkpoint, producing the same state and the same reconcile events.
* **Metrics.** The rate of reconcile events is a health signal. Zero reconciles means no partition activity. High reconcile rate during a merge reflects real concurrent work; high rate during steady state suggests a misconfigured invariant or a partition not being detected.
* **Debugging.** A user who says "my transaction succeeded and then was reversed" can be shown the exact chain: their tx, the concurrent tx that conflicted, the invariant that was violated, the reconcile that compensated, and the notification that fired.

This is a significant improvement over systems where compensation logic lives in ad-hoc application code — here it is visible in the protocol layer, auditable without privileged access to application internals.

## Relation to Current Partition Handling

Today's Optimystic has two partition-relevant mechanisms:

1. **Super-majority commit** ([correctness.md](correctness.md) §Theorem 2) — during partition, the minority cannot reach 75% and cannot commit. Safety through unavailability.
2. **Self-coordination guard and partition detector** ([internals.md](internals.md)) — a node that observes rapid churn or >50% network shrinkage blocks its own writes. Belt-and-suspenders.

These remain relevant under CRDT sync with partition healing, but their scope narrows:

* For invariants declared `reservation-required`, the super-majority commit still gates reservation. Partition → minority cannot reserve → minority cannot execute these operations. Same semantic as today, now opt-in per invariant.
* The partition detector continues to flag partitions, but its consequence shifts. Rather than blocking all writes, it raises the stability threshold for pending transactions, holds `on-stable` effects longer, and surfaces a "degraded consistency" indicator to the application so UIs can show "partitioned — changes will reconcile on reconnect" rather than silently failing.
* For invariants declared `compensatable`, a partition is no longer a fatal event — it is a period during which reconcile will have work to do when partitions heal. The protocol tracks and reports this; applications can instrument it.

## Dependency on the Underlying Transaction Model

A natural question once the design is on the table: how much of this framework depends on [crdt-sync.md](crdt-sync.md)? **Moderately, not deeply.** Most of the design transfers to any system that produces divergent histories and merges them deterministically — CRDT sync is one such system, probably the cleanest, but not the only one. A meaningful subset also applies to today's strict-CP Optimystic without any evolution.

This section maps the design onto two concrete implementation points — today's system and the CRDT-sync evolution — so it is clear what lands where.

### What the Design Actually Requires

Stripped to essentials, three properties of the substrate:

1. **Local progress under concurrent or partitioned execution.** Without this, reconcile never fires — there is nothing diverged to reconcile. Today's strict-CP Optimystic fails this precondition during partitions but satisfies a weaker form under concurrent-but-connected execution (the race-resolution path).
2. **Deterministic re-execution over an ordered log.** So every node's reconcile produces identical output. Any deterministic total order works; HLC is one choice.
3. **Append-only, content-addressed record.** So reconcile output is just another transaction through the same pipeline; audit trail is automatic.

Any substrate with all three can host the full design. CRDT sync does. Event sourcing with a deterministic reducer does. Calvin-style deterministic ordering does. Smart-contract chains do. Today's strict-CP system provides #2 and #3 but not the partition-time form of #1 — so a subset applies.

### Cleanly Separable From CRDT Sync

These concepts stand on their own regardless of consistency model:

| Concept | Why it is independent |
|---------|----------------------|
| Declarative invariants (`InvariantSpec`) | Richer schema; SQL `CHECK` is the degenerate case. Useful under any consistency. |
| Escrow / reservation primitive | Uses *strong consensus* — the opposite of CRDT. Layers directly onto today's log-tail machinery. |
| I-confluence classification | Analytical framework for reasoning about invariants. No runtime dependency. |
| Three-kind taxonomy (`compensatable` / `reservation-required` / `externally-visible`) | Vocabulary for invariants. Transports anywhere. |
| Conservative-vs-aggressive cascading compensation | A pattern that applies wherever compensation exists — sagas, workflows, distributed transactions. |
| Flag-for-review, audit trail, effect gating | Workflow and observability concepts. Independent of sync mechanism. |

### Actually Coupled to CRDT Sync

These lean on specific properties of the evolution:

| Concept | Why it is coupled |
|---------|-------------------|
| HLC as the deterministic total order | Generalizes to any deterministic total order, but the specific "per-tx HLC drives reconcile input ordering" shape is CRDT-sync-native. |
| Reconcile output is *just another transaction* | Works because CRDT sync treats every transaction uniformly. In a stricter system, reconcile output may need a distinct pipeline or privilege level. |
| Watermark stability horizons driving `effectGate` | One specific "settled enough to act on" mechanism. Stricter systems have simpler settledness (committed = settled) but less nuance around tentative effects. |
| Merge-time reconciliation itself | Requires divergent histories to exist, which requires local progress, which requires AP semantics somewhere in the stack. |

### Subset That Lands on Today's Strict-CP Optimystic

Without the CRDT-sync evolution, a meaningful portion of the design still applies — it simply runs at a different point in the transaction lifecycle. Specifically:

1. **Declarative invariants on collections.** Extend collection schemas to carry `InvariantSpec` with deterministic predicates. Validators enforce invariants during PEND as a natural extension of `CHECK` constraints. Invariants become part of the schema hash, inheriting the deterministic-replay property from [correctness.md](correctness.md) §Theorem 4.
2. **Declarative resolution rules at race-resolution time.** Today's `resolveRace()` deterministically selects a winner between conflicting transactions ([correctness.md](correctness.md) §Theorem 1). Upgrade this path from the hardcoded "most promises, then highest hash" rule to an application-supplied deterministic rule per collection, keyed on the same `ReconcileSpec` shape — but running at conflict-detection time rather than at merge time. The losing transaction's compensating action is appended to the log; effects are gated through the same `on-stable` / `on-reviewed` mechanism, where "stable" means "checkpointed."
3. **Escrow / reservation primitive.** Add as an independent feature for high-stakes operations, independent of any CRDT work. This *uses* today's strong-consensus machinery; it does not need CRDT sync at all. Declaring an invariant as `reservation-required` compiles to a reservation acquisition at BEGIN and a consumption step in the transaction body.
4. **Structured audit trail of resolution events.** Whenever `resolveRace()` picks a winner, log the losing transaction, the resolving rule, and the outcome as a first-class record in the collection log. This is a small change with large observability payoff and does not require CRDT sync.
5. **Effect gating via client-side outbox.** `on-stable` gating can be emulated by a client-side outbox that holds emitted effects until the transaction is checkpointed (today's stability signal). Not as uniform as the CRDT-sync version (which treats the outbox as replay-driven), but functional for the common cases.

Taken together, these items already constitute a substantial upgrade to today's conflict-handling model. They subsume the *structural* benefits of partition healing — declarative rules, audit, classification, escrow — without changing consistency semantics.

### What Requires CRDT Sync (or an Equivalent AP Substrate)

These are the specifically divergence-dependent parts:

- **Partition-time local progress on `compensatable` invariants.** The minority partition is blocked on any invariant that touches a log-tail cluster. No amount of declarative machinery changes this under strict CP.
- **Merge-and-reconcile behavior.** Divergent histories do not exist under strict CP; there is nothing to merge. Reconcile collapses to "pick one at race-resolution time" rather than "merge concurrent histories from both partitions."
- **Asynchronous reconcile as a signed, timestamped transaction at merge time.** The strict system's resolution is synchronous at PEND/COMMIT. Asynchronous merge-time reconcile requires deferred execution, which requires divergent histories.
- **Nuanced effect gating beyond committed-vs-uncommitted.** The tentative → propagated → stable tri-state depends on replay-driven visibility. Strict systems have only committed-vs-not; effect gating is correspondingly simpler (and less expressive).

### The Reframing

The dependency is not really on CRDT as a formalism. It is on a prior question:

> *Are you willing to let divergent histories exist, and commit to deterministic merge rules?*

- **Yes, broadly** → CRDT sync, event-sourced reducers, Calvin-style deterministic ordering, smart-contract chains, or any other AP-with-determinism substrate. The full design applies.
- **No** → items 1–5 above still apply, landing at race-resolution time rather than merge time. Partition-time local progress does not.
- **Per-invariant** (the recommended stance) → declare each invariant's disposition individually. CRDT-sync collections host `compensatable` invariants with merge-time reconcile; strict-mode collections or `reservation-required` invariants continue to use today's CP machinery. Both coexist in the same network.

The per-invariant stance is the honest one. It also makes both documents actionable: [crdt-sync.md](crdt-sync.md) describes the substrate for invariants that prefer availability-with-reconcile; this document describes what those reconcile rules look like; today's strict system continues to serve invariants that cannot tolerate divergence at all.

### Implementation Sequencing

This separability has a practical consequence: **the two evolutions can proceed independently.** A reasonable order:

1. **First**: land items 1–5 above on today's strict-CP system. Low-risk, high-value, useful immediately. This delivers declarative invariants, declarative resolution, escrow, and structured audit — all with today's consistency guarantees intact.
2. **Second**: land the CRDT-sync substrate ([crdt-sync.md](crdt-sync.md) migration path) as an opt-in per-collection mode. Strict-mode collections keep working; replay-mode collections gain partition-time availability.
3. **Third**: extend the invariant and reconcile machinery to trigger at merge time for replay-mode collections. The `ReconcileSpec` authored for race-resolution-time in step 1 is the same shape used for merge-time in step 3; most application rules transfer directly.

This means application authors can write invariant and reconcile declarations today against the current system, and those declarations become merge-time reconciles automatically when a collection is later migrated to replay mode — without application code changes.

## Operational Concerns

**Reconcile resource budget.** A malicious client could craft transactions with expensive reconcile rules. Mitigation: reconcile is part of the signed transaction, so its cost is billed to the issuer (reputation, rate limits). Engines enforce a per-reconcile work budget; exceeding it is a validation failure comparable to a non-deterministic SQL function.

**Flag-for-review queue.** When reconcile emits a `flag-for-review` transaction, it lands in a well-known `__review_queue` collection. Operators (or automated policy) act on items in the queue. Until action, affected entities are in a visible `conflict` state. This is not purely deterministic — a human decision is non-deterministic input — but it is *explicit*. The state transition out of `conflict` is a deterministic transaction authored and signed by the reviewer.

**Partition detection precision.** Current detector thresholds (5 peer departures in 10 seconds; 50% shrinkage) are heuristics. They continue to be heuristics under CRDT sync — false positives cost a small stability-latency penalty; false negatives mean a partition isn't flagged but CRDT sync handles it regardless. The stakes shift from safety to operator visibility.

**Conflict visualization.** During active reconciliation, applications benefit from a view of pending conflicts, in-flight compensations, and items flagged for review. Expose the internal state via a `__reconciliation_status` collection; let UI layers consume it.

**Testing.** Reconcile correctness is application-authored and application-consequential. A "simulate partition and merge" test harness is likely the first tool to build alongside this feature: construct two transaction streams, merge them, assert the reconciled state satisfies every invariant and matches expectations. Property-based testing (random partition splits + random concurrent transactions + assertion that invariants hold post-merge) is a natural follow-on.

## Design Discipline for Reconcile Authors

Writing a correct reconcile is harder than writing a good `CHECK` constraint. Some discipline helps:

1. **Start with the invariant classification.** Consult the I-confluence table. If the invariant is I-confluent, you don't need a reconcile. If it isn't, decide whether you need reservation or compensation.
2. **Enumerate concurrent scenarios.** For a given invariant, list the ways it could be violated by concurrent transactions. Write the reconcile to handle each explicitly.
3. **Prove convergence locally.** Show that your reconcile's output transaction cannot itself violate the same invariant, or bound the recursion depth.
4. **Choose the effect gate conservatively.** Default to `on-stable`. Promote to `on-hlc` only when the external system handles inverses gracefully. Use `on-reviewed` when in doubt about safety.
5. **Write the notification explicitly.** If users see the pre-compensation state, they will see the post-compensation state as a "change." Plan the notification as part of the reconcile, not as an afterthought.

The engine can help by providing:

* A "simulate merge" harness that runs reconcile against synthesized concurrent sets.
* A linter that flags reconciles returning transactions that don't satisfy the invariants they are meant to enforce.
* A replay-equivalence checker across nodes to detect determinism violations in reconcile code.

## Open Design Questions

* **Reconcile composition order.** When multiple invariants on the same transaction violate simultaneously, reconcile runs in `priority` order. Each subsequent reconcile sees the effects of prior reconciles. This needs formalization — in particular, whether priority alone is sufficient or whether a fixpoint iteration is needed.
* **Aggressive-mode convergence bounds.** Recursive compensation can in theory compose into long cascades. A formal bound is likely `cascade_depth ≤ transitive_write_dependency_depth(reconciled_tx)`, with a budget cap per merge event to prevent denial-of-service via crafted dependency chains.
* **Reservation interaction with CRDT sync.** Reservations use strong-consensus log-tail ordering; the transaction consuming the reservation is CRDT-sync. What happens if the reservation is acquired but the consuming tx is preempted by a concurrent tx with lower HLC? Proposal: the reservation names the intended transaction ID; only that tx can consume it. Needs design.
* **Cross-collection reconcile.** A reconcile for invariant on collection A may need to emit a compensating tx touching collection B. Under CRDT sync, the reconcile's output transaction naturally spans collections via shared HLC. Preliminary analysis suggests this does not open new convergence failure modes, but warrants formalization alongside [correctness.md](correctness.md) §Theorem 3 (Atomicity).
* **Human review integration.** `flag-for-review` is well-defined in the protocol, but the UI surface is application-level. A standardized review-queue schema and a reference UI in reference-peer would lower the adoption cost.
* **Economic incentives for reconcile authors.** Good reconcile rules are a nontrivial authoring burden. Beyond tooling, there is a question of whether the system should provide a library of *standard* reconciles (reverse-later-HLC, proportional-reduction, first-wins, flag-for-review) that the application picks from rather than authoring from scratch for common patterns.
* **Reconcile under Byzantine conditions.** A Byzantine node could in principle produce a reconcile-emitted transaction whose content disagrees with honest nodes' replays. Because reconcile is deterministic and inputs are fixed, any disagreement is detectable at cross-peer state-hash comparison — this falls under [right-is-right.md](right-is-right.md)'s replay-divergence dispute path. Worth a dedicated case analysis.

## See Also

* [crdt-sync.md](crdt-sync.md) — the CRDT evolution this document builds on.
* [correctness.md](correctness.md) — today's partition safety guarantees (§Theorem 2, §6.1) and the formal properties this model preserves or relaxes.
* [internals.md](internals.md) — current partition detector and self-coordination guard.
* [right-is-right.md](right-is-right.md) — Byzantine dispute mechanism; reconcile disagreements extend the "replay divergence" dispute path.
* [transactions.md](transactions.md) — baseline transaction model against which this proposal is an evolution.
