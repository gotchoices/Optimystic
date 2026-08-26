----
description: A machine copies its data to others when it loses responsibility for it, but never when new machines simply join and become co-responsible — so anything written while a deployment was one machine keeps exactly one copy forever, and no later machine can ever read it. Make a machine push copies of what it holds to peers that newly share responsibility for it.
prereq:
files: packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts
difficulty: hard
----

<!-- resume-note -->
**Resume note (2026-08-26 run, log
`tickets/.logs/2-replicate-owned-blocks-when-the-cohort-grows.implement.2026-08-26T05-37-43-102Z.log`).**
The prior run was stopped by a BUDGET_WARNING after investigation only — **no code changes were made;
the working tree is untouched by this ticket.** All the design decisions the ticket left open were
settled from reading the code; they are recorded below so the next run can start implementing
immediately instead of re-deriving them.

### Settled: the growth trigger lives in `RebalanceMonitor`, not `spread-on-churn`

Reasons, from the code as it stands:

- `RebalanceMonitor` already listens to **both** `connection:open` and `connection:close`
  (`rebalance-monitor.ts:98-99`); `SpreadOnChurnMonitor` listens only to `connection:close` and its
  whole vocabulary is departure-specific. Cohort growth arrives as `connection:open`.
- `RebalanceMonitor.performRebalanceCheck` already iterates the shared tracked set, assembles the
  per-block cohort **at the floor size** (`assembleCohort(coord, this.getCohortSize())`,
  `rebalance-monitor.ts:197`), and keeps per-block memory (`responsibilitySnapshot`). Extending that
  snapshot is the minimal change; spread-on-churn has no per-block memory at all.
- The monitor's event already flows into `BlockTransferCoordinator.handleRebalanceEvent` via the
  node-base handler (`libp2p-node-base.ts:1134`), so the push path reuses `confirmReplicated` with
  the floor already carried in the event — no new wiring in `libp2p-node-base.ts` is required for the
  event to reach the coordinator (only config passthrough + comment updates, if anything).
- Debounce, `minRebalanceIntervalMs` throttle, and partition suppression come for free.

### Settled: detection design (monitor side)

- Change `responsibilitySnapshot` from `Map<string, boolean>` to
  `Map<string, { responsible: boolean; cohortPeers: Set<string> }>`. `untrackBlock` still deletes
  the entry. Gained/lost logic reads `prior?.responsible ?? false`, unchanged in behavior.
- Add `grown: Map<string, string[]>` to `RebalanceEvent` — blockId → cohort peers newly
  co-responsible (never self). Growth arm runs whenever `isResponsible` (NOT gated on
  `wasResponsible`): `newPeers = cohort - self - (prior?.cohortPeers ?? ∅)`.
- **Treating a missing snapshot entry as "prior cohort = empty" is load-bearing.** First check after
  a topology event pushes to the whole non-self cohort. This is what heals the founder case (A alone
  commits; B joins → first check → push to B; C joins → second check → push to C only) AND the
  restarted-holder case ("stranded until it next runs" residual). Without it, peers that joined
  before the monitor's first check are recorded as already-seen and never pushed to.
- **Bound**: primary bound is free — the cohort is assembled at floor size (≤3), so `newPeers` per
  block is ≤ floor−1, and `confirmReplicated` stops per-block once the floor is met. Secondary bound:
  a per-check `growthBlockBudget` config (default 64). For a block dropped by the budget, **do not
  update its snapshot cohort** — the next check re-detects the same growth (self-healing retry) —
  and count it; emit one `log('growth budget reached: %d blocks deferred...', dropped)` line per
  check, per the ticket's "log what the bound dropped" requirement.
- A block cannot be both `lost` and `grown` (lost ⇒ not responsible ⇒ growth arm skipped). It CAN be
  both `gained` and `grown` (first observation); for a genuinely-just-gained block the push finds no
  local data and `confirmReplicated` logs `confirm:no-local-data` and reports it unconfirmed —
  benign, since those cohort peers are the pull's own source. Say this in the handoff.

