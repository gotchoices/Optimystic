description: A node asked for a record it does not have used to ask the rest of the network on every single read, with no limit, even on a one-machine deployment. On a one-machine deployment it now remembers a confirmed "does not exist" answer for the same short freshness window a record it holds already gets; on multi-machine networks it still asks every time, because remembering there hid freshly written records.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`settledAbsences`, `absenceIsSettled`, `forgetSettledAbsences`, `get`'s per-block decision, `fetchBlockFromCluster`'s `absenceSettled`)
  - packages/db-core/src/transactor/network-transactor.ts (comment only)
  - packages/db-core/src/cluster/structs.ts (config doc comments)
  - packages/db-p2p/test/coordinator-repo-absence-window.spec.ts
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (comment only)
  - docs/transactions.md (§ Lazy read-repair window, config table), docs/internals.md (unavailable-reads flag table)
  - tickets/backlog/feat-a-cohort-member-remembers-a-settled-absence.md (filed by review)
----
# A block this node does not hold gets a freshness window — on a cohort of one

## What shipped

`CoordinatorRepo.get` consults a block's cohort (the machines responsible for it) when the block is missing locally, or held but possibly stale. The stale case was already limited to one consult per `readRepairWindowMs` (10 s default); the missing case had no limit. The largest field producer is GitHub issue #8: control-plane code reading an empty `Revocation` collection before every membership lookup and every insert, on a lone node.

A missing block now skips its consult when an earlier consult, within the last window, **settled** its absence. After review, only the solo exit settles, meaning `findCluster` returned only this node. That is the one case where no write of the block can exist that this node has not seen: any acknowledged commit lands in this node's storage before the writer hears success, so the block reads as present and the memo is deleted.

- `settledAbsences`, an `LruMap<string, number>(1000)`, is stamped with the consult's *start* time. It is kept separate from `lastSeenCommitMs` on purpose.
- `fetchBlockFromCluster` returns a required `absenceSettled` field. It is `true` only at the solo-self exit; every other exit returns `false`.
- In `get`:
  - a present block deletes its memo;
  - a missing block with a fresh memo is served as-is, with no consult, flag or log line;
  - after a consult of a missing block, the memo is stamped only when the block is still missing, the absence was confirmed and the pass settled it; any other outcome deletes it, including the catch arm.
- Modes: `paranoid` never skips. `lazy` uses the window and the sample rate. `off` uses the window but not the sample rate.
- `pend` and `commit` clear the memo for their blocks first, whatever the outcome.
- Measured on a cohort of one, 9 reads of a never-written block inside one window: **9 → 1** consults. That holds both directly and through the real `NetworkTransactor` on a 1-node mesh.

## Review findings

**Diff read first** (`git show 0183c754`), then every touched file and the docs that describe the read-repair window.

### Major — the multi-peer memo broke read-after-write (verified, fixed by narrowing, follow-up filed)

The first full-suite run failed `fresh-node-ddl-multi.spec.ts` Scenario B: a 5-node cold start writes a tree on node A, and reading it on node B returns `undefined`. The implement handoff reported 0 failing.

A/B measurement, run in isolation with a temporary environment toggle that has since been removed: memo on, **5/20** failures; memo off, **0/20**.

A diagnostic log line showed one cohort member serving the memo for the tree header block after another coordinator's commit of it was acknowledged. The root cause is that this node takes part in other coordinators' writes as a cohort member through `ClusterRepo.applyConsensusOperation`. That path writes storage directly and never runs `CoordinatorRepo.pend/commit`, which is where the memo is cleared. Two further facts make the gap visible:
- a commit acknowledged at super-majority reaches the remaining members in the background (`scheduleCommitRetry`);
- `StorageRepo.get` reports a pending-only block as `{ state: {} }`.

So a lagging member keeps serving a remembered absent.

The accepted-tradeoff NOTE's premise was therefore false. It said: "a cohort member normally learns of a creation through the pend/commit it takes part in, and a local pend or commit clears this memo".

Fixed in this pass by returning `absenceSettled: false` at the multi-peer exits (`!corroborated` and `local-current`), with a comment at the site. Scenario B is now **20/20**, and the issue #8 solo win is unchanged.

Climbing the architecture ladder: the class-level fix is "every writer of this node's storage invalidates the memo", or making an in-flight pending visible to the read path. Filed as `tickets/backlog/feat-a-cohort-member-remembers-a-settled-absence.md` (performance only; the tree is correct without it). It is also recorded as evidence in `debt-freshness-state-scattered-across-coordinator-repo`, since this is exactly that ticket's "clearing conditions a freshness collaborator would own" theme.

