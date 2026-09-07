description: Let an application that knows how many machines are in a user's group tighten the block-repair safety check as the group grows, without also raising the bar for writes; and write down that a group which grows or shrinks applies the new number by restarting its node, not through a live reconfiguration API.
files: packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/src/cluster/quorum-restore.ts (doc only), packages/db-p2p/src/repo/coordinator-repo.ts (advisory text only), packages/db-p2p/src/libp2p-node-base.ts (comment only), packages/reference-peer/src/cli.ts, packages/db-p2p/docs/cluster.md, docs/optimystic.md, docs/internals.md, docs/architecture.md
difficulty: medium
----

# Declare the repair yardstick on its own; apply a changed size by rebuilding the node

## What this changes, in one paragraph

`clusterPolicy.assumedClusterSize` is one operator field that sets two different safety
yardsticks — the membership admission gate's low-confidence write floor, and the block-repair
corroboration floor. A deployment that wants the *strict* one raised (so a shrunken, unauthenticated
view of the network cannot talk block repair down to trusting one peer) currently has to raise the
*permissive* one too, which can refuse writes it needs. This ticket adds a second operator field that
moves only the repair yardstick, leaving admission alone. It also records — in a code `NOTE:` and in
the docs — the already-true fact that these numbers are resolved once at node construction, so a
group whose machine count changes applies the new number by building a new node, not through any
runtime setter. **No runtime setter is added. That decision is settled; do not reopen it.**

## Verified state of the code (re-checked at HEAD; two claims in the plan ticket were wrong)

- `resolveClusterPolicy` (`packages/db-p2p/src/cluster/cluster-policy.ts:~140`) runs exactly once, at
  `libp2p-node-base.ts:518`. Its outputs are captured as `private readonly` fields on
  `ClusterMember` (`cluster/cluster-repo.ts:333,366`) and `CoordinatorRepo`
  (`repo/coordinator-repo.ts:606,670`), and passed as a plain number into `createReconcileBlock`
  (`libp2p-node-base.ts:851` → `cluster/reconcile-block.ts:89`). There is no setter.
- **Correction to the plan ticket:** `assertClusterSizeCoupling`
  (`cluster/cluster-size-coupling.ts`) checks `clusterSize` only — the replication factor — and never
  reads either size *yardstick*. It is **not** a consumer of this change and needs no edit.
- **Correction to the plan ticket:** `CoordinatorRepoConfig` **already** carries an independent
  `repairCorroborationClusterSize?: number` (`repo/coordinator-repo.ts:503`), resolved at
  `coordinator-repo.ts:670-671` as
  `cfg?.repairCorroborationClusterSize ?? policy.assumedClusterSize ?? policy.clusterSize`.
  So the seam already exists one layer down; what is missing is the **operator-facing** field on
  `ClusterPolicyOptions` that feeds it. This ticket adds exactly that, and the resolution order below
  is deliberately the same shape, so the two layers read identically.
- The downstream consumer (Sereus, `../sereus/packages/quereus-plugin-sereus/src/cluster-size.ts`)
  declares `assumedClusterSize: 2` in **both** `CONTROL_CLUSTER_POLICY` (line 109) and
  `STRAND_CLUSTER_POLICY` (line 224), for every group size, because raising the shared field would
  also raise the write floor. Its own comment (lines 47-53) says so: *"asserting 16 there would make
  the admission gate demand ceil(0.75 x 16) = 12 declared peers and refuse every real party's
  writes."* This is the gap the new field closes.

## Arm 1 — the new operator field

### Name

`repairCorroborationClusterSize`, on `ClusterPolicyOptions['clusterPolicy']`. Same name as the
resolved field (`ResolvedClusterPolicy.repairCorroborationClusterSize`) and as the already-existing
`CoordinatorRepoConfig.repairCorroborationClusterSize`. Three names for one concept would be worse
than a long one.

### Resolution order