### Settled: reaction design (coordinator side)

- Extend `handleRebalanceEvent` to also process `event.grown`, reusing
  `confirmReplicated` per block with a **per-block floor of `min(event.floor, newPeers.length)`**.
  Passing the raw event floor is wrong: with 1 new peer and floor 3, `executeConfirm` can never reach
  the floor and would burn `maxRetries` re-pushing a peer that already accepted. With the min, one
  clean push per new peer, retries only on actual failure. In-flight key `confirm:<id>` dedups
  against the lost-confirm path for free.
- Extend `RebalanceReactionResult` with the growth outcome (e.g. `replicated`/`underReplicated`);
  node-base handler uses it only for logging — `released` gating is untouched.
- `enablePush` does not gate this path (same rationale as the existing NOTE in
  `confirmReplicated`, `block-transfer.ts:170`); the growth arm is gated by `rebalance.enabled`.
  State that in the handoff.

### Settled: test plan

- Unit: growth detection cases go in `rebalance-monitor.spec.ts` (first-observation seeds whole
  cohort; stable cohort → no `grown`; repeated checks don't re-emit; budget drop defers + re-detects;
  partition suppresses; lost∩grown impossible). Reaction hop extension in `rebalance-reaction.spec.ts`
  (its `wire()` already mirrors the node-base handler; `MockPeerNetwork.connect` throwing is enough to
  prove the grown push dialed).
- E2E "B reads the founder's block": `src/testing/mesh-harness.ts` is unsuitable — it has **no FRET
  and no monitors**. Build a component-level spec instead, combining:
  - the three-peer read harness of `test/coordinator-repo-single-holder.spec.ts` (real StorageRepos,
    real `CoordinatorRepo` + `createReconcileBlock`) for the "B reads and gets content" half, and
  - a real `RebalanceMonitor` + `BlockTransferCoordinator` on A with a MockFret whose cohort is
    mutated to simulate B/C joining (pattern in `rebalance-reaction.spec.ts`), and
  - a **loopback duplex stream** so A's push actually lands in B/C's storage: `ProtocolClient`
    (`protocol-client.ts:144`) writes LP-encoded frames via `stream.send(chunk)` then reads the
    response from the stream's async iterator. The existing mocks are response-only
    (`block-transfer.spec.ts:80`, `spread-on-churn.spec.ts` `createMockStream`) — the loopback must
    capture sent chunks, LP-decode + JSON-parse the `BlockTransferRequest`, feed it to the target
    node's real `BlockTransferService` (`handlePush` driven directly, as
    `block-transfer-push-persist.spec.ts:53` does), and yield the LP-encoded response.
  Assert: before growth, B's read fails exactly as `coordinator-repo-single-holder.spec.ts` pins;
  after the growth event fires and the push persists on B/C, B's read returns the content (two
  holders → the corroboration floor of 2 is met; no read-path change needed).
- Node-wiring: existing `rebalance-monitor-node-wiring.spec.ts` covers assembly; growth rides the
  same wiring, so at most add an assertion there — a separate new node-wiring spec is likely
  unnecessary (revisit once implemented).

### Remaining TODO (unchanged in substance from the list below)

Implement monitor + coordinator changes per above; write the tests per above; `yarn build`, then
`yarn workspace @optimystic/db-p2p test`, `yarn lint` from root; write the review handoff with the
honest residuals: offline-holder-forever case (covered only by
`backlog/debt-read-repair-commit-cert-verification`), checks are topology-event-driven only (a
quiet network after FRET converges late gets no re-check until the next connection event), and the
gained∩grown no-local-data benign push miss.
<!-- /resume-note -->

# Make the second copy, instead of teaching the reader to trust one

From `fix/single-holder-block-is-permanently-unreadable` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). This is the
behavioural fix. Its sibling `name-the-single-holder-deadlock` is the diagnostics half; the two are
independent and may land in either order.

