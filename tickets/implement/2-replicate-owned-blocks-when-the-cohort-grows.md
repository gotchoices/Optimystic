----
description: A machine copies its data to others when it loses responsibility for it, but never when new machines simply join and become co-responsible — so anything written while a deployment was one machine keeps exactly one copy forever, and no later machine can ever read it. Make a machine push copies of what it holds to peers that newly share responsibility for it.
prereq:
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts
difficulty: hard
----

<!-- resume-note -->
**Resume note (2026-08-25 run, second continuation).** The first run settled the design (decisions
preserved below under "Settled design", still authoritative). THIS run **implemented all code and
all tests**; it was stopped by a BUDGET_WARNING right after a clean root `yarn build`. **What
remains is validation only**: run the db-p2p test suite, fix anything that surfaces, lint, then
write the review handoff and move this ticket to review/. Do not re-derive or re-implement — read
the diff first (`git status` / `git diff`) and pick up at "Remaining steps".

### Code changes already made (complete, building)

- `src/cluster/rebalance-monitor.ts`:
  - `RebalanceEvent` gained a **required** `grown: Map<string, string[]>` field (blockId → newly
    co-responsible peers, never self), with a doc comment explaining the founder case.
  - `responsibilitySnapshot` is now `Map<string, { responsible: boolean; cohortPeers: Set<string> }>`;
    missing entry ⇒ prior cohort treated as empty (load-bearing: first check pushes to the whole
    non-self cohort — heals founder + restarted-holder cases).
  - Growth arm in `performRebalanceCheck` runs whenever `isResponsible` (not gated on
    `wasResponsible`); on loss the seen-set is cleared so a regain re-reports the whole cohort.
  - New config `growthBlockBudget` (default 64): caps grown blocks per check; a budget-dropped
    block's snapshot is NOT updated (self-healing re-detect next check) and one
    `log('growth budget reached: %d blocks deferred...')` line fires per check.