```ts
// A declared value that is not a positive finite integer is treated as NOT DECLARED and falls
// through, rather than poisoning the floor. Then the result is floored at minAbsoluteClusterSize.
repairCorroborationClusterSize =
    max(minAbsoluteClusterSize,
        declaredRepairSize ?? declaredCohortSize ?? clusterSize)

// Unchanged — pass-through exactly as today.
assumedClusterSize (admission gate) = options.clusterPolicy?.assumedClusterSize ?? minAbsoluteClusterSize
```

where `declaredRepairSize` and `declaredCohortSize` are the two operator fields after the
positive-finite-integer check.

Three properties this must have, and each is a spec:

- `assumedClusterSize` alone behaves **exactly** as today (sets both yardsticks). Every existing spec
  in `test/cluster-policy.spec.ts` stays green with no edit.
- The new field **never** touches `assumedClusterSize` (the admission/write floor) or `clusterSize`
  (the replication factor).
- The new field **wins** over `assumedClusterSize` for the repair yardstick when both are declared.

### Why degenerate values fall through rather than clamping to 2

The existing `NOTE:` at the top of `resolveClusterPolicy` says to clamp at this site "if another
composition root starts accepting unvalidated config" — a host deriving the count from its own
membership records is exactly that. But **clamping a degenerate value to `minAbsoluteClusterSize` (2)
would be the unsafe direction**: 2 is the one size whose corroboration floor *relaxes* to a single
voter, so `NaN` (today: every quorum comparison false, repair declines forever — dead but safe) would
become "trust one peer". Falling through to the next term instead treats a nonsense declaration as no
declaration, which lands on the strict `clusterSize` default. The trailing
`max(minAbsoluteClusterSize, …)` then only guards a `clusterSize` of 0 or 1, and is behaviourally a
no-op for every sane input — verify that when writing the specs rather than assuming it.

Replace the existing `NOTE:` paragraph with one that states the new rule (fall through, then floor)
and why 2 was rejected as the clamp target. Note that the admission-gate value stays an unvalidated
pass-through on purpose: `cluster-repo.admissionFloor` already floors a degenerate one itself, and
changing that here would alter a documented behaviour with no bug behind it.

### The `repair-fault-tolerance` startup advisory

- `cohortUndeclared` must require **both** operator fields absent (today: `declaredCohortSize ===
  undefined && clusterSize > minAbsoluteClusterSize`). Declaring only the new field is a declaration
  — the advisory's `undeclaredAdvice` text tells the reader to set `assumedClusterSize`, which is
  wrong advice for someone who has already declared the repair yardstick directly.
- Add `declaredRepairSize` to the structured log payload beside the existing `declaredCohortSize`, so
  a reader can tell which field produced the resolved number.
- `undeclaredAdvice`'s wording should name **both** fields as ways out, and say which one also raises
  the write floor.
- `noRepairMargin` is unchanged — it reads the resolved value and does not care where it came from.

### Reference-peer CLI

Add `--repair-corroboration-cluster-size`, mirroring `--assumed-cluster-size` exactly:
a `parseRepairCorroborationClusterSize` beside `parseAssumedClusterSize`
(`packages/reference-peer/src/cli.ts:70-78`), the option string in the command definition, and the
field in the options interface at `cli.ts:~214`. Same "must be a positive integer" rejection. The CLI
flags are untestable today (`tickets/backlog/debt-reference-peer-cli-flags-untestable`); do not try to
fix that here, and do not skip the flag because of it — a knob that exists in the TypeScript options
but not in the reference peer is a documentation asymmetry.

## Arm 2 — the rebuild contract, recorded

### The decision

**A host that learns a new group size tears down its node and builds a new one with the new number.**
Reasons, so a future reader does not re-litigate:

- The only party allowed to change the number is the host process that constructed the node, on the
  strength of its own authenticated membership records. A construction-time argument enforces that
  boundary for free — there is no surface a remote instruction could reach. A setter would have to
  rebuild that boundary and defend it against every later refactor.
