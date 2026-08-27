description: When a machine copies its data to a machine that just joined and that copy fails, it is never tried again. Make the machine only tick "done" once the copy is actually confirmed, retry a bounded number of times, and give it a way to retry without waiting for unrelated network activity.
prereq:
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts, docs/internals.md, docs/arachnode-ring-handoff.md
difficulty: hard
repro: verified

----

# Record a growth push as done only after it is confirmed

Fix-stage investigation of `bug-cohort-growth-push-is-never-retried-after-a-failure`.

## Reproduced

Verified against real components (a temporary spec, since removed — recipe under *Tests* below).
A two-node case: A holds a block written while it was alone; B joins the cohort but its first dial
fails; the push is reported `underReplicated`; B becomes reachable again and stays in the cohort —
and every subsequent `checkNow()` returns `null` forever. B never receives the block. The
single-holder defect the growth arm exists to heal survives one transient failure, permanently.

## Root cause — one site

`RebalanceMonitor.performRebalanceCheck` (`rebalance-monitor.ts`, the growth arm) adds the newly
co-responsible peers to the block's seen set (`responsibilitySnapshot[blockId].cohortPeers`) in the
same statement that reports them `grown` — before anything has pushed, let alone confirmed. The
reaction runs afterwards in `BlockTransferCoordinator.handleRebalanceEvent`, and its failure report
(`underReplicated`) reaches only a log line in `libp2p-node-base.ts:1151`. The monitor is never told,
so the peers are already "seen" and the growth is never re-detected.

Ways a push fails while the peer stays in the cohort (all resolve here, all are one fix): the dial or
response times out; the receiver reports the block in `missing` because it failed to persist; a
partition is detected between the monitor's own partition check and `confirmReplicated`'s.
`confirmReplicated`'s `maxRetries` (default 2, with backoff) only covers a hiccup of a few seconds
inside the one pass.

## The invariant to establish

**A peer enters a block's seen set only once a replica is confirmed on it, or once the block has
otherwise reached its floor.** Every failure mode above then re-detects for free, and future ones
cannot be added to the list.

That needs three things the current design does not have: a feedback channel from the reaction back
to the monitor, a bound on how long a node keeps retrying a peer that will not accept, and a way to
run a re-check without waiting for an unrelated libp2p connection event.

## 1. The feedback channel

Define the outcome type in `rebalance-monitor.ts` (which already owns `RebalanceEvent`; `block-transfer.ts`
imports from it, so the dependency direction is unchanged):

```ts
/**
 * What the growth reaction learned about ONE block reported `grown`. Fed back to
 * RebalanceMonitor.recordGrowthOutcome so the seen set is confirmation-driven.
 */
export interface GrowthOutcome {
	/** Newly co-responsible peers that may now be recorded as seen for this block. */
	satisfiedPeers: string[]
	/** True when nothing about this block is still owed a push. */
	complete: boolean
}
```

`RebalanceReactionResult` gains `growth: Map<string, GrowthOutcome>`. `replicateGrown` populates it
per block:

- **floor met** → `{ satisfiedPeers: <all peers the event reported for this block>, complete: true }`.
  This deliberately includes peers `executeConfirm` skipped once the floor was already reached — the
  block is adequately replicated, and re-pushing the remainder on every check forever would be a
  live loop. (Reachable today: growth clamps the floor to `min(eventFloor, newPeers.length)`, so a
  small network estimate can give `floor=1` with two new peers.)
- **no local data** (`confirm:no-local-data` — the gained∩grown first-observation case) →
  `{ satisfiedPeers: <all reported peers>, complete: true }`. There is nothing to replicate and no
  dial happens; those cohort peers are the pull's own source. This keeps today's behaviour exactly
  for that case rather than turning it into a permanent retry loop. See *Tripwire* below.
- **otherwise** → `{ satisfiedPeers: [...confirmedPeers], complete: false }`.
- **block dropped by the in-flight `confirm:<id>` dedup** → **no map entry at all.** `confirmReplicated`
  filters those ids out and they appear in neither `confirmed` nor `unconfirmed`; a missing entry must
  mean "no information", and the monitor must leave that block's state untouched (no seen additions,
  no attempt counted).

`executeConfirm` currently mutates caller-supplied `confirmed[]` / `unconfirmed[]` arrays and never
surfaces *which* peers confirmed. Refactor it to return a small result (`{ confirmedPeers: Set<string>;
noLocalData: boolean }` or equivalent) and let `confirmReplicated` build its arrays from that. The
lost-block release path ignores the extra fields — its behaviour must not change.

