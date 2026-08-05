description: A node used to decide "how many peers should this group have" in more than one place, and those places could disagree — a safety check could then measure against the wrong number. Separately, a deployment that only runs a couple of machines could have its self-repair silently and permanently disabled with no signal to the operator. Both are now fixed, with tests.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/cluster/cluster-size-coupling.ts (new), packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, docs/transactions.md, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/cluster-size-coupling.spec.ts (new)
difficulty: easy
----

# What changed

## Arm A — one resolved cluster size per node

`createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`) now calls `resolveClusterPolicy(options)` exactly once, early — right after `nodePrivateKey`/`inboundAuthorization` are set up and before `libp2pOptions` is built (was previously called a second time, redundantly, much later at what's now the `partitionDetector`/`fretSvc` block; that second call is deleted). The single `consensusConfig` it produces now feeds every cluster-size consumer:

- `networkManagerService({ clusterSize: consensusConfig.clusterSize, ... })` (was `options.clusterSize ?? 10`)
- `new Libp2pKeyPeerNetwork(node, consensusConfig.clusterSize, ...)` (was raw `options.clusterSize`, which meant the key network's own constructor default of 16 won by default whenever the operator left `clusterSize` unset)
- `networkManager.initSpreadOnChurnMonitor(..., consensusConfig.clusterSize, ...)` (was `options.clusterSize ?? 10`)

**New fail-fast backstop.** `packages/db-p2p/src/cluster/cluster-size-coupling.ts` exports `assertClusterSizeCoupling(resolvedClusterSize, consumers)`, mirroring the existing `assertSuperMajorityCoupling` (`cluster/supermajority-coupling.ts`) pattern. It's called once, right after the `networkManager` service instance is pulled off the started node (`libp2p-node-base.ts`, next to the `ownedBlocks` set), comparing `consensusConfig.clusterSize` against `keyNetwork.effectiveClusterSize` and `networkManager.effectiveClusterSize` — two new public getters added to `Libp2pKeyPeerNetwork` and `NetworkManagerService` respectively, exposing the private field each class already held. A future edit that reintroduces a private fallback on either class throws at node construction, naming both the resolved value and which consumer disagreed, instead of shipping a silent divergence.

`Libp2pKeyPeerNetwork`'s own constructor default (`clusterSize: number = 16`) is untouched — other composition roots (`reference-peer/src/cli.ts`, `quereus-plugin-optimystic`'s adapter, and the class's own test suite) construct it directly and are out of this ticket's scope; only `createLibp2pNodeBase`'s internal consistency was the bug.

## Arm B — startup warning when repair can't self-heal

`resolveClusterPolicy` (`packages/db-p2p/src/cluster/cluster-policy.ts`) now logs once, at resolution time (which happens once per node construction), when `clusterPolicy.assumedClusterSize` is absent AND `clusterSize > minAbsoluteClusterSize` (2) — the combination that leaves `repairCorroborationClusterSize` at the strict default (`clusterSize`), so a cohort that genuinely has fewer real peers than that can never supply the 2 distinct corroborators read-repair/reconcile require, and self-repair declines forever.

Log tag: `assumed-cluster-size-unset` (namespace `optimystic:db-p2p:cluster-policy`), payload `{ clusterSize, repairCorroborationClusterSize, corroborationFloor, message }`. The message names `CORROBORATION_FLOOR` (now exported from `cluster/quorum-restore.ts`, was module-private) and `repairCorroborationClusterSize`, states the fix (`clusterPolicy.assumedClusterSize`), and states explicitly that the fix does not lower the replication factor.

Because the condition is purely configuration-driven (not tied to an observed cohort), a deployment that genuinely runs `clusterSize` machines sees the warning too — this is deliberate per the ticket's edge-case note; the message is worded conditionally ("if you run fewer than N machines"), not as a fault.

**Decline logs now name the knob.** `cluster-fetch:no-quorum` (`repo/coordinator-repo.ts`), `reconcile:no-rev-quorum`, and `reconcile:no-content-quorum` (`cluster/reconcile-block.ts`) now all carry `repairCorroborationClusterSize` alongside the responder/carrier count and the `required` quorum size (the latter two log tags previously carried only `capacity`, the corroborator-capacity input to the quorum calculation, not the required-votes output — both are included now).

**Docs cross-link.** `docs/transactions.md` § "What a repair pass will and will not accept" (the two-node repair paragraph) now has a sentence pointing at the `assumed-cluster-size-unset` startup warning, naming the same `repairCorroborationClusterSize` field so the log line and the doc read the same way.

# Tests

- `packages/db-p2p/test/cluster-policy.spec.ts` — `describe('assumed-cluster-size-unset startup warning')` block: fires exactly once for the default (unconfigured) case, does not fire once `assumedClusterSize` is declared, does not fire for an honest `clusterSize: 2`, and does fire for a large genuinely-provisioned `clusterSize` (documenting the deliberate advisory-not-fault framing). Uses the existing `test/support/capture-log.ts` helper (already used by `coordinator-repo-read-repair*.spec.ts`).
- `packages/db-p2p/test/cluster-size-coupling.spec.ts` — unit tests on `assertClusterSizeCoupling` directly (passes when consumers agree, throws naming the consumer(s) that don't, skips `undefined` consumers), plus two integration tests that boot a real node via `createLibp2pNode` (`src/libp2p-node.js`) and assert `node.keyNetwork.effectiveClusterSize` and `(node.services.networkManager).effectiveClusterSize` both equal `resolveClusterPolicy({}).clusterSize` on the default path, and both equal an explicitly configured `clusterSize: 4`.

## Verification performed at implement handoff (this pass)

Re-ran independently, from a clean working tree (no code changes made in this pass — the fix commit had already landed):

- `packages/db-p2p`: `yarn tsc --noEmit` clean.
- `packages/db-p2p`: `yarn test` → 1529 passing, 0 failing, 44 pending (pre-existing skips, unrelated to this change).
- `reference-peer`: `yarn tsc --noEmit` clean.
- `quereus-plugin-optimystic`: `yarn tsc --noEmit` clean.
- Confirmed by reading `libp2p-node-base.ts`: exactly one `resolveClusterPolicy` call site (line ~470), `assertClusterSizeCoupling` called once against `{ keyNetwork, networkManager }`, and both `effectiveClusterSize` getters exist on `NetworkManagerService` and `Libp2pKeyPeerNetwork`.

# Gaps / what a reviewer should double check

- The coupling assertion currently only compares `keyNetwork` and `networkManager` — those are the two consumers that held an independently-resolvable private field before this fix. If a future consumer is added, it needs both a `consensusConfig.clusterSize`-sourced constructor argument AND an entry in the `assertClusterSizeCoupling` call site (`libp2p-node-base.ts`, next to the `ownedBlocks` set) to stay covered — nothing enforces that a new consumer gets added to the assertion.
- Did not touch `reference-peer/src/cli.ts` or `quereus-plugin-optimystic`'s `collection-factory.ts`/`key-network.ts`, which construct `Libp2pKeyPeerNetwork` directly (not through `createLibp2pNodeBase`) and so don't benefit from either the single-source fix or the coupling assertion. Out of scope per the ticket's `files:` list, but worth a reviewer's judgment call on whether it should be.
- Did not build the backlog item `feat-admission-floor-from-observed-cohort-high-water-mark` (deriving the yardstick from observation) — the ticket explicitly said not to; noting it's still open.