- All four consumers hold the number as an immutable snapshot by design. A live change either turns
  them into readers of a shared mutable cell (a new class of "which value did this pass see?" bugs)
  or reconstructs those four objects — a restart wearing a different name.
- In-flight work (a pend awaiting approval, a repair mid-consult, an armed read-repair window) is
  aborted and retried under a rebuild, which the system already handles for every crash. Under
  mutation each needs a "started under N, finishing under N+1" rule.
- Rebuilds are already routine downstream: Sereus rebuilds every strand's libp2p node on each wake
  from hibernation, and already re-resolves one volatile input at resume.
- The direction that matters is raise-only, and a group that has not yet applied a higher number is
  running at exactly the value it runs at today — so applying at the *next* rebuild costs nothing.

### The `NOTE:` (accepted tradeoff)

At `resolveClusterPolicy`, in the accepted-tradeoff form:

> `NOTE: accepted tradeoff — resolved once, at node construction; there is deliberately no runtime
> mutation of either size yardstick. A host that learns a new machine count applies it by building a
> new node (which every embedder already does on restart and on wake from hibernation), not through a
> setter: a construction-time argument is what keeps the number un-reachable from the network, and
> every consumer holds it as an immutable snapshot. Weighed against a live-reconfiguration API and
> kept. Revisit only if a deployment appears where a rebuild is measurably disruptive — for example a
> server-profile node holding thousands of blocks whose post-rebuild cohort-consult burst shows up in
> profiles.`

### What a rebuild costs (state this in `docs/optimystic.md`, in operator terms)

- **Survives:** every block, every persisted commit proof, executed-transaction markers, and
  in-flight coordinator/participant state *if* the host wired `transactionStateStore`
  (`ClusterMember.recoverTransactions` / `CoordinatorRepo.recoverTransactions`). A host that wires
  none loses in-flight transactions — which is already its behaviour on every crash.
- **Resets (all in the safe direction):** the read-repair freshness window (`lastSeenCommitMs`),
  recorded doubt (`unsettledAheadClaims`), the responsibility cache, and the rebalance monitor's
  responsibility snapshot. The first read of each held block after a rebuild consults the cohort, so
  doubt is rediscovered rather than lost; the first rebalance check re-pushes to the whole non-self
  cohort.
- **Peers' view:** a pend this node coordinated is abandoned; refused pends drop immediately and live
  ones age out on the staleness window, so a vanished coordinator does not wedge a block.

### Which numbers move together — say this once, in `packages/db-p2p/docs/cluster.md`

- `clusterSize` (replication factor / target breadth) is **network-wide**: every node must agree,
  because the admission gate's confident path compares a coordinator's declared set against the
  member's own derived width. Changing it is a coordinated rollout of every node — out of scope, and
  for growth from one machine up to `clusterSize` it need not change at all.
- The **repair yardstick** is per-node and safe for nodes to disagree on (each protects only its own
  reads). It should track the enrolled machine count. A value above `clusterSize` is harmless.
- The **admission yardstick** is per-node, but disagreement costs write availability. Its honest value
  trades write availability under low confidence for defence against a partition-induced downsize.
  This ticket gives the host the choice; it does not make it.

### Doc edits, by file

- `packages/db-p2p/docs/cluster.md` — the two qualifications block at lines ~913-928. The first
  qualification, *"The largest consumer cannot pass it yet — Sereus's `CadreNode` hardcodes
  `clusterSize: 3` and builds its `clusterPolicy` inline without exposing `assumedClusterSize`"*, is
  **false at HEAD** (see Verified state above) and must be replaced with the accurate statement: the
  consumer declares `assumedClusterSize: 2` at every group size because raising the shared field
  would also raise the write floor — which is the gap the new field closes. Also document the new
  field in *"The two defaults differ on purpose"* (lines ~885-896), and add the
  which-numbers-move-together paragraph above. The `ClusterConsensusConfig` code block at line ~850 is
  a *different* interface — the new field is on `ClusterPolicyOptions`, so do not add it there;
  document it in the prose instead.
