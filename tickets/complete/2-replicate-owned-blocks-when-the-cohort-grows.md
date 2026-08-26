----
description: A machine now pushes copies of blocks it holds to peers that newly become co-responsible for them, so data written while a deployment was a single machine no longer stays trapped on that machine forever. Reviewed, fixed inline, and one gap on the failure path filed as a backlog bug.
prereq:
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts, docs/internals.md, docs/architecture.md, docs/arachnode-ring-handoff.md
----

# Replicate owned blocks when the cohort grows — complete

From `fix/single-holder-block-is-permanently-unreadable` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). The behavioural half;
the diagnostics half (`name-the-single-holder-deadlock`) completed earlier.

## What shipped

Block repair requires two cohort peers to corroborate a claim. A block with one holder can only ever
produce one claim, and both pre-existing replication paths (rebalance "lost" push, spread-on-churn)
fire only when the holder *loses* responsibility. Growth — new machines joining and becoming
co-responsible — never triggered a copy, so anything committed while the deployment was one machine
stayed singly held and unreadable by everyone else, permanently.

- **`RebalanceMonitor`** — new growth arm. `RebalanceEvent` gained a required
  `grown: Map<string, string[]>` (blockId → peers newly co-responsible, never self).
  `responsibilitySnapshot` now stores `{ responsible, cohortPeers }` per block; a missing entry means
  "prior cohort empty", so the first check pushes to the whole non-self cohort — that is what heals
  the founder case and the restarted-holder case. The arm runs whenever the node is responsible;
  losing responsibility clears the seen set so a regain re-reports. `growthBlockBudget` (default 64)
  caps grown blocks per check; a dropped block's snapshot is deliberately not updated, so it
  re-detects next check.
- **`BlockTransferCoordinator`** — `handleRebalanceEvent` runs `replicateGrown` concurrently with the
  pull/confirm arms; the result gained `replicated` / `underReplicated`. Nothing is ever released off
  the grown arm. Per-block floor is `min(event.floor, newPeers.length)`.