Monitor API:

```ts
/**
 * Feedback from the growth reaction. `satisfiedPeers` enter the block's seen set; an incomplete
 * outcome counts an attempt against the give-up bound. Never called for a block the reaction had
 * no information about.
 */
recordGrowthOutcome(blockId: string, outcome: GrowthOutcome): void
```

Wire it in `libp2p-node-base.ts` inside the existing `.then((result) => …)`, alongside the
`released` loop. On the `.catch` path record nothing — the state stays un-advanced and the next check
retries, which is the correct outcome for a reaction that threw.

## 2. Seen-set bookkeeping changes

In the growth arm of `performRebalanceCheck`:

- **Never** add reported peers to `cohortPeers` at report time. Additions come only from
  `recordGrowthOutcome`.
- Replace the current `seenCohortPeers = new Set(currentPeers)` assignments with an **intersection**
  of the existing seen set against `currentPeers`. That preserves the existing departure self-heal (a
  peer that leaves the cohort drops out of the seen set, so its return is re-detected) without
  laundering unconfirmed peers into it.
- Responsibility loss still clears the whole per-block growth state (seen set, attempts, abandoned
  peers), as today.

## 3. Give-up policy

Without a bound, a peer that permanently refuses is re-pushed on every check forever, and — worse —
permanently-unsatisfied blocks re-consume `growthBlockBudget` (default 64) on every check and starve
genuinely-new growth. That starvation is the reason a bound is needed; the existing 60s
`minRebalanceIntervalMs` is a rate limit, not a decision.

- New config `growthMaxAttempts?: number`, default 5.
- Per block, keep `growthAttempts`. An outcome with `complete: false` increments it; any
  `complete: true` outcome resets it to 0.
- On reaching `growthMaxAttempts`, move the still-unsatisfied reported peers into a per-block
  `abandonedPeers` set, reset the counter, and log. Abandoned peers are excluded from `newPeers`, so
  nothing further is pushed to them for that block.
- `abandonedPeers` is intersected with the current cohort each check, so a peer that leaves and later
  rejoins is retried from scratch. Responsibility loss clears it outright.
- **Observable**, per the ticket's requirement that stopping not be silent: expose a diagnostic
  (e.g. `getGrowthDiagnostics(): { blocksAwaitingConfirmation: number; abandonedPairs: number }`),
  and upgrade the existing `cohort-growth: …` log line in `libp2p-node-base.ts` to name give-ups
  distinctly from ordinary not-yet-confirmed blocks.

## 4. A re-check trigger of its own

Checks fire only on libp2p `connection:open` / `connection:close`. A correctly-invalidated seen set
gets no check to act on if the network then goes quiet — which is exactly the "peer was briefly
unreachable" case. Add a self-arming timer:

- New config `growthRecheckIntervalMs?: number`, defaulting to `minRebalanceIntervalMs`; `0` disables.
- Armed at the end of a check **only when there is outstanding work** (any block with reported-but-
  unsatisfied peers, or `growthDeferred > 0`), disarmed when there is none. It fires `maybeRebalance()`
  so the existing throttle still bounds the push rate.
- `unref()` the timer so it never holds a Node process (or a test run) open, and clear it in `stop()`.