- `docs/optimystic.md` — *Deployment Sizes* → *"Who declares it"* (lines ~286-296): name the repair
  yardstick as the one the membership count should feed, that it is applied by rebuilding the node,
  and the restart contract in operator terms.
- `docs/internals.md` — the paragraph under the size table (lines ~776-781 and ~813-816) repeats the
  `assumedClusterSize`-only story; one sentence each naming the new field and the rebuild path.
- `docs/architecture.md` — *Supported deployment sizes* (line ~238): one sentence.

### Stale in-code prose to fix while you are here

- `packages/db-p2p/src/cluster/quorum-restore.ts:118-121` — *"The escape hatch … is one explicit
  operator declaration — `clusterPolicy.assumedClusterSize: 2` … or an honest `clusterSize: 2`"*.
  Add the third option.
- `packages/db-p2p/src/repo/coordinator-repo.ts:~230` — the `cohortTooSmallMessage` text says *"set
  clusterPolicy.assumedClusterSize"*. Name the new field too, and which of the two also moves the
  write floor.
- `packages/db-p2p/src/libp2p-node-base.ts:510-513` — the comment says *"the one operator field
  (`clusterPolicy.assumedClusterSize`)"*. There are two now.
- `packages/db-p2p/src/cluster/cluster-policy.ts` module doc — the *"Why two size yardsticks, not
  one"* section says *"A single explicit `clusterPolicy.assumedClusterSize` still sets BOTH"*. Still
  true, but now it is the *fallback*, not the only path. Update, and delete the sentence claiming
  the repair yardstick "is not declarable" if any such wording remains.
- `packages/db-p2p/src/cluster/cluster-policy.ts` — `ClusterPolicyOptions.clusterSize`'s own doc
  comment says the repair floor "DOES fall back to it when `clusterPolicy.assumedClusterSize` is
  absent". Add the new field to that chain.

## Edge cases & interactions

Each of these is a spec in `packages/db-p2p/test/cluster-policy.spec.ts` unless noted.

- **New field alone.** Moves `repairCorroborationClusterSize` only; `assumedClusterSize` stays at
  `minAbsoluteClusterSize` (2) and `clusterSize` stays at its default. This is the Sereus shape and
  the whole point of the ticket.
- **Both fields declared.** New field wins for repair; `assumedClusterSize` still sets admission.
- **`assumedClusterSize` alone.** Unchanged — sets both. Existing spec `an explicit
  assumedClusterSize sets BOTH` must pass untouched.
- **Neither declared.** Unchanged: admission 2, repair `clusterSize`.
- **New field declared below 2**, or below the visible cohort: floored at `minAbsoluteClusterSize`,
  and `corroboratorCapacity` still takes the `max` against peers actually visible — so the relaxed
  single-voter branch stays reachable only by a group that is genuinely that small. A stale-low
  declaration is never *worse* than the permanent 2 the downstream consumer runs today.
- **New field declared above `clusterSize`.** Allowed, not rejected. The floor is already capped at
  `CORROBORATION_FLOOR`, so the extra only makes the advisory's "undeclared" arm irrelevant. Document
  it; add a spec asserting it is accepted and does not touch `clusterSize`.
- **Degenerate declared values** — `0`, negative, `NaN`, `Infinity`, non-integer — for **each** of
  the two fields independently: falls through to the next term, never poisons the floor, never lands
  on the relaxed 2. Assert the resolved number explicitly, not just "not NaN".
- **Advisory silence when only the new field is declared** at a size with margin (e.g. 5): no
  `repair-fault-tolerance` line at all. Use `captureLog`/`hasTag` from `test/support/capture-log.js`,
  as the existing advisory specs do.