- `src/cluster/block-transfer.ts`:
  - `RebalanceReactionResult` gained `replicated` / `underReplicated`.
  - `handleRebalanceEvent` now also runs a new private `replicateGrown(grown, floor)` concurrently
    with pull/confirm; it calls `confirmReplicated` per block with per-block floor
    `min(event.floor, newPeers.length)` (raw floor would burn maxRetries when new peers < floor).
    Nothing is released off the grown arm.
  - **`executeConfirm` and `executePush` now pass `blockMeta`** (the source's `state.latest`) via a
    new `sourceMeta` helper — matches spread-on-churn's existing practice; required so pushed
    replicas land at the source's `(rev, actionId)` and can CORROBORATE the source in quorum votes
    (without it the E2E read would still decline: fabricated rev-1 actionIds never match).
- `src/libp2p-node-base.ts`: onRebalance handler logs `underReplicated` count
  (`cohort-growth: %d of %d grown blocks not confirmed...`); `released` gating untouched; the
  `rebalance?:` option doc updated to name the grown arm. `growthBlockBudget` flows through
  `options.rebalance` → `initRebalanceMonitor` automatically (config type extension only — no new
  wiring needed).

### Tests already written

- `test/rebalance-monitor.spec.ts`: new `describe('growth detection...')` — first observation seeds
  whole non-self cohort (gained∩grown); joiner-only delta; stable cohort → null (no re-push loop);
  lost∩grown impossible; budget defers + re-detects the OTHER block then goes quiet; regain after
  loss re-reports whole cohort.
- `test/rebalance-reaction.spec.ts`: new test — topology-triggered GROWN event (connection:open,
  cohort [self]→[self,peer2], block kept) drives a dial to the joiner through the node-base hop.
- `test/block-transfer.spec.ts`: two existing `RebalanceEvent` literals updated with `grown: new
  Map()`; three new `handleRebalanceEvent` tests — grown push confirms with exactly ONE dial even
  when floor(3) > new peers(1); receiver-refuses → `underReplicated`; no-local-data grown block →
  `underReplicated` with zero dials (the benign gained∩grown case).
- **New** `test/cohort-growth-heals-single-holder.spec.ts` — the E2E heal. Real StorageRepos for
  A/B/C; A committed `block-founder` rev 1 `action-1`; real `RebalanceMonitor` + real
  `BlockTransferCoordinator` (maxRetries 0) on A; a `LoopbackPeerNetwork` whose stream captures the
  real `ProtocolClient` LP frames, decodes them, drives B/C's REAL `BlockTransferService`
  handlePush/handlePull, and yields the LP-encoded response; B reads through the same
  `CoordinatorRepo` + `createReconcileBlock` harness `coordinator-repo-single-holder.spec.ts` uses,
  with C answering from its real repo. Asserts: pre-growth read declines; growth event grown=[B,C],
  gained/lost empty; `replicated=[block]`; B and C hold `{rev:1, actionId:'action-1'}`; post-push
  read serves 'v1'; repeat check → null.

### Remaining steps (validation only)

- `yarn workspace @optimystic/db-p2p test` — foreground, no redirection (or `2>&1 | tee
  tickets/.logs/<slug>.test.log` if grepping needed). Root `yarn build` already passed AFTER all
  edits, but the editor surfaced (possibly stale) TS diagnostics during editing — trust the test
  run's compile, not those.
- Likely failure points if anything is red, in order of suspicion:
  1. The loopback stream in the new E2E spec: `lpEncode` may yield `Uint8ArrayList` chunks; the
     loopback re-feeds captured chunks into `lpDecode`. If decode chokes, normalize each captured
     chunk with `chunk.subarray?.() ?? chunk` before yielding.
  2. `CoordinatorRepo` constructor arg order in the E2E spec — copied verbatim from
     `coordinator-repo-single-holder.spec.ts`; diff against it if construction throws.
  3. `getCohortSize()` returns 3 (MockFret has no getDiagnostics) → per-block floor min(3,2)=2 →
     BOTH B and C must accept; with `maxRetries: 0` any loopback hiccup fails the test — that is
     deliberate (deterministic in-memory path), fix the loopback rather than adding retries.
  4. `test/rebalance-monitor-node-wiring.spec.ts` — not modified; growth rides the same wiring so
     it should stay green; if it constructs `RebalanceEvent` literals it may need `grown: new Map()`.
- `yarn lint` from root.
- Timing-sensitive churn specs: run the db-p2p suite twice before calling it green (ticket
  requirement).
- Then write the review handoff into `tickets/review/2-replicate-owned-blocks-when-the-cohort-grows.md`
  and DELETE this file. The handoff must state honestly:
  - **Residuals**: (a) a holder offline for the whole growth window leaves the block stranded until
    it next runs AND the cohort next changes; a holder gone for good strands it permanently —
    covered only by `backlog/debt-read-repair-commit-cert-verification`. (b) checks are
    topology-event-driven only: a quiet network where FRET converges late gets no re-check until the
    next connection event. (c) the gained∩grown first-observation push finds no local data and
    no-ops (benign — those peers are the pull's own source); pinned by a test.
  - **Design decisions**: trigger lives in `RebalanceMonitor` (already listens to connection:open,
    has per-block memory, floor, debounce/throttle/partition-suppression for free — spread-on-churn
    is departure-only with no per-block memory); `enablePush` does NOT gate the grown arm (same
    rationale as the existing NOTE in `confirmReplicated`); gating is `rebalance.enabled`.
  - **Bound**: primary bound free (cohort ≤ floor ⇒ ≤ floor−1 pushes per block; confirm stops at
    floor); `growthBlockBudget` (64) bounds block count per pass; dropped blocks are logged and
    self-healing.
  - **blockMeta change**: `executeConfirm`/`executePush` now carry source `(rev, actionId)` — a
    behavior change on the pre-existing lost-block path too (replicas no longer land as fabricated
    rev-1). Flag for reviewer attention.
<!-- /resume-note -->

# Make the second copy, instead of teaching the reader to trust one

From `fix/single-holder-block-is-permanently-unreadable` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). This is the
behavioural fix. Its sibling `name-the-single-holder-deadlock` is the diagnostics half; both landed
independently — the diagnostics half is already complete.

## The defect in one sentence

Block repair requires two cohort peers to agree, a block with one holder can only ever produce one
claim, and both mechanisms that could create a second holder consume that same repair decision — so a
singly-held block stays singly-held and stays unreadable by anyone but its holder, permanently.
**This state is produced by growth, not by misconfiguration**: anything committed while the
deployment was one node has one holder; the cohort that later derives for that key has three.

## Settled design (from the first run's investigation — implemented as described)

- **Trigger lives in `RebalanceMonitor`**, not `spread-on-churn`: it already listens to BOTH
  `connection:open` and `connection:close`, assembles the per-block cohort at the floor size, keeps
  per-block memory (`responsibilitySnapshot`), and its event already flows into
  `BlockTransferCoordinator.handleRebalanceEvent` via the node-base handler. Debounce,
  `minRebalanceIntervalMs` throttle, and partition suppression come for free.
- **Missing snapshot entry ⇒ prior cohort = empty** — first check pushes to the whole non-self
  cohort; heals founder and restarted-holder cases.
- **Reaction reuses `confirmReplicated`** with per-block floor `min(event.floor, newPeers.length)`;
  in-flight `confirm:<id>` key dedups against the lost-confirm path.
- **"Does not already hold it" is established by the push response** (`missing` omission means the
  target had it or accepted it) — correct-but-chatty naive form, chattiness bounded by the floor and
  the per-pass budget; no holder-inventory protocol on speculation.
<!-- /settled design -->