This subsumes the existing `NOTE:` on the growth budget in `rebalance-monitor.ts`, which parks the
same observation for the deferred-block backlog ("give the monitor a periodic re-check rather than
raising the budget"). Update or remove that NOTE as part of the change rather than leaving it to be
re-derived.

## 5. Fairness

With retries now re-competing for `growthBlockBudget`, fill the budget in two passes: blocks with
`growthAttempts === 0` (fresh growth) first, retrying blocks with what remains. Otherwise a stuck
retry set at the front of the tracked-block insertion order starves peers that just joined.

## Tests

Existing tests encode the old "seen at report time" semantics and must be updated — this is expected,
not collateral damage:

- `rebalance-monitor.spec.ts` → *a peer joining the cohort reports ONLY the new peer as grown*: record
  a confirming outcome after the baseline check, or both peers are now reported.
- `rebalance-monitor.spec.ts` → *a stable cohort does not re-emit growth*: becomes "a **confirmed**
  cohort does not re-emit growth" — the outcome must be fed back before the second check returns null.
- `rebalance-monitor.spec.ts` → *the growth budget defers excess blocks*: needs outcomes recorded, or
  the first block competes again and the "it is the OTHER block" assertion is no longer meaningful.
- `cohort-growth-heals-single-holder.spec.ts` → the closing `expect(await monitor.checkNow()).to.equal(null)`
  needs the reaction's outcomes fed back into the monitor first.
- `block-transfer.spec.ts` growth cases (confirmed / refuses-to-persist / no-local-data) → assert the
  new `result.growth` entries alongside `replicated` / `underReplicated`.

New coverage:

- **The regression test for this ticket.** Reuse the loopback harness in
  `cohort-growth-heals-single-holder.spec.ts` (real `StorageRepo`s, real `BlockTransferService`, real
  `BlockTransferClient` frames over a loopback `IPeerNetwork`) with the peer network's `connect`
  throwing for peer ids in an `unreachable` set. Sequence: A alone → baseline check; B joins while
  unreachable → grown reported, `handleRebalanceEvent` returns `underReplicated: [block]`, outcomes
  fed back; B becomes reachable with the cohort unchanged → the next check **must** re-report B as
  grown, and the second push must land B's replica at the source's `(rev, actionId)`. Assert against
  B's repo, not just the event.
- The give-up bound: a peer that always reports the block `missing` stops being pushed after
  `growthMaxAttempts` and shows up in the diagnostic.
- The no-local-data case does not loop: a gained∩grown block with nothing local records complete and
  the next check returns null.
- The re-check timer arms while work is outstanding and disarms when it is not.

## Tripwire to record in code (not a ticket)

The no-local-data rule records the reported peers as seen. If the node later obtains that block by a
route other than a pull from those peers (a fresh local commit, a spread push), those peers stay
recorded and are never pushed. Benign today — a gained block's data comes from the cohort, which is
those very peers — so park it as a `NOTE:` at the no-local-data branch in `replicateGrown`, per the
tripwire rules.

## Docs to update

- `docs/internals.md:511-513` — currently states the growth push "happens once per detected growth,
  and a block whose push could not be confirmed keeps its single copy until the cohort changes again".
  That is precisely the behaviour being removed.
- `docs/internals.md:975` — the `grown` paragraph describes the seen set as recorded at report time.
- `docs/arachnode-ring-handoff.md:248` — the `handleRebalanceEvent` return shape gains `growth`.

## Explicitly out of scope

Not relaxing the two-claimant read-repair corroboration floor — that question is
`blocked/repair-floor-defends-a-door-the-push-path-leaves-open`, and it does not gate this work.

## TODO

- Add `GrowthOutcome` to `rebalance-monitor.ts`; add `growth: Map<string, GrowthOutcome>` to `RebalanceReactionResult`.
- Refactor `executeConfirm` to return `{ confirmedPeers, noLocalData }` instead of mutating caller arrays; rebuild `confirmReplicated`'s arrays from it, leaving the lost-block release path's behaviour unchanged.
- Populate `growth` in `replicateGrown` per the four rules above (floor-met, no-local-data, partial, in-flight-dropped ⇒ no entry).
- Add `RebalanceMonitor.recordGrowthOutcome`; stop adding reported peers to `cohortPeers` at report time; switch the seen-set updates to intersection against the current cohort.
- Add `growthMaxAttempts` config, per-block `growthAttempts` + `abandonedPeers`, and the give-up transition; exclude abandoned peers from `newPeers`; intersect abandoned peers with the current cohort; clear all growth state on responsibility loss.
- Add the growth diagnostic accessor and upgrade the `cohort-growth:` log line in `libp2p-node-base.ts` to distinguish give-ups from not-yet-confirmed.
- Add `growthRecheckIntervalMs` and the self-arming, `unref`'d re-check timer; clear it in `stop()`; update/remove the superseded growth-budget `NOTE:`.
- Fill `growthBlockBudget` in two passes (fresh growth before retries).
- Wire `recordGrowthOutcome` into the `onRebalance` handler in `libp2p-node-base.ts`; record nothing on the `.catch` path.
- Add the `NOTE:` tripwire at the no-local-data branch in `replicateGrown`.
- Update the five existing tests listed above; add the regression test, the give-up bound test, the no-local-data no-loop test, and the timer arm/disarm test.
- Update `docs/internals.md` (both passages) and `docs/arachnode-ring-handoff.md:248`.
- Run `yarn workspace @optimystic/db-p2p test` and `yarn typecheck`; hand off to review honest about anything left.