- **Advisory still fires when the new field declares a size with no margin** (2 or 3), with the
  `noRepairMargin` arm but *not* the `undeclaredAdvice` arm.
- **Log payload** carries `declaredRepairSize` alongside `declaredCohortSize`, so the source of the
  resolved number is legible.
- **A node rebuilt with a *lower* repair value mid-episode of a `cohort-too-small` deadlock.** The
  once-per-episode suppression lives in `unsettledAheadClaims`, which the rebuild resets, so the
  deadlock is re-reported once if it still holds. Correct behaviour — worth one line in the docs'
  restart contract; a spec here only if it can be written without booting a node.
- **`CoordinatorRepo` direct-construction path.** `cfg.repairCorroborationClusterSize` already exists
  and already wins over `assumedClusterSize`; the new `ClusterPolicyOptions` field must resolve into
  it via `libp2p-node-base.ts:851` unchanged. Confirm the two orders agree — a real node and a
  hand-wired `coordinatorRepo(...)` given the same numbers must land on the same yardstick.
- **Mesh harness** (`src/testing/mesh-harness.ts:348,451`) passes `clusterPolicy` through verbatim, so
  a mesh can now declare the two yardsticks apart. No change required; re-read the comment at line 451
  and correct it if the new field makes it stale.
- **`assertClusterSizeCoupling` is not involved** (it checks `clusterSize` only). Do not add the
  repair yardstick to it — the whole point is that nodes may legitimately disagree on that number.

## Out of scope

- Any runtime setter on `ClusterMember`, `CoordinatorRepo`, or `NodeOptions`. Settled above.
- Deriving any yardstick from network observation — that is
  `tickets/backlog/feat-admission-floor-from-observed-cohort-high-water-mark`, which is explicitly
  not-yet-buildable and already cross-references this ticket. If it ever lands, an observed value
  slots in as a term in the same resolution chain; do not build toward it here.
- Making `clusterSize` changeable without a coordinated restart of every node on the network.
- The Sereus-side derivation, which is that repo's ticket and depends on this one shipping.

## TODO

- Add `repairCorroborationClusterSize?: number` to `ClusterPolicyOptions['clusterPolicy']` with a doc
  comment stating what it sets, what it deliberately does *not* set (the write floor), and that it is
  applied at node construction only.
- Implement the resolution order in `resolveClusterPolicy`: positive-finite-integer check on both
  declared fields, fall-through chain, trailing `max(minAbsoluteClusterSize, …)`.
- Replace the existing unvalidated-config `NOTE:` with one describing the fall-through rule and why
  clamping to 2 was rejected.
- Add the accepted-tradeoff `NOTE:` recording rebuild-not-mutate, with its revisit condition.
- Update the advisory: `cohortUndeclared` requires both fields absent; add `declaredRepairSize` to
  the log payload; reword `undeclaredAdvice` to name both fields and which one moves the write floor.
- Update the `cluster-policy.ts` module doc and the `clusterSize` field doc for the two-field story.
- Fix the stale in-code prose listed above in `quorum-restore.ts`, `coordinator-repo.ts`,
  `libp2p-node-base.ts`.
- Add `--repair-corroboration-cluster-size` to `packages/reference-peer/src/cli.ts`, mirroring
  `--assumed-cluster-size`.
- Add the specs from *Edge cases & interactions* to `packages/db-p2p/test/cluster-policy.spec.ts`,
  without editing any existing spec.
- Rewrite the false Sereus qualification in `packages/db-p2p/docs/cluster.md`; document the new field
  and the which-numbers-move-together paragraph there.
- Add the restart contract and the "declare the repair yardstick" guidance to `docs/optimystic.md`;
  one-sentence corrections in `docs/internals.md` and `docs/architecture.md`.
- Build and test: `yarn workspace @optimystic/db-p2p build` and the db-p2p test suite; confirm every
  pre-existing `cluster-policy.spec.ts` case passes unmodified.