## The defect in one sentence

Block repair requires two cohort peers to agree, a block with one holder can only ever produce one
claim, and both mechanisms that could create a second holder consume that same repair decision — so a
singly-held block stays singly-held and stays unreadable by anyone but its holder, permanently.

Reproduced end-to-end against a real `CoordinatorRepo` + `createReconcileBlock`: with a 3-peer cohort
where one peer holds the block and the other affirmatively answers "I hold nothing", the reader
declines on every pass and never acquires the block — under an honest `assumedClusterSize: 3` and
under the unconfigured default alike. Full numbers are in the sibling ticket.

**This state is produced by growth, not by misconfiguration.** Anything committed while the
deployment was one node has one holder; the cohort that later derives for that key has three. A
deployment's founding records — schema, genesis, the first collection headers — are exactly the data
every later joiner must read, and exactly the data that is stranded. `clusterPolicy.assumedClusterSize`
cannot express "this block has one copy", so there is no configuration workaround.

## Why this is the fix rather than relaxing the read

The fix ticket weighed four directions. Three were rejected on measured grounds:

- **Relax the corroboration floor when every non-claimant affirmatively answered "I hold nothing".**
  Rejected. It is strictly weaker than today's rule — it drops the requirement that the cohort be
  small, so a widened view of nine non-holders plus one liar also passes — and, decisively, it is
  self-amplifying: `selectQuorumRev` counts distinct peer ids voting for the same `(rev, actionId)`,
  and an acquiring reader persists via `saveReplicatedBlock`, which advances `latest`, which
  `clusterLatestCallback` then reports. One accepted forgery makes the acceptor a genuine second
  voter, and the next reader sees a real two-peer quorum. A single bad acceptance becomes permanent
  cohort-wide truth.
- **Corroborate structurally against a parent the reader already holds.** Not buildable: parents name
  children by bare id only (`BranchNode.nodes: BlockId[]` in `db-core/src/btree/nodes.ts`;
  `BlockHeader` is `{ id, type, collectionId }`). No parent carries a child revision or content hash,
  so there is nothing independent to check a lone claim against. Adding one is a data-format change of
  the same magnitude as commit certificates — and it would still not cover a collection's own header
  block, which is the case in the report, because nothing inside the data points at it.
- **Verify the claim with a commit certificate instead of counting claimants.** Correct, and still the
  only way to make a *lone* claim trustworthy — but it is `backlog/debt-read-repair-commit-cert-verification`,
  whose own prerequisite (`feat-cluster-membership-threshold-cert-anchoring`) is not built. That
  ticket already carries this evidence. It remains the sound fix for blocks **already** stranded on an
  existing deployment; this ticket stops new ones being created and heals existing ones on any
  deployment whose holder is still online when the cohort grows.

**The remaining objection to this direction does not hold.** It is usually stated as "the acquiring
node faces the same trust decision, so pushing is no safer than pulling." It does not, because the
receiving side already exists and already accepts unverified pushes from any peer:
`BlockTransferService.handlePush` (`block-transfer-service.ts:199`) decodes a pushed payload,
checks only that it parses and has a `header`, and calls `saveReplicatedBlock` with
attacker-supplied `blockMeta` rev/actionId. No cohort-membership check, no signature, and no
authorization gate by default (`libp2p-node-base.ts:443` — absent `authorizeInboundStream`, every
service constructs its gate as `undefined`). This is already pinned green by
`test/block-transfer-push-persist.spec.ts:48` and `:65`, and is a documented design position for a
public database (`docs/internals.md:859`). A holder-initiated push therefore extends **no trust that
is not already extended**; it only changes who initiates. The wider question that raises is a human's
to answer and is filed separately as
`blocked/repair-floor-defends-a-door-the-push-path-leaves-open` — it does **not** gate this work.

## What is missing

Both existing push paths are triggered by a node **losing** something:

