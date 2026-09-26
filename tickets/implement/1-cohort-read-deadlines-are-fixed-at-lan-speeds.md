description: When a machine checks with the others in its group before trusting what it holds, each machine gets one second to answer, and that can't be changed. Over a slow link, such as two phones reaching each other through a relay, every answer arrives late and counts as no answer at all, so a machine that rejoins can never catch up. Make the time allowed configurable.
architecture: docs/transactions.md#read-consistency-and-staleness
files: packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig`, `DEFAULT_SUPER_MAJORITY_THRESHOLD` as the placement precedent), packages/db-p2p/src/cluster/cluster-policy.ts (`ClusterPolicyOptions`, `ResolvedClusterPolicy`, `resolveClusterPolicy`, `resolveRepairCorroborationClusterSize` as the shape precedent), packages/db-p2p/src/cluster/reconcile-block.ts (`RECONCILE_TIMEOUT_MS`), packages/db-p2p/src/repo/coordinator-repo.ts (`LATEST_QUERY_TIMEOUT_MS`, `queryClusterForLatest`, `withDeadline`, `CoordinatorRepoConfig`, the acquisition deadline in `restoreCorroborated`), packages/db-p2p/src/cluster/cluster-repo.ts (`ReconcileTimeoutMs`, `withReconcileTimeout`), packages/db-p2p/src/libp2p-node-base.ts (`fetchArchiveFromPeer`), packages/db-p2p/test/cluster-policy.spec.ts, docs/transactions.md, docs/internals.md, docs/debugging.md, packages/db-p2p/docs/cluster.md
difficulty: medium
repro: verified
----

# Cohort read deadlines are fixed at LAN speeds

Reported as GitHub issue #22 (gotchoices/Optimystic), by a downstream chat app whose deployments are two phones reaching each other only through a public circuit relay.

## What happens

A machine that re-attaches after being away reads a block it may be behind on. The coordinator (`CoordinatorRepo`) consults the block's cohort: it asks each cohort peer for its latest revision (`queryClusterForLatest` → `clusterLatestCallback` → a `SyncClient.requestBlock` round trip), then, once a revision is corroborated, fetches the block from the cohort (`acquireBlockFromCohort`, which is `createReconcileBlock` over `fetchArchiveFromPeer`) and persists it.

Three deadlines on that path are hardcoded constants with no configuration:

| deadline | value | where | what a miss does |
| --- | --- | --- | --- |
| per-peer latest-revision query | 1000 ms | `LATEST_QUERY_TIMEOUT_MS`, coordinator-repo.ts | the peer counts as **silent** |
| per-peer archive fetch | 1000 ms | the `setTimeout` race in `fetchArchiveFromPeer`, libp2p-node-base.ts | resolves `{ success: false }`, the same as "that peer holds nothing" |
| whole reconcile / acquisition pass | 5000 ms | `RECONCILE_TIMEOUT_MS`, reconcile-block.ts (used by both `CoordinatorRepo` read-repair and `ClusterMember.withReconcileTimeout`) | the pass is abandoned |

Each of those round trips is a fresh stream: dial or reuse the connection, multistream-select the sync protocol, send, receive. Over a relayed link with a round trip near 1.8 s, that cannot finish in 1 s. In a two-machine cohort the reader has exactly one peer, so one late answer is the whole quorum: the consult declines every time, and the reader never catches up. The reporter's app gives up after 120 s with its own "awaiting first sync" error.

## Reproduced, at the unit tier, with latency as the only variable

The fix stage ran it (this is what moved the ticket from `repro: static` to `repro: verified`). A throwaway `CoordinatorRepo` spec over the stub harness in `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts`: a two-member cohort (`clusterSize: 2`, `repairCorroborationClusterSize: 2`), a reader whose storage holds nothing, and a `clusterLatestCallback` whose one remote peer answers **honestly, with the revision, just 1200 ms late**.

At the shipped 1000 ms the consult produced the reporter's log line field-for-field:

```
cluster-fetch:peers-silent { blockId, silent: 1, consulted: 2 }
cluster-fetch:no-quorum { cohortPeers: 1, holders: 0, absent: 0, silent: 1, required: 1, repairCorroborationClusterSize: 2 }
```

and the read came back flagged `unavailable: 'cohort-unreachable'`.

The same spec with `LATEST_QUERY_TIMEOUT_MS` temporarily raised to 2000 — one number, nothing else touched — produced neither line: the claim was counted, the quorum was met, and the read ended at `cluster-fetch:not-restored` with `unavailable: 'claimed-elsewhere'` (no acquisition callback was wired in that harness, so the bytes had nowhere to come from — the claim itself was accepted, which is the half under test). The temporary edit was reverted and both throwaway specs deleted; the tree is unchanged.

So the causal chain is confirmed end to end, and the two outcomes are crisply distinguishable without any acquisition wiring — which is what the regression test below is built on. The archive fetch's 1000 ms was not reproduced separately and does not need to be: it is the same arithmetic on the same kind of round trip to the same peer, and it becomes the binding gate the moment the consult is allowed to succeed.

## What to build

A deployment on slow links must be able to raise these deadlines. **Defaults do not change**: a node that sets nothing behaves exactly as today.

One operator field, `clusterPolicy.cohortQueryTimeoutMs` — the time one cohort peer gets to answer one read-path request. Default 1000. It sets **both** per-peer deadlines: the latest-revision query and the archive fetch. They are the same kind of round trip to the same peer over the same protocol, so a separate setting for each would only let one be raised while the other still fails.

The whole-pass bound becomes `max(RECONCILE_TIMEOUT_MS, 5 × cohortQueryTimeoutMs)`, so it stays 5000 ms by default and grows with the per-peer budget rather than cutting a slow pass short. Both current callers use it: the read-path acquisition in `CoordinatorRepo` and `ClusterMember`'s commit-path reconcile. They share the constant today on purpose ("same operation, same bound", docs/internals.md) and must not drift apart.

### Decisions already settled — do not re-litigate these

The fix stage read the surrounding code and picked these; each has a reason a reviewer will ask for.

**Placement.** `DEFAULT_COHORT_QUERY_TIMEOUT_MS = 1000` goes in `packages/db-core/src/cluster/structs.ts` beside `DEFAULT_SUPER_MAJORITY_THRESHOLD`, whose doc comment states exactly this role: the single constant every tier that falls back to a default references, so two tiers cannot silently default differently. The optional operator field `cohortQueryTimeoutMs?: number` goes on `ClusterConsensusConfig` in the same file, which is what makes it reach `ClusterMember` (already constructed with a `ClusterConsensusConfig`) and `CoordinatorRepoConfig` (already `Partial<ClusterConsensusConfig> & …`) with no new parameter anywhere.

**Two shared resolvers, in `cluster/cluster-policy.ts`.** That module already hosts `resolveRepairCorroborationClusterSize` for precisely this reason — its own doc comment says there are two composition paths onto the number (`resolveClusterPolicy`, and the `CoordinatorRepo` constructor the readme's manual wiring uses) and that one function rather than two copies is what keeps them from drifting. The same argument applies here verbatim, and now with a third caller (`ClusterMember`). Add:

- `resolveCohortQueryTimeoutMs(declared: number | undefined): number` — validates, else defaults to `DEFAULT_COHORT_QUERY_TIMEOUT_MS`.
- `reconcilePassTimeoutMs(cohortQueryTimeoutMs: number): number` — `Math.max(RECONCILE_TIMEOUT_MS, 5 * cohortQueryTimeoutMs)`.

`cluster-policy.ts` importing `RECONCILE_TIMEOUT_MS` from `reconcile-block.ts` introduces no runtime cycle: reconcile-block's only edge back toward cluster-repo is a clause-level `import type`, which is erased (see docs/internals.md § Common Pitfalls, *Importing a Barrel That Re-exports You*, for why that distinction matters here).

**Validation throws; it does not fall through.** A value that is not a finite number, or is `≤ 0`, is a configuration error and throws a plain `Error` naming the field and the value — matching `assertSuperMajorityCoupling` in `packages/db-p2p/src/cluster/supermajority-coupling.ts`, which is the house style for a fail-fast at node construction. This deliberately differs from the discipline of its neighbour `asDeclaredSize`, which treats a degenerate declaration as *not declared* and falls through. The reason the two differ: for a cohort **size**, falling through lands on the strict `clusterSize` default and clamping would be the unsafe direction (2 is the one size whose corroboration floor relaxes to a single voter), so there is a safe reading of nonsense. For a **timeout** there is no safe direction to fall toward — falling through to 1000 would silently keep the LAN default on the deployment that typed the field in order to escape it, which is the exact failure this ticket exists to end. Say that in the resolver's doc comment.

A positive finite **fractional** value is accepted (it is a millisecond duration and `setTimeout` takes one). Do not add `Number.isInteger` here; that check belongs to the size fields, which count peers.

**`ResolvedClusterPolicy` carries both numbers concretely** — `cohortQueryTimeoutMs: number` and `reconcilePassTimeoutMs: number` — narrowed there the way `clusterSize` and `repairCorroborationClusterSize` already are, so the resolution is directly assertable and `libp2p-node-base` can thread the per-peer value into `fetchArchiveFromPeer` off the one `consensusConfig`.

**No coupling assertion is needed, and this is why.** `ClusterMember` and `CoordinatorRepo` each derive the pass bound by calling `reconcilePassTimeoutMs` on the `cohortQueryTimeoutMs` they read from their own config, and on a live node both read the one `resolveClusterPolicy` result (`libp2p-node-base.ts`'s `consensusConfig`). One derivation function on one input cannot produce two numbers, so the `assertSuperMajorityCoupling` pattern would assert an identity here. State that in a comment at `ClusterMember`'s resolution site, next to the existing note about the two reading a shared bound — the point of the comment is that a future change which gives either side its own default is what re-opens the drift, and that is when an assertion becomes worth adding.

**`fetchArchiveFromPeer` keeps its current contract**: a timed-out fetch resolves to "no archive" and the pass moves on to the next peer. Only the number changes.

**`packages/db-p2p/src/testing/mesh-harness.ts` needs no change.** It spreads the resolved policy into its coordinator factory (`{ ...policy }`) so the new field rides along, and its `makeFetchArchive` is in-process with no deadline to thread. Checked, not assumed.

## Stale comments that must be rewritten, not just left

Each of these currently tells a reader to edit a constant, or states a number that stops being fixed:

- The `NOTE:` inside `queryClusterForLatest` ("`LATEST_QUERY_TIMEOUT_MS` is a LAN-shaped budget … If a WAN deployment shows steady `cluster-fetch:peers-silent` against healthy peers, raise this"). It should point operators at the setting.
- The `NOTE:` at the acquisition `withDeadline` call in `CoordinatorRepo`, which reasons from "the underlying per-peer archive fetch is itself 1s-bounded, so the 5s is a stall ceiling, not a typical cost". Both numbers become resolved values, and the ratio the argument rests on is exactly what `max(5000, 5 × per-peer)` preserves — say so rather than deleting the reasoning.
- The comment above `ReconcileTimeoutMs` in `cluster-repo.ts`, and the one at `RECONCILE_TIMEOUT_MS` in `reconcile-block.ts`, both of which describe a shared constant.

## Out of scope, deliberately

- **An adaptive budget** (scaled from each peer's observed round-trip time) is the reporter's first-listed option. It needs a round-trip estimator and a policy for a peer with no history, which is design work. The fixed setting unblocks the reporter now. If adaptation is ever wanted, it would replace the default and keep this field as the override.
- **Retrying a missed budget at cohort size ≤ 2** (the reporter's option 2) changes when the read path declines, and so what an application observes. Not this ticket.
- **Separating "never asked" from "asked, no answer" in the silent set** (option 3). The consult already asks every peer it counts; a peer it could not dial is rejected through the same deadline. Not needed for this fix.
- The **write/push path's** per-peer deadlines (the callers' own bounds in `pushBlockToPeers`, `packages/db-p2p/src/cluster/block-transfer-service.ts`). Same latency exposure, different path, no report against it.
- The reporter's secondary note, that a write fails for a moment right after its partner detaches ("1/2 approvals"), is a two-member cohort needing both members until membership notices the departure. It is transient by their own measurement, and a separate question from the deadlines.

## Tests

Two, and the split between them is deliberate.

**`resolveClusterPolicy` (add to `packages/db-p2p/test/cluster-policy.spec.ts`).** This is where the *defaults* are pinned, because they are pure arithmetic: an unconfigured node resolves `cohortQueryTimeoutMs` to 1000 and `reconcilePassTimeoutMs` to 5000; a declared 3000 resolves to 3000 and 15000; a declared 100 keeps the pass bound at 5000 (the `max` floor); and `0`, a negative, `NaN` and `Infinity` each throw. The existing suite's "resolves the rest of the consensus config to its documented defaults" case is the natural neighbour.

**`CoordinatorRepo`, unit tier (new spec).** This pins the one thing resolution cannot: that the per-peer deadline site actually reads the resolved number. Reuse the stub harness from `coordinator-repo-read-repair.spec.ts` (`makeKeyNetwork` / `makeClusterClient`, plus a storage repo that holds nothing) with a two-member cohort and a `clusterLatestCallback` whose remote peer answers with a revision after a fixed delay. Two cases over the same callback delay, asserting the two outcomes the reproduction above established:

- deadline shorter than the delay → `cluster-fetch:peers-silent` and `cluster-fetch:no-quorum` are logged, and the read is flagged `unavailable: 'cohort-unreachable'`.
- deadline longer than the delay → neither line is logged, and the read is flagged `'claimed-elsewhere'` instead (the claim was counted and selected; with no `acquireBlockFromCohort` wired the bytes have nowhere to come from, which is why no acquisition stub is needed).

Use `captureLog('coordinator-repo', …)` and `hasTag` from `test/support/capture-log.ts` — note `hasTag` takes the whole captured array, not one entry.

**Use small declared durations, not the default.** There is no fake-timer library in this repo (`db-p2p` devDependencies carry mocha + chai only, and `withDeadline` uses real `setTimeout`, which the class's `now` seam does not cover — that seam is only for the read-repair window). Adding one for a single spec is not worth a new shared dependency and a `lint:deps` conversation. So declare e.g. `cohortQueryTimeoutMs: 40` and `1500` against a callback that answers after 250 ms — roughly half a second of real time for both cases, with a ~6× margin either side of the delay so a loaded CI run does not flip the verdict. Exercising the *default* would mean waiting past 1000 ms in a suite that should not burn real seconds, and the default is already pinned at the resolution tier: the deadline site reads one resolved number, and the other test says what that number is.

Nothing needs to prove that the archive fetch reads the setting beyond the node-base wiring passing it through. Keep that wiring on the one resolved value, so there is nothing separate to test.

## Docs

- **docs/transactions.md § Read Consistency and Staleness.** Add `cohortQueryTimeoutMs` to the `ClusterConsensusConfig` knob table there, and name it in the sentence that currently reads "bounded by the same 5s deadline (`RECONCILE_TIMEOUT_MS`)" — the 5 s is now a default and a floor, not a constant. Say when to raise it: steady `cluster-fetch:peers-silent` against peers that are healthy and answering everything else.
- **docs/debugging.md § `cluster-fetch:no-quorum` and `reconcile:no-rev-quorum`.** The `silent` above `0` row currently says only "Wait, or fix reachability". A relayed link is neither, and this table is where an operator with the reporter's symptom actually lands: add that a deadline shorter than the link's round trip produces the same shape, and name the setting.
- **packages/db-p2p/docs/cluster.md**, alongside the other `clusterPolicy` fields (the `clusterSize` vs `assumedClusterSize` section and the `repairCorroborationClusterSize` material that follows it).
- **docs/internals.md**, the reconcile bullet that names `RECONCILE_TIMEOUT_MS` as the shared bound ("same operation, same bound"): it now names the resolved bound and how it is derived.

Follow the citation convention in AGENTS.md § Documentation citations — symbol-or-quoted-fragment anchors bound to paths, no line numbers — and run `yarn lint:docs` before handing off.

## TODO

- Add `DEFAULT_COHORT_QUERY_TIMEOUT_MS` and the optional `cohortQueryTimeoutMs` field to `packages/db-core/src/cluster/structs.ts`
- Add `resolveCohortQueryTimeoutMs` (validating, throwing) and `reconcilePassTimeoutMs` to `cluster/cluster-policy.ts`; add `cohortQueryTimeoutMs` to `ClusterPolicyOptions.clusterPolicy` and both resolved numbers to `ResolvedClusterPolicy`, resolved in `resolveClusterPolicy`
- Replace `LATEST_QUERY_TIMEOUT_MS` in `CoordinatorRepo` with the value resolved in its constructor (through the shared resolver, defaulting to 1000 for the direct-constructor path) and use the derived pass bound for the read-path acquisition deadline
- Resolve the same two numbers in `ClusterMember` and use the pass bound in `withReconcileTimeout`
- Thread the per-peer value into `fetchArchiveFromPeer` in libp2p-node-base.ts, off the one `consensusConfig`
- Rewrite the four stale comments listed above
- Tests as above
- Docs as above
- `yarn build && yarn typecheck && yarn test` from the root, plus `yarn lint:docs`