- **`executeConfirm` / `executePush` now send `blockMeta`** (the source's `state.latest`), so a pushed
  replica lands at the source's `(rev, actionId)` instead of a fabricated rev-1 whose action id could
  never corroborate the source in a quorum vote.
- **`libp2p-node-base.ts`** — the onRebalance handler logs an under-replication count; `released`
  gating untouched; `growthBlockBudget` flows through `options.rebalance`.

## Review findings

Read the implement diff (`git show cfecbff..44cfa7f -- packages/db-p2p/src/`) before the handoff
summary, then traced each new path into the code it calls: `saveReplicatedBlock` → `saveReplica` →
`saveForwardRevision` (monotonicity and range-merge under the new `blockMeta`), `GetBlockResult`'s
`state.latest` vs `materializedRev` contract, the semaphore/in-flight/retry structure of
`executeConfirm`, the monitor's snapshot lifecycle, and every doc that describes the rebalance path.

### Confirmed sound (checked, nothing to change)

- **The `blockMeta` behaviour change the handoff flagged on the pre-existing lost-block path is
  safe.** Traced it through `saveReplicatedBlock` → `saveReplica` → `saveForwardRevision`: the
  monotonic guard means a stale push cannot downgrade a receiver holding a newer revision, and the
  `meta.ranges.unshift([prevRev ?? rev])` open-ended anchor means landing rev N over a receiver at
  rev M < N leaves no unservable history gap. Spread-on-churn has pushed this way all along; no
  consumer depended on the fabricated rev-1 behaviour. Now also pinned by tests (below).
- **The `min(floor, newPeers.length)` clamp is not just a guard, it is always the binding term.**
  `floor` is `getCohortSize()` and the new peers are a subset of the non-self cohort, so
  `newPeers.length ≤ floor − 1` always. The effect is "push to every new peer", which is what the arm
  wants. Left as written — the `min` is the honest expression of the intent.
- **Blast radius of the first-observation whole-cohort re-push is bounded and small.**
  `getCohortSize()` clamps to 3, so at most two pushes per block, and `growthBlockBudget` caps blocks
  per check. A restart re-pushing everything is cheap enough not to be worth a holder-inventory
  protocol.
- **The `grown`/`lost` mutual exclusion, the `gained ∩ grown` no-op, and the budget deferral** each
  hold as documented and each already have a test.

### Fixed in this pass (minor)

- **`sourceMeta` was structurally typed to an ad-hoc literal (`{ state?: { latest?: ... } }`)**, which
  silently accepts any object — a rename in `GetBlockResult` would have made it return `undefined`
  forever with no type error. Now a shared exported `sourceBlockMeta(blockId, result)` in
  `block-transfer-service.ts`, typed as `Pick<GetBlockResult, 'state' | 'materializedRev'>`, living
  next to the `BlockTransferRequest.blockMeta` wire type it builds.
- **The same `blockMeta` construction was duplicated in `spread-on-churn.ts`.** Both push paths now
  call the shared helper.
- **`state.latest` was paired with content that is only guaranteed to be that revision on an unpinned
  read.** All three call sites read unpinned today, so nothing was wrong — but the pairing was
  unguarded, and a future pinned read there would label rev-M content as rev N, making every holder of
  it a false corroborator for a revision it does not hold. The helper now drops the meta (falling back
  to the receiver's deterministic rev-1 replica) and logs when `materializedRev` disagrees with
  `latest`.
- **`handleRebalanceEvent` guarded `event.grown` with `?.` / `?? new Map()` while `libp2p-node-base.ts`
  read `event.grown.size` unguarded**, on a field the interface declares required. Made consistent —
  the field is required, so the guards are gone.
- **Docs were stale.** `docs/internals.md:509` stated outright that "growing the deployment afterwards
  does not retroactively copy it" — false as of this change, and it is the sentence an operator reads
  when diagnosing exactly this. Corrected, with the remaining best-effort caveat stated. Also updated:
  the `RebalanceMonitor` sections in `docs/internals.md` and `docs/architecture.md` (which listed only
  `gained`/`lost`/`newOwners`), the `handleRebalanceEvent` return shape in `docs/internals.md` and
  `docs/arachnode-ring-handoff.md` (both still said `{ pulled, released, retained }`), and a new
  paragraph documenting the `blockMeta` ride-along and why the `(rev, actionId)` match is load-bearing.

### Test gaps closed (minor)

The implementer's tests covered the growth arm well — detection, budget, regain, the reaction hop,
and a real end-to-end heal. Two gaps:

- **The flagged `blockMeta` change to the pre-existing lost-block path had no test at all** — the
  end-to-end spec proves it for the grown arm only. `MockPeerNetwork` now records the decoded request
  each client writes, and two new tests assert `pushBlocks` and `confirmReplicated` both carry the
  source's `(rev, actionId)`.
- **The new `materializedRev` guard** has four unit tests (carried, agreeing, disagreeing, absent).

### Filed as a ticket (major)

- **`backlog/bug-cohort-growth-push-is-never-retried-after-a-failure`** — the monitor adds new peers
  to its per-block seen set in the same statement that reports them `grown`, *before* anything checks
  the push landed. `underReplicated` is only logged. So a push that fails while the peer remains in
  the cohort (dial/response timeout, receiver persist failure, a partition arising between the check
  and the reaction) is never retried, and on a two-machine deployment that leaves the block singly
  held and permanently unreadable — the exact symptom this ticket exists to fix, surviving one
  transient failure. Filed at the invariant rung rather than as three failure-mode fixes: *a peer
  enters the seen set only once a replica is confirmed on it*. Not fixed inline because it needs a
  feedback channel from the reaction back to the monitor plus a give-up policy — design work, not a
  patch. No open ticket claimed these sites (checked by grep across all stage folders).

### Recorded as a tripwire, not a ticket

- **The growth budget drains only as fast as topology events arrive.** Deferred blocks come back one
  budget-full per check, and checks fire only on a libp2p connection event (further throttled to 60s).
  Fine at today's sizes — cohort size is clamped to 3 — but a deployment tracking blocks in the
  thousands would want a periodic re-check rather than a bigger budget. `NOTE:` at the deferral log
  site in `rebalance-monitor.ts`.

### Accepted tradeoffs left alone

None encountered — no `NOTE:` accepted-tradeoff comments sit at any site this diff touches.

### Not re-raised

`blocked/repair-floor-defends-a-door-the-push-path-leaves-open` already holds the open question of
whether an unauthenticated `handlePush` is intended, which the `blockMeta` ride-along touches (it lets
a pusher name the revision a replica lands at). That is a human decision already parked; this review
adds nothing to it.

## Residual gaps carried forward from implement (still true)

- A holder offline for the whole growth window leaves its block stranded until the holder next runs
  AND the cohort next changes; a holder gone for good strands it permanently. Only
  `backlog/debt-read-repair-commit-cert-verification` covers that.
- Checks are topology-event-driven only: a quiet network where FRET converges late gets no re-check
  until the next connection event.

## Validation

- `yarn workspace @optimystic/db-p2p test` — **1927 passing, 0 failing, 44 pending** (1921 before; +6
  from this review's new tests).
- `yarn test` from root (all workspaces) — **0 failing**, 6m32s, exit 0.
- `yarn lint` from root — clean, exit 0.
- `yarn build` from root — green, exit 0.
