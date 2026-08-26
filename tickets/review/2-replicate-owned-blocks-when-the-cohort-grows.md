----
description: A machine now pushes copies of blocks it holds to peers that newly become co-responsible for them, so data written while a deployment was a single machine no longer stays trapped on that machine forever. Review the growth-detection arm, the push reaction, and the metadata ride-along that makes pushed replicas count in quorum votes.
prereq:
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts
----

# Replicate owned blocks when the cohort grows — review handoff

From `fix/single-holder-block-is-permanently-unreadable` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). This is the
behavioural half; the diagnostics half (`name-the-single-holder-deadlock`) already completed.

## What was wrong

Block repair requires two cohort peers to corroborate a claim. A block with one holder can only
ever produce one claim, and both pre-existing replication paths (rebalance "lost" push, spread-on-
churn) fire only when the holder *loses* responsibility. Growth — new machines joining and becoming
co-responsible — never triggered a copy, so anything committed while the deployment was one machine
stayed singly-held and unreadable by everyone else, permanently.

## What was built

- **`RebalanceMonitor` (`src/cluster/rebalance-monitor.ts`)** — new growth arm:
  - `RebalanceEvent` gained a required `grown: Map<string, string[]>` field (blockId → peers newly
    co-responsible, never self).
  - `responsibilitySnapshot` now stores `{ responsible, cohortPeers }` per block. A missing entry
    means "prior cohort empty", so the *first* check pushes to the whole non-self cohort — this is
    what heals the founder case and the restarted-holder case.
  - The growth arm runs whenever the node is responsible (not gated on `wasResponsible`); losing
    responsibility clears the seen-set so a regain re-reports the whole cohort.
  - New config `growthBlockBudget` (default 64) caps grown blocks per check. A budget-dropped
    block's snapshot is NOT updated, so it re-detects next check (self-healing); one log line per
    check reports the deferral.
- **`BlockTransferCoordinator` (`src/cluster/block-transfer.ts`)** — reaction:
  - `handleRebalanceEvent` runs a new private `replicateGrown(grown, floor)` concurrently with the
    existing pull/confirm arms; result gained `replicated` / `underReplicated`. Nothing is ever
    released off the grown arm.
  - Per-block floor is `min(event.floor, newPeers.length)` — the raw floor would burn maxRetries
    whenever fewer new peers exist than the floor.
  - **`executeConfirm` and `executePush` now send `blockMeta` (the source's `state.latest`)** via a
    new `sourceMeta` helper. Without it, pushed replicas landed as fabricated rev-1 records whose
    actionIds never match the source's, so they could not corroborate it in quorum votes and the
    end-to-end read would still decline.
- **`libp2p-node-base.ts`** — the onRebalance handler logs an under-replication count; `released`
  gating untouched; `growthBlockBudget` flows through `options.rebalance` with no new wiring.

## Design decisions (argue with these, not the code, first)

- **Trigger lives in `RebalanceMonitor`, not spread-on-churn**: the monitor already listens to both
  `connection:open` and `connection:close`, assembles the per-block cohort at floor size, keeps
  per-block memory, and its event already flows into `handleRebalanceEvent` — debounce,
  `minRebalanceIntervalMs` throttle, and partition suppression come for free. Spread-on-churn is
  departure-only with no per-block memory.
- **`enablePush` does NOT gate the grown arm** — same rationale as the existing NOTE in
  `confirmReplicated`. Gating is `rebalance.enabled`.
- **"Target does not already hold it" is established by the push response** (a `missing` omission
  means the target had it or accepted it). Chatty but correct; chattiness bounded by the floor and
  the per-pass budget. No holder-inventory protocol was added on speculation.
- **Bound**: cohort ≤ floor ⇒ at most floor−1 pushes per block (confirm stops at floor);
  `growthBlockBudget` bounds block count per pass; dropped blocks logged and self-healing.

## ⚠ Reviewer attention: blockMeta behavior change on a pre-existing path

`executeConfirm`/`executePush` carrying the source's `(rev, actionId)` changes the *pre-existing
lost-block* push path too — replicas no longer land as fabricated rev-1 records. This matches what
spread-on-churn already did, and the full suite is green, but it is a semantic change to a path this
ticket did not set out to touch. Verify no consumer depended on the fabricated-rev behavior.

## Known residual gaps (not regressions — document, don't fix silently)

- A holder offline for the whole growth window leaves its block stranded until the holder next runs
  AND the cohort next changes; a holder gone for good strands it permanently. Only
  `backlog/debt-read-repair-commit-cert-verification` covers that.
- Checks are topology-event-driven only: a quiet network where FRET converges late gets no re-check
  until the next connection event.
- The gained∩grown first-observation push finds no local data and no-ops — benign (those peers are
  the pull's own source); pinned by a test.

## Tests (floor, not ceiling)

- `test/rebalance-monitor.spec.ts` — growth-detection describe: first observation seeds whole
  non-self cohort; joiner-only delta; stable cohort → null (no re-push loop); lost∩grown
  impossible; budget defers then re-detects then goes quiet; regain after loss re-reports.
- `test/block-transfer.spec.ts` — grown push confirms with exactly one dial even when floor(3) >
  new peers(1); receiver-refuses → `underReplicated`; no-local-data grown block →
  `underReplicated`, zero dials.
- `test/rebalance-reaction.spec.ts` — topology-triggered grown event drives a dial to the joiner
  through the node-base hop.
- `test/cohort-growth-heals-single-holder.spec.ts` — the end-to-end heal over real components:
  real StorageRepos for A/B/C, real monitor + coordinator on A, pushes travel the real
  length-prefixed `ProtocolClient` frames into B/C's real `BlockTransferService`, and B reads via
  the same `CoordinatorRepo` + `createReconcileBlock` harness the single-holder spec uses. Asserts
  pre-growth decline, grown=[B,C], replicas land at the source's `(rev, actionId)`, post-push read
  serves the content, repeat check → null.

## Validation performed

- `yarn workspace @optimystic/db-p2p test` — **1921 passing, 0 failing, 44 pending — run twice**
  (timing-sensitive churn specs), both clean.
- `yarn lint` from root — clean.
- Root `yarn build` — green (prior run, after all source edits).
- One fix landed during validation: the E2E spec originally created a fresh `MemoryRawStorage`
  inside the per-operation `createBlockStorage` factory, losing the pend before the commit; now one
  raw storage per node is shared across factory calls (matching
  `coordinator-repo-single-holder.spec.ts`), with a comment at the site explaining why.