### Minor — fixed inline

- **Stamp time.** The memo was stamped at the consult's end, which stretches "confirmed within one window" by the consult's duration. It is now stamped at the consult's start (`consultStartedAt`), pinned by a new spec that uses a slow cohort lookup.
- **`off` mode and the sample rate.** `off` mode drew against `readRepairSampleRate`, though the doc comment and `shouldReadRepair` treat sampling as `lazy`-only. The code now matches, pinned by a new spec.
- **Stale docs:**
  - `docs/transactions.md` said a missing block is "exempt from the window", described `off` as "fetch only on miss", and described the window as "`'lazy'` only". A paragraph now describes the absence memo, its solo-only scope and why, plus the adjusted table.
  - `docs/internals.md`'s flag table now notes which unflagged absent is remembered.
  - The config doc comments in `structs.ts` are updated.
  - The `network-transactor.ts` comment and the unavailable spec's comment are narrowed to the solo scope.
- **Accepted-tradeoff NOTE** on `settledAbsences` rewritten to the residual that actually remains: a transient cohort-of-one view that grows costs up to one window. That matches the held-block growth case already pinned. The revision-floor revisit condition is kept.

### Tripwires recorded

- The in-flight-consult vs local-write race, flagged by the implementer: a clear that lands during a consult is re-stamped. It is bounded, because the refused writer's next pend clears the memo again. Parked as a `NOTE:` at the stamp site in `get`, with the cheap fix named.
- The LRU eviction note (1000 entries; an eviction costs one extra consult) was already at the declaration.

### Spec changes (`coordinator-repo-absence-window.spec.ts`, 29 cases)

- **Cohort of one:** unchanged cases, plus:
  - `off` ignores the sample rate;
  - the window runs from the consult's start;
  - two "a re-consult that does not settle forgets a still-fresh memo" cases (throw; a cohort grown past this node);
  - multi-block, moved here from the three-member section.
- **Three-member cohort:** now pins "never remembered":
  - an all-"nothing" cohort consults 9 of 9 reads — the regression gate for the finding above;
  - a creation elsewhere is seen on the very next read;
  - the flagged and empty-cohort cases are kept as they were.

### Checked, nothing found

- **Held-block path:** the present-block path, `flagUnconfirmedCurrency` and `recordAheadClaim` are unchanged in behaviour.
- **Sync reads** (`skipClusterFetch`) still never consult or stamp.
- **Solo safety against other writers:** a solo cohort's commits land on this node before they are acknowledged.
- **Types:** `absenceSettled` is required, so any future exit has to state its side.
- **Resource cleanup:** the map is LRU-bounded.
- **The implementer's "fifth, not sixth" `LruMap` count:** correct.
- **Size:** `wc -l packages/db-p2p/src/repo/coordinator-repo.ts` gives 2818 lines, tracked by the existing debt ticket; not re-filed.

### Validation

- `yarn workspace @optimystic/db-core build` and `yarn workspace @optimystic/db-p2p build`: clean.
- eslint on every changed file: clean.
- `yarn lint:docs`: all citations resolve.
- Targeted: the absence-window, solo-read-repair and unavailable specs, 75 passing.
- Scenario B loop: 20/20.
- Full `packages/db-p2p` `yarn test`: 2679 passing, 50 pending, 1 failing. The failure is `routing-key-convention-divergence.spec.ts`'s FRET threshold case (0.8475 vs 0.85, random peer ids, no `CoordinatorRepo`). That spec's Diary read-back case is also intermittent: it failed 6 of 15 runs with the memo off. Both are written up in `tickets/.pre-existing-error.md` for triage; they are the evidence spec of `blocked/writer-and-servers-disagree-on-where-a-block-lives`. An earlier full run in this pass was fully green (2680 passing).

### Not measured

The idle reconcile loop's consult rate is still unmeasured, as the implementer said. On a solo node the remaining per-consult cost is `findCluster`, which belongs to `plan/a-solo-node-recomputes-a-constant-answer-and-our-gate-cannot-see-it`. That ticket's expectation that this change shrinks the `fetchBlockFromCluster` site now applies only to solo nodes.

## For the human (outward-facing, not posted by the agent)

Consider replying on GitHub issue #8:
- `kjeib`'s statistic (254 `default/Revocation` consults, none preceded by a read-repair trigger) identified the missing-block path.
- On a lone node, absent reads now cost one consult per 10 s window per block.
- Multi-machine deployments are unchanged for now (see the backlog feature).
- This does not by itself fix any non-convergence being reported.