- `spread-on-churn` (`spread-on-churn.ts`) fires on peer *departure* — its whole config vocabulary is
  `departureDebounceMs`, `expansionStep`.
- `BlockTransferCoordinator.handleRebalanceEvent` (`block-transfer.ts:125`) pulls `event.gained` and
  pushes/confirms `event.lost`.

Nothing fires when a node **keeps** responsibility for a block and a new peer becomes co-responsible
for it. That is precisely the founding case: the founder never loses the block, so it never pushes;
the joiner never had it, so it is not in anyone's `gained` set as a transfer source. The block sits
with one copy.

The receiving primitive is already there and already correct for this use: `pushBlocks` /
`confirmReplicated` in `block-transfer.ts` push to candidate owners and count how many report holding
a current replica, with per-block timeout, retry, partition guard and an in-flight de-dup key.
`confirmReplicated` deliberately ignores `enablePush` because confirmation requires pushing; note
that when reusing it.

## Shape of the work

A cohort-growth trigger alongside the existing departure trigger:

```
peer joins / FRET neighbourhood widens
  → for each block this node tracks (the shared `ownedBlocks` set already threaded through
    RebalanceMonitor and SpreadOnChurn via `trackedBlocks`)
      → which cohort peers are newly co-responsible and do NOT already hold a current replica?
      → push to them, up to the replication floor
```

Design points to settle in the implementation, not assumed here:

- **Where it belongs.** `spread-on-churn` already owns "a peer set changed, re-spread"; adding a
  growth arm there keeps one place that reacts to churn. `rebalance-monitor` already computes
  gained/lost/floor. Pick one and say why in the handoff — do not add a third module that also
  watches peer churn.
- **How "does not already hold it" is established.** `confirmReplicated` gets this for free: a push
  response that omits the block from `missing` means the target already had it or accepted it. That
  makes the naive implementation (push to every co-responsible peer) correct but chatty. Measure the
  chattiness before optimising it; do not add a holder-inventory protocol on speculation.
- **Cost control.** This must not turn every peer join into a full re-replication of a node's entire
  block set on a large deployment. Bound it — by replication floor already met, by a per-pass block
  budget, or by debounce, in that order of preference. Whatever bound you choose, `log()` what it
  dropped: a silent cap reads as "everything got replicated" when it did not.
- **Honest limitation to state in the handoff.** This heals a stranded block only while its sole
  holder is online and notices the growth. A holder that was offline for the whole growth window
  leaves the block stranded until it next runs, and a holder that is gone for good leaves it stranded
  permanently. Say so plainly; it is the residual that commit-cert verification would cover and this
  ticket does not.

## TODO

- Write the failing end-to-end test first, using `src/testing/mesh-harness.ts` or the three-peer
  harness described in `implement/name-the-single-holder-deadlock`: node A commits a block while it is
  the only node; nodes B and C join and become co-responsible; B reads the block. Assert B gets the
  content. Today it does not.
- Decide and document where the growth trigger lives (`spread-on-churn` vs `rebalance-monitor`);
  reuse `BlockTransferCoordinator.confirmReplicated` rather than writing a second push loop.
- Implement the trigger over the shared `trackedBlocks` / `ownedBlocks` set, with a bound and a log
  line naming anything the bound dropped.
- Wire it in `libp2p-node-base.ts` next to the existing churn wiring, and add the node-wiring spec
  alongside `spread-on-churn-node-wiring.spec.ts` / `rebalance-monitor-node-wiring.spec.ts`.
- Cover the negative cases: a partition in progress must not push (match the existing
  `partitionDetector` guard); a block already at the replication floor must not re-push; repeated
  growth events must not re-push the same block in a loop.
- `yarn build`, then `yarn test` from `packages/db-p2p`; `yarn lint` from root. If the change touches
  timing-sensitive churn specs, run them twice before calling them green.
- In the review handoff, state the residual honestly: which singly-held blocks this does **not** heal,
  and that `backlog/debt-read-repair-commit-cert-verification` is what covers them.
